/**
 * server.js - Game server (Node.js + Socket.IO).
 * Assignment 4 PDF: Section 3 System Architecture - server as authoritative host for game logic, state, auth, rooms.
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { loginUser, registerUser } = require('./database');
const cfg = require('./config');

/* Ryan Mendez - Express and Socket.IO setup; serves static public folder. FR-1: application has a starting page. */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

/* Ryan Mendez - In-memory store for lobbies, players, and active games. FR-3: multiplayer lobby; FR-4/5: rooms. */
const lobbies = {};
const players = {};
const GAMES = {};
/* An Nguyen - Real elapsed time for game loop; fixes timer running slow. FR-12: state updates at several Hz. */
const TICK_INTERVAL_MS = 1000 / cfg.TICK_RATE;
let lastTickTime = Date.now();
const USERNAME_REGEX = /^[a-zA-Z0-9._-]+$/;

/* Ryan Mendez - Validates username length, format, and password length before login/register. FR-2: account creation. */
function validateAuth(username, password) {
  if (!username || typeof username !== 'string') return 'Username required';
  const u = username.trim();
  if (u.length < cfg.USERNAME_MIN_LEN || u.length > cfg.USERNAME_MAX_LEN) return 'Username 2–20 characters';
  if (!USERNAME_REGEX.test(u)) return 'Username: letters, numbers, . _ - only';
  if (!password || typeof password !== 'string') return 'Password required';
  if (password.length < cfg.PASSWORD_MIN_LEN) return 'Password at least 4 characters';
  return null;
}

/* Ryan Mendez + An Nguyen - Creates initial game state. FR-7: one random Cat, rest Rats; FR-8: map with terminals; An Nguyen: obstacles, power-ups. */
function createGameState(lobbyId, playerIds) {
  const state = {
    id: lobbyId,
    players: {},
    terminals: [],
    obstacles: [],
    powerups: [],
    exitOpen: false,
    timeLeft: cfg.GAME_TIME_SEC,
    status: 'playing',
    winner: null
  };

  const catId = playerIds[Math.floor(Math.random() * playerIds.length)];
  const half = cfg.MAP_SIZE / 2;
  const margin = 200;

  playerIds.forEach(id => {
    state.players[id] = {
      id: id,
      role: id === catId ? 'cat' : 'mouse',
      x: 0,
      y: 0,
      hp: 100,
      speed: cfg.BASE_SPEED,
      isSprinting: false,
      sprintTime: cfg.SPRINT_DURATION_SEC,
      sprintCooldown: 0,
      maxSprintTime: cfg.SPRINT_DURATION_SEC,
      attackCooldown: 0,
      dead: false,
      escaped: false,
      speedBoostUntil: 0,
      rageUntil: 0,
      lastInputTime: Date.now()
    };
  });

  for (let i = 0; i < cfg.TERMINAL_COUNT; i++) {
    const tx = Math.floor(Math.random() * ((cfg.MAP_SIZE - margin * 2) / 100)) * 100 - half + margin;
    const ty = Math.floor(Math.random() * ((cfg.MAP_SIZE - margin * 2) / 100)) * 100 - half + margin;
    state.terminals.push({ id: i, x: tx, y: ty, progress: 0, completed: false });
  }

  for (let i = 0; i < cfg.OBSTACLE_COUNT; i++) {
    const w = cfg.OBSTACLE_MIN_SIZE + Math.random() * (cfg.OBSTACLE_MAX_SIZE - cfg.OBSTACLE_MIN_SIZE);
    const h = cfg.OBSTACLE_MIN_SIZE + Math.random() * (cfg.OBSTACLE_MAX_SIZE - cfg.OBSTACLE_MIN_SIZE);
    const x = (Math.random() * (cfg.MAP_SIZE - margin * 2)) - half + margin;
    const y = (Math.random() * (cfg.MAP_SIZE - margin * 2)) - half + margin;
    state.obstacles.push({ id: i, x, y, w, h });
  }

  const types = ['heal', 'speed', 'speed', 'rage'];
  for (let i = 0; i < cfg.POWERUP_COUNT; i++) {
    const type = types[i % types.length];
    const px = (Math.random() * (cfg.MAP_SIZE - margin * 2)) - half + margin;
    const py = (Math.random() * (cfg.MAP_SIZE - margin * 2)) - half + margin;
    state.powerups.push({ id: i, x: px, y: py, type, respawnAt: 0 });
  }

  return state;
}

/* An Nguyen - Broadcasts game events (terminal complete, exit open, escape, catch, power-up) to lobby. FR-13/14: players informed on catch. */
function emitGameEvent(lobbyId, event) {
  if (lobbyId && io) io.to(lobbyId).emit('gameEvent', event);
}

/* An Nguyen - Resolves player position out of obstacle rectangles to prevent walking through. FR-8: map contains obstacles. */
function pushOutOfObstacle(px, py, obstacles) {
  let x = px, y = py;
  for (let iter = 0; iter < 5; iter++) {
    let inside = false;
    for (const o of obstacles) {
      const hw = o.w / 2, hh = o.h / 2;
      const left = o.x - hw, right = o.x + hw, top = o.y - hh, bottom = o.y + hh;
      if (x >= left && x <= right && y >= top && y <= bottom) {
        inside = true;
        const dl = x - left, dr = right - x, dt = y - top, db = bottom - y;
        const min = Math.min(dl, dr, dt, db);
        if (min === dl) x = left - 2;
        else if (min === dr) x = right + 2;
        else if (min === dt) y = top - 2;
        else y = bottom + 2;
        break;
      }
    }
    if (!inside) break;
  }
  return { x, y };
}

/* Ryan Mendez - WebSocket connection handler. FR-1: login/register from main menu; FR-2: new user registration in DB. */
io.on('connection', (socket) => {
  socket.on('login', ({ username, password }) => {
    const msg = validateAuth(username, password);
    if (msg) return socket.emit('loginResponse', { success: false, message: msg });
    const u = username.trim();
    loginUser(u, password, (err, user) => {
      if (user) {
        players[socket.id] = { username: user.username, lobby: null };
        socket.emit('loginResponse', { success: true, username: user.username });
      } else {
        registerUser(u, password, (err, id) => {
          if (!err) {
            players[socket.id] = { username: u, lobby: null };
            socket.emit('loginResponse', { success: true, username: u });
          } else {
            socket.emit('loginResponse', { success: false, message: 'Taken/Error' });
          }
        });
      }
    });
  });

  /* Ryan Mendez - Returns list of available lobbies with player count. FR-3: lobby displays game rooms and number of players. */
  socket.on('getLobbies', () => {
    const list = [];
    for (const [id, lobby] of Object.entries(lobbies)) {
      list.push({ id, players: lobby.players.map(p => players[p].username) });
    }
    socket.emit('lobbyList', list);
  });

  /* Ryan Mendez - Creates a new room and adds creator; notifies lobby list. FR-4: user can form a new game room. */
  socket.on('createLobby', () => {
    const id = 'lobby_' + Math.random().toString(36).slice(2, 7);
    lobbies[id] = { players: [socket.id], timer: cfg.LOBBY_COUNTDOWN_SEC, started: false };
    players[socket.id].lobby = id;
    socket.join(id);
    const playerList = [{ id: socket.id, username: players[socket.id].username }];
    socket.emit('joinedLobby', { lobbyId: id, players: playerList });
    io.emit('lobbyUpdate');
  });

  /* Ryan Mendez - Joins an existing room if slot available and not started. FR-5: join a game room already in progress. */
  socket.on('joinLobby', (lobbyId) => {
    if (lobbies[lobbyId] && lobbies[lobbyId].players.length < cfg.MAX_LOBBY_PLAYERS && !lobbies[lobbyId].started) {
      lobbies[lobbyId].players.push(socket.id);
      players[socket.id].lobby = lobbyId;
      socket.join(lobbyId);
      const playerList = lobbies[lobbyId].players.map(id => ({ id, username: players[id]?.username || '?' }));
      socket.emit('joinedLobby', { lobbyId, players: playerList });
      io.to(lobbyId).emit('lobbyPlayers', playerList);
    }
  });

  /* Ryan Mendez - Removes player from lobby and cleans up empty lobbies. FR-19: user can log out / leave session. */
  socket.on('leaveLobby', () => {
    const p = players[socket.id];
    if (!p || !p.lobby) return;
    const lobbyId = p.lobby;
    const lobby = lobbies[lobbyId];
    if (lobby) {
      lobby.players = lobby.players.filter(id => id !== socket.id);
      if (lobby.players.length === 0) delete lobbies[lobbyId];
      else io.to(lobbyId).emit('lobbyPlayers', lobby.players.map(id => ({ id, username: players[id]?.username || '?' })));
    }
    p.lobby = null;
    socket.leave(lobbyId);
    socket.emit('leftLobby');
  });

  /* Ryan Mendez + An Nguyen - Processes movement, sprint, action (attack/repair); An Nguyen: inputDelta, obstacles, power-up pickup. FR-10: movement/action to server; FR-11: server validates and updates state. */
  socket.on('playerInput', (input) => {
    const p = players[socket.id];
    if (!p || !p.lobby || !GAMES[p.lobby]) return;
    
    const game = GAMES[p.lobby];
    const playerState = game.players[socket.id];
    
    /* FR-10 precondition: player not killed. */
    if (!playerState || playerState.dead || playerState.escaped) return;

    /* An Nguyen - Real-time delta for movement and repair so timing matches real seconds. */
    const inputNow = Date.now();
    const inputDelta = Math.min((inputNow - (playerState.lastInputTime || inputNow)) / 1000, 0.05);
    playerState.lastInputTime = inputNow;

    let speed = playerState.speed;
    
    if (input.sprint && playerState.sprintCooldown <= 0 && playerState.sprintTime > 0) {
      speed *= cfg.SPRINT_MULTIPLIER;
      playerState.isSprinting = true;
    } else {
      playerState.isSprinting = false;
    }

    // Movement
    let dx = 0;
    let dy = 0;
    if (input.up)    { dx -= 1; dy -= 1; } 
    if (input.down)  { dx += 1; dy += 1; }
    if (input.left)  { dx -= 1; dy += 1; }
    if (input.right) { dx += 1; dy -= 1; }

    if (dx !== 0 || dy !== 0) {
      const length = Math.hypot(dx, dy);
      dx /= length;
      dy /= length;
    }
    if (Date.now() < (playerState.speedBoostUntil || 0)) speed *= cfg.POWERUP_SPEED_MULT;

    playerState.x += dx * speed * inputDelta;
    playerState.y += dy * speed * inputDelta;

    const limit = cfg.MAP_SIZE / 2;
    if (playerState.x < -limit) playerState.x = -limit;
    if (playerState.x > limit) playerState.x = limit;
    if (playerState.y < -limit) playerState.y = -limit;
    if (playerState.y > limit) playerState.y = limit;

    const pushed = pushOutOfObstacle(playerState.x, playerState.y, game.obstacles || []);
    playerState.x = pushed.x;
    playerState.y = pushed.y;

    const now = Date.now();
    (game.powerups || []).forEach(pu => {
      if (pu.respawnAt > 0) return;
      const dist = Math.hypot(playerState.x - pu.x, playerState.y - pu.y);
      if (dist > cfg.POWERUP_PICKUP_RADIUS) return;
      pu.respawnAt = now + cfg.POWERUP_RESPAWN_SEC * 1000;
      if (pu.type === 'heal' && playerState.role === 'mouse') {
        playerState.hp = Math.min(100, playerState.hp + cfg.POWERUP_HEAL_AMOUNT);
        emitGameEvent(p.lobby, { type: 'powerup', kind: 'heal', playerId: socket.id });
      } else if (pu.type === 'speed') {
        playerState.speedBoostUntil = now + cfg.POWERUP_SPEED_DURATION_MS;
        emitGameEvent(p.lobby, { type: 'powerup', kind: 'speed', playerId: socket.id });
      } else if (pu.type === 'rage' && playerState.role === 'cat') {
        playerState.rageUntil = now + cfg.POWERUP_RAGE_DURATION_MS;
        emitGameEvent(p.lobby, { type: 'powerup', kind: 'rage', playerId: socket.id });
      }
    });

    /* Ryan Mendez - Action: Cat attacks closest Rat in range; Mouse repairs terminals. FR-13/14: catch when Cat hits Rat; FR-15: Rats complete puzzles to unlock exit. */
    if (input.action) {
      if (playerState.role === 'cat') {
        if (playerState.attackCooldown <= 0) {
            /* Ryan Mendez - Find closest live Mouse within attack range. */
            let closestTarget = null;
            let closestDist = cfg.ATTACK_RANGE;

            for (const pid in game.players) {
              const target = game.players[pid];
              if (target.role === 'mouse' && !target.dead && !target.escaped) {
                const dist = Math.hypot(playerState.x - target.x, playerState.y - target.y);
                if (dist < closestDist) {
                  closestDist = dist;
                  closestTarget = target;
                }
              }
            }

            if (closestTarget) {
              /* An Nguyen - Rage power-up increases Cat damage. */
              const damage = (Date.now() < (playerState.rageUntil || 0))
                ? cfg.ATTACK_DAMAGE * cfg.POWERUP_RAGE_DAMAGE_MULT
                : cfg.ATTACK_DAMAGE;
              closestTarget.hp -= damage;
              emitGameEvent(p.lobby, { type: 'catHit', targetId: closestTarget.id, damage });
              if (closestTarget.hp <= 0) {
                closestTarget.hp = 0;
                closestTarget.dead = true;
                emitGameEvent(p.lobby, { type: 'mouseDown', playerId: closestTarget.id, username: players[closestTarget.id]?.username });
                checkGameEnd(game, p.lobby);
              } else {
                closestTarget.speed += cfg.BASE_SPEED;
                setTimeout(() => {
                  if (!closestTarget.dead && !closestTarget.escaped) closestTarget.speed -= cfg.BASE_SPEED;
                }, cfg.MOUSE_SPEED_BOOST_DURATION_MS);
              }
              playerState.speed -= 100;
              setTimeout(() => { playerState.speed += 100; }, cfg.CAT_SLOW_DURATION_MS);
            }
            playerState.attackCooldown = cfg.ATTACK_COOLDOWN_SEC; 
        }
      } else {
        /* Ryan Mendez - Mouse repairs terminal when in radius; completing required count opens exit. FR-15: touch objects to unlock exit. */
        game.terminals.forEach(t => {
          if (!t.completed) {
            const dist = Math.hypot(playerState.x - t.x, playerState.y - t.y);
            if (dist < cfg.REPAIR_RADIUS) {
              t.progress += (100 / 60) * inputDelta * 10;
              if (t.progress >= 100) {
                t.progress = 100;
                t.completed = true;
                emitGameEvent(p.lobby, { type: 'terminalComplete', terminalId: t.id, count: game.terminals.filter(x => x.completed).length });
                checkWinCondition(game, p.lobby);
              }
            }
          }
        });
      }
    }
  });

  /* Ryan Mendez - On disconnect: remove from lobby/game; treat as dead in active game. FR-19: session termination. */
  socket.on('disconnect', () => {
    const p = players[socket.id];

    if (p && p.lobby && lobbies[p.lobby]) {
      const lobby = lobbies[p.lobby];
      lobby.players = lobby.players.filter(id => id !== socket.id);
      if (lobby.players.length === 0) delete lobbies[p.lobby];
      else io.to(p.lobby).emit('lobbyPlayers', lobby.players.map(id => ({ id, username: players[id]?.username || '?' })));
    }

    if (p && p.lobby && GAMES[p.lobby]) {
        const game = GAMES[p.lobby];
        const playerState = game.players[socket.id];
        
        if (playerState) {
            playerState.dead = true; 
            delete game.players[socket.id]; 

            if (playerState.role === 'cat') {
                io.to(p.lobby).emit('gameOver', 'mice');
                delete GAMES[p.lobby];
            } else {
                checkGameEnd(game, p.lobby);
            }
        }
    }
    delete players[socket.id];
  });
});

/* Ryan Mendez - When enough terminals completed, open exit. FR-15: exit door opened when puzzle requirements satisfied. */
function checkWinCondition(game, lobbyId) {
  const completed = game.terminals.filter(t => t.completed).length;
  if (completed >= cfg.TERMINALS_TO_COMPLETE && !game.exitOpen) {
    game.exitOpen = true;
    emitGameEvent(lobbyId, { type: 'exitOpen' });
  }
}

/* Ryan Mendez - Determines winner when no active mice: Mice win if any escaped; else Cat wins. FR-16: Rats win if escape before timer; FR-17: Cat wins when all Rats caught. */
function checkGameEnd(game, lobbyId) {
    const mice = Object.values(game.players).filter(pl => pl.role === 'mouse');
    const activeMice = mice.filter(m => !m.dead && !m.escaped).length;

    if (activeMice === 0) {
        const escapedMice = mice.filter(m => m.escaped).length;
        if (escapedMice > 0) {
            io.to(lobbyId).emit('gameOver', 'mice');
        } else {
            io.to(lobbyId).emit('gameOver', 'cat');
        }
        delete GAMES[lobbyId];
        delete lobbies[lobbyId];
    }
}

/* An Nguyen - Game loop uses real elapsed time (dt) so all timers match real seconds. FR-6: countdown then game launch; FR-12: periodic state broadcast. */
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTickTime) / 1000, 0.1);
  lastTickTime = now;

  /* FR-6: when 2+ players, countdown then start game. */
  for (const lobbyId in lobbies) {
    const lobby = lobbies[lobbyId];
    if (!lobby.started && lobby.players.length >= cfg.MIN_PLAYERS) {
      const prev = lobby.timer;
      lobby.timer -= dt;
      if (lobby.timer <= 0) {
        lobby.started = true;
        GAMES[lobbyId] = createGameState(lobbyId, lobby.players);
        io.to(lobbyId).emit('gameStart', GAMES[lobbyId]);
      } else {
        if (Math.floor(lobby.timer) < Math.floor(prev)) {
             io.to(lobbyId).emit('lobbyTimer', Math.ceil(lobby.timer));
        }
      }
    }
  }

  /* FR-12: disseminate updated game state; FR-16: Rats escape at center when exit open; FR-17: time over or all caught. */
  for (const gameId in GAMES) {
    const game = GAMES[gameId];
    game.timeLeft -= dt;

    (game.powerups || []).forEach(pu => {
      if (pu.respawnAt > 0 && now >= pu.respawnAt) pu.respawnAt = 0;
    });

    if (game.exitOpen) {
        for (const pid in game.players) {
            const p = game.players[pid];
            if (p.role === 'mouse' && !p.dead && !p.escaped) {
                const dist = Math.hypot(p.x, p.y);
                if (dist < cfg.EXIT_RADIUS) {
                    p.escaped = true;
                    emitGameEvent(gameId, { type: 'mouseEscaped', playerId: pid, username: players[pid]?.username });
                    checkGameEnd(game, gameId);
                }
            }
        }
    }

    for (const pid in game.players) {
      const p = game.players[pid];
      if (p.dead || p.escaped) continue;

      if (p.attackCooldown > 0) p.attackCooldown -= dt;

      if (p.isSprinting) {
        p.sprintTime -= dt;
        if (p.sprintTime <= 0) {
          p.isSprinting = false;
          p.sprintTime = 0;
          p.sprintCooldown = cfg.SPRINT_COOLDOWN_SEC;
        }
      } else {
        if (p.sprintCooldown > 0) {
          p.sprintCooldown -= dt;
        } else if (p.sprintTime < p.maxSprintTime) {
          p.sprintTime = Math.min(p.maxSprintTime, p.sprintTime + dt);
        }
      }
    }

    if (game.timeLeft <= 0) {
      const escapedMice = Object.values(game.players).filter(pl => pl.role === 'mouse' && pl.escaped).length;
      if (escapedMice > 0) {
          io.to(gameId).emit('gameOver', 'mice');
      } else {
          io.to(gameId).emit('gameOver', 'cat');
      }
      delete GAMES[gameId];
      delete lobbies[gameId];
    } else {
      io.to(gameId).emit('gameState', game);
    }
  }
}, TICK_INTERVAL_MS);

/* An Nguyen - Port from env or config; try next port if in use and print URL. */
const port = Number(process.env.PORT) || cfg.PORT;
const MAX_PORT_ATTEMPTS = 10;
let portAttempt = 0;

function tryListen(p) {
  portAttempt++;
  server.listen(p, () => {
    const url = `http://localhost:${p}`;
    console.log('Server running on port', p);
    console.log('Open in browser:', url);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && portAttempt < MAX_PORT_ATTEMPTS) {
    const nextPort = port + portAttempt;
    tryListen(nextPort);
  } else if (err.code === 'EADDRINUSE') {
    console.error(`Ports ${port}-${port + MAX_PORT_ATTEMPTS - 1} are in use. Free a port or set PORT=...`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

tryListen(port);
