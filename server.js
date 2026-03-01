/**
 * server.js - Game server (Node.js + Socket.IO).
 * Assignment 4 PDF: Section 3 System Architecture - server as authoritative host for game logic, state, auth, rooms.
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { loginUser, registerUser } = require('./database');
const cfg = require('./config');

/* Ryan Mendez - Express and Socket.IO setup; serves static public folder. Short: server and static files. PDF: FR-1 (application has starting page); Section 3 (server authoritative). */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

/* Ryan Mendez - In-memory store for lobbies, players, and active games. Short: lobby and game state. PDF: FR-3 (multiplayer lobby), FR-4/5 (rooms). */
const lobbies = {};
const players = {};
const GAMES = {};
/* An Nguyen - Tick interval for game loop using real elapsed time. Short: periodic state updates. PDF: FR-12 (state disseminated at several Hz). */
const TICK_INTERVAL_MS = 1000 / cfg.TICK_RATE;
let lastTickTime = Date.now();
const USERNAME_REGEX = /^[a-zA-Z0-9._-]+$/;

/* Ryan Mendez - Validates username and password before login/register. Short: account validation. PDF: FR-2 (new user registration). */
function validateAuth(username, password) {
  if (!username || typeof username !== 'string') return 'Username required';
  const u = username.trim();
  if (u.length < cfg.USERNAME_MIN_LEN || u.length > cfg.USERNAME_MAX_LEN) return 'Username 2–20 characters';
  if (!USERNAME_REGEX.test(u)) return 'Username: letters, numbers, . _ - only';
  if (!password || typeof password !== 'string') return 'Password required';
  if (password.length < cfg.PASSWORD_MIN_LEN) return 'Password at least 4 characters';
  return null;
}

/* Ryan Mendez + An Nguyen - Creates initial game state: maze, terminals, powerups, roles. Short: one Cat, rest Rats; map with obstacles/terminals. PDF: FR-7 (random Cat/Rats), FR-8 (map with obstacles, interactive escapes). */
function createGameState(lobbyId, playerIds) {
  const state = {
    id: lobbyId,
    players: {},
    terminals: [],
    obstacles: [],
    powerups: [],
    exitOpen: false,
    timeLeft: cfg.GAME_TIME_SEC,
    selectionTimeLeft: 15,
    status: 'selection',
    winner: null
  };
  /* An Nguyen - 15s class selection phase; Cat waits while mice pick class. */

  /* An Nguyen - Maze generation (recursive backtracker) for procedural walls; obstacles replace flat layout. */
  const CELL_SIZE = 200;
  const ATTEMPTS = 20; // For ensuring reachable terminals/powerups if placed randomly
  const ROWS = cfg.MAP_SIZE / CELL_SIZE;
  const COLS = cfg.MAP_SIZE / CELL_SIZE;

  // 1. Initialize Grid
  const grid = [];
  for (let y = 0; y < ROWS; y++) {
    const row = [];
    for (let x = 0; x < COLS; x++) {
      row.push({ x, y, visited: false, top: true, right: true, bottom: true, left: true });
    }
    grid.push(row);
  }

  // 2. DFS for Maze
  const stack = [];
  let current = grid[0][0];
  current.visited = true;

  // Choose random start for maze gen to vary structure, but we will spawn players at corners
  // Actually, standard algo starts at 0,0 is fine.

  function getUnvisitedNeighbors(cell) {
    const neighbors = [];
    const { x, y } = cell;
    if (y > 0 && !grid[y - 1][x].visited) neighbors.push(grid[y - 1][x]); // Top
    if (x < COLS - 1 && !grid[y][x + 1].visited) neighbors.push(grid[y][x + 1]); // Right
    if (y < ROWS - 1 && !grid[y + 1][x].visited) neighbors.push(grid[y + 1][x]); // Bottom
    if (x > 0 && !grid[y][x - 1].visited) neighbors.push(grid[y][x - 1]); // Left
    return neighbors;
  }

  function removeWalls(a, b) {
    const x = a.x - b.x;
    const y = a.y - b.y;
    if (x === 1) { a.left = false; b.right = false; }
    else if (x === -1) { a.right = false; b.left = false; }
    if (y === 1) { a.top = false; b.bottom = false; }
    else if (y === -1) { a.bottom = false; b.top = false; }
  }

  // Iterative implementation to avoid stack overflow
  stack.push(current);
  while (stack.length > 0) {
    current = stack[stack.length - 1]; // Peek
    const neighbors = getUnvisitedNeighbors(current);
    if (neighbors.length > 0) {
      const next = neighbors[Math.floor(Math.random() * neighbors.length)];
      removeWalls(current, next);
      next.visited = true;
      stack.push(next);
    } else {
      stack.pop();
    }
  }

  // 3. Convert Maze Walls to Obstacles
  // Coordinate system: center is 0,0. Top-Left is (-1000, -1000).
  const HALF_MAP = cfg.MAP_SIZE / 2;
  const THICKNESS = 10;

  // Add border walls
  state.obstacles.push({ id: 'border_top', x: 0, y: -HALF_MAP, w: cfg.MAP_SIZE, h: THICKNESS });
  state.obstacles.push({ id: 'border_bottom', x: 0, y: HALF_MAP, w: cfg.MAP_SIZE, h: THICKNESS });
  state.obstacles.push({ id: 'border_left', x: -HALF_MAP, y: 0, w: THICKNESS, h: cfg.MAP_SIZE });
  state.obstacles.push({ id: 'border_right', x: HALF_MAP, y: 0, w: THICKNESS, h: cfg.MAP_SIZE });

  // Add internal walls
  // To avoid duplicates, we only draw Bottom and Right walls for each cell (if they exist)
  // The 'Top' and 'Left' of a cell are handled by the 'Bottom' and 'Right' of its neighbors.
  let obsId = 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cell = grid[y][x];
      const cx = (x * CELL_SIZE) - HALF_MAP + (CELL_SIZE / 2); // Center X of cell
      const cy = (y * CELL_SIZE) - HALF_MAP + (CELL_SIZE / 2); // Center Y of cell

      if (cell.bottom) {
        state.obstacles.push({
          id: `wall_h_${obsId++}`,
          x: cx,
          y: cy + CELL_SIZE / 2,
          w: CELL_SIZE + THICKNESS, // Overlap slightly to plug corners
          h: THICKNESS
        });
      }
      if (cell.right) {
        state.obstacles.push({
          id: `wall_v_${obsId++}`,
          x: cx + CELL_SIZE / 2,
          y: cy,
          w: THICKNESS,
          h: CELL_SIZE + THICKNESS // Overlap slightly
        });
      }
    }
  }

  /* Ryan Mendez - Random Cat. An Nguyen - Player state includes class, skillCooldown, invisibleUntil, wallPhases, rageUntil, jokerUntil, etc. for all classes. */
  const catId = playerIds[Math.floor(Math.random() * playerIds.length)];

  // Cat at Top-Left (Cell 0,0), Mice at Bottom-Right (Cell MAX, MAX)
  // Add slight offset so they aren't inside the wall
  const startX = -HALF_MAP + CELL_SIZE / 2;
  const startY = -HALF_MAP + CELL_SIZE / 2;
  const endX = HALF_MAP - CELL_SIZE / 2;
  const endY = HALF_MAP - CELL_SIZE / 2;

  playerIds.forEach(id => {
    const isCat = (id === catId);
    state.players[id] = {
      id: id,
      role: isCat ? 'cat' : 'mouse',
      x: isCat ? startX : endX,
      y: isCat ? startY : endY,
      hp: 100,
      speed: cfg.BASE_SPEED,
      isSprinting: false,
      sprintTime: cfg.SPRINT_DURATION_SEC,
      sprintCooldown: 0,
      maxSprintTime: cfg.SPRINT_DURATION_SEC,
      attackCooldown: 0,
      dead: false,
      escaped: false,
      class: 0,
      skillCooldown: 0,
      isJumping: false,
      wallPhases: 0,
      invisibleUntil: 0,
      frozenUntil: 0,
      jokerUntil: 0,
      speedBoostUntil: 0,
      rageUntil: 0,
      lastInputTime: Date.now()
    };
  });

  /* Terminals & Powerups spread randomly, but not inside walls (center of cells) */
  const freeCells = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      // Don't spawn in starting cells (0,0) or (ROWS-1, COLS-1) to imply "bases"
      if ((x === 0 && y === 0) || (x === COLS - 1 && y === ROWS - 1)) continue;
      freeCells.push({ x, y });
    }
  }

  // Shuffle freeCells
  for (let i = freeCells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [freeCells[i], freeCells[j]] = [freeCells[j], freeCells[i]];
  }

  let cellIdx = 0;

  for (let i = 0; i < cfg.TERMINAL_COUNT; i++) {
    if (cellIdx >= freeCells.length) break;
    const c = freeCells[cellIdx++];
    const tx = (c.x * CELL_SIZE) - HALF_MAP + (CELL_SIZE / 2);
    const ty = (c.y * CELL_SIZE) - HALF_MAP + (CELL_SIZE / 2);
    // Generate 15 questions for this terminal to support Lazy class
    const questions = generateMathQuestions();
    state.terminals.push({ id: i, x: tx, y: ty, progress: 0, completed: false, questions });
  }

  // Initialize player terminal progress
  playerIds.forEach(id => {
    state.players[id].terminalProgress = {}; // Map terminalId -> count (0-5)
  });

  /* An Nguyen - Power-up/boost spawn on map: heal, speed, rage; placed in free cells. */
  const types = ['heal', 'speed', 'speed', 'rage'];
  for (let i = 0; i < cfg.POWERUP_COUNT; i++) {
    if (cellIdx >= freeCells.length) break;
    const c = freeCells[cellIdx++];
    const px = (c.x * CELL_SIZE) - HALF_MAP + (CELL_SIZE / 2);
    const py = (c.y * CELL_SIZE) - HALF_MAP + (CELL_SIZE / 2);
    const type = types[i % types.length];
    state.powerups.push({ id: i, x: px, y: py, type, respawnAt: 0 });
  }

  return state;
}

/* An Nguyen - Emits game events to lobby (terminal complete, exit open, catch, etc.). Short: inform all players. PDF: FR-13/14 (players informed on catch). */
function emitGameEvent(lobbyId, event) {
  if (lobbyId && io) io.to(lobbyId).emit('gameEvent', event);
}

/* An Nguyen - Collision: resolve position out of walls; supports jump and Into Vent. Short: map obstacles. PDF: FR-8 (map contains obstacles). */
function pushOutOfObstacle(px, py, oldX, oldY, obstacles, playerState, dx, dy) {
  let x = px, y = py;

  if (playerState && playerState.isJumping) return { x, y };

  function checkCollision(cx, cy) {
    const pr = 24; // Increased Player radius heavily to stop diagonal corner glides
    for (const o of obstacles) {
      const hw = o.w / 2, hh = o.h / 2;
      const left = o.x - hw - pr, right = o.x + hw + pr, top = o.y - hh - pr, bottom = o.y + hh + pr;
      if (cx > left && cx < right && cy > top && cy < bottom) return true;
    }
    return false;
  }

  if (checkCollision(x, y)) {
    // Into Vent ability: pass through wall by teleporting forward 120 units
    if (playerState && playerState.wallPhases > 0 && (dx !== 0 || dy !== 0)) {
      playerState.wallPhases--;
      return { x: px + dx * 120, y: py + dy * 120, ventJump: true };
    }

    // Collision detected. Try sliding.
    // 1. Revert Y, keep X
    if (!checkCollision(x, oldY)) {
      return { x: x, y: oldY };
    }
    // 2. Revert X, keep Y
    if (!checkCollision(oldX, y)) {
      return { x: oldX, y: y };
    }
    // 3. Both fail, revert both (full stop)
    return { x: oldX, y: oldY };
  }
  return { x, y };
}

/* An Nguyen - Generates math questions for terminal puzzle (+, -, *, /). Short: puzzle content. PDF: FR-15 (puzzles to unlock exit). */
function generateMathQuestions() {
  const questions = [];
  const ops = ['+', '-', '*', '/'];
  for (let i = 0; i < 15; i++) {
    const op = ops[Math.floor(Math.random() * ops.length)];
    let a, b, ans;
    if (op === '+' || op === '-') {
      // 1-2 digits (1-99)
      a = Math.floor(Math.random() * 99) + 1;
      b = Math.floor(Math.random() * 99) + 1;
      if (op === '-') {
        if (a < b) [a, b] = [b, a]; // Ensure non-negative
        ans = a - b;
      } else {
        ans = a + b;
      }
    } else {
      // 1 digit (1-9)
      a = Math.floor(Math.random() * 9) + 1;
      b = Math.floor(Math.random() * 9) + 1;
      if (op === '/') {
        ans = a;
        a = ans * b; // Ensure clean division
      } else {
        ans = a * b;
      }
    }
    questions.push({ q: `${a} ${op} ${b}`, a: ans });
  }
  return questions;
}

/* Ryan Mendez - Socket connection: login, register, lobby, game handlers. Short: auth and lobby. PDF: FR-1 (login/register), FR-2 (registration in DB). */
io.on('connection', (socket) => {
  // ... (Login/Register/Lobby logic remains same)
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

  /* Ryan Mendez - Returns list of lobbies for join. Short: view available rooms. PDF: FR-3 (lobby displays rooms). */
  socket.on('getLobbies', () => {
    const list = [];
    for (const [id, lobby] of Object.entries(lobbies)) {
      list.push({ id, players: lobby.players.map(p => players[p].username) });
    }
    socket.emit('lobbyList', list);
  });

  /* Ryan Mendez - Creates new lobby and joins socket. Short: form new room. PDF: FR-4 (user can create room). */
  socket.on('createLobby', () => {
    const id = 'lobby_' + Math.random().toString(36).slice(2, 7);
    lobbies[id] = { players: [socket.id], timer: cfg.LOBBY_COUNTDOWN_SEC, started: false };
    players[socket.id].lobby = id;
    socket.join(id);
    const playerList = [{ id: socket.id, username: players[socket.id].username }];
    socket.emit('joinedLobby', { lobbyId: id, players: playerList });
    io.emit('lobbyUpdate');
  });

  /* Ryan Mendez - Joins existing lobby if slot available. Short: join room. PDF: FR-5 (join available room). */
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

  /* Ryan Mendez - Leaves current lobby. Short: leave room. PDF: FR-3 (participate in sessions). */
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

  /* An Nguyen - Mouse selects class (skill) during selection phase. Short: class choice. PDF: FR-7 (roles), extended. */
  socket.on('selectClass', (classId) => {
    const p = players[socket.id];
    if (!p || !p.lobby || !GAMES[p.lobby]) return;
    const game = GAMES[p.lobby];
    const playerState = game.players[socket.id];

    if (playerState && playerState.role === 'mouse' && game.status === 'selection') {
      playerState.class = parseInt(classId);

      // Check if all mice chose a class, then we can start early
      const mice = Object.values(game.players).filter(pl => pl.role === 'mouse');
      const allSelected = mice.every(m => m.class > 0);
      if (allSelected) {
        game.status = 'playing';
        game.selectionTimeLeft = 0;
      }
    }
  });

  /* An Nguyen - Mouse interacts with closest terminal; sends next question. Short: puzzle interaction. PDF: FR-15 (touch objects to unlock exit). */
  socket.on('interactTerminal', () => {
    const p = players[socket.id];
    if (!p || !p.lobby || !GAMES[p.lobby]) return;
    const game = GAMES[p.lobby];
    const playerState = game.players[socket.id];
    if (!playerState || playerState.dead || playerState.role !== 'mouse') return;

    // Find closest terminal
    let closestT = null;
    let minDst = cfg.REPAIR_RADIUS;
    game.terminals.forEach(t => {
      if (!t.completed) {
        const d = Math.hypot(playerState.x - t.x, playerState.y - t.y);
        if (d < minDst) { minDst = d; closestT = t; }
      }
    });

    if (closestT) {
      // Check progress
      const progress = playerState.terminalProgress[closestT.id] || 0;
      const requiredQs = playerState.class === 7 ? 3 : (playerState.class === 10 ? 12 : 5);
      if (progress < requiredQs) {
        const q = closestT.questions[progress];
        socket.emit('terminalQuestion', { terminalId: closestT.id, questionIndex: progress + 1, total: requiredQs, q: q.q });
      }
    }
  });

  /* An Nguyen - Validates terminal answer and advances or completes puzzle. Short: puzzle completion. PDF: FR-15 (puzzle requirements). */
  socket.on('submitAnswer', ({ terminalId, answer }) => {
    const p = players[socket.id];
    if (!p || !p.lobby || !GAMES[p.lobby]) return;
    const game = GAMES[p.lobby];
    const playerState = game.players[socket.id];
    const term = game.terminals.find(t => t.id === terminalId);

    if (playerState && term && !term.completed) {
      const progress = playerState.terminalProgress[terminalId] || 0;
      const requiredQs = playerState.class === 7 ? 3 : (playerState.class === 10 ? 12 : 5);

      if (progress < requiredQs) {
        const q = term.questions[progress];
        if (parseInt(answer) === q.a) {
          playerState.terminalProgress[terminalId] = progress + 1;

          if (playerState.terminalProgress[terminalId] >= requiredQs) {
            term.completed = true;
            term.progress = 100; // Visual
            emitGameEvent(p.lobby, { type: 'terminalComplete', terminalId: term.id, count: game.terminals.filter(x => x.completed).length });
            checkWinCondition(game, p.lobby);
            socket.emit('terminalComplete', { terminalId });
          } else {
            // Next Question
            const nextQ = term.questions[playerState.terminalProgress[terminalId]];
            socket.emit('terminalQuestion', { terminalId: term.id, questionIndex: playerState.terminalProgress[terminalId] + 1, total: requiredQs, q: nextQ.q });
          }
        } else {
          socket.emit('terminalError', 'Wrong answer!');
        }
      }
    }
  });

  /* Ryan Mendez - Processes movement, sprint, action, skills; collision; attack; powerups. Short: server validates actions. PDF: FR-10 (input to server), FR-11 (server authenticates, changes state). */
  socket.on('playerInput', (input) => {
    const p = players[socket.id];
    if (!p || !p.lobby || !GAMES[p.lobby]) return;

    const game = GAMES[p.lobby];
    const playerState = game.players[socket.id];

    if (!playerState || playerState.dead || playerState.escaped) return;

    if (game.status === 'selection') return; // Ignore movement during selection

    const inputNow = Date.now();
    if (playerState.frozenUntil > inputNow) return; // Frozen by Diplomouse

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
    if (input.up) { dx -= 1; dy -= 1; }
    if (input.down) { dx += 1; dy += 1; }
    if (input.left) { dx -= 1; dy += 1; }
    if (input.right) { dx += 1; dy -= 1; }

    if (dx !== 0 || dy !== 0) {
      const length = Math.hypot(dx, dy);
      dx /= length;
      dy /= length;
    }
    if (Date.now() < (playerState.speedBoostUntil || 0)) speed *= cfg.POWERUP_SPEED_MULT;

    /* An Nguyen - All 10 mouse class active skills: Boost Speed, High Jump, Invisible, Money Token, Support, Into Vent, Puzzle Prof, Pull Player, Diplomouse; Lazy has no skill. */
    if (input.activeSkill && playerState.skillCooldown <= 0 && playerState.role === 'mouse') {
      const cls = playerState.class;
      const nowTime = Date.now();
      if (cls === 1) { // Boost Speed
        playerState.speedBoostUntil = Math.max(playerState.speedBoostUntil || 0, nowTime) + 5000;
        playerState.skillCooldown = 15;
      } else if (cls === 2) { // High Jump
        playerState.isJumping = true;
        setTimeout(() => { if (game.players[socket.id]) game.players[socket.id].isJumping = false; }, 1000);
        playerState.skillCooldown = 10;
      } else if (cls === 3) { // Invisible
        playerState.invisibleUntil = nowTime + 10000;
        playerState.skillCooldown = 25;
      } else if (cls === 4) { // Money Token
        for (let i = 0; i < 3; i++) {
          game.powerups.push({ id: Math.random(), x: playerState.x + (Math.random() - 0.5) * 150, y: playerState.y + (Math.random() - 0.5) * 150, type: 'money', respawnAt: 0 });
        }
        playerState.skillCooldown = 30;
      } else if (cls === 5) { // Support Other
        const r = Math.random();
        if (r < 0.33) playerState.speedBoostUntil = nowTime + 5000;
        else if (r < 0.66) playerState.invisibleUntil = nowTime + 5000;
        else game.powerups.push({ id: Math.random(), x: playerState.x, y: playerState.y, type: 'money', respawnAt: 0 });
        playerState.skillCooldown = 20;
      } else if (cls === 6) { // Into Vent
        playerState.wallPhases = 2;
        playerState.skillCooldown = 35;
      } else if (cls === 8) { // Pull Player
        let closestTarget = null;
        let closestDist = Infinity;
        for (const pid in game.players) {
          if (pid !== socket.id && !game.players[pid].dead) {
            const dist = Math.hypot(playerState.x - game.players[pid].x, playerState.y - game.players[pid].y);
            if (dist < closestDist) { closestDist = dist; closestTarget = game.players[pid]; }
          }
        }
        if (closestTarget) {
          closestTarget.x = playerState.x;
          closestTarget.y = playerState.y;
        }
        playerState.skillCooldown = 40;
      } else if (cls === 9) { // Diplomouse
        let cat = null;
        for (const pid in game.players) { if (game.players[pid].role === 'cat') cat = game.players[pid]; }
        if (cat) {
          playerState.frozenUntil = nowTime + 3000;
          cat.frozenUntil = nowTime + 3000;
          emitGameEvent(p.lobby, { type: 'diplomouse', msg: 'Diplomouse used globally! Rolling fate...' });
          setTimeout(() => {
            if (!game.players[socket.id]) return;
            const r = Math.random();
            if (r < 0.33) {
              if (game.players[cat.id]) game.players[cat.id].speedBoostUntil = Date.now() + 5000;
              emitGameEvent(p.lobby, { type: 'diplomouse', msg: 'Fate: Cat gained speed!' });
            } else if (r < 0.66) {
              if (game.players[socket.id]) game.players[socket.id].speedBoostUntil = Date.now() + 5000;
              emitGameEvent(p.lobby, { type: 'diplomouse', msg: 'Fate: Mouse gained speed!' });
            } else {
              if (game.players[cat.id]) game.players[cat.id].jokerUntil = Date.now() + 10000;
              emitGameEvent(p.lobby, { type: 'diplomouse', msg: 'JOKER! Cat has instakill!' });
            }
          }, 3000);
          playerState.skillCooldown = 60;
        }
      }
    }

    const oldX = playerState.x;
    const oldY = playerState.y;

    const targetX = playerState.x + dx * speed * inputDelta;
    const targetY = playerState.y + dy * speed * inputDelta;

    // Divide movement into 5 small steps to prevent tunneling
    const steps = 5;
    const stepX = (targetX - oldX) / steps;
    const stepY = (targetY - oldY) / steps;

    let currX = oldX;
    let currY = oldY;
    const limit = cfg.MAP_SIZE / 2;

    for (let i = 0; i < steps; i++) {
      currX += stepX;
      currY += stepY;

      if (currX < -limit) currX = -limit;
      if (currX > limit) currX = limit;
      if (currY < -limit) currY = -limit;
      if (currY > limit) currY = limit;

      const pushed = pushOutOfObstacle(currX, currY, currX - stepX, currY - stepY, game.obstacles || [], playerState, dx, dy);
      currX = pushed.x;
      currY = pushed.y;

      if (pushed.ventJump) {
        break; // Teleported, stop stepping for this tick
      }
    }

    playerState.x = currX;
    playerState.y = currY;

    /* An Nguyen - Power-up/boost pickup: heal (mouse), speed, rage (cat); respawn timer. */
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

    if (input.action) {
      if (playerState.role === 'cat') {
        if (playerState.attackCooldown <= 0) {
          // ... Cat attack logic same
          let closestTarget = null;
          let closestDist = cfg.ATTACK_RANGE;
          for (const pid in game.players) {
            const target = game.players[pid];
            if (target.role === 'mouse' && !target.dead && !target.escaped) {
              const dist = Math.hypot(playerState.x - target.x, playerState.y - target.y);
              if (dist < closestDist) { closestDist = dist; closestTarget = target; }
            }
          }
          if (closestTarget) {
            /* An Nguyen - Cat attack with power-up integration: rage boost, Joker (Diplomouse) instakill. */
            let damage = (Date.now() < (playerState.rageUntil || 0)) ? cfg.ATTACK_DAMAGE * cfg.POWERUP_RAGE_DAMAGE_MULT : cfg.ATTACK_DAMAGE;
            if (Date.now() < (playerState.jokerUntil || 0)) damage = 1000; // Insta kill

            closestTarget.hp -= damage;
            emitGameEvent(p.lobby, { type: 'catHit', targetId: closestTarget.id, damage });
            if (closestTarget.hp <= 0) {
              closestTarget.hp = 0; closestTarget.dead = true;
              emitGameEvent(p.lobby, { type: 'mouseDown', playerId: closestTarget.id, username: players[closestTarget.id]?.username });
              checkGameEnd(game, p.lobby);
            } else {
              closestTarget.speed += cfg.BASE_SPEED;
              setTimeout(() => { if (!closestTarget.dead && !closestTarget.escaped) closestTarget.speed -= cfg.BASE_SPEED; }, cfg.MOUSE_SPEED_BOOST_DURATION_MS);
            }
            playerState.speed -= 100;
            setTimeout(() => { playerState.speed += 100; }, cfg.CAT_SLOW_DURATION_MS);
          }
          playerState.attackCooldown = cfg.ATTACK_COOLDOWN_SEC;
        }
      }
      // Mouse action logic removed (moved to interactTerminal event)
      // Actually, if we want to keep "hold space to repair" heavily deprecated. 
      // The user wants "Math problems". So basic Space is now Interact.
    }
  });

  /* Ryan Mendez - On disconnect: remove from lobby/game; mark dead if in game. Short: session termination. PDF: FR-19 (log out, session terminated). */
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

/* Ryan Mendez - Opens exit when required terminals completed. Short: puzzle unlocks exit. PDF: FR-15 (Rats complete puzzles to unlock exit). */
function checkWinCondition(game, lobbyId) {
  const completed = game.terminals.filter(t => t.completed).length;
  if (completed >= cfg.TERMINALS_TO_COMPLETE && !game.exitOpen) {
    game.exitOpen = true;
    emitGameEvent(lobbyId, { type: 'exitOpen' });
  }
}

/* Ryan Mendez - Determines winner: Mice if any escaped, else Cat. Short: game over logic. PDF: FR-16 (Rats win if escape), FR-17 (Cat wins when all caught). */
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

/* An Nguyen - Game loop: countdown, start game, state broadcast, exit check, timers. Short: tick at several Hz. PDF: FR-6 (countdown then launch), FR-12 (disseminate state periodically). */
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

    if (game.status === 'selection') {
      game.selectionTimeLeft -= dt;
      if (game.selectionTimeLeft <= 0) {
        game.status = 'playing';
      }
      io.to(gameId).emit('gameState', game);
      continue; // Skip the rest of game loop during selection
    }

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

      if (p.skillCooldown > 0) p.skillCooldown -= dt;
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

/* An Nguyen - Server port from env/config; try next port if in use. Short: server listen. PDF: Section 3 (hosting). */
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
