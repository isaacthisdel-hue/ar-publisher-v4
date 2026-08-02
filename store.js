// ============================================================
// RESTAURANT STORE — persists the restaurant list (names, branches,
// socials, review link, signed status) so it survives redeploys/
// restarts instead of living only in memory.
//
// Two backends, tried in this order:
//   1. Supabase — the SAME project already used by analytics.js, reusing
//      SUPABASE_URL / SUPABASE_SERVICE_KEY. No Railway action needed at
//      all if that's already set up.
//   2. Railway Volume — a JSON file on a mounted disk (Settings ->
//      Volumes -> Add Volume, mount path /data, or set DATA_DIR).
// Falls back to memory-only (same as before) if neither is configured,
// so the app keeps working regardless — same graceful-degradation
// pattern as analytics.js when Supabase isn't set up.
//
// ONE-TIME SUPABASE SETUP (SQL editor, only needed for the Supabase
// backend — skip this if you're using a Volume instead):
//   create table if not exists restaurants (
//     slug text primary key,
//     name text not null,
//     branches jsonb not null default '{}',
//     socials jsonb not null default '{}',
//     review_url text not null default '',
//     signed boolean not null default false,
//     manage_token text,
//     updated_at timestamptz not null default now()
//   );
//   -- if that table already exists from before manage_token existed:
//   alter table restaurants add column if not exists manage_token text;
//
// This file also stores per-dish overrides (availability on/off, which
// collection a dish belongs to) set by restaurant owners on their private
// /manage dashboard — see server.js's manage routes. These live ONLY in
// Supabase (no volume fallback): they're keyed off dishes that already
// live in GitHub (see menu.js), and are merged in at render time rather
// than committed back to the repo, so a toggle takes effect instantly
// with no GitHub Pages rebuild delay.
//   create table if not exists dish_overrides (
//     restaurant_slug text not null,
//     branch_slug text not null default '',
//     dish_slug text not null,
//     available boolean not null default true,
//     collection text not null default '',
//     updated_at timestamptz not null default now(),
//     primary key (restaurant_slug, branch_slug, dish_slug)
//   );
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TABLE = 'restaurants';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'restaurants.json');

function supabaseEnabled() { return Boolean(SUPABASE_URL && SUPABASE_KEY); }
function volumeEnabled() {
  try { fs.accessSync(DATA_DIR, fs.constants.W_OK); return true; }
  catch { return false; }
}
function storageEnabled() { return supabaseEnabled() || volumeEnabled(); }
function storageBackend() {
  if (supabaseEnabled()) return 'supabase';
  if (volumeEnabled()) return 'volume';
  return 'memory';
}

// Low-level Supabase REST helper — same pattern as analytics.js's sb().
async function sb(pathSuffix, options = {}) {
  const url = SUPABASE_URL + '/rest/v1/' + pathSuffix;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase ' + res.status + ': ' + text);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function rowToRestaurant(row) {
  return {
    name: row.name,
    branches: row.branches || {},
    socials: row.socials || {},
    reviewUrl: row.review_url || '',
    signed: !!row.signed,
    manageToken: row.manage_token || '',
  };
}

function restaurantToRow(slug, r) {
  return {
    slug,
    name: r.name,
    branches: r.branches || {},
    socials: r.socials || {},
    review_url: r.reviewUrl || '',
    signed: !!r.signed,
    manage_token: r.manageToken || '',
    updated_at: new Date().toISOString(),
  };
}

// Generates a private, hard-to-guess token for a restaurant's owner
// dashboard link (.../manage/<token>) — a capability URL instead of a
// password the owner would have to remember.
function generateManageToken() {
  return crypto.randomBytes(16).toString('hex');
}

// ── Volume (file) backend ──────────────────────────────────────────────
function loadFromVolume() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}
function saveAllToVolume(restaurants) {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(restaurants, null, 2));
    fs.renameSync(tmp, FILE); // atomic swap, avoids a half-written file on crash
  } catch (e) {
    console.error('Failed to save restaurants.json:', e.message);
  }
}

// ── Public API ──────────────────────────────────────────────────────────

// Loads every restaurant at startup, from whichever backend is active.
async function loadRestaurants() {
  if (supabaseEnabled()) {
    try {
      const rows = await sb(TABLE + '?select=*');
      const out = {};
      (rows || []).forEach((row) => { out[row.slug] = rowToRestaurant(row); });
      return out;
    } catch (e) {
      console.error('Failed to load restaurants from Supabase:', e.message);
      return {};
    }
  }
  if (volumeEnabled()) return loadFromVolume();
  return {};
}

// Upserts one restaurant. Call after any add/update to it (including
// branch/social/review/signed changes) — pass the full updated record,
// plus the whole restaurants map (only used by the volume backend, which
// has to rewrite the whole file since it has no per-row upsert).
async function persistUpsert(slug, restaurant, allRestaurants) {
  if (supabaseEnabled()) {
    const row = restaurantToRow(slug, restaurant);
    try {
      await sb(TABLE + '?on_conflict=slug', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
    } catch (e) {
      // Most likely cause: the manage_token column hasn't been added to
      // the restaurants table yet (the ALTER TABLE was never run). Without
      // this fallback, THAT alone would silently fail to save anything for
      // this restaurant -- not just its manage token -- every single time,
      // which is exactly the "everything resets after a deploy" bug.
      // Retry once without manage_token so the rest of the record (name,
      // branches, socials...) still persists; only the manage-link feature
      // degrades until the migration is run.
      if ('manage_token' in row) {
        try {
          const { manage_token, ...rowWithoutToken } = row;
          await sb(TABLE + '?on_conflict=slug', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(rowWithoutToken),
          });
          console.error(
            'Saved restaurant "' + slug + '" to Supabase WITHOUT manage_token ' +
            '(column likely missing -- run: alter table restaurants add column if not exists manage_token text;). ' +
            'Original error: ' + e.message
          );
        } catch (e2) {
          console.error('Failed to save restaurant "' + slug + '" to Supabase (retry without manage_token also failed):', e2.message);
        }
      } else {
        console.error('Failed to save restaurant "' + slug + '" to Supabase:', e.message);
      }
    }
    return;
  }
  if (volumeEnabled()) saveAllToVolume(allRestaurants);
}

// Deletes one restaurant.
async function persistDelete(slug, allRestaurants) {
  if (supabaseEnabled()) {
    try {
      await sb(TABLE + '?slug=eq.' + encodeURIComponent(slug), {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
    } catch (e) {
      console.error('Failed to delete restaurant from Supabase:', e.message);
    }
    return;
  }
  if (volumeEnabled()) saveAllToVolume(allRestaurants);
}

// ── Dish overrides (availability + collection, owner-editable) ──────────
// Supabase-only: gracefully no-ops if it isn't configured, same as
// analytics.js does when Supabase isn't set up. Falls back to "everything
// available, no collections" everywhere it's read.
const OVERRIDES_TABLE = 'dish_overrides';

function overridesEnabled() { return supabaseEnabled(); }

// Returns { [dishSlug]: { available, collection } } for one restaurant/branch.
async function loadOverrides(restaurantSlug, branchSlug) {
  if (!overridesEnabled()) return {};
  try {
    const rows = await sb(
      OVERRIDES_TABLE +
      '?restaurant_slug=eq.' + encodeURIComponent(restaurantSlug) +
      '&branch_slug=eq.' + encodeURIComponent(branchSlug || '') +
      '&select=dish_slug,available,collection'
    );
    const out = {};
    (rows || []).forEach((row) => {
      out[row.dish_slug] = { available: !!row.available, collection: row.collection || '' };
    });
    return out;
  } catch (e) {
    console.error('Failed to load dish overrides from Supabase:', e.message);
    return {};
  }
}

// Upserts one dish's override. Only the fields passed in `patch` are
// changed — pass the merged result of (current override, patch) so a
// collection-only edit doesn't accidentally reset availability, etc.
async function saveOverride(restaurantSlug, branchSlug, dishSlug, values) {
  if (!overridesEnabled()) return false;
  try {
    await sb(OVERRIDES_TABLE + '?on_conflict=restaurant_slug,branch_slug,dish_slug', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        restaurant_slug: restaurantSlug,
        branch_slug: branchSlug || '',
        dish_slug: dishSlug,
        available: values.available !== undefined ? !!values.available : true,
        collection: values.collection || '',
        updated_at: new Date().toISOString(),
      }),
    });
    return true;
  } catch (e) {
    console.error('Failed to save dish override to Supabase:', e.message);
    return false;
  }
}

// Actually exercises the active backend (not just "is the env var set")
// so a missing table / missing column / bad credentials shows up as a
// clear, specific error instead of silently degrading to "nothing saves."
async function checkHealth() {
  if (supabaseEnabled()) {
    try {
      await sb(TABLE + '?select=slug&limit=1');
    } catch (e) {
      return { ok: false, backend: 'supabase', error: 'restaurants table: ' + e.message };
    }
    try {
      await sb(OVERRIDES_TABLE + '?select=restaurant_slug&limit=1');
    } catch (e) {
      return { ok: false, backend: 'supabase', error: 'dish_overrides table: ' + e.message };
    }
    return { ok: true, backend: 'supabase', error: null };
  }
  if (volumeEnabled()) return { ok: true, backend: 'volume', error: null };
  return { ok: false, backend: 'memory', error: 'No SUPABASE_URL/SUPABASE_SERVICE_KEY and no writable Railway Volume -- restaurant data is memory-only and will be lost on every redeploy.' };
}

module.exports = {
  storageEnabled, storageBackend, loadRestaurants, persistUpsert, persistDelete, DATA_DIR,
  generateManageToken, overridesEnabled, loadOverrides, saveOverride, checkHealth,
};
