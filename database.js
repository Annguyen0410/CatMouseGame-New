/**
 * database.js - User persistence and auth. Assignment 4 PDF: FR-2 account creation/registration in database; FR-1 login.
 * Ryan Mendez - SQLite DB, users table, login and register with bcrypt; legacy plain-text upgrade.
 */
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const db = new sqlite3.Database('./game.db');

const SALT_ROUNDS = 10;

db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, coins INTEGER DEFAULT 0)");
});

/* Ryan Mendez - Validates credentials; supports bcrypt or legacy plain-text (upgrades on login). FR-2: precondition username/email not already used. */
function loginUser(username, password, callback) {
  db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
    if (err) return callback(err, null);
    if (!row) return callback(null, null);
    // Support legacy plain-text passwords: if stored value looks like bcrypt hash, use compare; else plain match and upgrade
    const stored = row.password || '';
    if (stored.startsWith('$2')) {
      bcrypt.compare(password, stored, (err, ok) => {
        if (err) return callback(err, null);
        callback(null, ok ? { id: row.id, username: row.username } : null);
      });
    } else {
      if (stored === password) {
        bcrypt.hash(password, SALT_ROUNDS, (err, hash) => {
          if (!err && hash) db.run("UPDATE users SET password = ? WHERE id = ?", [hash, row.id]);
        });
        return callback(null, { id: row.id, username: row.username });
      }
      callback(null, null);
    }
  });
}

/* Ryan Mendez - Hashes password and inserts new user. FR-2: new user account established and registered in database. */
/* Ryan Mendez - Hashes password and inserts new user. FR-2: new user account established and registered in database. */
function registerUser(username, password, callback) {
  bcrypt.hash(password, SALT_ROUNDS, (err, hash) => {
    if (err) return callback(err, null);
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hash], function(err) {
      callback(err, this ? this.lastID : null);
    });
  });
}

module.exports = { db, loginUser, registerUser };
