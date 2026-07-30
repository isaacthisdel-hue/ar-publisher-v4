// ============================================================
// RESTAURANT STORE — persists the restaurant list (names, branches,
// socials, review link, signed status) to a Railway Volume so it
// survives redeploys/restarts, instead of living only in memory.
//
// SETUP (one time, in the Railway dashboard):
//   Your service -> Settings -> Volumes -> Add Volume
//   Mount path: /data   (or set DATA_DIR to whatever you mount it at)
//
// Without a volume attached, this silently falls back to memory-only
// behavior (same graceful-degradation pattern as analytics.js when
// Supabase isn't configured) — the app still works, it just won't
// remember restaurants across a redeploy until a volume is attached.
//
// NOTE: published dishes themselves are NOT stored here. They already
// live forever in each restaurant's GitHub repo (dishes.json manifest),
// which is the existing source of truth — see menu.js. This file only
// covers the admin-side restaurant list that used to live in memory.
// ============================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'restaurants.json');

function storageEnabled() {
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Loads the persisted restaurant list at startup. Returns {} if no
// volume is attached yet, or no file has been written yet.
function loadRestaurants() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Writes the full restaurant list. Called after every mutation (add/
// delete restaurant or branch, update socials/review/signed). Writes to
// a temp file and renames over the real one so a crash mid-write can't
// leave a half-written, corrupt restaurants.json behind.
function saveRestaurants(restaurants) {
  if (!storageEnabled()) return;
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(restaurants, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('Failed to save restaurants.json:', e.message);
  }
}

module.exports = { storageEnabled, loadRestaurants, saveRestaurants, DATA_DIR };
