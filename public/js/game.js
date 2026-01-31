let gameInstance;

function startGame(initialState) {
    if (gameInstance) gameInstance.destroy(true);

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

let cursors;
let myId = socket.id;
let dynamicGraphics;
let staticGraphics;
let visualPlayers = {};

function preload() {}

function create() {
    // 1. Setup Graphics
    staticGraphics = this.add.graphics();
    drawGrid(staticGraphics);
    dynamicGraphics = this.add.graphics();
    
    // 2. Setup Text Label Storage
    this.hpLabels = {}; 

    // 3. Setup Controls
    cursors = this.input.keyboard.createCursorKeys();
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);

    // 4. Listen for Server Updates
    socket.on('gameState', (state) => {
        updateUI(state);
        drawGame(this, state);
    });
}

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

function drawGame(scene, state) {
    dynamicGraphics.clear();
    const myPlayer = state.players[socket.id];
    if (!myPlayer) return;

    // Smooth Camera
    const isoCam = toIso(myPlayer.x, myPlayer.y);
    scene.cameras.main.scrollX = lerp(scene.cameras.main.scrollX, isoCam.x - scene.cameras.main.width / 2, 0.1);
    scene.cameras.main.scrollY = lerp(scene.cameras.main.scrollY, isoCam.y - scene.cameras.main.height / 2, 0.1);

    // Draw Terminals
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
    
    // Draw Exit
    if (state.exitOpen) {
        const isoExit = toIso(0, 0);
        dynamicGraphics.fillStyle(0x00ff00, 0.3);
        dynamicGraphics.fillCircle(isoExit.x, isoExit.y, 150);
    }
}

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
}
