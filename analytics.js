// ============================================================
// ANALYTICS — records dish scans/views/AR-launches into Supabase
// and reads them back for the dashboard.
//
// Data lives in Supabase (NOT Railway), so it survives every
// Railway redeploy, rebuild, or even a host migration.
//
// SETUP (one time): set two Railway environment variables:
//   SUPABASE_URL          = https://xxxxx.supabase.co
//   SUPABASE_SERVICE_KEY  = your service_role secret key
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TABLE = 'scan_events';

const analyticsEnabled = () => Boolean(SUPABASE_URL && SUPABASE_KEY);

// Low-level helper: call the Supabase REST API.
async function sb(path, options = {}) {
  const url = SUPABASE_URL + '/rest/v1/' + path;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase ' + res.status + ': ' + text);
  }
  // Some requests (inserts with Prefer: return=minimal) have empty bodies
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Record one event. type = 'scan' | 'ar_launch' | 'view_time' | 'menu_open' | 'menu_tap'
// dishKey uniquely identifies the dish: "restaurant/branch/dish"
// For 'menu_tap', extra.dishSlug names which dish was tapped from the menu —
// it's appended so the row is filed against that dish, not the menu itself.
async function recordEvent(dishKey, type, extra = {}) {
  if (!analyticsEnabled()) return; // silently no-op if not configured yet
  let key = dishKey;
  if (type === 'menu_tap' && extra.dishSlug) {
    key = dishKey.replace(/\/+$/, '') + '/' + extra.dishSlug;
  }
  const row = {
    dish_key: key,
    event_type: type,
    device: extra.device || null,
    view_ms: extra.viewMs || null,
    created_at: new Date().toISOString(),
  };
  try {
    await sb(TABLE, {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify(row),
    });
  } catch (e) {
    console.error('recordEvent failed:', e.message);
  }
}

// Read all events for one dish and compute the stats the dashboard shows.
async function getStats(dishKey) {
  if (!analyticsEnabled()) {
    return { enabled: false };
  }
  // Pull every event for this dish (encode the key for the URL)
  const rows = await sb(
    TABLE + '?dish_key=eq.' + encodeURIComponent(dishKey) + '&select=event_type,device,view_ms,created_at&order=created_at.desc&limit=100000'
  );

  const scans = rows.filter(r => r.event_type === 'scan');
  const arLaunches = rows.filter(r => r.event_type === 'ar_launch');
  const viewTimes = rows.filter(r => r.event_type === 'view_time' && r.view_ms);

  const totalViewMs = viewTimes.reduce((sum, r) => sum + (r.view_ms || 0), 0);
  const avgViewMs = viewTimes.length ? Math.round(totalViewMs / viewTimes.length) : 0;

  // device split
  const devices = { iphone: 0, android: 0, other: 0 };
  scans.forEach(r => {
    const d = (r.device || 'other').toLowerCase();
    if (d.includes('iphone') || d.includes('ios')) devices.iphone++;
    else if (d.includes('android')) devices.android++;
    else devices.other++;
  });

  // last 14 days scan counts for a mini trend
  const byDay = {};
  scans.forEach(r => {
    const day = (r.created_at || '').slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  });

  return {
    enabled: true,
    totalScans: scans.length,
    arLaunches: arLaunches.length,
    arLaunchRate: scans.length ? Math.round((arLaunches.length / scans.length) * 100) : 0,
    totalViewMs,
    avgViewMs,
    devices,
    byDay,
    lastScan: scans[0] ? scans[0].created_at : null,
  };
}

// Read all events under a branch and rank dishes by how many people tapped
// them from the menu. This is the "what are customers curious about" view.
async function getMenuStats(menuKey) {
  if (!analyticsEnabled()) return { enabled: false };
  const rows = await sb(
    TABLE + '?dish_key=like.' + encodeURIComponent(menuKey + '%') +
    '&select=dish_key,event_type,device,view_ms,created_at&order=created_at.desc&limit=100000'
  );

  const menuOpens = rows.filter(r => r.event_type === 'menu_open' && r.dish_key === menuKey);
  const menuTaps  = rows.filter(r => r.event_type === 'menu_tap');
  const dishScans = rows.filter(r => r.event_type === 'scan' && r.dish_key !== menuKey);
  const arLaunches = rows.filter(r => r.event_type === 'ar_launch');

  // Per-dish rollup keyed by the dish's own slug
  const per = {};
  function bucket(key) {
    const slug = key.split('/').pop();
    if (!per[slug]) per[slug] = { slug, taps: 0, scans: 0, ar: 0 };
    return per[slug];
  }
  menuTaps.forEach(r => { bucket(r.dish_key).taps++; });
  dishScans.forEach(r => { bucket(r.dish_key).scans++; });
  arLaunches.forEach(r => { bucket(r.dish_key).ar++; });

  const dishes = Object.values(per).sort((a, b) => (b.scans + b.taps) - (a.scans + a.taps));

  const viewTimes = rows.filter(r => r.event_type === 'view_time' && r.view_ms);
  const totalViewMs = viewTimes.reduce((s, r) => s + (r.view_ms || 0), 0);

  const byDay = {};
  menuOpens.forEach(r => {
    const d = (r.created_at || '').slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
  });

  return {
    enabled: true,
    isMenu: true,
    menuOpens: menuOpens.length,
    totalTaps: menuTaps.length,
    totalScans: dishScans.length,
    arLaunches: arLaunches.length,
    avgViewMs: viewTimes.length ? Math.round(totalViewMs / viewTimes.length) : 0,
    totalViewMs,
    dishes,
    byDay,
    lastOpen: menuOpens[0] ? menuOpens[0].created_at : null,
  };
}

module.exports = { recordEvent, getStats, getMenuStats, analyticsEnabled };
