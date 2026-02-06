/**
 * main.js - Client entry: Socket.IO, menu/lobby/game-over UI. Assignment 4 PDF: FR-1 main menu; FR-3 lobby; FR-18 results; Section 3 client communicates with server.
 */
const socket = io();
let currentUser = null;
let currentLobby = null;

const mainMenu = document.getElementById('main-menu');
const lobbyScreen = document.getElementById('lobby-screen');
const gameUi = document.getElementById('game-ui');
const gameOverScreen = document.getElementById('game-over-screen');

const panelLogin = document.getElementById('panel-login');
const panelSettings = document.getElementById('panel-settings');

/* Ryan Mendez - Hides login and settings slide panels. */
function closeAllPanels() {
    panelLogin.classList.remove('visible-right');
    panelLogin.classList.add('hidden-right');
    panelSettings.classList.remove('visible-right');
    panelSettings.classList.add('hidden-right');
}

/* Ryan Mendez - Start button toggles login panel. FR-1: main menu option Login. */
document.getElementById('btn-start').addEventListener('click', () => {
    const isLoginOpen = panelLogin.classList.contains('visible-right');
    closeAllPanels();
    if (!isLoginOpen) {
        panelLogin.classList.remove('hidden-right');
        panelLogin.classList.add('visible-right');
    }
});

/* Ryan Mendez - Settings button toggles settings panel. FR-20: custom control/audio menu. */
document.getElementById('btn-settings').addEventListener('click', () => {
    const isSettingsOpen = panelSettings.classList.contains('visible-right');
    closeAllPanels();
    if (!isSettingsOpen) {
        panelSettings.classList.remove('hidden-right');
        panelSettings.classList.add('visible-right');
    }
});

document.getElementById('close-settings').addEventListener('click', () => {
    closeAllPanels();
});

/* Ryan Mendez - Login/register: send credentials to server; show lobby on success. An Nguyen: form submit with preventDefault. FR-1 login/register; FR-2 register. */
const loginSubmitBtn = document.getElementById('login-submit-btn');
document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const user = document.getElementById('username').value.trim();
    const pass = document.getElementById('password').value;
    const msgEl = document.getElementById('login-msg');
    msgEl.textContent = '';
    if (!user || !pass) {
        msgEl.textContent = 'Enter username and password';
        msgEl.style.color = '#ff5555';
        return;
    }
    loginSubmitBtn.disabled = true;
    loginSubmitBtn.textContent = 'Logging in...';
    socket.emit('login', { username: user, password: pass });
});

/* Ryan Mendez - On login response: show lobby or error message. FR-1 postcondition: main menu with login. */
socket.on('loginResponse', (res) => {
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = 'Enter';
    if (res.success) {
        currentUser = res.username;
        mainMenu.classList.add('hidden');
        lobbyScreen.classList.remove('hidden');
    } else {
        const msg = document.getElementById('login-msg');
        msg.textContent = res.message || 'Login failed';
        msg.style.color = '#ff5555';
        msg.style.marginTop = '10px';
    }
});

/* Ryan Mendez - Create lobby and refresh lobby list. FR-4: form new room; FR-3: view available rooms. */
document.getElementById('create-lobby-btn').addEventListener('click', () => {
    socket.emit('createLobby');
});

document.getElementById('find-lobby-btn').addEventListener('click', () => {
    socket.emit('getLobbies');
});

/* Ryan Mendez - Display available lobbies as overlay with join buttons. FR-3: lobby displays game rooms. */
socket.on('lobbyList', (list) => {
    const existing = document.getElementById('lobby-list-overlay');
    if (existing) existing.remove();

    const div = document.createElement('div');
    div.id = 'lobby-list-overlay';
    div.className = 'overlay-panel';

    const h3 = document.createElement('h3');
    h3.textContent = 'Available Lobbies';
    div.appendChild(h3);

    if (list.length === 0) {
        const p = document.createElement('p');
        p.className = 'overlay-empty';
        p.textContent = 'No lobbies found. Create one!';
        div.appendChild(p);
    }

    list.forEach(l => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Lobby ' + l.id + ' (' + l.players.length + '/5)';
        btn.className = 'lobby-join-btn';
        btn.onclick = () => { socket.emit('joinLobby', l.id); div.remove(); };
        div.appendChild(btn);
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Cancel';
    close.className = 'overlay-cancel-btn';
    close.onclick = () => div.remove();
    div.appendChild(close);

    document.body.appendChild(div);
});

/* Ryan Mendez - Joined a lobby: show lobby id, timer, player list, leave button. FR-5 postcondition: user in room player list. */
socket.on('joinedLobby', (data) => {
    const { lobbyId, players: playerList } = typeof data === 'string' ? { lobbyId: data, players: [] } : data;
    currentLobby = lobbyId;
    const lobbyDisplay = document.getElementById('active-lobby-display');
    lobbyDisplay.innerHTML = '<h2 id="lobby-title">Lobby: ' + lobbyId + '</h2><p id="lobby-timer">Waiting for players...</p><ul id="player-list"></ul><button type="button" id="leave-lobby-btn">Leave Lobby</button>';
    applyLobbyStyles(lobbyDisplay);
    document.getElementById('leave-lobby-btn').addEventListener('click', () => { socket.emit('leaveLobby'); });
    updatePlayerList(playerList);
});

socket.on('leftLobby', () => {
    currentLobby = null;
    const lobbyDisplay = document.getElementById('active-lobby-display');
    lobbyDisplay.innerHTML = '<h2 id="lobby-title">Lobby Selection</h2><p id="lobby-timer">Leave lobby — use Create or Refresh to join a game.</p><ul id="player-list"></ul>';
    applyLobbyStyles(lobbyDisplay);
});

socket.on('lobbyPlayers', (playerList) => {
    updatePlayerList(playerList);
});

function applyLobbyStyles(container) {
    const h2 = container.querySelector('#lobby-title');
    if (h2) { h2.style.fontFamily = "'Luckiest Guy', cursive"; h2.style.fontSize = '40px'; h2.style.letterSpacing = '2px'; }
}

function updatePlayerList(playerList) {
    const ul = document.getElementById('player-list');
    if (!ul) return;
    ul.innerHTML = '';
    (playerList || []).forEach(({ username }) => {
        const li = document.createElement('li');
        li.textContent = username;
        li.className = 'lobby-player-item';
        ul.appendChild(li);
    });
}

socket.on('lobbyUpdate', () => {});

/* Ryan Mendez - Update lobby countdown display. FR-6: countdown timer then game session launched. */
socket.on('lobbyTimer', (time) => {
    const timerEl = document.getElementById('lobby-timer');
    if (timerEl) timerEl.textContent = 'Starting in: ' + time;
});

/* Ryan Mendez - Game started: hide lobby, show game UI, start Phaser with initial state. FR-6 postcondition: all players to game screen. */
socket.on('gameStart', (initialState) => {
    lobbyScreen.classList.add('hidden');
    gameUi.classList.remove('hidden');
    startGame(initialState);
});

/* Ryan Mendez - Game over: show winner (Cat/Mice) and game-over screen. FR-16/17 postcondition: result shown; FR-18: result and back to lobby. */
socket.on('gameOver', (winner) => {
    gameUi.classList.add('hidden');
    gameOverScreen.classList.remove('hidden');
    document.getElementById('winner-text').textContent = winner === 'cat' ? 'CAT WINS' : 'MICE WIN';
});

/* Ryan Mendez - Back to lobby from game over. FR-18: results displayed and taken back to lobby. */
document.getElementById('game-over-back').addEventListener('click', () => {
    currentLobby = null;
    gameOverScreen.classList.add('hidden');
    lobbyScreen.classList.remove('hidden');
    const lobbyDisplay = document.getElementById('active-lobby-display');
    lobbyDisplay.innerHTML = '<h2 id="lobby-title">Lobby Selection</h2><p id="lobby-timer">Create or join a lobby to play.</p><ul id="player-list"></ul>';
    applyLobbyStyles(lobbyDisplay);
});
