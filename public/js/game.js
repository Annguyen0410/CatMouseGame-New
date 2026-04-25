/**
 * game.js - Three.js game scene: render 3D map, players, terminals; capture input; sync with server state.
 * An Nguyen - Migrated entire client from 2D (Phaser) to 3D (Three.js): scene, camera, textures, floor/wall design, characters, powerups.
 * Assignment 4 PDF: FR-9 client displays map/characters; FR-10 input; Section 3 client-side rendering.
 */

/* Ryan Mendez - Global refs. An Nguyen - 3D engine (Three.js scene, camera, renderer) replacing original 2D. FR-9: client shows game world. */
let scene, camera, renderer;
let players = {};
let obstacles = [];
let terminals = [];
let powerups = [];
let socketId = null;
let myId = null;
let lastState = null;
let animationId = null;
let font = null; // For 3D text if needed, or use HTML overlay

/* GLB model system */
let catModelTemplate = null;
let ratModelTemplate = null;
const playerMixers = {};      // id -> THREE.AnimationMixer
const playerAnimActions = {}; // id -> { idle, run }
const playerIsMoving = {};       // id -> boolean
const playerLastPos = {};        // id -> { x, y }
const playerTargetRotY = {};     // id -> target Y rotation in radians
const playerMovingTimestamp = {}; // id -> ms timestamp of last detected movement
const clock = new THREE.Clock();
const CAT_MODEL_SCALE = 30;
const RAT_MODEL_SCALE = 25;
// Y lift so model sits on the floor — increase if it sinks, decrease if it floats
const CAT_MODEL_Y = 0;
const RAT_MODEL_Y = 0;
// Rotate to correct for each model's export orientation
const CAT_FACING_OFFSET = -Math.PI / 2; // Cat model exported facing +X → rotate -90°
const RAT_FACING_OFFSET = 0;            // Rat model exported facing the correct direction

function loadGameModels() {
    const loader = new THREE.GLTFLoader();
    loader.load('/Cat.glb',
        gltf => { catModelTemplate = gltf; },
        undefined,
        err => console.warn('Cat.glb failed to load', err)
    );
    loader.load('/Rat.glb',
        gltf => { ratModelTemplate = gltf; },
        undefined,
        err => console.warn('Rat.glb failed to load', err)
    );
}

/* Build a procedural run AnimationClip for the Cat (which ships with only an idle clip).
   Swing axis is Y in bone-local space — same convention confirmed from Rat_Run keyframes. */
function createCatRunClip() {
    const SWING = 0.55; // radians (~31°) per leg

    // Bind-pose quaternions taken from GLB node data [x, y, z, w]
    const RF_rest = new THREE.Quaternion(-0.0336, -0.7063,  0.7063, -0.0336).normalize();
    const LF_rest = new THREE.Quaternion( 0.0336,  0.7063, -0.7063,  0.0336).normalize();
    const RB_rest = new THREE.Quaternion( 0.0336,  0.7063, -0.7063,  0.0336).normalize();
    const LB_rest = new THREE.Quaternion( 0.0336,  0.7063, -0.7063,  0.0336).normalize();
    const tail_rest = new THREE.Quaternion(0.0295, 0.0170, -0.0001, 0.9994).normalize();

    const yAxis = new THREE.Vector3(0, 1, 0);
    const xAxis = new THREE.Vector3(1, 0, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const qFwd  = new THREE.Quaternion().setFromAxisAngle(zAxis, -SWING);
    const qBck  = new THREE.Quaternion().setFromAxisAngle(zAxis,  SWING);
    const qSway = new THREE.Quaternion().setFromAxisAngle(zAxis,  0.45);
    const qSwaR = new THREE.Quaternion().setFromAxisAngle(zAxis, -0.45);

    function kf(rest, delta) {
        const q = new THREE.Quaternion().copy(rest).multiply(delta);
        return [q.x, q.y, q.z, q.w];
    }
    function arr(q) { return [q.x, q.y, q.z, q.w]; }

    const t = [0, 0.1, 0.2, 0.3, 0.4]; // 0.4 s loop
    const tracks = [];

    // Diagonal trot: RF+LB in phase, LF+RB in opposite phase
    tracks.push(new THREE.QuaternionKeyframeTrack('R_Leg_Upper.quaternion', t, [
        ...kf(RF_rest, qFwd), ...arr(RF_rest), ...kf(RF_rest, qBck), ...arr(RF_rest), ...kf(RF_rest, qFwd)
    ]));
    tracks.push(new THREE.QuaternionKeyframeTrack('L_Leg_Upper.quaternion', t, [
        ...kf(LF_rest, qBck), ...arr(LF_rest), ...kf(LF_rest, qFwd), ...arr(LF_rest), ...kf(LF_rest, qBck)
    ]));
    tracks.push(new THREE.QuaternionKeyframeTrack('R_BLeg_Upper.quaternion', t, [
        ...kf(RB_rest, qBck), ...arr(RB_rest), ...kf(RB_rest, qFwd), ...arr(RB_rest), ...kf(RB_rest, qBck)
    ]));
    tracks.push(new THREE.QuaternionKeyframeTrack('L_BLeg_Upper.quaternion', t, [
        ...kf(LB_rest, qFwd), ...arr(LB_rest), ...kf(LB_rest, qBck), ...arr(LB_rest), ...kf(LB_rest, qFwd)
    ]));

    // Body bob through belly bone (its rest local-Y is 0; ±0.006 gives visible bounce)
    tracks.push(new THREE.VectorKeyframeTrack('belly.position', t, [
        -0.0025, -0.006, -0.0162,
        -0.0025,  0.006, -0.0162,
        -0.0025, -0.006, -0.0162,
        -0.0025,  0.006, -0.0162,
        -0.0025, -0.006, -0.0162,
    ]));

    // Tail sway (Z-axis in tail2's local space)
    tracks.push(new THREE.QuaternionKeyframeTrack('tail2.quaternion', [0, 0.2, 0.4], [
        ...kf(tail_rest, qSway), ...kf(tail_rest, qSwaR), ...kf(tail_rest, qSway)
    ]));

    return new THREE.AnimationClip('Run', 0.4, tracks);
}

function createPlayerModel(role) {
    const template = role === 'cat' ? catModelTemplate : ratModelTemplate;
    if (!template) return null;

    const group = new THREE.Group();
    // SkeletonUtils.clone rebinds bone references correctly for skinned/animated meshes
    const modelScene = THREE.SkeletonUtils
        ? THREE.SkeletonUtils.clone(template.scene)
        : template.scene.clone(true);
    const scale = role === 'cat' ? CAT_MODEL_SCALE : RAT_MODEL_SCALE;
    modelScene.scale.setScalar(scale);
    modelScene.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            // Clone material(s) per player so opacity changes don't bleed to other players
            if (Array.isArray(child.material)) {
                child.material = child.material.map(m => m.clone());
            } else {
                child.material = child.material.clone();
            }
        }
    });
    group.add(modelScene);

    const mixer = new THREE.AnimationMixer(modelScene);
    const clips = template.animations;
    const actions = {};

    if (clips && clips.length > 0) {
        const idleClip = clips.find(c => /idle|stand/i.test(c.name)) || clips[0];
        const runClip  = clips.find(c => /run|walk|jog/i.test(c.name));

        if (idleClip) {
            actions.idle = mixer.clipAction(idleClip);
            actions.idle.setLoop(THREE.LoopRepeat, Infinity);
            actions.idle.play();
        }
        let resolvedRunClip = (runClip && runClip !== idleClip) ? runClip
                           : (clips.length > 1 ? clips[1] : null);
        if (!resolvedRunClip && role === 'cat') resolvedRunClip = createCatRunClip();
        if (resolvedRunClip) {
            actions.run = mixer.clipAction(resolvedRunClip);
            actions.run.setLoop(THREE.LoopRepeat, Infinity);
            actions.run.clampWhenFinished = false;
        }
    }

    return { group, mixer, actions };
}

function switchPlayerAnimation(id, moving) {
    if (!playerAnimActions[id]) return;
    const wasMoving = playerIsMoving[id];
    if (moving === wasMoving) return;
    playerIsMoving[id] = moving;
    const { idle, run } = playerAnimActions[id];
    if (moving && run) {
        if (idle) idle.fadeOut(0.15);
        run.reset().play().fadeIn(0.15);
    } else {
        if (run) run.fadeOut(0.15);
        if (idle) idle.reset().play().fadeIn(0.15);
    }
}

/* Ryan Mendez - Base materials. An Nguyen - 3D materials for Cat, Mouse, walls, floor, terminals, exit (used with textures). FR-9: client renders characters. */
const MAT_CAT = new THREE.MeshLambertMaterial({ color: 0xff8800 }); // Orange
const MAT_MOUSE = new THREE.MeshLambertMaterial({ color: 0x888888 }); // Grey
const MAT_WALL = new THREE.MeshLambertMaterial({ color: 0x555555 });
const MAT_FLOOR = new THREE.MeshLambertMaterial({ color: 0x222222 });
const MAT_TERM_INC = new THREE.MeshLambertMaterial({ color: 0xffff00 });
const MAT_TERM_COM = new THREE.MeshLambertMaterial({ color: 0x00ff00 });
const MAT_EXIT_CLOSED = new THREE.MeshLambertMaterial({ color: 0x440000 });
const MAT_EXIT_OPEN = new THREE.MeshLambertMaterial({ color: 0x00ff00, transparent: true, opacity: 0.5 });

/* Ryan Mendez - Tracks keyboard state for movement and actions. FR-10: input devices for move/interact. */
const keys = { w: false, a: false, s: false, d: false, shift: false, space: false, f: false };

/* Ryan Mendez - Entry point: sets up scene, camera, renderer, listeners, socket handlers. FR-9: client displays game world; FR-12: state from server. */
function startGame(initialState) {
    if (animationId) cancelAnimationFrame(animationId);

    const container = document.getElementById('game-container');
    container.innerHTML = '';

    /* An Nguyen - 3D scene (replaced 2D canvas): background, fog for depth. FR-9: client shows map. */
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f5dc); // Beige background for cozy feel
    scene.fog = new THREE.Fog(0xf5f5dc, 500, 2500);

    /* An Nguyen - 3D perspective camera, top-down angled view (replaced 2D view). FR-9: player observes game world. */
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 5000);
    camera.position.set(0, 800, 600); // High up and angled
    camera.lookAt(0, 0, 0);

    /* An Nguyen - WebGL 3D renderer with antialias and shadows (replaced 2D renderer). Section 3: client-side rendering. */
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    /* An Nguyen - Real textures for floor and walls (wood floor PNG, wall texture PNG); replaced flat/SVG look. FR-8: map with obstacles. */
    const loader = new THREE.TextureLoader();
    const woodTexture = loader.load('assets/floor.jpg');
    woodTexture.wrapS = THREE.RepeatWrapping;
    woodTexture.wrapT = THREE.RepeatWrapping;
    woodTexture.repeat.set(15, 15);

    const wallTexture = loader.load('assets/wall.png');
    wallTexture.wrapS = THREE.RepeatWrapping;
    wallTexture.wrapT = THREE.RepeatWrapping;

    const MAT_FLOOR_TEX = new THREE.MeshLambertMaterial({ map: woodTexture });
    window.MAT_WALL_TEX = new THREE.MeshLambertMaterial({ map: wallTexture }); // Export Global for updateGame

    /* Ryan Mendez - Ambient and directional light with shadows. FR-9: visual rendering. */
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5); // Neutral ambient
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfff5e6, 0.8); // Warm sun
    dirLight.position.set(500, 1000, 500);
    dirLight.castShadow = true;
    dirLight.shadow.camera.left = -1000;
    dirLight.shadow.camera.right = 1000;
    dirLight.shadow.camera.top = 1000;
    dirLight.shadow.camera.bottom = -1000;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    scene.add(dirLight);

    /* An Nguyen - 3D floor plane with wood texture (floor/wall design). FR-8: playable map. */
    const floorGeo = new THREE.PlaneGeometry(3000, 3000);
    const floor = new THREE.Mesh(floorGeo, MAT_FLOOR_TEX);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    /* Ryan Mendez - Key and resize listeners. FR-10: keyboard used to move and interact. */
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.removeEventListener('resize', onWindowResize);
    window.addEventListener('resize', onWindowResize);

    /* Ryan Mendez - Subscribe to game state and events from server. FR-12: server disseminates state to clients. */
    socket.off('gameState');
    socket.off('gameEvent');
    socket.off('terminalQuestion');
    socket.off('terminalError');
    socket.off('terminalComplete');

    /* Ryan Mendez - On gameState: update 3D world and UI; show class selection or cat wait during selection phase. FR-12: current state to all clients. */
    socket.on('gameState', (state) => {
        lastState = state;
        updateGame(state);
        updateUI(state);

        // Handle Selection Phase UI
        const classScreen = document.getElementById('class-selection-screen');
        const catWaitScreen = document.getElementById('cat-waiting-screen');
        const p = state.players[myId];

        if (state.status === 'selection') {
            if (p && p.role === 'mouse') {
                if (p.class === 0) {
                    classScreen.classList.remove('hidden');
                    populateClassGrid();
                    document.getElementById('class-selection-title').innerText = `Choose Your Class (${Math.ceil(state.selectionTimeLeft)}s)`;
                } else {
                    classScreen.classList.add('hidden');
                    catWaitScreen.classList.remove('hidden');
                    catWaitScreen.querySelector('p').innerText = `Waiting for other mice...`;
                }
            } else if (p && p.role === 'cat') {
                catWaitScreen.classList.remove('hidden');
                catWaitScreen.querySelector('p').innerText = `Game starts in ${Math.ceil(state.selectionTimeLeft)}s`;
            }
        } else {
            classScreen.classList.add('hidden');
            catWaitScreen.classList.add('hidden');
        }
    });

    socket.on('gameEvent', handleGameEvent);

    /* An Nguyen - Terminal mini-game: show question overlay, error feedback, and completion. FR-15: puzzle/terminal interaction to unlock exit. */
    socket.on('terminalQuestion', (data) => {
        showTerminalOverlay(data);
    });

    socket.on('terminalError', (msg) => {
        const fb = document.getElementById('terminal-feedback');
        if (fb) fb.innerText = msg;
    });

    socket.on('terminalComplete', () => {
        hideTerminalOverlay();
        addEventFeed("Terminal Verified!");
    });

    myId = socket.id;
    loadGameModels();

    /* Ryan Mendez - Terminal overlay button and Enter key submit. FR-10: interact with objects. */
    document.getElementById('terminal-submit-btn').onclick = submitTerminalAnswer;
    document.getElementById('terminal-escape-btn').onclick = hideTerminalOverlay;
    document.getElementById('terminal-input').onkeydown = (e) => {
        if (e.key === 'Enter') submitTerminalAnswer();
    };

    /* Ryan Mendez - Start render and input loop. FR-9: client updates view. */
    animate();
}

let classGridPopulated = false;
/* An Nguyen - All 10 mouse classes + cat integration: definitions for selection phase (skills, descriptions, colors). FR-7: roles; extended. */
const CLASSES = [
    { id: 1, name: "Boost Speed", desc: "+20% speed for 5s (Skill)", color: "#FFFF00" },
    { id: 2, name: "High Jump", desc: "Jump over 1 wall (Skill) [10s CD]", color: "#90EE90" },
    { id: 3, name: "Invisible", desc: "Invisible to Cat for 10s (Skill)", color: "#FFFFFF" },
    { id: 4, name: "Money Token", desc: "Spawn coins around you (Skill)", color: "#FFD700" },
    { id: 5, name: "Support", desc: "Random buff for 5s (Skill)", color: "#DDA0DD" },
    { id: 6, name: "Into Vent", desc: "Phase through 2 walls (Skill) [35s CD]", color: "#8B4513" },
    { id: 7, name: "Puzzle Prof", desc: "Terminals take 3 Qs instead of 5 [60s CD]", color: "#FFA500" },
    { id: 8, name: "Pull Player", desc: "Pull nearest player to you [40s CD]", color: "#04d9ff" },
    { id: 9, name: "Diplomouse", desc: "Random global event: Spd or Joker", color: "#FFC0CB" },
    { id: 10, name: "Lazy", desc: "Does nothing. Terminals take 12 Qs.", color: "#808080" }
];

/* An Nguyen - Fills class selection grid with cards; emit selectClass on click. FR-6: pre-game selection phase. */
function populateClassGrid() {
    if (classGridPopulated) return;
    const grid = document.getElementById('class-grid');
    grid.innerHTML = '';
    CLASSES.forEach(c => {
        const card = document.createElement('div');
        card.className = 'class-card';
        card.dataset.class = c.id;
        card.innerHTML = `<h3>${c.name}</h3><p>${c.desc}</p>`;
        card.onclick = () => {
            socket.emit('selectClass', c.id);
            document.getElementById('class-selection-screen').classList.add('hidden');
        };
        grid.appendChild(card);
    });
    classGridPopulated = true;
}

let isTerminalOpen = false;
let currentTerminalId = null;

/* An Nguyen - Shows terminal repair overlay with question and progress. FR-15: puzzle interaction for exit. */
function showTerminalOverlay(data) {
    isTerminalOpen = true;
    currentTerminalId = data.terminalId;
    document.getElementById('terminal-overlay').classList.remove('hidden');
    document.getElementById('terminal-progress').innerText = `Question ${data.questionIndex}/${data.total}`;
    document.getElementById('terminal-question-text').innerText = `${data.q} = ?`;
    document.getElementById('terminal-input').value = '';
    document.getElementById('terminal-input').focus();
    document.getElementById('terminal-feedback').innerText = '';

    // Clear movement keys to stop moving
    keys.w = keys.a = keys.s = keys.d = keys.shift = keys.space = false;
}

/* An Nguyen - Hides terminal overlay and refocuses game. FR-10: return to game after interaction. */
function hideTerminalOverlay() {
    isTerminalOpen = false;
    currentTerminalId = null;
    document.getElementById('terminal-overlay').classList.add('hidden');
    document.getElementById('game-container').focus();
}

/* An Nguyen - Sends answer to server for terminal question. FR-15: puzzle completion. */
function submitTerminalAnswer() {
    if (!currentTerminalId) return;
    const val = document.getElementById('terminal-input').value;
    if (val === '') return;
    socket.emit('submitAnswer', { terminalId: currentTerminalId, answer: val });
}

/* Ryan Mendez - Handles game events: catHit, terminalComplete, exitOpen, escape, mouseDown, powerup, diplomouse. FR-13/14: players informed on catch. */
function handleGameEvent(e) {
    if (e.type === 'catHit' && e.targetId === socket.id) {
        addEventFeed('You were hit! -' + Math.round(e.damage));
        shakeCamera();
        if (window.AudioManager) window.AudioManager.playSFX('assets/sounds/cat_hit.mp3');
        // If hit while in terminal, close it?
        if (isTerminalOpen) hideTerminalOverlay();
    }
    if (e.type === 'terminalComplete') {
        addEventFeed(`Terminal repaired! (${e.count || 0}/5)`);
        if (window.AudioManager) window.AudioManager.playSFX('assets/sounds/terminal_complete.mp3');
    }
    if (e.type === 'exitOpen') {
        addEventFeed('Exit opened! Run to center!');
        if (window.AudioManager) window.AudioManager.playSFX('assets/sounds/exit_open.mp3');
    }
    if (e.type === 'mouseEscaped') {
        addEventFeed(`${e.username || 'Someone'} escaped!`);
        if (window.AudioManager) window.AudioManager.playSFX('assets/sounds/mouse_escape.mp3');
    }
    if (e.type === 'mouseDown') {
        addEventFeed(`${e.username || 'A mouse'} was caught!`);
        if (window.AudioManager) window.AudioManager.playSFX('assets/sounds/mouse_caught.mp3');
    }
    if (e.type === 'powerup') {
        addEventFeed(`${e.kind} picked up`);
        if (window.AudioManager) window.AudioManager.playSFX('assets/sounds/powerup_pickup.mp3');
    }
    if (e.type === 'diplomouse') addEventFeed(`🐭 ${e.msg}`);
}

/* An Nguyen - Prepends event message to feed; keeps last 5, auto-removes after 5s. FR-13/14: all players informed. */
function addEventFeed(text) {
    const feed = document.getElementById('event-feed');
    const div = document.createElement('div');
    div.innerText = text;
    div.className = 'feed-item';
    feed.prepend(div);
    if (feed.children.length > 5) feed.removeChild(feed.lastChild);
    setTimeout(() => div.remove(), 5000);
}

/* Ryan Mendez - Syncs 3D scene with server state: players, obstacles, terminals, powerups, exit, minimap. FR-9: client shows map and characters; FR-12: reset view from state. */
function updateGame(state) {
    /* Remove dead/disconnected players */
    for (let id in players) {
        if (!state.players[id] || state.players[id].dead || state.players[id].escaped) {
            scene.remove(players[id].mesh);
            if (playerMixers[id]) { playerMixers[id].stopAllAction(); delete playerMixers[id]; }
            delete playerAnimActions[id];
            delete playerLastPos[id];
            delete playerIsMoving[id];
            delete playerTargetRotY[id];
            delete playerMovingTimestamp[id];
            delete players[id];
        }
    }

    /* Add/Update players */
    for (let id in state.players) {
        const p = state.players[id];
        if (p.dead || p.escaped) continue;

        /* Replace placeholder once the GLB template finishes loading */
        if (players[id] && players[id].isPlaceholder) {
            const template = p.role === 'cat' ? catModelTemplate : ratModelTemplate;
            if (template) {
                scene.remove(players[id].mesh);
                delete players[id];
            }
        }

        if (!players[id]) {
            const modelData = createPlayerModel(p.role);
            if (modelData) {
                /* An Nguyen - GLB model replaces primitive mesh; hitbox sizes unchanged on server. FR-9: characters in game world. */
                scene.add(modelData.group);
                playerMixers[id] = modelData.mixer;
                playerAnimActions[id] = modelData.actions;
                playerIsMoving[id] = false;
                players[id] = { mesh: modelData.group, role: p.role, isPlaceholder: false };
                playerTargetRotY[id] = p.role === 'cat' ? 0 : Math.PI / 2;
                modelData.group.rotation.y = playerTargetRotY[id];
            } else {
                /* Fallback primitive while model is still downloading */
                const geo = p.role === 'cat' ? new THREE.SphereGeometry(20, 32, 32) : new THREE.BoxGeometry(25, 25, 25);
                const mat = p.role === 'cat' ? MAT_CAT : MAT_MOUSE;
                const mesh = new THREE.Mesh(geo, mat);
                mesh.castShadow = true;
                scene.add(mesh);
                players[id] = { mesh, role: p.role, isPlaceholder: true };
            }
        }

        /* An Nguyen - Invisible skill: hide from cat view or show ghost to others. FR-9: character visibility. */
        if (p.invisibleUntil && p.invisibleUntil > Date.now()) {
            if (lastState && lastState.players[myId] && lastState.players[myId].role === 'cat') {
                if (players[id]) players[id].mesh.visible = false;
                continue;
            } else if (players[id]) {
                if (!players[id].isPlaceholder) {
                    players[id].mesh.traverse(c => { if (c.isMesh) { c.material.transparent = true; c.material.opacity = 0.3; } });
                } else {
                    players[id].mesh.material.transparent = true;
                    players[id].mesh.material.opacity = 0.3;
                }
            }
        } else if (players[id]) {
            players[id].mesh.visible = true;
            if (!players[id].isPlaceholder) {
                players[id].mesh.traverse(c => { if (c.isMesh) { c.material.transparent = false; c.material.opacity = 1.0; } });
            } else {
                players[id].mesh.material.transparent = false;
                players[id].mesh.material.opacity = 1.0;
            }
        }

        /* Ryan Mendez - Lerp player position and camera follow for local player. FR-9: observe game world. */
        const mesh = players[id].mesh;
        const prevPos = playerLastPos[id] || { x: p.x, y: p.y };
        const dx = p.x - prevPos.x;
        const dz = p.y - prevPos.y; // server Y maps to 3D Z
        playerLastPos[id] = { x: p.x, y: p.y };

        // High tick rate (240 Hz) means most frames have dx≈0 even while moving.
        // Stamp the last real-movement time and keep isMoving true for 250 ms after it.
        if (Math.abs(dx) > 0.5 || Math.abs(dz) > 0.5) playerMovingTimestamp[id] = performance.now();
        const isMoving = (performance.now() - (playerMovingTimestamp[id] || 0)) < 250;

        if (!players[id].isPlaceholder) {
            switchPlayerAnimation(id, isMoving);
            // Update target rotation when moving; animate() lerps toward it each frame
            if (Math.abs(dx) > 0.5 || Math.abs(dz) > 0.5) {
                const facingOffset = players[id].role === 'cat' ? CAT_FACING_OFFSET : RAT_FACING_OFFSET;
                playerTargetRotY[id] = Math.atan2(dx, dz) + facingOffset;
            }
        }

        mesh.position.x = lerp(mesh.position.x, p.x, 0.2);
        mesh.position.z = lerp(mesh.position.z, p.y, 0.2); // Server Y is 3D Z
        // Per-role Y lift — tune CAT_MODEL_Y / RAT_MODEL_Y if model sinks into or floats above floor
        mesh.position.y = players[id].isPlaceholder ? 0 : (players[id].role === 'cat' ? CAT_MODEL_Y : RAT_MODEL_Y);

        if (id === myId) {
            const targetX = mesh.position.x;
            const targetZ = mesh.position.z + 400; // Offset Z for angled view
            const targetY = 600; // Height

            camera.position.x = lerp(camera.position.x, targetX, 0.1);
            camera.position.z = lerp(camera.position.z, targetZ, 0.1);
            camera.position.y = lerp(camera.position.y, targetY, 0.1);
            camera.lookAt(mesh.position.x, 0, mesh.position.z);
        }
    }

    /* An Nguyen - 3D wall meshes with wall texture (floor/wall design); built once from state.obstacles. PDF: FR-8 (map contains obstacles). */
    if (obstacles.length === 0 && state.obstacles.length > 0) {
        state.obstacles.forEach(o => {
            const h = 60; // Wall height
            const geo = new THREE.BoxGeometry(o.w, h, o.h); // o.h is Z depth in 3D
            const wallMat = window.MAT_WALL_TEX || MAT_WALL;
            // Clone material to handle different texture repeats based on wall size? 
            // For now, world-mapped texture or simple repeat is fine.
            const mesh = new THREE.Mesh(geo, wallMat);
            mesh.position.set(o.x, h / 2, o.y);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            scene.add(mesh);
            obstacles.push(mesh);
        });
    }

    /* Ryan Mendez - Sync terminal meshes and completion color. Short: interactive escapes. PDF: FR-8, FR-15 (terminals). */
    if (terminals.length !== state.terminals.length) {
        terminals.forEach(t => scene.remove(t.mesh));
        terminals = [];
        state.terminals.forEach(t => {
            const geo = new THREE.CylinderGeometry(15, 15, 50, 16);
            const mesh = new THREE.Mesh(geo, MAT_TERM_INC);
            mesh.position.set(t.x, 25, t.y);
            mesh.castShadow = true;
            scene.add(mesh);
            terminals.push({ id: t.id, mesh: mesh });
        });
    }

    state.terminals.forEach(t => {
        const term = terminals.find(x => x.id === t.id);
        if (term) {
            term.mesh.material = t.completed ? MAT_TERM_COM : MAT_TERM_INC;
            if (t.completed) {
                term.mesh.position.y = 10; // Sink when done
            }
        }
    });

    /* An Nguyen - Power-up/boost system: 3D powerup meshes (heal, speed, rage) from state; float animation. FR-8: map elements. */
    powerups.forEach(p => scene.remove(p));
    powerups = [];
    (state.powerups || []).forEach(p => {
        if (p.respawnAt > 0) return;
        const color = p.type === 'heal' ? 0x00ff00 : p.type === 'speed' ? 0x00aaff : 0xff6600;
        const geo = new THREE.OctahedronGeometry(10);
        const mat = new THREE.MeshPhongMaterial({ color: color, emissive: color, emissiveIntensity: 0.5 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(p.x, 20 + Math.sin(Date.now() / 500) * 5, p.y); // Float animation
        mesh.rotation.y = Date.now() / 1000;
        scene.add(mesh);
        powerups.push(mesh);
    });

    /* Ryan Mendez - When exit open, draw ring marker and green light at center. FR-15: door of escape opened; FR-16: escape route. */
    if (state.exitOpen) {
        if (!scene.getObjectByName('exitMarker')) {
            const geo = new THREE.RingGeometry(100, 120, 32);
            const mesh = new THREE.Mesh(geo, MAT_EXIT_OPEN);
            mesh.name = 'exitMarker';
            mesh.rotation.x = -Math.PI / 2;
            mesh.position.set(0, 5, 0);
            scene.add(mesh);

            const light = new THREE.PointLight(0x00ff00, 1, 500);
            light.position.set(0, 50, 0);
            scene.add(light);
        }
    }

    /* An Nguyen - Draw 2D minimap with walls and players. FR-9: client shows map. */
    drawMinimap(state);
}

/* Ryan Mendez - Updates HUD: HP, role, controls hint, timer, terminals, sprint/skill bars. FR-9: player observes state. */
function updateUI(state) {
    const p = state.players[socket.id];
    if (!p) return;
    document.getElementById('hp-bar').innerText = `HP: ${Math.floor(p.hp)}`;

    let roleText = `Role: ${p.role.toUpperCase()}`;
    if (p.role === 'mouse' && p.class > 0) {
        const cls = CLASSES.find(c => c.id === p.class);
        if (cls) roleText += ` - ${cls.name}`;
    }
    document.getElementById('role-display').innerText = roleText;

    const hintText = p.role === 'cat'
        ? 'WASD move · Shift sprint · Space attack'
        : 'WASD move · Shift sprint · Space interact · F skill';
    document.getElementById('controls-hint').innerText = hintText;

    document.getElementById('timer-display').innerText = `Time: ${Math.floor(state.timeLeft)}`;
    document.getElementById('terminals-left').innerText = `Terminals: ${state.terminals.filter(t => t.completed).length}/5`;

    const sprintEl = document.getElementById('sprint-bar');
    if (p.sprintCooldown > 0) {
        sprintEl.innerText = `Cooldown: ${Math.ceil(p.sprintCooldown)}`;
        sprintEl.style.color = 'red';
    } else {
        sprintEl.innerText = `Sprint Ready (${Math.ceil(p.sprintTime)}s)`;
        sprintEl.style.color = 'lime';
    }

    const skillEl = document.getElementById('skill-bar');
    if (p.class > 0) { // Has a skill
        if (p.skillCooldown > 0) {
            skillEl.innerText = `CD: ${Math.ceil(p.skillCooldown)}s`;
            skillEl.style.color = 'red';
        } else {
            skillEl.innerText = `Skill Ready (F)`;
            skillEl.style.color = 'lime';
        }
    } else {
        skillEl.innerText = `No Skill`;
        skillEl.style.color = 'gray';
    }
}

/* Ryan Mendez - Animation loop: emit playerInput to server and render. FR-10: movement/action relayed to server. */
function animate() {
    animationId = requestAnimationFrame(animate);

    const delta = clock.getDelta();
    for (const id in playerMixers) {
        playerMixers[id].update(delta);
    }

    // Smoothly rotate each model toward its movement direction each frame
    for (const id in players) {
        if (!players[id].isPlaceholder && playerTargetRotY[id] !== undefined) {
            players[id].mesh.rotation.y = lerpAngle(players[id].mesh.rotation.y, playerTargetRotY[id], 0.18);
        }
    }

    if (!isTerminalOpen && myId && lastState && lastState.players[myId] && !lastState.players[myId].dead) {
        const input = {
            up: keys.w,
            down: keys.s,
            left: keys.a,
            right: keys.d,
            sprint: keys.shift,
            action: keys.space,
            activeSkill: keys.f
        };
        socket.emit('playerInput', input);
    }

    renderer.render(scene, camera);
}

/* Ryan Mendez - Key down: set movement/action flags; Space triggers interactTerminal; Escape closes terminal. FR-10: keyboard input. */
function onKeyDown(e) {
    if (isTerminalOpen && e.code !== 'Escape') return;

    if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.w = true;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.s = true;
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.a = true;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.d = true;
    if (e.code === 'ShiftLeft') keys.shift = true;
    if (e.code === 'KeyF') keys.f = true;

    if (e.code === 'Space') {
        keys.space = true;
        socket.emit('interactTerminal');
    }

    if (e.code === 'Escape') {
        if (isTerminalOpen) hideTerminalOverlay();
    }
}

/* Ryan Mendez - Key up: clear movement and action flags. FR-10: input handling. */
function onKeyUp(e) {
    if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.w = false;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.s = false;
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.a = false;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.d = false;
    if (e.code === 'ShiftLeft') keys.shift = false;
    if (e.code === 'Space') keys.space = false;
    if (e.code === 'KeyF') keys.f = false;
}

/* Ryan Mendez - Resize camera aspect and renderer size. FR-9: client view. */
function onWindowResize() {
    if (camera && renderer) {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }
}

/* Ryan Mendez - Linear interpolation for smooth position updates. FR-9: smooth view. */
function lerp(start, end, amt) {
    return (1 - amt) * start + amt * end;
}

/* Angle interpolation taking the shortest arc around the circle (handles 350°→10° correctly). */
function lerpAngle(current, target, amt) {
    let diff = ((target - current + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    return current + diff * amt;
}

/* An Nguyen - Brief camera shake on cat hit. FR-13/14: feedback when caught. */
function shakeCamera() {
    const originalPos = camera.position.clone();
    let duration = 200;
    const start = Date.now();

    function shake() {
        const now = Date.now();
        const elapsed = now - start;
        if (elapsed < duration) {
            const intensity = 15 * (1 - elapsed / duration);
            camera.position.x = originalPos.x + (Math.random() - 0.5) * intensity;
            camera.position.z = originalPos.z + (Math.random() - 0.5) * intensity;
            requestAnimationFrame(shake);
        } // Positions restore naturally by update loop
    }
    shake();
}

/* An Nguyen - Draws 2D minimap: walls, players (cat/mouse), hide invisible from cat. FR-9: client shows map. */
function drawMinimap(state) {
    const canvas = document.getElementById('minimap');
    if (!canvas || !state.players[socket.id]) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const scale = (w - 10) / 2000;
    const cx = w / 2, cy = h / 2;

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, h);

    // Draw walls on minimap
    ctx.fillStyle = '#555';
    (state.obstacles || []).forEach(o => {
        ctx.fillRect(cx + (o.x - o.w / 2) * scale, cy + (o.y - o.h / 2) * scale, o.w * scale, o.h * scale);
    });

    // Players interaction
    for (const id in state.players) {
        const p = state.players[id];
        if (p.dead && !p.escaped) continue;

        let shouldHide = false;
        if (p.invisibleUntil && p.invisibleUntil > Date.now()) {
            if (lastState && lastState.players[myId] && lastState.players[myId].role === 'cat') {
                shouldHide = true;
            }
        }
        if (shouldHide) continue;

        const x = cx + p.x * scale;
        const y = cy + p.y * scale;

        ctx.fillStyle = p.role === 'cat' ? '#f00' : '#0af';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();

        if (id === socket.id) {
            ctx.strokeStyle = '#fff';
            ctx.stroke();
        }
    }
}