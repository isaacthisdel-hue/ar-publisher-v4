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

// Record one event. type = 'scan' | 'ar_launch' | 'view_time'
// dishKey uniquely identifies the dish: "restaurant/branch/dish"
async function recordEvent(dishKey, type, extra = {}) {
  if (!analyticsEnabled()) return; // silently no-op if not configured yet
  const row = {
    dish_key: dishKey,
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

module.exports = { recordEvent, getStats, analyticsEnabled };
