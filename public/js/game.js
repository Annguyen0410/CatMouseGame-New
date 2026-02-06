/**
 * game.js - Phaser game scene: render map, players, terminals; capture input; sync with server state. Assignment 4 PDF: FR-9 client shows map/characters; FR-10 input to server; Section 3 Phaser for rendering.
 */
let gameInstance;

/* Ryan Mendez - Boots Phaser with initial state. An Nguyen: socket.off to avoid duplicate listeners; currentScene null on destroy. FR-6: game session begins. */
function startGame(initialState) {
    socket.off('gameState');
    socket.off('gameEvent');
    if (gameInstance) gameInstance.destroy(true);
    currentScene = null;

    const config = {
        type: Phaser.AUTO,
        parent: 'game-container',
        width: window.innerWidth,
        height: window.innerHeight,
        backgroundColor: '#111',
        scene: { preload, create, update }
    };
    gameInstance = new Phaser.Game(config);

    window.addEventListener('resize', () => {
        gameInstance.scale.resize(window.innerWidth, window.innerHeight);
    });
}

const MAP_SIZE = 2000;
let cursors;
let myId = socket.id;
let dynamicGraphics;
let staticGraphics;
let visualPlayers = {};
let lastState = null;
let currentScene = null;
let floatingTexts = [];
let eventFeedList = [];
const MAX_FEED_ITEMS = 5;

function preload() {}

function create() {
    currentScene = this;
    floatingTexts = [];
    eventFeedList = [];

    staticGraphics = this.add.graphics();
    drawGrid(staticGraphics);
    dynamicGraphics = this.add.graphics();

    this.hpLabels = {};

    cursors = this.input.keyboard.createCursorKeys();
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);

    /* Ryan Mendez - Receive server state and redraw. FR-12 postcondition: current state to all clients. */
    socket.on('gameState', (state) => {
        lastState = state;
        updateUI(state);
        drawGame(currentScene, state);
    });

    /* An Nguyen - Handle game events: damage float + screen shake, terminal/exit/escape/catch/power-up feed. FR-13/14: players informed. */
    socket.on('gameEvent', (e) => {
        if (e.type === 'catHit' && e.targetId === socket.id && currentScene) {
            floatingTexts.push({ text: '-' + Math.round(e.damage), x: (lastState && lastState.players[socket.id]) ? lastState.players[socket.id].x : 0, y: (lastState && lastState.players[socket.id]) ? lastState.players[socket.id].y : 0, t: 0 });
            currentScene.cameras.main.shake(200, 0.008);
        }
        if (e.type === 'terminalComplete') {
            addEventFeed('Terminal repaired! (' + (e.count || 0) + '/5)');
        }
        if (e.type === 'exitOpen') {
            addEventFeed('Exit opened! Run to center!');
        }
        if (e.type === 'mouseEscaped') {
            addEventFeed((e.username || 'Someone') + ' escaped!');
        }
        if (e.type === 'mouseDown') {
            addEventFeed((e.username || 'A mouse') + ' was caught!');
        }
        if (e.type === 'powerup') {
            if (e.playerId === socket.id) {
                const msg = e.kind === 'heal' ? 'Healed!' : e.kind === 'speed' ? 'Speed boost!' : 'Rage!';
                floatingTexts.push({ text: msg, x: (lastState && lastState.players[socket.id]) ? lastState.players[socket.id].x : 0, y: (lastState && lastState.players[socket.id]) ? lastState.players[socket.id].y : 0, t: 0 });
            }
            addEventFeed(e.kind === 'heal' ? 'Heal picked up' : e.kind === 'speed' ? 'Speed picked up' : 'Rage picked up');
        }
    });
}

function addEventFeed(text) {
    eventFeedList.unshift({ text, t: 0 });
    if (eventFeedList.length > MAX_FEED_ITEMS) eventFeedList.pop();
    const el = document.getElementById('event-feed');
    if (el) {
        el.innerHTML = eventFeedList.slice(0, MAX_FEED_ITEMS).map(e => '<div class="feed-item">' + e.text + '</div>').join('');
    }
}

/* Ryan Mendez - Each frame: send movement and action to server. FR-10: keyboard used to move and interact; postcondition action relayed to server. */
function update() {
    const input = {
        up: cursors.up.isDown || this.input.keyboard.keys[87].isDown,
        down: cursors.down.isDown || this.input.keyboard.keys[83].isDown,
        left: cursors.left.isDown || this.input.keyboard.keys[65].isDown,
        right: cursors.right.isDown || this.input.keyboard.keys[68].isDown,
        sprint: this.input.keyboard.keys[16].isDown,
        action: this.input.keyboard.keys[32].isDown
    };
    socket.emit('playerInput', input);
}

function toIso(x, y) {
    return { x: x - y, y: (x + y) / 2 };
}

function drawGrid(g) {
    g.clear();
    const gridSize = 2000;
    const step = 100;
    g.lineStyle(1, 0x444444, 0.3); 

    for (let x = -gridSize/2; x <= gridSize/2; x += step) {
        const s = toIso(x, -gridSize/2);
        const e = toIso(x, gridSize/2);
        g.moveTo(s.x, s.y);
        g.lineTo(e.x, e.y);
    }
    for (let y = -gridSize/2; y <= gridSize/2; y += step) {
        const s = toIso(-gridSize/2, y);
        const e = toIso(gridSize/2, y);
        g.moveTo(s.x, s.y);
        g.lineTo(e.x, e.y);
    }
    g.strokePath();
}

function lerp(start, end, amt) {
    return (1 - amt) * start + amt * end;
}

/* Ryan Mendez + An Nguyen - Renders game world: camera follow, obstacles, power-ups, terminals, players, exit, floating text. An Nguyen: scene/camera guard. FR-9: client shows map, characters, interactivity. */
function drawGame(scene, state) {
    if (!scene || !scene.cameras || !scene.cameras.main) return;
    const myPlayer = state.players[socket.id];
    if (!myPlayer) return;

    dynamicGraphics.clear();
    const isoCam = toIso(myPlayer.x, myPlayer.y);
    scene.cameras.main.scrollX = lerp(scene.cameras.main.scrollX, isoCam.x - scene.cameras.main.width / 2, 0.1);
    scene.cameras.main.scrollY = lerp(scene.cameras.main.scrollY, isoCam.y - scene.cameras.main.height / 2, 0.1);

    // Obstacles
    (state.obstacles || []).forEach(o => {
        const iso = toIso(o.x, o.y);
        const w = o.w * 0.7;
        const h = o.h * 0.5;
        dynamicGraphics.fillStyle(0x333333, 0.9);
        dynamicGraphics.fillRect(iso.x - w/2, iso.y - h/2, w, h);
        dynamicGraphics.lineStyle(2, 0x555555, 1);
        dynamicGraphics.strokeRect(iso.x - w/2, iso.y - h/2, w, h);
    });

    // Power-ups (only when active)
    (state.powerups || []).forEach(pu => {
        if (pu.respawnAt > 0) return;
        const iso = toIso(pu.x, pu.y);
        const color = pu.type === 'heal' ? 0x00ff00 : pu.type === 'speed' ? 0x00aaff : 0xff6600;
        dynamicGraphics.fillStyle(color, 0.9);
        dynamicGraphics.fillCircle(iso.x, iso.y, 10);
        dynamicGraphics.lineStyle(2, 0xffffff, 0.8);
        dynamicGraphics.strokeCircle(iso.x, iso.y, 10);
    });

    // Terminals
    state.terminals.forEach(t => {
        const iso = toIso(t.x, t.y);
        dynamicGraphics.fillStyle(t.completed ? 0x00ff00 : 0xffff00, 1);
        dynamicGraphics.fillCircle(iso.x, iso.y, 15);
        
        if (!t.completed && t.progress > 0) {
            dynamicGraphics.fillStyle(0x00ff00, 1);
            dynamicGraphics.fillRect(iso.x - 20, iso.y - 30, 40 * (t.progress/100), 5);
        }
    });

    // Cleanup Labels for disconnected/dead players
    for (const id in scene.hpLabels) {
        if (!state.players[id] || state.players[id].dead) {
            scene.hpLabels[id].setVisible(false);
        }
    }

    // Draw Players
    for (const id in state.players) {
        const serverP = state.players[id];
        if (serverP.dead) continue;

        // Init visual position if new
        if (!visualPlayers[id]) visualPlayers[id] = { x: serverP.x, y: serverP.y };

        // Interpolate position
        visualPlayers[id].x = lerp(visualPlayers[id].x, serverP.x, 0.5);
        visualPlayers[id].y = lerp(visualPlayers[id].y, serverP.y, 0.5);

        const iso = toIso(visualPlayers[id].x, visualPlayers[id].y);
        
        // Draw Sprite
        dynamicGraphics.fillStyle(serverP.role === 'cat' ? 0xff0000 : 0x00aaff, 1);
        dynamicGraphics.fillCircle(iso.x, iso.y - 20, 12);
        
        // Draw Shadow
        dynamicGraphics.fillStyle(0x000000, 0.5);
        dynamicGraphics.fillEllipse(iso.x, iso.y, 12, 6);

        // --- HP TEXT LOGIC ---
        // Only show if Mouse AND HP < 100
        if (serverP.role === 'mouse' && serverP.hp < 100) {
            if (!scene.hpLabels[id]) {
                // Create label if it doesn't exist
                scene.hpLabels[id] = scene.add.text(0, 0, '', {
                    fontSize: '14px',
                    fontFamily: 'monospace',
                    fill: '#ffffff',
                    stroke: '#000000',
                    strokeThickness: 3
                }).setOrigin(0.5);
            }
            // Update Label
            const label = scene.hpLabels[id];
            label.setVisible(true);
            label.setText(`HP: ${Math.floor(serverP.hp)}`);
            label.setPosition(iso.x, iso.y - 50); // 50px above ground (30px above head)
            label.setDepth(100); // Ensure it's on top
        } else {
            // Hide label if full HP or Cat
            if (scene.hpLabels[id]) scene.hpLabels[id].setVisible(false);
        }
    }
    
    // Exit (pulsing when open)
    if (state.exitOpen) {
        const isoExit = toIso(0, 0);
        const pulse = 0.25 + 0.2 * Math.sin(Date.now() / 300);
        dynamicGraphics.fillStyle(0x00ff00, pulse);
        dynamicGraphics.fillCircle(isoExit.x, isoExit.y, 150);
        dynamicGraphics.lineStyle(3, 0x00ff88, 0.6);
        dynamicGraphics.strokeCircle(isoExit.x, isoExit.y, 150);
    }

    // Floating damage/pickup texts (rise from player)
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft = floatingTexts[i];
        ft.t++;
        if (ft.t > 90) {
            if (ft.obj) ft.obj.destroy();
            floatingTexts.splice(i, 1);
            continue;
        }
        const fx = ft.x !== undefined ? ft.x : myPlayer.x;
        const fy = ft.y !== undefined ? ft.y : myPlayer.y;
        const iso = toIso(fx, fy);
        const screenY = iso.y - 40 - ft.t * 0.5;
        const alpha = 1 - ft.t / 90;
        if (!ft.obj) {
            ft.obj = scene.add.text(iso.x, screenY, ft.text, {
                fontSize: '20px',
                fontFamily: 'Luckiest Guy',
                color: ft.text.indexOf('-') === 0 ? '#ff5555' : '#88ff88',
                stroke: '#000',
                strokeThickness: 2
            }).setOrigin(0.5);
        }
        ft.obj.setPosition(iso.x, screenY);
        ft.obj.setAlpha(alpha);
        ft.obj.setVisible(true);
    }

    /* An Nguyen - Top-down minimap: players, terminals, obstacles, exit. */
    drawMinimap(state);
}

/* An Nguyen - Draws minimap canvas with players (cat/mice), terminals, obstacles, exit zone. */
function drawMinimap(state) {
    const canvas = document.getElementById('minimap');
    if (!canvas || !state.players[socket.id]) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const half = MAP_SIZE / 2;
    const scale = (w - 10) / MAP_SIZE;
    const cx = w / 2, cy = h / 2;

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.strokeRect(1, 1, w - 2, h - 2);

    const toMinimap = (gx, gy) => ({
        x: cx + gx * scale,
        y: cy - gy * scale
    });

    (state.obstacles || []).forEach(o => {
        const p = toMinimap(o.x, o.y);
        ctx.fillStyle = 'rgba(80,80,80,0.8)';
        ctx.fillRect(p.x - (o.w * scale) / 2, p.y - (o.h * scale) / 2, o.w * scale, o.h * scale);
    });

    state.terminals.forEach(t => {
        const p = toMinimap(t.x, t.y);
        ctx.fillStyle = t.completed ? '#0a0' : '#aa0';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
    });

    if (state.exitOpen) {
        const p = toMinimap(0, 0);
        ctx.fillStyle = 'rgba(0,255,100,0.5)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
        ctx.fill();
    }

    for (const id in state.players) {
        const p = state.players[id];
        if (p.dead && !p.escaped) continue;
        const pos = toMinimap(p.x, p.y);
        ctx.fillStyle = p.role === 'cat' ? '#f44' : p.escaped ? '#888' : '#4af';
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, id === socket.id ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
        if (id === socket.id) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }
}

/* Ryan Mendez + An Nguyen - Updates HUD: role, HP, timer, terminals, sprint; An Nguyen: buff indicators (speed/rage). FR-9: observe game world and character. */
function updateUI(state) {
    const p = state.players[socket.id];
    if(!p) return;
    document.getElementById('role-display').innerText = `Role: ${p.role.toUpperCase()}`;
    document.getElementById('hp-bar').innerText = `HP: ${Math.floor(p.hp)}`;
    document.getElementById('timer-display').innerText = `Time: ${Math.floor(state.timeLeft)}`;
    document.getElementById('terminals-left').innerText = `Terminals: ${state.terminals.filter(t=>t.completed).length}/5`;

    const sprintEl = document.getElementById('sprint-bar');
    if (p.sprintCooldown > 0) {
        sprintEl.innerText = `Cooldown: ${Math.ceil(p.sprintCooldown)}`;
        sprintEl.style.color = 'red';
    } else {
        sprintEl.innerText = `Sprint Ready (${Math.ceil(p.sprintTime)}s)`;
        sprintEl.style.color = 'lime';
    }

    const now = Date.now();
    const buffEl = document.getElementById('buff-indicators');
    if (buffEl) {
        const parts = [];
        if (p.speedBoostUntil && now < p.speedBoostUntil) {
            parts.push('<span class="buff speed">Speed ' + Math.ceil((p.speedBoostUntil - now) / 1000) + 's</span>');
        }
        if (p.rageUntil && now < p.rageUntil) {
            parts.push('<span class="buff rage">Rage ' + Math.ceil((p.rageUntil - now) / 1000) + 's</span>');
        }
        buffEl.innerHTML = parts.join(' ');
    }
}
