const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const { mergeNutritionPanel } = require('./mergeNutritionPanel');
const { recordEvent, getStats, getMenuStats, analyticsEnabled } = require('./analytics');
const { manifestPath, upsertDish, buildMenuPage, MANIFEST } = require('./menu');
const { buildSocialRow, SOCIAL_CSS, cleanSocials, buildReviewBlock, REVIEW_CSS, REVIEW_I18N } = require('./social');
const { storageEnabled, storageBackend, loadRestaurants, persistUpsert, persistDelete, DATA_DIR } = require('./store');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());
app.use(cookieParser());

const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_SECRET = 'changeme' } = process.env;

// ── Restaurant store ────────────────────────────────────────────────────────
// { 'bella-italia': { name: 'Bella Italia', branches: { 'downtown': 'Downtown', 'laval': 'Laval' } } }
// Kept in memory for fast reads (same as before), but now loaded from — and
// saved back to — Supabase or a Railway Volume (see store.js) after every
// change, so it survives redeploys instead of resetting on every restart.
// Populated just before app.listen() below, once the initial load resolves.
let restaurants = {};

function signToken(t) { return Buffer.from(COOKIE_SECRET + '|' + t).toString('base64'); }
function unsignToken(s) {
  try {
    const d = Buffer.from(s, 'base64').toString('utf8');
    const [sec, ...rest] = d.split('|');
    if (sec !== COOKIE_SECRET) return null;
    return rest.join('|');
  } catch { return null; }
}
function getToken(req) { return unsignToken(req.cookies.gh_token || ''); }
function slugify(str) { return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

// ── AUTH ──────────────────────────────────────────────────────────────────────

app.get('/auth/login', (req, res) => {
  res.redirect('https://github.com/login/oauth/authorize?client_id=' + GITHUB_CLIENT_ID + '&scope=repo');
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/');
  try {
    const r = await axios.post('https://github.com/login/oauth/access_token',
      { client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code },
      { headers: { Accept: 'application/json' } });
    const token = r.data.access_token;
    if (!token) return res.redirect('/');
    res.cookie('gh_token', signToken(token), { httpOnly: true, maxAge: 30*24*60*60*1000 });
    res.redirect('/');
  } catch { res.redirect('/'); }
});

app.get('/auth/logout', (req, res) => { res.clearCookie('gh_token'); res.redirect('/'); });

// ── RESTAURANT API ────────────────────────────────────────────────────────────

// Get all restaurants
app.get('/api/restaurants', (req, res) => {
  if (!getToken(req)) return res.status(401).json({ error: 'Not logged in' });
  res.json(restaurants);
});

// Add restaurant or add branch to existing restaurant
app.post('/api/restaurants', (req, res) => {
  if (!getToken(req)) return res.status(401).json({ error: 'Not logged in' });
  const { name, branch } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Restaurant name required' });

  const slug = slugify(name);
  if (!restaurants[slug]) {
    restaurants[slug] = { name: name.trim(), branches: {}, socials: {}, reviewUrl: '', signed: false };
  }

  if (branch && branch.trim()) {
    const bSlug = slugify(branch);
    restaurants[slug].branches[bSlug] = branch.trim();
  }

  persistUpsert(slug, restaurants[slug], restaurants);
  res.json({ success: true, slug, restaurant: restaurants[slug] });
});

// Update a restaurant's social links (Instagram, TikTok, etc.)
app.put('/api/restaurants/:slug/socials', (req, res) => {
  if (!getToken(req)) return res.status(401).json({ error: 'Not logged in' });
  const { slug } = req.params;
  if (!restaurants[slug]) return res.status(404).json({ error: 'Restaurant not found' });
  restaurants[slug].socials = cleanSocials(req.body || {});
  persistUpsert(slug, restaurants[slug], restaurants);
  res.json({ success: true, slug, socials: restaurants[slug].socials });
});

// Update a restaurant's Google review link.
app.put('/api/restaurants/:slug/review', (req, res) => {
  if (!getToken(req)) return res.status(401).json({ error: 'Not logged in' });
  const { slug } = req.params;
  if (!restaurants[slug]) return res.status(404).json({ error: 'Restaurant not found' });
  const url = (req.body && req.body.reviewUrl || '').trim();
  restaurants[slug].reviewUrl = url;
  persistUpsert(slug, restaurants[slug], restaurants);
  res.json({ success: true, slug, reviewUrl: url });
});

// Mark a restaurant as signed (counts toward the mission target) or unmark (a test).
app.put('/api/restaurants/:slug/signed', (req, res) => {
  if (!getToken(req)) return res.status(401).json({ error: 'Not logged in' });
  const { slug } = req.params;
  if (!restaurants[slug]) return res.status(404).json({ error: 'Restaurant not found' });
  restaurants[slug].signed = !!(req.body && req.body.signed);
  persistUpsert(slug, restaurants[slug], restaurants);
  res.json({ success: true, slug, signed: restaurants[slug].signed });
});

// Add branch to existing restaurant
app.post('/api/restaurants/:slug/branches', (req, res) => {
  if (!getToken(req)) return res.status(401).json({ error: 'Not logged in' });
  const { slug } = req.params;
  const { branch } = req.body;
  if (!restaurants[slug]) return res.status(404).json({ error: 'Restaurant not found' });
  if (!branch || !branch.trim()) return res.status(400).json({ error: 'Branch name required' });

  const bSlug = slugify(branch);
  restaurants[slug].branches[bSlug] = branch.trim();
  persistUpsert(slug, restaurants[slug], restaurants);
  res.json({ success: true, slug, restaurant: restaurants[slug] });
});

// Delete restaurant
app.delete('/api/restaurants/:slug', (req, res) => {
  if (!getToken(req)) return res.status(401).json({ error: 'Not logged in' });
  const slug = req.params.slug;
  delete restaurants[slug];
  persistDelete(slug, restaurants);
  res.json({ success: true });
});

// Delete branch
app.delete('/api/restaurants/:slug/branches/:bSlug', (req, res) => {
  if (!getToken(req)) return res.status(401).json({ error: 'Not logged in' });
  const { slug, bSlug } = req.params;
  if (restaurants[slug]) {
    delete restaurants[slug].branches[bSlug];
    persistUpsert(slug, restaurants[slug], restaurants);
  }
  res.json({ success: true });
});

// Past dishes published for a restaurant (optionally scoped to one branch —
// pass ?branch=<bSlug>, or omit for a branch-less restaurant's repo root).
// No new storage needed: dishes.json already lives forever in the
// restaurant's GitHub repo (see menu.js) — this just reads it back, the
// same way the live customer-facing menu page does.
app.get('/api/restaurants/:slug/dishes', async (req, res) => {
  if (!getToken(req)) return res.status(401).json({ error: 'Not logged in' });
  const { slug } = req.params;
  if (!restaurants[slug]) return res.status(404).json({ error: 'Restaurant not found' });
  const branchSlug = (req.query.branch || '').toString();
  const repoName = 'ar-' + slug;
  try {
    const manifest = await fetchManifest(repoName, branchSlug);
    const dishes = manifest && Array.isArray(manifest.dishes) ? manifest.dishes : [];
    res.json({ success: true, dishes });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load dishes: ' + (e.message || e) });
  }
});

// ── PUBLISH ───────────────────────────────────────────────────────────────────

// ── NUTRITION PANEL GENERATOR ─────────────────────────────────────────────────
// Bakes a flat "nutrition card" plane directly into the GLB geometry, next to
// the dish. Returns the enhanced GLB as a download — import this into Blender
// and export to USDZ to get the panel on iPhone AR too.
app.post('/generate-nutrition-glb', upload.single('glbFile'), async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const glbFile = req.file;
  if (!glbFile) return res.status(400).json({ error: 'Missing .glb file' });

  const nutrition = {
    calories: (req.body.calories || '').trim(),
    protein: (req.body.protein || '').trim(),
    carbs: (req.body.carbs || '').trim(),
    fat: (req.body.fat || '').trim(),
    allergens: (req.body.allergens || '').trim(),
    spiceLevel: (req.body.spiceLevel || '').trim(),
  };

  try {
    const mergedBuffer = await mergeNutritionPanel(glbFile.buffer, nutrition);
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Disposition', 'attachment; filename="model-with-nutrition.glb"');
    res.send(mergedBuffer);
  } catch (err) {
    console.error('Nutrition panel merge error:', err.message);
    res.status(500).json({ error: 'Failed to generate enhanced GLB: ' + err.message });
  }
});

app.post('/publish', upload.fields([
  { name: 'glbFile',  maxCount: 1 },
  { name: 'usdzFile', maxCount: 1 },
  { name: 'logoFile', maxCount: 1 }
]), async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const dishName       = (req.body.dishName    || 'My Dish').trim();
  const brandName      = (req.body.brandName   || '').trim();
  const topLabel       = (req.body.topLabel    || '').trim();
  const theme          = (req.body.theme       || 'dark-elegant').trim();
  const restaurantSlug = (req.body.restaurant  || '').trim();
  const branchSlug     = (req.body.branch      || '').trim();
  const glbFile        = req.files?.glbFile?.[0];
  const usdzFile       = req.files?.usdzFile?.[0];
  const logoFile       = req.files?.logoFile?.[0];

  if (!glbFile)        return res.status(400).json({ error: 'Missing .glb file' });
  if (!usdzFile)       return res.status(400).json({ error: 'Missing .usdz file' });
  if (!brandName && !logoFile) return res.status(400).json({ error: 'Please enter a company name or upload a logo' });
  if (!restaurantSlug) return res.status(400).json({ error: 'Please select a restaurant' });

  const restaurant = restaurants[restaurantSlug];
  if (!restaurant)     return res.status(400).json({ error: 'Restaurant not found. Please add it first.' });

  let username;
  try {
    const { data } = await axios.get('https://api.github.com/user', {
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'Servision' }, timeout: 8000
    });
    username = data.login;
  } catch { return res.status(401).json({ error: 'Could not verify GitHub user' }); }

  // One repo per restaurant
  const repoName   = 'ar-' + restaurantSlug;
  const dishSlug   = slugify(dishName);
  // Folder: branch/dish or just dish if no branch
  const folderPath = branchSlug ? branchSlug + '/' + dishSlug : dishSlug;

  const ghHeaders = {
    Authorization: 'Bearer ' + token,
    'User-Agent': 'Servision',
    Accept: 'application/vnd.github+json'
  };

  // Create repo if needed
  try {
    await axios.post('https://api.github.com/user/repos', {
      name: repoName,
      description: 'AR menu for ' + restaurant.name,
      private: false,
      auto_init: false
    }, { headers: ghHeaders });
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    if (!msg.includes('already exists')) return res.status(500).json({ error: 'Could not create repo: ' + msg });
  }

  async function pushFile(filePath, contentBuffer) {
    const url = 'https://api.github.com/repos/' + username + '/' + repoName + '/contents/' + filePath;
    let sha;
    try { const e = await axios.get(url, { headers: ghHeaders }); sha = e.data.sha; } catch {}
    const body = { message: 'Add ' + filePath, content: contentBuffer.toString('base64') };
    if (sha) body.sha = sha;
    await axios.put(url, body, { headers: ghHeaders });
  }

  let logoFileName = null;
  if (logoFile) {
    const ext = logoFile.originalname.split('.').pop().toLowerCase();
    logoFileName = 'logo.' + ext;
  }

  try {
    await pushFile(folderPath + '/index.html', Buffer.from(buildARPage(dishName, brandName, topLabel, logoFileName, theme, restaurant.socials, restaurant.reviewUrl), 'utf8'));
    await pushFile(folderPath + '/model.glb',  glbFile.buffer);
    await pushFile(folderPath + '/model.usdz', usdzFile.buffer);
    if (logoFile && logoFileName) await pushFile(folderPath + '/' + logoFileName, logoFile.buffer);

    // ── MENU MANIFEST ──────────────────────────────────────────────────────
    // Keep <branch>/dishes.json in sync so the single-QR menu page always
    // lists every dish. Read → merge → push. Never blocks publishing.
    try {
      const mPath = manifestPath(branchSlug);
      const mUrl = 'https://api.github.com/repos/' + username + '/' + repoName + '/contents/' + mPath;
      let existing = {};
      try {
        const cur = await axios.get(mUrl, { headers: ghHeaders });
        existing = JSON.parse(Buffer.from(cur.data.content, 'base64').toString('utf8'));
      } catch { /* first dish in this branch — start fresh */ }

      const merged = upsertDish(existing, {
        slug: dishSlug,
        name: dishName,
        label: topLabel,
        _restaurant: restaurant.name || restaurantSlug,
        _branch: branchSlug,
        _brandName: brandName,
        _logo: logoFileName,
        _theme: theme,
        _socials: restaurant.socials || {},
        _reviewUrl: restaurant.reviewUrl || '',
      });

      // Logo lives in the dish folder; for the menu page we also drop a copy
      // at the branch root so the manifest can reference it directly.
      if (logoFile && logoFileName) {
        const branchLogo = branchSlug ? branchSlug + '/' + logoFileName : logoFileName;
        try { await pushFile(branchLogo, logoFile.buffer); } catch {}
      }

      await pushFile(mPath, Buffer.from(JSON.stringify(merged, null, 2), 'utf8'));
    } catch (mErr) {
      console.error('Manifest update failed (dish still published):', mErr.message);
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to push files: ' + (err.response?.data?.message || err.message) });
  }

  // Enable Pages
  try {
    await axios.post('https://api.github.com/repos/' + username + '/' + repoName + '/pages',
      { source: { branch: 'main', path: '/' } }, { headers: ghHeaders });
  } catch (err) {
    if (err.response?.status !== 409) console.error('Pages error:', err.response?.data || err.message);
  }

  const liveUrl = 'https://ar.servision.ca/' + restaurantSlug + '/' + folderPath;
  const repoUrl = 'https://github.com/' + username + '/' + repoName;
  // Single-QR menu page: one code on the table, every dish inside.
  const menuUrl = 'https://ar.servision.ca/' + restaurantSlug + (branchSlug ? '/' + branchSlug : '') + '/';

  res.json({ success: true, repoUrl, liveUrl, menuUrl });
});


// ── AR PROXY ──────────────────────────────────────────────────────────────────
// Catches ar.servision.ca/restaurant/branch/dish and proxies GitHub Pages
// URL stays as ar.servision.ca — GitHub never shows in the browser

const https = require('https');
const GITHUB_USERNAME = 'isaacthisdel-hue';

function proxyFromGitHub(githubPath, req, res, depth) {
  if (depth > 4) { res.writeHead(508); return res.end('Too many redirects'); }

  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 Servision-Proxy/1.0',
    'Accept': req.headers['accept'] || '*/*',
  };
  // Only forward Range if the browser actually sent one — an empty
  // Range header can cause GitHub's CDN to behave unexpectedly
  if (req.headers['range']) reqHeaders['Range'] = req.headers['range'];

  const options = {
    hostname: GITHUB_USERNAME + '.github.io',
    path: githubPath,
    method: req.method || 'GET',
    headers: reqHeaders
  };

  const proxyReq = https.request(options, (proxyRes) => {
    const status = proxyRes.statusCode;
    let contentType = proxyRes.headers['content-type'] || 'application/octet-stream';

    // Force correct MIME types — iOS Quick Look and Android Scene Viewer
    // will silently refuse to launch AR if these are wrong, with no visible error
    if (githubPath.endsWith('.usdz')) {
      contentType = 'model/vnd.usdz+zip';
    } else if (githubPath.endsWith('.glb')) {
      contentType = 'model/gltf-binary';
    }

    if (status === 301 || status === 302) {
      let newPath = proxyRes.headers['location'] || '';
      try { newPath = new URL(newPath).pathname; } catch {}
      proxyRes.resume();
      return proxyFromGitHub(newPath, req, res, depth + 1);
    }

    const headers = {
      'Content-Type': contentType,
      'Cache-Control': (githubPath.endsWith('.glb') || githubPath.endsWith('.usdz'))
        ? 'public, max-age=3600'
        : 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };

    // CRITICAL: if GitHub's CDN compressed the response, we must tell the
    // browser so it decompresses correctly — otherwise model-viewer receives
    // corrupted binary data, fails to load the model silently, and AR never activates
    if (proxyRes.headers['content-encoding']) {
      headers['Content-Encoding'] = proxyRes.headers['content-encoding'];
    } else if (proxyRes.headers['content-length']) {
      headers['Content-Length'] = proxyRes.headers['content-length'];
    }
    if (proxyRes.headers['content-range']) {
      headers['Content-Range'] = proxyRes.headers['content-range'];
    }
    // iOS Quick Look requires Accept-Ranges: bytes to preview USDZ files —
    // force it for model files even if GitHub doesn't send it explicitly
    if (githubPath.endsWith('.usdz') || githubPath.endsWith('.glb')) {
      headers['Accept-Ranges'] = 'bytes';
    } else if (proxyRes.headers['accept-ranges']) {
      headers['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
    }

    res.writeHead(status, headers);

    // HEAD requests must never include a body — iOS Quick Look sends HEAD
    // first to check file info, and a body here can break its preflight check
    if (req.method === 'HEAD') {
      proxyRes.resume();
      return res.end();
    }

    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) { res.writeHead(502); res.end('Gateway error'); }
  });

  proxyReq.end();
}

// Catches requests coming from ar.servision.ca
// ── ANALYTICS TRACKING ────────────────────────────────────────────────────────
// The AR pages POST here when opened, when AR launches, and when the visitor
// leaves (with view time). CORS-open so the GitHub-hosted pages can reach it.
app.post('/track', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { dishKey, type, device, viewMs, dishSlug } = req.body || {};
  if (!dishKey || !type) return res.status(400).json({ ok: false });
  await recordEvent(dishKey, type, { device, viewMs, dishSlug });
  res.json({ ok: true });
});
app.options('/track', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// Serve the analytics dashboard HTML for a dish, or for a whole branch menu.
// 3+ segments  → single dish dashboard
// 1-2 segments → menu dashboard (which dishes are people curious about)
async function serveDashboard(dishKey, res) {
  try {
    const depth = dishKey.split('/').filter(Boolean).length;
    const stats = depth >= 3 ? await getStats(dishKey) : await getMenuStats(dishKey);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(buildDashboardPage(dishKey, stats));
  } catch (e) {
    res.status(500).send('<h1>Dashboard error</h1><p>' + (e.message || e) + '</p>');
  }
}

// ── SINGLE-QR MENU ───────────────────────────────────────────────────────────
// Fetches <branch>/dishes.json straight from GitHub Pages (no API, no rate
// limit, no auth) and renders the menu index live. If no manifest exists the
// path isn't a menu at all — fall through to the normal GitHub proxy so
// branch-less dish pages keep working.
function fetchManifest(repoName, branchSlug) {
  const path = '/' + repoName + '/' + (branchSlug ? branchSlug + '/' : '') + MANIFEST;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: GITHUB_USERNAME + '.github.io',
      path,
      method: 'GET',
      headers: { 'User-Agent': 'Servision-Menu/1.0', 'Accept': 'application/json' }
    }, (r) => {
      if (r.statusCode === 301 || r.statusCode === 302) { r.resume(); return resolve(null); }
      if (r.statusCode !== 200) { r.resume(); return resolve(null); }
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { body += c; });
      r.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function serveMenu(repoName, restaurantSlug, branchSlug, req, res) {
  const manifest = await fetchManifest(repoName, branchSlug);

  // No manifest → this isn't a menu root. Most likely a dish published
  // without a branch (ar.servision.ca/<restaurant>/<dish>/). Proxy it.
  if (!manifest || !Array.isArray(manifest.dishes)) {
    const rest = branchSlug ? branchSlug + '/' : '';
    return proxyFromGitHub('/' + repoName + '/' + rest, req, res, 0);
  }

  const basePath = '/' + restaurantSlug + (branchSlug ? '/' + branchSlug : '') + '/';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(buildMenuPage(manifest, basePath));
}

app.use((req, res, next) => {
  const host = req.headers.host || '';
  const isArSubdomain = host.startsWith('ar.');
  if (!isArSubdomain) return next();

  const rawPath = req.path.replace(/^\//, '');
  const parts = rawPath.split('/').filter(Boolean);

  if (parts.length === 0) {
    return res.redirect(302, 'https://www.servision.ca');
  }

  const restaurantSlug = parts[0];
  const rest = parts.slice(1).join('/');
  const repoName = 'ar-' + restaurantSlug;

  // ── DASHBOARD: ar.servision.ca/<rest>/<branch>/<dish>/dashboard ──
  // Intercept before proxying to GitHub — serve the analytics dashboard.
  if (parts[parts.length - 1].toLowerCase() === 'dashboard') {
    const dishKey = parts.slice(0, -1).join('/'); // everything except "dashboard"
    return serveDashboard(dishKey, res);
  }

  // Check if this is a file request (has extension) or a page request
  const isFile = rest && /\.[a-z0-9]+$/i.test(rest);
  // Also catch a file at the very root of the domain (e.g. /favicon.ico),
  // where `rest` is empty but the first segment has an extension.
  const isRootFile = parts.length === 1 && /\.[a-z0-9]+$/i.test(parts[0]);

  // ── SINGLE-QR MENU PAGE ────────────────────────────────────────────────
  // ar.servision.ca/<restaurant>/            → menu of dishes at repo root
  // ar.servision.ca/<restaurant>/<branch>/   → menu of that branch
  // Only fires when the path has no file extension and is 1–2 segments deep,
  // so dish pages (3 segments) and assets always pass through untouched.
  if (!isFile && !isRootFile && parts.length <= 2) {
    if (!req.path.endsWith('/')) return res.redirect(302, req.path + '/');
    const branchForMenu = parts.length === 2 ? parts[1] : '';
    return serveMenu(repoName, restaurantSlug, branchForMenu, req, res);
  }

  // CRITICAL: if this is a page (not a file) and the URL has no trailing slash,
  // redirect to add one. Without it, the browser resolves relative paths like
  // "model.glb" incorrectly (it drops the last path segment), causing 404s.
  if (!isFile && !isRootFile && !req.path.endsWith('/')) {
    return res.redirect(302, req.path + '/');
  }

  const githubPath = isRootFile
    ? '/' + repoName + '/' + parts[0]      // file sitting at the repo root
    : isFile
      ? '/' + repoName + '/' + rest        // file: no trailing slash
      : rest
        ? '/' + repoName + '/' + rest + '/'  // page: trailing slash
        : '/' + repoName + '/';              // root: trailing slash

  proxyFromGitHub(githubPath, req, res, 0);
});

// ── MAIN PAGE ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const token = getToken(req);
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buildHTML(!!token));
});

// Renders the analytics dashboard for one dish.
function buildDashboardPage(dishKey, stats) {
  const parts = dishKey.split('/');
  const dishName = (parts[parts.length - 1] || 'Dish').replace(/-/g, ' ');
  const restaurant = (parts[0] || '').replace(/-/g, ' ');

  if (!stats.enabled) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard — ${dishName}</title></head>
<body style="font-family:system-ui;background:#111009;color:#F2EDE4;padding:40px;text-align:center">
<h1 style="text-transform:capitalize">${dishName}</h1>
<p style="color:#C8873A">Analytics not connected yet.</p>
<p style="color:rgba(242,237,228,0.5);max-width:400px;margin:20px auto">The SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables need to be set in Railway to start collecting scan data.</p>
</body></html>`;
  }

  // ── MENU-LEVEL DASHBOARD ────────────────────────────────────────────────
  if (stats.isMenu) return buildMenuDashboard(dishKey, stats);

  const fmtTime = (ms) => {
    if (!ms) return '0s';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m + 'm ' + (s % 60) + 's';
  };

  // Build a simple 14-day bar trend
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, label: key.slice(5), count: stats.byDay[key] || 0 });
  }
  const maxDay = Math.max(1, ...days.map(d => d.count));
  const bars = days.map(d =>
    `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
       <div style="width:100%;background:#C8873A;border-radius:3px 3px 0 0;height:${Math.round((d.count / maxDay) * 90)}px;min-height:2px" title="${d.count} scans"></div>
       <div style="font-size:8px;color:rgba(242,237,228,0.4);transform:rotate(-45deg);white-space:nowrap">${d.label}</div>
     </div>`
  ).join('');

  const lastScan = stats.lastScan ? new Date(stats.lastScan).toLocaleString() : 'Never';

  const card = (label, value, sub) =>
    `<div style="background:#1A1812;border:1px solid rgba(200,135,58,0.2);border-radius:12px;padding:22px">
       <div style="font-size:12px;color:rgba(242,237,228,0.5);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">${label}</div>
       <div style="font-size:34px;font-weight:700;color:#F2EDE4">${value}</div>
       ${sub ? `<div style="font-size:12px;color:#C8873A;margin-top:4px">${sub}</div>` : ''}
     </div>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard — ${dishName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#111009;color:#F2EDE4;padding:24px;max-width:760px;margin:0 auto}
h1{text-transform:capitalize;font-size:26px;margin-bottom:2px}
.sub{color:rgba(242,237,228,0.5);font-size:13px;margin-bottom:24px;text-transform:capitalize}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:14px}
.wide{background:#1A1812;border:1px solid rgba(200,135,58,0.2);border-radius:12px;padding:22px}
@media(min-width:560px){.grid{grid-template-columns:repeat(4,1fr)}}
</style></head>
<body>
<h1>${dishName}</h1>
<div class="sub">${restaurant} · Servision Analytics</div>

<div class="grid">
  ${card('Total Scans', stats.totalScans, stats.totalScans > 0 ? 'people viewed this dish' : 'no scans yet')}
  ${card('AR Launches', stats.arLaunches, stats.arLaunchRate + '% tapped to view in AR')}
  ${card('Avg View Time', fmtTime(stats.avgViewMs), 'per visitor')}
  ${card('Total View Time', fmtTime(stats.totalViewMs), 'all visitors combined')}
</div>

<div class="wide" style="margin-bottom:14px">
  <div style="font-size:12px;color:rgba(242,237,228,0.5);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:16px">Scans — last 14 days</div>
  <div style="display:flex;align-items:flex-end;gap:5px;height:110px">${bars}</div>
</div>

<div class="grid" style="grid-template-columns:repeat(3,1fr)">
  ${card('iPhone', stats.devices.iphone)}
  ${card('Android', stats.devices.android)}
  ${card('Other', stats.devices.other)}
</div>

<div style="text-align:center;color:rgba(242,237,228,0.35);font-size:11px;margin-top:24px">
  Last scan: ${lastScan} · Updates live
</div>
</body></html>`;
}

// Menu-level dashboard: which dishes are customers actually curious about.
function buildMenuDashboard(menuKey, s) {
  const parts = menuKey.split('/').filter(Boolean);
  const title = (parts[parts.length - 1] || 'Menu').replace(/-/g, ' ');
  const restaurant = (parts[0] || '').replace(/-/g, ' ');

  const fmtTime = (ms) => {
    if (!ms) return '0s';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + 's';
    return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  };

  const card = (label, value, sub) =>
    `<div style="background:#1A1812;border:1px solid rgba(200,135,58,0.2);border-radius:12px;padding:22px">
       <div style="font-size:12px;color:rgba(242,237,228,0.5);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">${label}</div>
       <div style="font-size:34px;font-weight:700;color:#F2EDE4">${value}</div>
       ${sub ? `<div style="font-size:12px;color:#C8873A;margin-top:4px">${sub}</div>` : ''}
     </div>`;

  const maxInterest = Math.max(1, ...s.dishes.map(d => d.scans + d.taps));
  const rows = s.dishes.length ? s.dishes.map((d, i) => {
    const interest = d.scans + d.taps;
    const pct = Math.round((interest / maxInterest) * 100);
    const name = d.slug.replace(/-/g, ' ');
    return `<div style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <div style="font-size:15px;text-transform:capitalize">
          <span style="color:#C8873A;font-weight:700;margin-right:8px">${i + 1}</span>${name}
        </div>
        <div style="font-size:12px;color:rgba(242,237,228,0.5)">${interest} views · ${d.ar} in AR</div>
      </div>
      <div style="height:8px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:#C8873A;border-radius:4px"></div>
      </div>
    </div>`;
  }).join('') : '<div style="color:rgba(242,237,228,0.45);text-align:center;padding:30px">No dish views yet — once customers start scanning the table QR, the most-wanted dishes appear here.</div>';

  const lastOpen = s.lastOpen ? new Date(s.lastOpen).toLocaleString() : 'Never';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Menu Dashboard — ${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#111009;color:#F2EDE4;padding:24px;max-width:780px;margin:0 auto}
h1{text-transform:capitalize;font-size:26px;margin-bottom:2px}
.sub{color:rgba(242,237,228,0.5);font-size:13px;margin-bottom:24px;text-transform:capitalize}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:14px}
.wide{background:#1A1812;border:1px solid rgba(200,135,58,0.2);border-radius:12px;padding:24px}
@media(min-width:600px){.grid{grid-template-columns:repeat(4,1fr)}}
</style></head><body>
<h1>${title} — Menu</h1>
<div class="sub">${restaurant} · Servision Analytics</div>

<div class="grid">
  ${card('Menu Opens', s.menuOpens, 'table QR scans')}
  ${card('Dish Views', s.totalScans + s.totalTaps, 'dishes opened')}
  ${card('AR Launches', s.arLaunches, 'viewed on the table')}
  ${card('Avg Time', fmtTime(s.avgViewMs), 'per visitor')}
</div>

<div class="wide">
  <div style="font-size:12px;color:rgba(242,237,228,0.5);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Most wanted dishes</div>
  <div style="font-size:12px;color:rgba(242,237,228,0.4);margin-bottom:20px;line-height:1.5">Ranked by how many customers opened each dish. High interest + low sales usually means people are curious but hesitating — worth a better description, a photo, or a price look.</div>
  ${rows}
</div>

<div style="text-align:center;color:rgba(242,237,228,0.35);font-size:11px;margin-top:24px">
  Last menu scan: ${lastOpen} · Updates live
</div>
</body></html>`;
}

const PORT = process.env.PORT || 8080;
loadRestaurants().then((loaded) => {
  restaurants = loaded;
}).catch((e) => {
  console.error('Failed to load restaurants at startup:', e.message);
}).finally(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('Servision running on port ' + PORT);
    const backend = storageBackend();
    if (backend === 'supabase') {
      console.log('Restaurant data persisted to Supabase — survives redeploys.');
    } else if (backend === 'volume') {
      console.log('Restaurant data persisted to ' + DATA_DIR + ' (Railway Volume attached).');
    } else {
      console.log(
        'WARNING: no persistence backend configured — restaurant data will NOT survive a redeploy. ' +
        'Either it will use the same SUPABASE_URL/SUPABASE_SERVICE_KEY as analytics automatically once ' +
        'those are set, or attach a Railway Volume (Settings -> Volumes) mounted at ' + DATA_DIR + '.'
      );
    }
  });
});

// ── PUBLISHER UI ──────────────────────────────────────────────────────────────

function buildHTML(loggedIn) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Servision Publisher</title>
<script type="importmap">
{
  "imports": {
    "three": "https://unpkg.com/three@0.185.1/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.185.1/examples/jsm/"
  }
}
</script>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Archivo+Narrow:wght@500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#D8CFBB;--panel:#E1D8C4;--panel2:#DBD1BC;
  --ink:#1A1610;--ink-soft:#4A3F30;--ink-faint:#7A6E5C;
  --bronze:#7A5A2E;--bronze-deep:#5A4020;--bronze-glow:rgba(122,90,46,0.14);
  --line:rgba(26,22,16,0.16);--line-strong:rgba(26,22,16,0.28);
  --green:#3E5A2E;--red:#8A3226;
  --amber:var(--bronze);--surface:var(--panel);--surface2:var(--panel2);--border:var(--line);--muted:var(--ink-soft);--cream:var(--ink);
  --disp:'Archivo Narrow',sans-serif;--body:'Archivo',sans-serif;--mono:'JetBrains Mono',monospace}
html,body{min-height:100%;background:var(--bg);color:var(--ink);font-family:var(--body)}
body{background:
  radial-gradient(1400px 700px at 15% -10%, rgba(122,90,46,0.08), transparent 55%),
  radial-gradient(1000px 600px at 100% 110%, rgba(122,90,46,0.05), transparent 55%),
  var(--bg);
  background-attachment:fixed}

/* ── APP SHELL: sidebar + workspace ──────────────────────────────── */
body.app{display:grid;grid-template-columns:248px 1fr;grid-template-rows:100vh;padding:0;overflow:hidden}
.sidebar{
  background:linear-gradient(180deg, var(--panel), var(--panel2));
  border-right:1px solid var(--line);
  display:flex;flex-direction:column;padding:28px 20px;height:100vh;position:relative}
.brand{display:flex;align-items:center;margin-bottom:2px;padding-left:2px}
.brand-img{width:100%;max-width:200px;height:auto;display:block}
.brand-mark{font-family:var(--disp);font-size:26px;font-weight:800;letter-spacing:.01em;font-style:italic;color:var(--ink);line-height:1}
.brand-mark span{color:var(--ink)}
.brand-tag{font-family:var(--mono);font-size:9px;letter-spacing:.3em;text-transform:uppercase;color:var(--ink-faint);margin:10px 0 36px;padding-left:3px}
.nav{display:flex;flex-direction:column;gap:3px}
.nav-item{display:flex;align-items:center;gap:13px;padding:11px 14px;border-radius:9px;
  background:none;border:1px solid transparent;color:var(--ink-soft);font-family:var(--body);font-size:13.5px;font-weight:500;
  cursor:pointer;text-align:left;width:100%;transition:all .16s}
.nav-item:hover{background:var(--bronze-glow);color:var(--ink)}
.nav-item.active{background:var(--bronze-glow);border-color:rgba(154,123,79,.30);color:var(--bronze-deep);font-weight:600}
.nav-item .ico{font-size:9px;font-family:var(--mono);width:16px;text-align:center;letter-spacing:0}
.sidebar-foot{margin-top:auto;padding-top:20px;border-top:1px solid var(--line)}
.status-pill{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:10px;letter-spacing:.05em;color:var(--ink-soft);margin-bottom:14px}
.status-dot{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(92,122,74,.16);animation:livePulse 2.6s ease-in-out infinite}
@keyframes livePulse{0%,100%{opacity:1}50%{opacity:.4}}
.logout-btn{display:block;width:100%;text-align:center;background:none;border:1px solid var(--line);color:var(--ink-soft);
  font-size:12px;padding:9px;border-radius:8px;cursor:pointer;font-family:var(--body);text-decoration:none;transition:all .16s}
.logout-btn:hover{border-color:var(--bronze);color:var(--ink)}

/* workspace */
.workspace{height:100vh;overflow-y:auto;padding:0;background:var(--bg)}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:flex-end;justify-content:space-between;
  padding:24px 44px 20px;background:color-mix(in srgb,var(--bg) 88%, transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.topbar-title{font-family:var(--disp);font-size:26px;font-weight:700;line-height:1;color:var(--ink);letter-spacing:.01em;text-transform:uppercase}
.topbar-sub{font-size:12.5px;color:var(--ink-soft);margin-top:6px}
.topbar-meta{display:flex;gap:30px;align-items:flex-end}
.metric{text-align:right}
.metric-num{font-family:var(--mono);font-size:20px;font-weight:700;color:var(--bronze-deep);font-variant-numeric:tabular-nums;line-height:1}
.metric-lbl{font-family:var(--mono);font-size:8.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint);margin-top:5px}
.workspace-inner{padding:32px 44px 90px;max-width:1200px}

/* section visibility */
.section{display:none}
.section.active{display:block;animation:fadeUp .42s cubic-bezier(.2,.7,.2,1)}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.card{width:100%;max-width:100%;background:transparent;border:none;border-radius:0;padding:0;box-shadow:none}
header.legacy,.tabs{display:none}

/* ── COMMAND CENTER ──────────────────────────────────────────────── */
.cc-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:20px;margin-bottom:20px}
.cc-hero{background:linear-gradient(158deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:18px;padding:34px 36px;position:relative;overflow:hidden}
.cc-hero::before{content:"";position:absolute;inset:0;background:radial-gradient(520px 300px at 88% -20%,var(--bronze-glow),transparent 62%);pointer-events:none}
.cc-eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--bronze-deep);margin-bottom:20px;display:flex;align-items:center;gap:9px}
.cc-eyebrow::before{content:"";width:22px;height:1px;background:var(--bronze)}
.cc-bignum{font-family:var(--disp);font-style:italic;font-weight:800;font-size:112px;line-height:.82;color:var(--ink);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.cc-bignum .of{color:var(--ink-faint);font-size:52px;font-style:italic}
.cc-biglbl{font-family:var(--body);font-size:14px;color:var(--ink-soft);margin-top:14px;letter-spacing:.01em}
.cc-biglbl b{color:var(--ink);font-weight:600}
.cc-progress{height:8px;background:rgba(28,26,22,.08);border-radius:5px;margin-top:22px;overflow:hidden}
.cc-progress-fill{height:100%;background:linear-gradient(90deg,var(--bronze),var(--bronze-deep));border-radius:5px;transition:width 1s cubic-bezier(.2,.7,.2,1)}
.cc-side{display:flex;flex-direction:column;gap:20px}
.cc-count{background:var(--ink);color:var(--panel);border-radius:18px;padding:28px 30px;position:relative;overflow:hidden;flex:1;display:flex;flex-direction:column;justify-content:center}
.cc-count::after{content:"";position:absolute;right:-30px;bottom:-30px;width:150px;height:150px;border:1px solid rgba(245,241,232,.08);border-radius:50%}
.cc-count-lbl{font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:rgba(245,241,232,.5);margin-bottom:12px}
.cc-count-num{font-family:var(--mono);font-size:56px;font-weight:700;line-height:.9;color:var(--panel);font-variant-numeric:tabular-nums}
.cc-count-unit{font-size:13px;color:rgba(245,241,232,.6);margin-top:8px}
.cc-count-num.warn{color:#E8B04A}
.cc-quote{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px 30px;position:relative}
.cc-quote-mark{font-family:var(--disp);font-style:italic;font-size:40px;color:var(--bronze);line-height:.6;opacity:.5}
.cc-quote-text{font-family:var(--disp);font-size:20px;font-weight:600;font-style:italic;color:var(--ink);line-height:1.24;margin-top:6px}
.cc-statrow{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:20px}
.cc-stat{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px 26px}
.cc-stat-num{font-family:var(--mono);font-size:32px;font-weight:700;color:var(--ink);line-height:1;font-variant-numeric:tabular-nums}
.cc-stat-lbl{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);margin-top:10px}
.cc-milestones{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:28px 32px}
.cc-mile-head{font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink-soft);margin-bottom:22px}
.cc-mile-track{display:flex;gap:14px;flex-wrap:wrap}
.cc-mile{flex:1;min-width:120px;border:1px solid var(--line);border-radius:12px;padding:18px 16px;text-align:center;position:relative;transition:all .2s}
.cc-mile.on{border-color:var(--bronze);background:var(--bronze-glow)}
.cc-mile-ico{font-size:20px;margin-bottom:8px;filter:grayscale(1);opacity:.35}
.cc-mile.on .cc-mile-ico{filter:none;opacity:1}
.cc-mile-name{font-size:12px;font-weight:600;color:var(--ink-soft)}
.cc-mile.on .cc-mile-name{color:var(--ink)}
.cc-mile-sub{font-family:var(--mono);font-size:9px;color:var(--ink-faint);margin-top:3px;text-transform:uppercase;letter-spacing:.08em}
.cc-mile.on .cc-mile-sub{color:var(--bronze-deep)}

@media(max-width:900px){.cc-grid{grid-template-columns:1fr}.cc-bignum{font-size:88px}}
@media(max-width:820px){
  body.app{grid-template-columns:1fr;grid-template-rows:auto 1fr;overflow:auto}
  .sidebar{height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:12px;padding:14px 18px}
  .brand-tag{display:none}.brand{margin:0 auto 0 0}
  .nav{flex-direction:row;gap:6px}.nav-item{padding:9px 12px}.nav-item span.lbl{display:none}
  .sidebar-foot{margin:0;padding:0;border:none;width:auto}.status-pill{display:none}
  .workspace{height:auto}.topbar{padding:16px 20px}.topbar-meta{display:none}.workspace-inner{padding:22px 20px 70px}
  .cc-statrow{grid-template-columns:1fr}.cc-bignum{font-size:76px}
}

/* legacy header (login page) */
header{width:100%;max-width:440px;display:flex;justify-content:center;align-items:center;margin-bottom:30px}
.logo{font-family:var(--disp);font-style:italic;font-size:26px;font-weight:700;letter-spacing:.04em;color:var(--ink)}
.logo span{color:var(--bronze)}
.tab{flex:1;padding:11px;border-radius:8px 8px 0 0;border:1px solid var(--line);border-bottom:none;background:none;color:var(--ink-soft);font-family:var(--body);font-size:13px;font-weight:600;cursor:pointer}
.tab.active{background:var(--panel);color:var(--bronze-deep)}

/* FORM */
.card-title{font-family:var(--disp);font-size:24px;font-weight:700;text-transform:uppercase;letter-spacing:.01em;margin-bottom:6px;color:var(--ink)}
.card-sub{font-size:13px;color:var(--ink-soft);margin-bottom:28px;line-height:1.5}
.field{margin-bottom:18px}
.field label{display:block;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--bronze-deep);margin-bottom:8px}
.field input[type=text],.field select{width:100%;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:11px 14px;color:var(--ink);font-family:var(--body);font-size:14px;outline:none;-webkit-appearance:none;transition:border-color .15s}
.field input[type=text]:focus,.field select:focus{border-color:var(--bronze)}
.field input::placeholder{color:var(--ink-faint)}
.field select option{background:var(--panel);color:var(--ink)}
.hint{font-size:11px;color:var(--ink-soft);margin-top:5px;line-height:1.4}
.file-zone{width:100%;background:var(--panel);border:1.5px dashed var(--line-strong);border-radius:8px;padding:20px;text-align:center;cursor:pointer;position:relative;transition:border-color .2s}
.file-zone:hover{border-color:var(--bronze)}
.file-zone input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.file-zone .label{font-size:13px;color:var(--ink-soft);pointer-events:none}
.file-zone .label strong{display:block;color:var(--ink);margin-bottom:4px}
.file-zone.done{border-color:var(--green);border-style:solid}
.file-zone.done .label strong{color:var(--green)}
.divider{height:1px;background:var(--line);margin:24px 0}
.toggle-row{display:flex;gap:10px;margin-bottom:16px}
.toggle-btn{flex:1;padding:9px;border-radius:6px;border:1px solid var(--line);background:none;color:var(--ink-soft);font-family:var(--body);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
.toggle-btn.active{border-color:var(--bronze);color:var(--bronze-deep);background:var(--bronze-glow)}

/* Signed / Test toggle on each restaurant */
.sign-toggle{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;font-weight:700;
  padding:5px 10px;border-radius:6px;background:none;border:1px solid var(--line-strong);color:var(--ink-soft);
  cursor:pointer;transition:all .15s;margin-right:8px}
.sign-toggle:hover{border-color:var(--bronze)}
.sign-toggle.on{background:var(--bronze);border-color:var(--bronze-deep);color:#F5F1E8}

/* BUTTONS */
.btn{font-family:inherit;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;border:none;cursor:pointer;transition:opacity .15s}
.btn-primary{background:var(--bronze);color:var(--panel);width:100%;padding:14px;margin-top:20px;font-weight:700}
.btn-primary:hover{background:var(--bronze-deep)}
.btn-primary:disabled{opacity:.4;cursor:not-allowed}
.btn-outline{background:none;border:1px solid var(--border);color:var(--muted);font-size:12px;padding:7px 14px}
.btn-outline:hover{border-color:var(--amber);color:var(--amber)}
.btn-danger{background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:2px 6px;line-height:1;transition:color .15s}
.btn-danger:hover{color:var(--red)}
.btn-add-branch{background:none;border:1px dashed var(--border);color:var(--muted);font-family:inherit;font-size:12px;font-weight:600;padding:6px 14px;border-radius:6px;cursor:pointer;transition:all .15s;margin-top:8px}
.btn-add-branch:hover{border-color:var(--amber);color:var(--amber)}

/* STATUS */
.status{margin-top:16px;padding:14px 16px;border-radius:8px;font-size:13px;line-height:1.6;display:none}
.status.info{background:rgba(200,135,58,.1);border:1px solid var(--border);color:var(--cream)}
.status.error{background:rgba(138,50,38,.10);border:1px solid rgba(138,50,38,.35);color:var(--red)}
.status.success{background:rgba(76,175,125,.1);border:1px solid rgba(76,175,125,.3);color:var(--cream)}
.link-box{margin-top:10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:12px 14px;font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:10px}
.link-box a{color:var(--amber);text-decoration:none;word-break:break-all;flex:1}
.copy-btn{background:none;border:1px solid var(--border);color:var(--muted);font-size:10px;padding:3px 8px;border-radius:4px;cursor:pointer;font-family:inherit;flex-shrink:0;transition:all .15s}
.copy-btn:hover{border-color:var(--amber);color:var(--amber)}
.tip{margin-top:10px;font-size:11.5px;color:var(--muted)}
.qr-box{margin-top:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center}
.qr-box img{width:150px;height:150px;border-radius:4px;background:white;padding:4px}
.qr-box p{font-size:11px;color:var(--muted);margin-top:8px}

/* RESTAURANT LIST */
.rest-card{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin-bottom:12px}
.rest-card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.rest-name{font-size:15px;font-weight:600;color:var(--cream)}
.branches-list{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.branch-tag{display:inline-flex;align-items:center;gap:6px;background:rgba(200,135,58,.08);border:1px solid rgba(200,135,58,.2);border-radius:20px;padding:4px 10px;font-size:12px;color:var(--cream)}
.branch-tag button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0;line-height:1;transition:color .15s}
.branch-tag button:hover{color:var(--red)}
.no-branches{font-size:12px;color:var(--muted);margin-bottom:8px}
.add-branch-form{display:none;margin-top:10px;gap:8px;align-items:center}
.add-branch-form.open{display:flex}
.add-branch-form input{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px 12px;color:var(--cream);font-family:inherit;font-size:13px;outline:none}
.add-branch-form input:focus{border-color:var(--amber)}

/* COMMAND CENTER POPUP */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;z-index:9998;padding:20px}
.modal-panel{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:32px;max-width:720px;width:100%;max-height:88vh;overflow-y:auto}
.modal-close{position:absolute;top:14px;right:14px;width:32px;height:32px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--muted);font-size:18px;line-height:1;cursor:pointer;transition:.15s}
.modal-close:hover{color:var(--cream);border-color:var(--amber)}

/* LOGIN */
.login-card{width:100%;max-width:640px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:56px 40px;text-align:center}
.github-btn{display:inline-flex;align-items:center;gap:10px;background:var(--ink);color:var(--panel);font-family:inherit;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;border:none;cursor:pointer;text-decoration:none;transition:opacity .15s}
.github-btn:hover{opacity:.88}
</style>
</head>
<body class="${loggedIn ? 'app' : ''}">
${!loggedIn ? `
<header>
  <div class="logo">Ser<span>vision</span></div>
</header>
<div class="login-card">
  <div class="card-title" style="margin-bottom:12px">Publisher</div>
  <div class="card-sub">Connect your GitHub account to get started.</div>
  <a href="/auth/login" class="github-btn">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
    Continue with GitHub
  </a>
</div>
` : `
<aside class="sidebar">
  <div class="brand"><img src="data:image/png;base64,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" alt="Servision" class="brand-img"></div>
  <div class="brand-tag">AR Publishing Console</div>
  <nav class="nav">
    <button class="nav-item active" id="tab-btn-restaurants" onclick="showTab('restaurants')"><span class="ico">01</span><span class="lbl">Restaurants</span></button>
    <button class="nav-item" id="tab-btn-publish" onclick="showTab('publish')"><span class="ico">02</span><span class="lbl">Publish Dish</span></button>
    <button class="nav-item" id="mission-btn" onclick="openCommandModal()"><span class="ico">◈</span><span class="lbl">Mission</span></button>
  </nav>
  <div class="sidebar-foot">
    <div class="status-pill"><span class="status-dot"></span> SYSTEM ONLINE</div>
    <a href="/auth/logout" class="logout-btn">Log out</a>
  </div>
</aside>
<main class="workspace">
  <div class="topbar">
    <div>
      <div class="topbar-title" id="ws-title">Restaurants</div>
      <div class="topbar-sub" id="ws-sub">Manage locations, table QR codes and social links</div>
    </div>
    <div class="topbar-meta">
      <div class="metric"><div class="metric-num" id="stat-restaurants">0</div><div class="metric-lbl">Restaurants</div></div>
      <div class="metric"><div class="metric-num" id="stat-branches">0</div><div class="metric-lbl">Locations</div></div>
      <div class="metric"><div class="metric-num">3D</div><div class="metric-lbl">AR Ready</div></div>
    </div>
  </div>
  <div class="workspace-inner">
  <div class="card">

  <!-- COMMAND CENTER (popup, opened via the Mission button) -->
  <div id="command-modal" class="modal-overlay" style="display:none" onclick="if (event.target === this) closeCommandModal()">
  <div class="modal-panel">
  <button class="modal-close" type="button" onclick="closeCommandModal()" aria-label="Close">×</button>
  <div id="tab-command">
    <div class="cc-grid">
      <div class="cc-hero">
        <div class="cc-eyebrow">Mission · August 20 Target</div>
        <div class="cc-bignum"><span id="cc-signed">0</span><span class="of">/8</span></div>
        <div class="cc-biglbl">Restaurants signed toward the target of <b>5 to 8 by August 20</b>. This is the number that turns Servision from a build into a business.</div>
        <div class="cc-progress"><div class="cc-progress-fill" id="cc-fill" style="width:0%"></div></div>
      </div>
      <div class="cc-side">
        <div class="cc-count">
          <div class="cc-count-lbl">Days Remaining</div>
          <div class="cc-count-num" id="cc-days">—</div>
          <div class="cc-count-unit" id="cc-days-unit">until August 20, 2026</div>
        </div>
        <div class="cc-quote">
          <div class="cc-quote-mark">"</div>
          <div class="cc-quote-text" id="cc-quote">Build young. Compound early. Buy your freedom decades before the average.</div>
        </div>
      </div>
    </div>
    <div class="cc-statrow">
      <div class="cc-stat"><div class="cc-stat-num" id="cc-restaurants">0</div><div class="cc-stat-lbl">Restaurants Live</div></div>
      <div class="cc-stat"><div class="cc-stat-num" id="cc-locations">0</div><div class="cc-stat-lbl">Locations Active</div></div>
      <div class="cc-stat"><div class="cc-stat-num" id="cc-dishes">—</div><div class="cc-stat-lbl">Dishes Published</div></div>
    </div>
    <div class="cc-milestones">
      <div class="cc-mile-head">Milestones</div>
      <div class="cc-mile-track">
        <div class="cc-mile" id="mile-1"><div class="cc-mile-ico">◈</div><div class="cc-mile-name">First Client</div><div class="cc-mile-sub">1 signed</div></div>
        <div class="cc-mile" id="mile-2"><div class="cc-mile-ico">◈</div><div class="cc-mile-name">Half Target</div><div class="cc-mile-sub">4 signed</div></div>
        <div class="cc-mile" id="mile-3"><div class="cc-mile-ico">◈</div><div class="cc-mile-name">Mission Complete</div><div class="cc-mile-sub">8 signed</div></div>
        <div class="cc-mile" id="mile-4"><div class="cc-mile-ico">◈</div><div class="cc-mile-name">Franchise Ready</div><div class="cc-mile-sub">15 signed</div></div>
      </div>
    </div>
  </div>
  </div>
  </div>

  <!-- PUBLISH TAB -->
  <div id="tab-publish" class="section">
    <div class="card-title">Publish AR Experience</div>
    <div class="card-sub">Select a restaurant, fill in the dish details, upload your 3D files.</div>

    <div class="field">
      <label>Restaurant</label>
      <select id="restaurantSelect" onchange="onRestaurantChange()">
        <option value="">— Select restaurant —</option>
      </select>
      <div class="hint">No restaurants? Add them in the Restaurants tab first.</div>
    </div>

    <div class="field" id="branchField" style="display:none">
      <label>Branch / Location</label>
      <select id="branchSelect">
        <option value="">— Main / No specific branch —</option>
      </select>
    </div>

    <div class="divider"></div>

    <div class="field">
      <label>Dish Name</label>
      <input type="text" id="dishName" placeholder="e.g. Margherita Pizza" maxlength="60">
    </div>

    <div class="field">
      <label>Menu Section <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">(label shown at top of AR page)</span></label>
      <input type="text" id="topLabel" placeholder="e.g. Pizzas, Starters, Desserts" maxlength="30">
    </div>

    <div class="field">
      <label>Page Style <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">(the look of the AR page)</span></label>
      <select id="themeSelect">
        <option value="dark-elegant">Dark Elegant — warm amber on near-black (default)</option>
        <option value="light-minimal">Light Minimal — clean cream & terracotta</option>
        <option value="bold-modern">Bold Modern — black with electric lime</option>
        <option value="warm-trattoria">Warm Trattoria — deep red, classic Italian</option>
      </select>
      <div class="hint">The 3D model and AR button are identical in every style — only colours and fonts change.</div>
    </div>

    <div class="divider"></div>

    <div class="field">
      <label>Company Identity</label>
      <div class="toggle-row">
        <button class="toggle-btn active" id="btn-text" onclick="switchMode('text')">Use Text Name</button>
        <button class="toggle-btn" id="btn-logo" onclick="switchMode('logo')">Upload Logo</button>
      </div>
      <div id="mode-text">
        <input type="text" id="brandName" placeholder="e.g. NOSTRA" maxlength="30">
        <div class="hint">Displayed at the top of the AR page.</div>
      </div>
      <div id="mode-logo" style="display:none">
        <div class="file-zone" id="zone-logo">
          <input type="file" id="logoFile" accept=".png,.jpg,.jpeg,.svg,.webp">
          <div class="label"><strong>Click to choose logo image</strong>PNG or SVG with transparent background works best. Max 160px wide.</div>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <div class="field">
      <label>Nutrition Info <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">(optional — adds a 3D info card next to the dish)</span></label>
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:8px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <input type="text" id="nutCalories" placeholder="Calories (e.g. 320)">
          <input type="text" id="nutProtein" placeholder="Protein g (e.g. 24)">
          <input type="text" id="nutCarbs" placeholder="Carbs g (e.g. 18)">
          <input type="text" id="nutFat" placeholder="Fat g (e.g. 12)">
        </div>
        <input type="text" id="nutAllergens" placeholder="Allergens (e.g. Peanuts, Dairy, Gluten)" style="width:100%;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--muted)">Spice level (optional):</span>
          <div id="spicePeppers" style="display:flex;gap:4px">
            <span class="pepper" data-level="1" style="font-size:22px;cursor:pointer;filter:grayscale(1);opacity:.5;transition:all .12s">🌶️</span>
            <span class="pepper" data-level="2" style="font-size:22px;cursor:pointer;filter:grayscale(1);opacity:.5;transition:all .12s">🌶️</span>
            <span class="pepper" data-level="3" style="font-size:22px;cursor:pointer;filter:grayscale(1);opacity:.5;transition:all .12s">🌶️</span>
            <span class="pepper" data-level="4" style="font-size:22px;cursor:pointer;filter:grayscale(1);opacity:.5;transition:all .12s">🌶️</span>
            <span class="pepper" data-level="5" style="font-size:22px;cursor:pointer;filter:grayscale(1);opacity:.5;transition:all .12s">🌶️</span>
          </div>
          <button type="button" id="spiceClear" style="background:none;border:none;color:var(--muted);font-size:11px;cursor:pointer;text-decoration:underline">clear</button>
          <input type="hidden" id="nutSpice" value="0">
        </div>
        <div class="file-zone" id="zone-baseGlb" style="margin-bottom:10px">
          <input type="file" id="baseGlbFile" accept=".glb">
          <div class="label"><strong>Click to choose your plain .glb file</strong>Before Blender — the one straight from Polycam</div>
        </div>
        <button class="btn btn-outline" id="generateNutBtn" style="width:100%">Generate Enhanced GLB with Info Card →</button>
        <div class="status" id="nut-status"></div>
        <div class="hint" style="margin-top:8px">
          After downloading: import into Blender → export as USDZ → upload both the enhanced GLB and that USDZ below.
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <div class="field">
      <label>3D Model — .glb file</label>
      <div class="file-zone" id="zone-glb">
        <input type="file" id="glbFile" accept=".glb">
        <div class="label"><strong>Click to choose .glb file</strong>From Polycam export, or your enhanced GLB from above</div>
      </div>
    </div>

    <div class="field">
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">File too big to publish? Shrink your .glb under 10 MB — textures and shape preserved. Do this BEFORE converting to USDZ.</div>
        <button class="btn btn-outline" id="compressGlbBtn" style="width:100%">🗜 Compress GLB to under 10 MB</button>
        <div class="status" id="compress-status"></div>
      </div>
    </div>

    <div class="field">
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">No .usdz yet? Convert your .glb above into a .usdz right here — no Blender needed.</div>
        <button class="btn btn-outline" id="convertUsdzBtn" style="width:100%">⚡ Convert GLB → USDZ (in browser)</button>
        <div class="status" id="convert-status"></div>
      </div>
    </div>

    <div class="field">
      <label>AR Model — .usdz file <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">(iPhone AR)</span></label>
      <div class="file-zone" id="zone-usdz">
        <input type="file" id="usdzFile" accept=".usdz">
        <div class="label"><strong>Click to choose .usdz file</strong>From the converter above, or Polycam/Blender export</div>
      </div>
    </div>

    <button class="btn btn-primary" id="publishBtn">Publish to GitHub Pages →</button>
    <div class="status" id="pub-status"></div>
  </div>

  <!-- RESTAURANTS TAB -->
  <div id="tab-restaurants" class="section active">
    <div class="card-title">Restaurants</div>
    <div class="card-sub">Each restaurant gets its own GitHub repo. Add branches anytime — each branch gets its own folder inside the repo.</div>

    <div id="restaurant-list">
      <div style="color:var(--muted);font-size:13px;padding:8px 0" id="empty-msg">No restaurants yet. Add one below.</div>
    </div>

    <div class="divider"></div>

    <div style="font-size:13px;font-weight:600;color:var(--cream);margin-bottom:16px">+ Add New Restaurant</div>

    <div class="field">
      <label>Restaurant Name</label>
      <input type="text" id="newRestName" placeholder="e.g. Bella Italia" maxlength="60">
    </div>
    <div class="field">
      <label>First Branch / Location <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">(optional)</span></label>
      <input type="text" id="newRestBranch" placeholder="e.g. Downtown, West Island, Laval" maxlength="60">
      <div class="hint">You can always add more branches later directly on the restaurant card.</div>
    </div>
    <button class="btn btn-primary" id="addRestBtn" style="margin-top:4px">+ Add Restaurant</button>
    <div class="status" id="rest-status"></div>
  </div>

</div>
  </div>
</main>
`}

<script>
var cachedRestaurants = {};
var currentMode = 'text';

// Moved up from further down in the file (next to refreshCommand(), where it
// used to live) — it MUST be defined before the very first refreshCommand()
// call below, or CC_QUOTES.length throws and kills every button listener
// that hadn't been registered yet.
var CC_QUOTES = [
  'Build young. Compound early. Buy your freedom decades before the average.',
  'The average millionaire is 55. That is not the timeline.',
  'When, not if.',
  'Effort now so you can chill later.',
  'The demo sells. Your job is to open, show, and stay quiet.',
  'One yes changes the whole month.',
  'Warm first. Cold after you have proof.',
  'You are not selling. You are showing them money they are missing.',
  'A calendar does not care how ready you feel.',
  'Signed clients beat perfect code every time.'
];

// ── TABS ──────────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active'); });
  document.querySelectorAll('.tab, .nav-item').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('tab-' + name).classList.add('active');
  var navBtn = document.getElementById('tab-btn-' + name);
  if (navBtn) navBtn.classList.add('active');
  var titles = {
    publish: ['Publish Dish', 'Turn a 3D model into a live AR experience'],
    restaurants: ['Restaurants', 'Manage locations, table QR codes and social links']
  };
  var t = titles[name];
  if (t) {
    var wt = document.getElementById('ws-title'); if (wt) wt.textContent = t[0];
    var ws = document.getElementById('ws-sub'); if (ws) ws.textContent = t[1];
  }
  if (name === 'restaurants') loadRestaurants();
  if (name === 'publish') loadRestaurantDropdown();
}

// Command Center is now a popup (Mission button) instead of a tab — it's a
// status dashboard, not a workflow step like Restaurants/Publish.
function openCommandModal() {
  refreshCommand();
  document.getElementById('command-modal').style.display = 'flex';
}
function closeCommandModal() {
  document.getElementById('command-modal').style.display = 'none';
}

// ── FILE ZONES ────────────────────────────────────────────────────────────────
function setupZone(zoneId, inputId) {
  var zone = document.getElementById(zoneId);
  var input = document.getElementById(inputId);
  if (!zone || !input) return;
  input.addEventListener('change', function() {
    if (input.files[0]) {
      zone.classList.add('done');
      zone.querySelector('strong').textContent = '✓ ' + input.files[0].name;
    }
  });
}
setupZone('zone-glb', 'glbFile');
setupZone('zone-usdz', 'usdzFile');
setupZone('zone-logo', 'logoFile');
setupZone('zone-baseGlb', 'baseGlbFile');

// ── SPICE PEPPER SELECTOR ──────────────────────────────────────────────────
(function() {
  var peppers = document.querySelectorAll('#spicePeppers .pepper');
  var hidden = document.getElementById('nutSpice');
  var clearBtn = document.getElementById('spiceClear');
  if (!peppers.length || !hidden) return;

  function paint(level) {
    peppers.forEach(function(p) {
      var lvl = parseInt(p.getAttribute('data-level'), 10);
      if (lvl <= level) {
        p.style.filter = 'grayscale(0)';
        p.style.opacity = '1';
        p.style.transform = 'scale(1.1)';
      } else {
        p.style.filter = 'grayscale(1)';
        p.style.opacity = '0.5';
        p.style.transform = 'scale(1)';
      }
    });
  }

  peppers.forEach(function(p) {
    var lvl = parseInt(p.getAttribute('data-level'), 10);
    p.addEventListener('mouseenter', function() { paint(lvl); });
    p.addEventListener('click', function() { hidden.value = String(lvl); paint(lvl); });
  });
  document.getElementById('spicePeppers').addEventListener('mouseleave', function() {
    paint(parseInt(hidden.value, 10) || 0);
  });
  if (clearBtn) clearBtn.addEventListener('click', function() { hidden.value = '0'; paint(0); });
})();

// ── IN-BROWSER GLB COMPRESSOR ──────────────────────────────────────────────
// Shrinks textures via canvas (handles WebP natively) and simplifies geometry
// with meshoptimizer (removes triangles, keeps UVs). Replaces the chosen file
// in the .glb input directly, so Convert/Publish use the compressed version.
var compressBtn = document.getElementById('compressGlbBtn');
if (compressBtn) {
  compressBtn.addEventListener('click', function() {
    var glbInput = document.getElementById('glbFile');
    var glbFile = glbInput.files[0];
    if (!glbFile) return setStatus('compress-status', 'error', 'Choose your .glb file above first.');

    compressBtn.disabled = true;
    compressBtn.textContent = 'Compressing…';
    setStatus('compress-status', 'info', '⏳ Loading optimizer…');

    runGlbCompression(glbFile).then(function(newFile) {
      var dt = new DataTransfer();
      dt.items.add(newFile);
      glbInput.files = dt.files;
      var zone = document.getElementById('zone-glb');
      zone.classList.add('done');
      var mb = (newFile.size / 1048576).toFixed(1);
      zone.querySelector('strong').textContent = '✓ ' + newFile.name + ' (' + mb + ' MB)';
      var origMb = (glbFile.size / 1048576).toFixed(1);
      setStatus('compress-status', 'success', '✓ ' + origMb + ' MB → ' + mb + ' MB. Now convert to USDZ below, then publish.');
      compressBtn.disabled = false;
      compressBtn.textContent = '🗜 Compress GLB to under 10 MB';
    }).catch(function(err) {
      console.error('Compression error:', err);
      setStatus('compress-status', 'error', '❌ Compression failed: ' + (err.message || err));
      compressBtn.disabled = false;
      compressBtn.textContent = '🗜 Compress GLB to under 10 MB';
    });
  });
}

function runGlbCompression(file) {
  var core, ext, fns, MeshoptSimplifier, io, doc;

  return Promise.all([
    import('https://esm.sh/@gltf-transform/core@4'),
    import('https://esm.sh/@gltf-transform/extensions@4'),
    import('https://esm.sh/@gltf-transform/functions@4'),
    import('https://esm.sh/meshoptimizer@0.22')
  ]).then(function(mods) {
    core = mods[0]; ext = mods[1]; fns = mods[2];
    MeshoptSimplifier = mods[3].MeshoptSimplifier;
    io = new core.WebIO().registerExtensions(ext.ALL_EXTENSIONS);
    setStatus('compress-status', 'info', '⏳ Reading model…');
    return file.arrayBuffer();
  }).then(function(buffer) {
    return io.readBinary(new Uint8Array(buffer));
  }).then(function(d) {
    doc = d;
    // ── Auto de-shine ────────────────────────────────────────────────────
    // Polycam bakes a metallicRoughness texture that makes plates shiny and
    // washes out colours in AR. Food isn't metal — strip it and force matte
    // on every dish. Runs here so EVERY compressed model is de-shined, whether
    // or not the nutrition panel was added.
    deshineAllMaterials(doc);
    setStatus('compress-status', 'info', '⏳ Optimizing textures…');
    return shrinkAllTextures(doc, 1024, 0.8);
  }).then(function() {
    setStatus('compress-status', 'info', '⏳ Simplifying geometry… (can take a minute on big models)');
    return MeshoptSimplifier.ready;
  }).then(function() {
    return doc.transform(fns.weld());
  }).then(function() {
    // Custom per-primitive simplify: skips small meshes (like the 2-triangle
    // nutrition panel) which fns.simplify would collapse to nothing.
    simplifyLargeMeshes(doc, MeshoptSimplifier, 0.35, 0.01);
    // Recompute smooth vertex normals so photogrammetry faceting/bumpiness
    // catches light cleanly instead of looking blocky. This changes SHADING
    // only — no vertex is moved, so crispy edges and detail stay intact.
    setStatus('compress-status', 'info', '⏳ Smoothing surface shading…');
    return doc.transform(fns.prune(), fns.dedup(), fns.normals({ overwrite: true }));
  }).then(function() {
    return io.writeBinary(doc);
  }).then(function(bytes) {
    if (bytes.byteLength <= 10 * 1048576) return bytes;
    // Still over 10 MB — second, more aggressive pass
    setStatus('compress-status', 'info', '⏳ Still over 10 MB — running a stronger pass…');
    return shrinkAllTextures(doc, 512, 0.72).then(function() {
      simplifyLargeMeshes(doc, MeshoptSimplifier, 0.5, 0.02);
      return doc.transform(fns.prune(), fns.dedup());
    }).then(function() {
      return io.writeBinary(doc);
    });
  }).then(function(bytes) {
    var baseName = file.name.replace('.glb', '');
    return new File([bytes], baseName + '-compressed.glb', { type: 'model/gltf-binary' });
  });
}

function deshineAllMaterials(doc) {
  // Strip the metallicRoughness texture and force matte on all materials
  // except the nutrition label (which is meant to be flat/unlit-looking).
  doc.getRoot().listMaterials().forEach(function(material) {
    if (material.getName() === 'nutrition-label-material') return;
    material.setMetallicRoughnessTexture(null);
    material.setMetallicFactor(0);
    material.setRoughnessFactor(1);
  });
}

function simplifyLargeMeshes(doc, MeshoptSimplifier, ratio, errorTol) {
  var MIN_TRIS = 200; // protect small meshes like the nutrition panel
  doc.getRoot().listMeshes().forEach(function(mesh) {
    mesh.listPrimitives().forEach(function(prim) {
      var idxAcc = prim.getIndices();
      var posAcc = prim.getAttribute('POSITION');
      if (!idxAcc || !posAcc) return;
      var triCount = idxAcc.getCount() / 3;
      if (triCount < MIN_TRIS) return;
      var srcIndices = new Uint32Array(idxAcc.getArray());
      var srcPositions = new Float32Array(posAcc.getArray());
      var target = Math.max(3, Math.floor(srcIndices.length * ratio / 3) * 3);
      var result = MeshoptSimplifier.simplify(srcIndices, srcPositions, 3, target, errorTol);
      idxAcc.setArray(result[0]);
    });
  });
}

function shrinkAllTextures(doc, maxDim, quality) {
  var textures = doc.getRoot().listTextures();
  var chain = Promise.resolve();
  textures.forEach(function(tex) {
    chain = chain.then(function() {
      var img = tex.getImage();
      if (!img) return;
      var isLabel = tex.getName() === 'nutrition-label'; // don't touch the info card
      var blob = new Blob([img], { type: tex.getMimeType() || 'image/png' });
      return createImageBitmap(blob).then(function(bitmap) {
        var scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
        var w = Math.max(1, Math.round(bitmap.width * scale));
        var h = Math.max(1, Math.round(bitmap.height * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, w, h);
        return new Promise(function(resolve) {
          canvas.toBlob(resolve, 'image/jpeg', quality);
        });
      }).then(function(outBlob) {
        if (!outBlob) return;
        return outBlob.arrayBuffer().then(function(ab) {
          tex.setImage(new Uint8Array(ab)).setMimeType('image/jpeg');
        });
      }).catch(function() { /* skip unreadable texture, keep original */ });
    });
  });
  return chain;
}

// Boosts contrast + saturation and applies a light unsharp-mask sharpen to a
// canvas in place. Makes flat photogrammetry food textures look richer and
// crisper WITHOUT adding file size (it's the same pixels, just adjusted).
function enhanceCanvas(ctx, w, h) {
  var CONTRAST = 1.14;    // >1 = punchier
  var SATURATION = 1.18;  // >1 = more vivid food colours
  var SHARPEN = 0.6;      // 0..1 strength of edge sharpening

  var imgData = ctx.getImageData(0, 0, w, h);
  var d = imgData.data;
  var src = new Uint8ClampedArray(d);          // copy for sharpen sampling
  var cf = CONTRAST, sf = SATURATION;

  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i+1], b = d[i+2];

    // Contrast around mid-grey
    r = (r - 128) * cf + 128;
    g = (g - 128) * cf + 128;
    b = (b - 128) * cf + 128;

    // Saturation (blend toward luma)
    var lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + (r - lum) * sf;
    g = lum + (g - lum) * sf;
    b = lum + (b - lum) * sf;

    d[i]   = r < 0 ? 0 : r > 255 ? 255 : r;
    d[i+1] = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i+2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }

  // Light unsharp mask: add back the difference from a 4-neighbour blur.
  if (SHARPEN > 0) {
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var o = (y * w + x) * 4;
        for (var c = 0; c < 3; c++) {
          var p = o + c;
          var blur = (src[p - 4] + src[p + 4] + src[p - w*4] + src[p + w*4]) * 0.25;
          var sharp = d[p] + (d[p] - blur) * SHARPEN;
          d[p] = sharp < 0 ? 0 : sharp > 255 ? 255 : sharp;
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

// ── IN-BROWSER GLB → USDZ CONVERTER ────────────────────────────────────────
// Uses Three.js USDZExporter, loaded on-demand so it never slows the page.
//
// Why the old USDZ used to balloon past the compressed GLB size:
// USDZExporter re-encodes every texture through a <canvas>. On old Three.js
// builds it always re-encoded as lossless PNG, no matter what format the
// source GLB texture was — so a GLB we'd already shrunk to JPEG at ~10 MB
// came back out the other side as 15+ MB of PNG. Newer Three.js (bumped in
// the importmap above) keeps JPEG when the source texture says so, but it
// still re-encodes at the browser's default JPEG quality (~0.92) with no way
// to configure it — a second, needlessly-high-quality re-compression on top
// of textures we already compressed once. withJpegQuality() below patches
// canvas.toBlob for the duration of the export so we control that quality
// directly, and runUsdzExportUnder5MB() retries at smaller texture size /
// lower quality until the file is under 5 MB, keeping the first (highest
// detail) pass that clears the target.
function withJpegQuality(quality, fn) {
  var proto = HTMLCanvasElement.prototype;
  var origToBlob = proto.toBlob;
  proto.toBlob = function(callback, type, q) {
    if (type === 'image/jpeg') return origToBlob.call(this, callback, type, quality);
    return origToBlob.call(this, callback, type, q);
  };
  function restore(v) { proto.toBlob = origToBlob; return v; }
  return Promise.resolve().then(fn).then(restore, function(err) { restore(); throw err; });
}

function runUsdzExportUnder5MB(exporter, scene, onProgress) {
  var TARGET_BYTES = 5 * 1048576;
  var passes = [
    { maxTextureSize: 1024, quality: 0.82, label: 'full detail' },
    { maxTextureSize: 1024, quality: 0.6,  label: 'reduced texture quality' },
    { maxTextureSize: 768,  quality: 0.55, label: 'smaller textures' },
    { maxTextureSize: 512,  quality: 0.5,  label: 'compact textures' }
  ];
  var i = 0;
  function attempt() {
    var p = passes[i];
    if (onProgress) onProgress(p, i);
    return withJpegQuality(p.quality, function() {
      return exporter.parseAsync(scene, { maxTextureSize: p.maxTextureSize });
    }).then(function(bytes) {
      i++;
      if (bytes.byteLength <= TARGET_BYTES || i >= passes.length) return bytes;
      return attempt();
    });
  }
  return attempt();
}

var convertBtn = document.getElementById('convertUsdzBtn');
if (convertBtn) {
  convertBtn.addEventListener('click', function() {
    var glbFile = document.getElementById('glbFile').files[0];
    if (!glbFile) return setStatus('convert-status', 'error', 'Choose your .glb file above first.');

    convertBtn.disabled = true;
    convertBtn.textContent = 'Loading converter…';
    setStatus('convert-status', 'info', '⏳ Loading 3D engine…');

    var THREE, GLTFLoader, USDZExporter;

    // Dynamically import Three.js modules from CDN only when needed
    Promise.all([
      import('three'),
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/exporters/USDZExporter.js')
    ]).then(function(mods) {
      THREE = mods[0];
      GLTFLoader = mods[1].GLTFLoader;
      USDZExporter = mods[2].USDZExporter;

      setStatus('convert-status', 'info', '⏳ Reading your model…');
      return glbFile.arrayBuffer();
    }).then(function(buffer) {
      return new Promise(function(resolve, reject) {
        var loader = new GLTFLoader();
        loader.parse(buffer, '', function(gltf) { resolve(gltf); }, function(err) { reject(err); });
      });
    }).then(function(gltf) {
      var exporter = new USDZExporter();
      return runUsdzExportUnder5MB(exporter, gltf.scene, function(pass) {
        setStatus('convert-status', 'info', '⏳ Converting to USDZ (' + pass.label + ')…');
      });
    }).then(function(arraybuffer) {
      var blob = new Blob([arraybuffer], { type: 'model/vnd.usdz+zip' });
      var baseName = glbFile.name.replace(/\.glb$/i, '') || 'model';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = baseName + '.usdz';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      var mb = (arraybuffer.byteLength / 1048576).toFixed(1);
      var overTarget = arraybuffer.byteLength > 5 * 1048576;
      setStatus('convert-status', 'success', '✓ USDZ downloaded (' + mb + ' MB)' + (overTarget ? ' — still above 5 MB even at lowest quality; try simplifying the GLB more' : '') + '! Now upload it in the .usdz box below.');
      convertBtn.disabled = false;
      convertBtn.textContent = '⚡ Convert GLB → USDZ (in browser)';
    }).catch(function(err) {
      console.error('USDZ conversion error:', err);
      setStatus('convert-status', 'error', '❌ Conversion failed: ' + (err.message || err) + '. This GLB may use a feature USDZ cannot represent.');
      convertBtn.disabled = false;
      convertBtn.textContent = '⚡ Convert GLB → USDZ (in browser)';
    });
  });
}

// ── NUTRITION PANEL GENERATOR ──────────────────────────────────────────────
var genNutBtn = document.getElementById('generateNutBtn');
if (genNutBtn) {
  genNutBtn.addEventListener('click', function() {
    var baseGlb = document.getElementById('baseGlbFile').files[0];
    if (!baseGlb) return setStatus('nut-status', 'error', 'Please select your plain .glb file first.');

    var calories = document.getElementById('nutCalories').value.trim();
    var protein  = document.getElementById('nutProtein').value.trim();
    var carbs    = document.getElementById('nutCarbs').value.trim();
    var fat      = document.getElementById('nutFat').value.trim();
    var allergens = document.getElementById('nutAllergens').value.trim();
    var spice    = document.getElementById('nutSpice').value.trim();

    if (!calories && !protein && !carbs && !fat && !allergens && (!spice || spice === '0')) {
      return setStatus('nut-status', 'error', 'Fill in at least one field (calories, macros, allergens, or spice).');
    }

    genNutBtn.disabled = true;
    genNutBtn.textContent = 'Generating…';
    setStatus('nut-status', 'info', '⏳ Baking info card into your 3D model…');

    var form = new FormData();
    form.append('glbFile', baseGlb);
    form.append('calories', calories);
    form.append('protein', protein);
    form.append('carbs', carbs);
    form.append('fat', fat);
    form.append('allergens', allergens);
    form.append('spiceLevel', spice);

    fetch('/generate-nutrition-glb', { method: 'POST', body: form })
      .then(function(res) {
        if (!res.ok) return res.json().then(function(d) { throw new Error(d.error || 'Failed'); });
        return res.blob();
      })
      .then(function(blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'model-with-nutrition.glb';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setStatus('nut-status', 'success', '✓ Downloaded! Now import into Blender, export as USDZ, then upload both files below.');
        genNutBtn.disabled = false;
        genNutBtn.textContent = 'Generate Enhanced GLB with Info Card →';
      })
      .catch(function(err) {
        setStatus('nut-status', 'error', '❌ ' + err.message);
        genNutBtn.disabled = false;
        genNutBtn.textContent = 'Generate Enhanced GLB with Info Card →';
      });
  });
}

// ── IDENTITY TOGGLE ───────────────────────────────────────────────────────────
function switchMode(mode) {
  currentMode = mode;
  document.getElementById('mode-text').style.display = mode === 'text' ? 'block' : 'none';
  document.getElementById('mode-logo').style.display = mode === 'logo' ? 'block' : 'none';
  document.getElementById('btn-text').classList.toggle('active', mode === 'text');
  document.getElementById('btn-logo').classList.toggle('active', mode === 'logo');
}

// ── RESTAURANT DROPDOWN (Publish tab) ─────────────────────────────────────────
function loadRestaurantDropdown() {
  fetch('/api/restaurants')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      cachedRestaurants = data;
      var sel = document.getElementById('restaurantSelect');
      if (!sel) return;
      var cur = sel.value;
      sel.innerHTML = '<option value="">— Select restaurant —</option>';
      Object.keys(data).forEach(function(slug) {
        var opt = document.createElement('option');
        opt.value = slug;
        opt.textContent = data[slug].name;
        sel.appendChild(opt);
      });
      if (cur) { sel.value = cur; onRestaurantChange(); }
    });
}

function onRestaurantChange() {
  var slug = document.getElementById('restaurantSelect').value;
  var bf = document.getElementById('branchField');
  var bs = document.getElementById('branchSelect');
  if (!bf || !bs) return;
  var r = cachedRestaurants[slug];
  if (r && Object.keys(r.branches).length > 0) {
    bf.style.display = 'block';
    bs.innerHTML = '<option value="">— Main / No specific branch —</option>';
    Object.keys(r.branches).forEach(function(bSlug) {
      var opt = document.createElement('option');
      opt.value = bSlug;
      opt.textContent = r.branches[bSlug];
      bs.appendChild(opt);
    });
  } else {
    bf.style.display = 'none';
  }
}

if (document.getElementById('restaurantSelect')) loadRestaurantDropdown();
// Load restaurants immediately on page ready so Command Center has real counts
if (document.querySelector('body.app')) { loadRestaurants(); openCommandModal(); }

// ── RESTAURANT MANAGER ────────────────────────────────────────────────────────
function loadRestaurants() {
  fetch('/api/restaurants')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      cachedRestaurants = data;
      renderRestaurants(data);
      updateTopbarStats(data);
      refreshCommand();
    });
}

// Reflect real counts in the workspace topbar.
function updateTopbarStats(data) {
  var keys = Object.keys(data || {});
  var branches = 0;
  keys.forEach(function(k){ branches += Object.keys(data[k].branches || {}).length; });
  var rEl = document.getElementById('stat-restaurants');
  var bEl = document.getElementById('stat-branches');
  if (rEl) rEl.textContent = keys.length;
  if (bEl) bEl.textContent = branches;
}

// ── COMMAND CENTER ──────────────────────────────────────────────────
function refreshCommand() {
  // countdown to Aug 20 of the current year (or next year if already past)
  var now = new Date();
  var target = new Date(now.getFullYear(), 7, 20); // Aug = 7
  if (target < now) target = new Date(now.getFullYear() + 1, 7, 20);
  var days = Math.max(0, Math.ceil((target - now) / 86400000));
  var d = document.getElementById('cc-days');
  var du = document.getElementById('cc-days-unit');
  if (d) {
    d.textContent = days;
    if (days <= 14) d.classList.add('warn');
    if (du) du.textContent = 'until August 20, ' + target.getFullYear();
  }
  // signed count = restaurants that have at least one branch (proxy for "live")
  var data = cachedRestaurants || {};
  var keys = Object.keys(data);
  var signed = 0, locations = 0;
  keys.forEach(function(k){
    var br = Object.keys(data[k].branches || {}).length;
    locations += br;
    if (data[k].signed) signed++;
  });
  var s = document.getElementById('cc-signed'); if (s) s.textContent = signed;
  var f = document.getElementById('cc-fill'); if (f) f.style.width = Math.min(100, (signed/8)*100) + '%';
  var r = document.getElementById('cc-restaurants'); if (r) r.textContent = keys.length;
  var l = document.getElementById('cc-locations'); if (l) l.textContent = locations;
  // milestones
  [[1,1],[2,4],[3,8],[4,15]].forEach(function(m){
    var el = document.getElementById('mile-'+m[0]);
    if (el) el.classList.toggle('on', signed >= m[1]);
  });
  // rotating quote (deterministic per day so it feels intentional)
  var q = document.getElementById('cc-quote');
  if (q) {
    var idx = Math.floor((now.getTime()/86400000)) % CC_QUOTES.length;
    q.textContent = CC_QUOTES[idx];
  }
}

function renderRestaurants(data) {
  var list = document.getElementById('restaurant-list');
  var emptyMsg = document.getElementById('empty-msg');
  if (!list) return;
  var keys = Object.keys(data);

  if (emptyMsg) emptyMsg.style.display = keys.length === 0 ? 'block' : 'none';

  list.querySelectorAll('.rest-card').forEach(function(c) { c.remove(); });

  keys.forEach(function(slug) {
    var r = data[slug];
    var card = document.createElement('div');
    card.className = 'rest-card';
    card.id = 'rest-' + slug;

    var bSlugs = Object.keys(r.branches);

    var headerDiv = document.createElement('div');
    headerDiv.className = 'rest-card-header';
    var nameDiv = document.createElement('div');
    nameDiv.className = 'rest-name';
    nameDiv.textContent = r.name;
    var signBtn = document.createElement('button');
    signBtn.className = 'sign-toggle' + (r.signed ? ' on' : '');
    signBtn.title = r.signed ? 'Marked as signed — counts toward mission' : 'Mark as signed (real client, not a test)';
    signBtn.innerHTML = (r.signed ? '● SIGNED' : '○ Test');
    signBtn.setAttribute('data-action', 'toggle-signed');
    signBtn.setAttribute('data-slug', slug);
    var delBtn = document.createElement('button');
    delBtn.className = 'btn-danger';
    delBtn.title = 'Delete restaurant';
    delBtn.textContent = '×';
    delBtn.setAttribute('data-action', 'delete-restaurant');
    delBtn.setAttribute('data-slug', slug);
    headerDiv.appendChild(nameDiv);
    headerDiv.appendChild(signBtn);
    headerDiv.appendChild(delBtn);

    var branchesDiv = document.createElement('div');
    branchesDiv.className = 'branches-list';
    branchesDiv.id = 'branches-' + slug;
    if (bSlugs.length > 0) {
      bSlugs.forEach(function(bSlug) {
        var tag = document.createElement('span');
        tag.className = 'branch-tag';
        tag.textContent = r.branches[bSlug] + ' ';
        var qrBtn = document.createElement('button');
        qrBtn.textContent = '⛶';
        qrBtn.title = 'Table QR — whole menu';
        qrBtn.setAttribute('data-action', 'menu-qr');
        qrBtn.setAttribute('data-slug', slug);
        qrBtn.setAttribute('data-bslug', bSlug);
        qrBtn.setAttribute('data-bname', r.branches[bSlug]);
        tag.appendChild(qrBtn);
        var dishBtn = document.createElement('button');
        dishBtn.textContent = '📋';
        dishBtn.title = 'View past dishes published here';
        dishBtn.setAttribute('data-action', 'view-dishes');
        dishBtn.setAttribute('data-slug', slug);
        dishBtn.setAttribute('data-bslug', bSlug);
        dishBtn.setAttribute('data-bname', r.branches[bSlug]);
        tag.appendChild(dishBtn);
        var xBtn = document.createElement('button');
        xBtn.textContent = '×';
        xBtn.title = 'Remove branch';
        xBtn.setAttribute('data-action', 'delete-branch');
        xBtn.setAttribute('data-slug', slug);
        xBtn.setAttribute('data-bslug', bSlug);
        tag.appendChild(xBtn);
        branchesDiv.appendChild(tag);
      });
    } else {
      var noBranch = document.createElement('div');
      noBranch.className = 'no-branches';
      noBranch.textContent = 'No branches yet';
      branchesDiv.appendChild(noBranch);
      // A branch-less restaurant still has a menu at its repo root.
      var rootQr = document.createElement('button');
      rootQr.className = 'btn-add-branch';
      rootQr.textContent = '⛶ Table QR';
      rootQr.setAttribute('data-action', 'menu-qr');
      rootQr.setAttribute('data-slug', slug);
      rootQr.setAttribute('data-bslug', '');
      rootQr.setAttribute('data-bname', r.name);
      branchesDiv.appendChild(rootQr);
      var rootDishBtn = document.createElement('button');
      rootDishBtn.className = 'btn-add-branch';
      rootDishBtn.style.marginLeft = '6px';
      rootDishBtn.textContent = '📋 Dishes';
      rootDishBtn.title = 'View past dishes published here';
      rootDishBtn.setAttribute('data-action', 'view-dishes');
      rootDishBtn.setAttribute('data-slug', slug);
      rootDishBtn.setAttribute('data-bslug', '');
      rootDishBtn.setAttribute('data-bname', r.name);
      branchesDiv.appendChild(rootDishBtn);
    }

    var addBranchBtn = document.createElement('button');
    addBranchBtn.className = 'btn-add-branch';
    addBranchBtn.textContent = '+ Add Branch';
    addBranchBtn.setAttribute('data-action', 'toggle-add-branch');
    addBranchBtn.setAttribute('data-slug', slug);

    var addForm = document.createElement('div');
    addForm.className = 'add-branch-form';
    addForm.id = 'add-branch-form-' + slug;
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'e.g. West Island';
    input.id = 'branch-input-' + slug;
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') saveBranch(slug);
    });
    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-outline';
    saveBtn.textContent = 'Save';
    saveBtn.setAttribute('data-action', 'save-branch');
    saveBtn.setAttribute('data-slug', slug);
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-outline';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('data-action', 'toggle-add-branch');
    cancelBtn.setAttribute('data-slug', slug);
    addForm.appendChild(input);
    addForm.appendChild(saveBtn);
    addForm.appendChild(cancelBtn);

    card.appendChild(headerDiv);
    card.appendChild(branchesDiv);
    card.appendChild(addBranchBtn);
    card.appendChild(addForm);

    // ── Social links section ────────────────────────────────────────────
    var socialToggle = document.createElement('button');
    socialToggle.className = 'btn-add-branch';
    socialToggle.style.marginLeft = '8px';
    var socialCount = r.socials ? Object.keys(r.socials).filter(function(k){return r.socials[k];}).length : 0;
    socialToggle.textContent = socialCount ? '★ Social links (' + socialCount + ')' : '☆ Add social links';
    socialToggle.setAttribute('data-action', 'toggle-socials');
    socialToggle.setAttribute('data-slug', slug);
    card.appendChild(socialToggle);

    var socialForm = document.createElement('div');
    socialForm.className = 'social-form';
    socialForm.id = 'social-form-' + slug;
    socialForm.style.cssText = 'display:none;margin-top:10px;padding:14px;background:rgba(0,0,0,.2);border-radius:10px';
    var PLATFORMS = [
      ['instagram','Instagram','@handle or link'],
      ['facebook','Facebook','page name or link'],
      ['tiktok','TikTok','@handle or link'],
      ['x','X (Twitter)','@handle or link'],
      ['youtube','YouTube','@handle or link'],
      ['snapchat','Snapchat','username or link']
    ];
    var socials = r.socials || {};
    PLATFORMS.forEach(function(pf){
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px';
      var lbl = document.createElement('label');
      lbl.textContent = pf[1];
      lbl.style.cssText = 'font-size:12px;color:var(--muted);width:82px;flex-shrink:0';
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = pf[2];
      inp.value = socials[pf[0]] || '';
      inp.id = 'social-' + slug + '-' + pf[0];
      inp.style.cssText = 'flex:1;font-size:13px;padding:7px 10px';
      wrap.appendChild(lbl); wrap.appendChild(inp);
      socialForm.appendChild(wrap);
    });
    var saveSocial = document.createElement('button');
    saveSocial.className = 'btn btn-outline';
    saveSocial.style.cssText = 'width:100%;margin-top:6px';
    saveSocial.textContent = 'Save social links';
    saveSocial.setAttribute('data-action', 'save-socials');
    saveSocial.setAttribute('data-slug', slug);
    socialForm.appendChild(saveSocial);
    var socialStatus = document.createElement('div');
    socialStatus.id = 'social-status-' + slug;
    socialStatus.style.cssText = 'font-size:12px;margin-top:6px;text-align:center';
    socialForm.appendChild(socialStatus);

    // ── Google review link ──────────────────────────────────────────────
    var revDivider = document.createElement('div');
    revDivider.style.cssText = 'border-top:1px solid var(--border);margin:16px 0 12px';
    socialForm.appendChild(revDivider);
    var revLabel = document.createElement('div');
    revLabel.innerHTML = '★ Google Review Link';
    revLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--amber);margin-bottom:4px';
    socialForm.appendChild(revLabel);
    var revHint = document.createElement('div');
    revHint.textContent = 'Adds a "Leave a review" button to the AR and menu pages. Paste your Google review link.';
    revHint.style.cssText = 'font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.5';
    socialForm.appendChild(revHint);
    var revWrap = document.createElement('div');
    revWrap.style.cssText = 'display:flex;gap:8px';
    var revInput = document.createElement('input');
    revInput.type = 'text';
    revInput.placeholder = 'https://g.page/r/... or your review link';
    revInput.value = r.reviewUrl || '';
    revInput.id = 'review-' + slug;
    revInput.style.cssText = 'flex:1;font-size:13px;padding:8px 10px';
    revWrap.appendChild(revInput);
    var revSave = document.createElement('button');
    revSave.className = 'btn btn-outline';
    revSave.textContent = 'Save';
    revSave.style.cssText = 'padding:8px 16px';
    revSave.setAttribute('data-action', 'save-review');
    revSave.setAttribute('data-slug', slug);
    revWrap.appendChild(revSave);
    socialForm.appendChild(revWrap);
    var revStatus = document.createElement('div');
    revStatus.id = 'review-status-' + slug;
    revStatus.style.cssText = 'font-size:12px;margin-top:6px;text-align:center';
    socialForm.appendChild(revStatus);
    card.appendChild(socialForm);

    list.appendChild(card);
  });
}

// Event delegation — handles all restaurant card buttons reliably
document.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  var action = btn.getAttribute('data-action');
  var slug = btn.getAttribute('data-slug');
  var bSlug = btn.getAttribute('data-bslug');

  if (action === 'delete-restaurant') deleteRestaurant(slug);
  if (action === 'delete-branch') deleteBranch(slug, bSlug);
  if (action === 'toggle-add-branch') toggleAddBranch(slug);
  if (action === 'save-branch') saveBranch(slug);
  if (action === 'copy') copyText(btn.getAttribute('data-copy'), btn);
  if (action === 'menu-qr') showMenuQR(slug, bSlug, btn.getAttribute('data-bname'));
  if (action === 'view-dishes') showDishList(slug, bSlug, btn.getAttribute('data-bname'));
  if (action === 'close-dish-list') { var dm = document.getElementById('dish-list-modal'); if (dm) dm.remove(); }
  if (action === 'toggle-socials') {
    var sf = document.getElementById('social-form-' + slug);
    if (sf) sf.style.display = sf.style.display === 'none' ? 'block' : 'none';
  }
  if (action === 'save-socials') saveSocials(slug);
  if (action === 'save-review') saveReview(slug);
  if (action === 'toggle-signed') toggleSigned(slug);
  if (action === 'close-qr') { var mo = document.getElementById('qr-modal'); if (mo) mo.remove(); }
});

// Toggle whether a restaurant counts toward the mission target.
function toggleSigned(slug) {
  var cur = cachedRestaurants[slug];
  if (!cur) return;
  var newVal = !cur.signed;
  fetch('/api/restaurants/' + slug + '/signed', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signed: newVal })
  })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.success) {
        cachedRestaurants[slug].signed = data.signed;
        renderRestaurants(cachedRestaurants);
        refreshCommand();
      }
    });
}

// Save a restaurant's Google review link.
function saveReview(slug) {
  var el = document.getElementById('review-' + slug);
  var status = document.getElementById('review-status-' + slug);
  var url = el ? el.value.trim() : '';
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saving…'; }
  fetch('/api/restaurants/' + slug + '/review', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewUrl: url })
  })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.success) {
        if (cachedRestaurants[slug]) cachedRestaurants[slug].reviewUrl = data.reviewUrl;
        if (status) { status.style.color = 'var(--green,#4CAF7D)'; status.textContent = url ? '✓ Review button added to your pages' : '✓ Review link removed'; }
      } else {
        if (status) { status.style.color = 'var(--red,#e05555)'; status.textContent = data.error || 'Failed to save'; }
      }
    })
    .catch(function(){ if (status) { status.style.color = 'var(--red,#e05555)'; status.textContent = 'Network error'; } });
}

// Save a restaurant's social links to the server.
function saveSocials(slug) {
  var platforms = ['instagram','facebook','tiktok','x','youtube','snapchat'];
  var body = {};
  platforms.forEach(function(p){
    var el = document.getElementById('social-' + slug + '-' + p);
    if (el && el.value.trim()) body[p] = el.value.trim();
  });
  var status = document.getElementById('social-status-' + slug);
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saving…'; }
  fetch('/api/restaurants/' + slug + '/socials', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.success) {
        if (cachedRestaurants[slug]) cachedRestaurants[slug].socials = data.socials;
        if (status) { status.style.color = 'var(--green,#4CAF7D)'; status.textContent = '✓ Saved — applies to dishes you publish from now on'; }
        loadRestaurants();
      } else {
        if (status) { status.style.color = 'var(--red,#e05555)'; status.textContent = data.error || 'Failed to save'; }
      }
    })
    .catch(function(){ if (status) { status.style.color = 'var(--red,#e05555)'; status.textContent = 'Network error'; } });
}

// Table QR — one code per branch that opens the whole menu.
function showMenuQR(slug, bSlug, bName) {
  var menuUrl = 'https://ar.servision.ca/' + slug + (bSlug ? '/' + bSlug : '') + '/';
  var qrBig = 'https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=2&data=' + encodeURIComponent(menuUrl);
  var existing = document.getElementById('qr-modal');
  if (existing) existing.remove();

  var modal = document.createElement('div');
  modal.id = 'qr-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px';
  modal.innerHTML =
    '<div style="background:var(--surface);border:1px solid rgba(200,135,58,.4);border-radius:16px;padding:26px;max-width:400px;width:100%;text-align:center">' +
      '<div style="font-family:Cormorant Garamond,serif;font-size:24px;margin-bottom:2px">' + (bName || 'Menu') + '</div>' +
      '<div style="font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--amber);margin-bottom:16px">Table QR — whole menu</div>' +
      '<img src="' + qrBig + '" alt="Menu QR" style="width:100%;max-width:280px;background:#fff;padding:12px;border-radius:12px">' +
      '<div style="font-size:11px;color:var(--muted);margin:14px 0 4px;line-height:1.55">Print this once and put it on every table. It always shows the current menu — publishing a new dish updates it automatically.</div>' +
      '<a href="' + menuUrl + '" target="_blank" style="font-size:11.5px;word-break:break-all;display:block;margin-bottom:14px">' + menuUrl + '</a>' +
      '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
        '<a class="copy-btn" href="' + qrBig + '" download="table-qr.png" target="_blank" style="text-decoration:none">Download QR</a>' +
        '<button class="copy-btn" data-action="copy" data-copy="' + menuUrl + '">Copy link</button>' +
        '<button class="copy-btn" data-action="close-qr">Close</button>' +
      '</div>' +
    '</div>';
  modal.addEventListener('click', function(ev) { if (ev.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

// Shows every dish ever published to this restaurant/branch, pulled live
// from its GitHub repo (dishes.json) — not stored anywhere new, since
// GitHub has always been the permanent record of what's been published.
// Each row links to the live AR page and its stats dashboard.
function showDishList(slug, bSlug, bName) {
  var existing = document.getElementById('dish-list-modal');
  if (existing) existing.remove();

  var modal = document.createElement('div');
  modal.id = 'dish-list-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px';
  modal.innerHTML =
    '<div style="background:var(--surface);border:1px solid rgba(200,135,58,.4);border-radius:16px;padding:26px;max-width:460px;width:100%;max-height:78vh;overflow-y:auto;text-align:left">' +
      '<div style="font-family:Cormorant Garamond,serif;font-size:22px;margin-bottom:2px">' + (bName || 'Menu') + '</div>' +
      '<div style="font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--amber);margin-bottom:16px">Published Dishes</div>' +
      '<div id="dish-list-body" style="font-size:13px;color:var(--muted)">Loading…</div>' +
      '<div style="margin-top:16px;text-align:center"><button class="copy-btn" data-action="close-dish-list">Close</button></div>' +
    '</div>';
  modal.addEventListener('click', function(ev) { if (ev.target === modal) modal.remove(); });
  document.body.appendChild(modal);

  fetch('/api/restaurants/' + slug + '/dishes' + (bSlug ? '?branch=' + encodeURIComponent(bSlug) : ''))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var body = document.getElementById('dish-list-body');
      if (!body) return;
      if (data.error) { body.textContent = data.error; return; }
      var dishes = data.dishes || [];
      if (dishes.length === 0) { body.textContent = 'No dishes published here yet.'; return; }
      var base = 'https://ar.servision.ca/' + slug + (bSlug ? '/' + bSlug : '') + '/';
      body.innerHTML = dishes.map(function(d) {
        var url = base + d.slug + '/';
        return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)">' +
          '<div style="min-width:0"><div style="color:var(--cream);font-size:14px;overflow-wrap:anywhere">' + d.name + '</div>' +
          (d.label ? '<div style="font-size:10.5px;color:var(--amber);text-transform:uppercase;letter-spacing:.08em">' + d.label + '</div>' : '') + '</div>' +
          '<div style="display:flex;gap:6px;flex-shrink:0">' +
            '<a href="' + url + '" target="_blank" class="copy-btn" style="text-decoration:none;font-size:11px">Open</a>' +
            '<a href="' + url + 'dashboard" target="_blank" class="copy-btn" style="text-decoration:none;font-size:11px">Stats</a>' +
          '</div>' +
        '</div>';
      }).join('');
    })
    .catch(function() {
      var body = document.getElementById('dish-list-body');
      if (body) body.textContent = 'Failed to load dishes — try again.';
    });
}

function toggleAddBranch(slug) {
  var form = document.getElementById('add-branch-form-' + slug);
  var isOpen = form.classList.contains('open');
  form.classList.toggle('open', !isOpen);
  if (!isOpen) document.getElementById('branch-input-' + slug).focus();
}

function saveBranch(slug) {
  var input = document.getElementById('branch-input-' + slug);
  var branch = input.value.trim();
  if (!branch) return;
  fetch('/api/restaurants/' + slug + '/branches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: branch })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) return alert(data.error);
    input.value = '';
    document.getElementById('add-branch-form-' + slug).classList.remove('open');
    cachedRestaurants = data.restaurant ? Object.assign(cachedRestaurants, {[slug]: data.restaurant}) : cachedRestaurants;
    loadRestaurants();
    loadRestaurantDropdown();
  });
}

function deleteBranch(slug, bSlug) {
  if (!confirm('Remove this branch?')) return;
  fetch('/api/restaurants/' + slug + '/branches/' + bSlug, { method: 'DELETE' })
    .then(function() { loadRestaurants(); loadRestaurantDropdown(); });
}

function deleteRestaurant(slug) {
  if (!confirm('Remove this restaurant? The GitHub repo will not be deleted.')) return;
  fetch('/api/restaurants/' + slug, { method: 'DELETE' })
    .then(function() { loadRestaurants(); loadRestaurantDropdown(); });
}

var addBtn = document.getElementById('addRestBtn');
if (addBtn) {
  addBtn.addEventListener('click', function() {
    var name   = document.getElementById('newRestName').value.trim();
    var branch = document.getElementById('newRestBranch').value.trim();
    if (!name) return setStatus('rest-status', 'error', 'Please enter a restaurant name.');
    addBtn.disabled = true;
    fetch('/api/restaurants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, branch: branch })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        setStatus('rest-status', 'error', '❌ ' + data.error);
      } else {
        document.getElementById('newRestName').value = '';
        document.getElementById('newRestBranch').value = '';
        setStatus('rest-status', 'success', '✓ ' + data.restaurant.name + ' added successfully.');
        loadRestaurants();
        loadRestaurantDropdown();
      }
      addBtn.disabled = false;
    })
    .catch(function(err) {
      // Previously missing: any network hiccup or non-JSON server response
      // left this promise chain unhandled, so the button just stayed
      // disabled forever with zero feedback — looked exactly like "doesn't work".
      console.error('Add restaurant error:', err);
      setStatus('rest-status', 'error', '❌ Something went wrong adding the restaurant. Try again.');
      addBtn.disabled = false;
    });
  });
}

// ── PUBLISH ───────────────────────────────────────────────────────────────────
var pubBtn = document.getElementById('publishBtn');
if (pubBtn) {
  pubBtn.addEventListener('click', function() {
    var restaurant = document.getElementById('restaurantSelect').value;
    var branchEl   = document.getElementById('branchSelect');
    var branch     = branchEl ? branchEl.value : '';
    var dishName   = document.getElementById('dishName').value.trim();
    var topLabel   = document.getElementById('topLabel').value.trim();
    var brandName  = currentMode === 'text' ? document.getElementById('brandName').value.trim() : '';
    var glbFile    = document.getElementById('glbFile').files[0];
    var usdzFile   = document.getElementById('usdzFile').files[0];
    var logoFile   = currentMode === 'logo' ? document.getElementById('logoFile').files[0] : null;

    if (!restaurant)                          return setStatus('pub-status', 'error', 'Please select a restaurant.');
    if (!dishName)                            return setStatus('pub-status', 'error', 'Please enter a dish name.');
    if (currentMode === 'text' && !brandName) return setStatus('pub-status', 'error', 'Please enter a company name.');
    if (currentMode === 'logo' && !logoFile)  return setStatus('pub-status', 'error', 'Please upload a logo.');
    if (!glbFile)                             return setStatus('pub-status', 'error', 'Please select a .glb file.');
    if (!usdzFile)                            return setStatus('pub-status', 'error', 'Please select a .usdz file.');

    pubBtn.disabled = true;
    pubBtn.textContent = 'Publishing…';
    setStatus('pub-status', 'info', '⏳ Uploading and publishing to GitHub… about 30 seconds.');

    var form = new FormData();
    form.append('restaurant', restaurant);
    form.append('branch',     branch);
    form.append('dishName',   dishName);
    form.append('topLabel',   topLabel);
    form.append('theme',      (document.getElementById('themeSelect') ? document.getElementById('themeSelect').value : 'dark-elegant'));
    form.append('brandName',  brandName);
    form.append('glbFile',    glbFile);
    form.append('usdzFile',   usdzFile);
    if (logoFile) form.append('logoFile', logoFile);

    fetch('/publish', { method: 'POST', body: form })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) {
          setStatus('pub-status', 'error', '❌ ' + data.error);
        } else {
          var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=' + encodeURIComponent(data.liveUrl);
          var menuQrUrl = data.menuUrl ? 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=1&data=' + encodeURIComponent(data.menuUrl) : '';
          var menuBlock = data.menuUrl ? (
            '<div style="background:linear-gradient(135deg,rgba(200,135,58,.12),rgba(200,135,58,.04));border:1px solid rgba(200,135,58,.45);border-radius:12px;padding:18px;margin:14px 0">' +
              '<div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--amber);margin-bottom:4px">⭐ Table QR — whole menu, one code</div>' +
              '<div style="font-size:11.5px;color:var(--muted);margin-bottom:12px;line-height:1.5">Put this single code on every table. It lists all dishes in this branch and updates itself whenever you publish — the code never changes.</div>' +
              '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">' +
                '<img src="' + menuQrUrl + '" alt="Menu QR" style="width:130px;height:130px;background:#fff;padding:7px;border-radius:8px;flex-shrink:0">' +
                '<div style="flex:1;min-width:190px">' +
                  '<a href="' + data.menuUrl + '" target="_blank" style="word-break:break-all;font-size:12px">' + data.menuUrl + '</a>' +
                  '<div style="display:flex;gap:7px;margin-top:9px;flex-wrap:wrap">' +
                    '<button class="copy-btn" data-action="copy" data-copy="' + data.menuUrl + '">Copy link</button>' +
                    '<a class="copy-btn" href="' + menuQrUrl + '" download="menu-qr.png" target="_blank" style="text-decoration:none;display:inline-block">Download QR</a>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>'
          ) : '';
          setStatus('pub-status', 'success',
            '<strong>🎉 Published!</strong><br>' + menuBlock +
            '<div class="link-box"><div style="flex:1"><div style="font-size:10px;color:var(--muted);margin-bottom:3px">LIVE AR PAGE — ready in ~60 sec</div>' +
            '<a href="' + data.liveUrl + '" target="_blank">' + data.liveUrl + '</a></div>' +
            '<button class="copy-btn" data-action="copy" data-copy="' + data.liveUrl + '">Copy</button></div>' +
            '<div class="link-box"><div style="flex:1"><div style="font-size:10px;color:var(--muted);margin-bottom:3px">GITHUB REPO</div>' +
            '<a href="' + data.repoUrl + '" target="_blank">' + data.repoUrl + '</a></div>' +
            '<button class="copy-btn" data-action="copy" data-copy="' + data.repoUrl + '">Copy</button></div>' +
            '<div class="link-box"><div style="flex:1"><div style="font-size:10px;color:var(--muted);margin-bottom:3px">📊 ANALYTICS DASHBOARD — your private link</div>' +
            '<a href="' + data.liveUrl + '/dashboard" target="_blank">' + data.liveUrl + '/dashboard</a></div>' +
            '<button class="copy-btn" data-action="copy" data-copy="' + data.liveUrl + '/dashboard">Copy</button></div>' +
            '<div class="qr-box"><img src="' + qrUrl + '" alt="QR Code"><p>Scan to preview · Right-click to save</p></div>' +
            '<div class="tip">⏱ GitHub Pages takes ~60 seconds on first publish.</div>'
          );
        }
        pubBtn.disabled = false;
        pubBtn.textContent = 'Publish to GitHub Pages →';
      })
      .catch(function(err) {
        setStatus('pub-status', 'error', '❌ Network error: ' + err.message);
        pubBtn.disabled = false;
        pubBtn.textContent = 'Publish to GitHub Pages →';
      });
  });
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(function() {
    btn.textContent = 'Copied!';
    setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
  });
}

function setStatus(id, type, html) {
  var el = document.getElementById(id);
  el.className = 'status ' + type;
  el.style.display = 'block';
  el.innerHTML = html;
}
</script>
</body>
</html>`;
}

// ── AR PAGE ───────────────────────────────────────────────────────────────────

function buildARPage(dishName, brandName, topLabel, logoFileName, theme, socials, reviewUrl) {
  const THEMES = {
    'dark-elegant': {
      fonts: 'Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=DM+Sans:wght@400;500;600',
      display: "'Cormorant Garamond',serif",
      body: "'DM Sans',sans-serif",
      vars: "--accent:#C8873A;--bg:#111009;--surface:#1A1812;--border:rgba(200,135,58,0.15);--border-dim:rgba(255,255,255,0.06);--fg:#F2EDE4;--muted:rgba(242,237,228,0.45)"
    },
    'light-minimal': {
      fonts: 'Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600&family=Inter:wght@400;500;600',
      display: "'Fraunces',serif",
      body: "'Inter',sans-serif",
      vars: "--accent:#B4523A;--bg:#F6F3EE;--surface:#FFFFFF;--border:rgba(30,25,20,0.12);--border-dim:rgba(30,25,20,0.06);--fg:#1E1914;--muted:rgba(30,25,20,0.5)"
    },
    'bold-modern': {
      fonts: 'Space+Grotesk:wght@400;500;700',
      display: "'Space Grotesk',sans-serif",
      body: "'Space Grotesk',sans-serif",
      vars: "--accent:#E8FF5A;--bg:#0C0C0E;--surface:#161619;--border:rgba(232,255,90,0.18);--border-dim:rgba(255,255,255,0.06);--fg:#F5F5F5;--muted:rgba(245,245,245,0.5)"
    },
    'warm-trattoria': {
      fonts: 'Playfair+Display:ital,wght@0,400;0,700;1,400&family=Nunito+Sans:wght@400;600;700',
      display: "'Playfair Display',serif",
      body: "'Nunito Sans',sans-serif",
      vars: "--accent:#9C2B2B;--bg:#1C1410;--surface:#271C16;--border:rgba(212,160,90,0.20);--border-dim:rgba(255,255,255,0.06);--fg:#F5E9D8;--muted:rgba(245,233,216,0.5)"
    }
  };
  const t = THEMES[theme] || THEMES['dark-elegant'];

  const identityHTML = logoFileName
    ? '<img src="' + logoFileName + '" alt="logo" style="max-width:160px;max-height:60px;width:auto;height:auto;object-fit:contain;display:block;margin:0 auto">'
    : '<span class="top-text">' + brandName + '</span>';

  const topLabelHTML = topLabel
    ? '<div class="top-label"><div class="top-line"></div>' + identityHTML + '<div class="top-line"></div></div><div class="section-label">' + topLabel + '</div>'
    : '<div class="top-label"><div class="top-line"></div>' + identityHTML + '<div class="top-line"></div></div>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<title>${dishName} — AR</title>
<script type="module" src="https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js"><\/script>
<link href="https://fonts.googleapis.com/css2?family=${t.fonts}&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{${t.vars};--amber:var(--accent);--cream:var(--fg)}
html,body{height:100%;width:100%;overflow:hidden;background:var(--bg);color:var(--fg);font-family:${t.body}}
model-viewer{position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:0;left:0}
.page{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;padding:max(env(safe-area-inset-top),16px) 28px max(env(safe-area-inset-bottom),16px)}
.lang-toggle{position:absolute;top:max(env(safe-area-inset-top),14px);right:16px;display:flex;border:1px solid var(--border);border-radius:6px;overflow:hidden}
.lang-btn{background:none;border:none;color:var(--muted);font-family:inherit;font-size:10px;font-weight:700;letter-spacing:.06em;padding:5px 10px;cursor:pointer;transition:all .15s}
.lang-btn.active{background:rgba(200,135,58,.15);color:var(--amber)}
.top-label{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.top-line{flex:1;height:1px;max-width:40px;background:var(--border)}
.top-text{font-size:13px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--amber)}
.section-label{font-size:10px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);text-align:center;margin-top:2px}
.title-block{text-align:center;margin-top:8px}
.dish-name{font-family:${t.display};font-size:clamp(34px,10vw,54px);font-weight:600;line-height:1.05;color:var(--fg)}
.dish-sub{font-size:12px;color:var(--muted);margin-top:4px;letter-spacing:.04em}
.center-wrap{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%}
.tap-arrow{font-size:12px;color:var(--amber);letter-spacing:.12em;text-transform:uppercase;font-weight:600;margin-top:18px;display:flex;align-items:center;gap:8px;animation:pulse-arrow 2s ease-in-out infinite}
.tap-arrow::before{content:'';display:block;width:0;height:0;border-left:7px solid var(--amber);border-top:5px solid transparent;border-bottom:5px solid transparent;opacity:.8}
.ar-btn{position:relative;width:min(62vw,250px);height:min(62vw,250px);border-radius:50%;background:none;border:none;cursor:pointer;-webkit-tap-highlight-color:transparent;display:flex;align-items:center;justify-content:center}
.ring1{position:absolute;inset:-18px;border-radius:50%;border:1px solid rgba(200,135,58,.12);animation:breathe 4s ease-in-out infinite}
.ring2{position:absolute;inset:-36px;border-radius:50%;border:1px solid rgba(200,135,58,.06);animation:breathe 4s .8s ease-in-out infinite}
.face{position:relative;width:100%;height:100%;border-radius:50%;border:1px solid var(--border);background:radial-gradient(circle at 38% 32%,rgba(200,135,58,.1) 0%,transparent 55%),radial-gradient(circle at 65% 72%,rgba(200,135,58,.05) 0%,transparent 45%),#1A1812;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;overflow:hidden;animation:glow 4s ease-in-out infinite}
.ar-btn:active .face{transform:scale(.96)}
.face::after{content:'';position:absolute;top:-40%;left:-50%;width:35%;height:180%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.04),transparent);transform:skewX(-15deg);animation:sweep 5s ease-in-out infinite}
.rim{position:absolute;inset:14px;border-radius:50%;border:1px solid rgba(200,135,58,.12);pointer-events:none}
.brand{display:flex;flex-direction:column;align-items:center;gap:6px;z-index:1}
.brand-name{font-family:${t.display};font-size:28px;font-weight:600;color:var(--fg);line-height:1.1;text-align:center;padding:0 16px}
.brand-div{width:32px;height:1px;background:var(--border)}
.brand-sub{font-size:9.5px;font-weight:600;letter-spacing:.25em;text-transform:uppercase;color:var(--amber);opacity:.8}
.steps{display:flex;align-items:flex-start;gap:8px;margin-top:28px}
.step{display:flex;flex-direction:column;align-items:center;gap:6px;width:72px}
.step-n{width:24px;height:24px;border-radius:50%;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--amber)}
.step-l{font-size:10.5px;color:var(--muted);text-align:center;line-height:1.4}
.step-line{width:16px;height:1px;background:var(--border-dim);margin-top:12px;flex-shrink:0}
.compat{margin-top:16px;display:flex;align-items:center;gap:12px;font-size:10.5px;color:var(--muted)}
.dot{width:2px;height:2px;border-radius:50%;background:var(--border)}
@keyframes breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.03)}}
@keyframes glow{0%,100%{box-shadow:0 4px 40px rgba(200,135,58,.08)}50%{box-shadow:0 4px 70px rgba(200,135,58,.18)}}
@keyframes sweep{0%{left:-50%;opacity:0}20%{opacity:1}60%{left:130%;opacity:0}100%{left:130%;opacity:0}}
@keyframes pulse-arrow{0%,100%{opacity:.6;transform:translateX(0)}50%{opacity:1;transform:translateX(4px)}}
${SOCIAL_CSS}
${REVIEW_CSS}
</style>
</head>
<body>
<model-viewer 
    src="model.glb" 
    ios-src="model.usdz" 
    ar 
    ar-modes="webxr scene-viewer quick-look"
    loading="eager"
    reveal="auto"
    exposure="1.0"
    shadow-intensity="1"
    shadow-softness="0.6"
    style="position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:0;left:0;"
    id="mv">
</model-viewer>
<div class="page">
  <div class="lang-toggle">
    <button class="lang-btn active" id="lang-en" onclick="setLang('en')">EN</button>
    <button class="lang-btn" id="lang-fr" onclick="setLang('fr')">FR</button>
  </div>
  ${topLabelHTML}
  <div class="title-block">
    <div class="dish-name">${dishName}</div>
    <div class="dish-sub" id="txt-sub">Tap to bring this dish to life in your space</div>
  </div>
  <div class="center-wrap">
    <button class="ar-btn" id="arBtn">
      <div class="ring1"></div><div class="ring2"></div>
      <div class="face">
        <div class="rim"></div>
        <div class="brand">
          <div class="brand-name" id="txt-circle">See it on<br>your table</div>
          <div class="brand-div"></div>
          <div class="brand-sub" id="txt-view">👆 Tap here</div>
        </div>
      </div>
    </button>
    <div class="tap-arrow" id="txt-tap-label">Tap the circle</div>
    <div class="steps">
      <div class="step"><div class="step-n">1</div><div class="step-l" id="txt-s1">Tap the circle</div></div>
      <div class="step-line"></div>
      <div class="step"><div class="step-n">2</div><div class="step-l" id="txt-s2">Point at your table</div></div>
      <div class="step-line"></div>
      <div class="step"><div class="step-n">3</div><div class="step-l" id="txt-s3">See it appear</div></div>
    </div>
  </div>
  <div class="compat"><span id="txt-c1">Works on iPhone & Android</span><span class="dot"></span><span id="txt-c2">No app needed</span></div>
  ${buildReviewBlock(reviewUrl, 'en')}
  ${buildSocialRow(socials)}
</div>
<script>
var mv = document.getElementById('mv');

// ── Servision analytics ──────────────────────────────────────────────────
// Derives the dish key from the URL path and reports scan / ar_launch /
// view_time to the server. Fails silently — never blocks the AR experience.
(function(){
  var TRACK_URL = 'https://ar.servision.ca/track';
  var path = location.pathname.replace(/^\\/+|\\/+$/g,''); // trim slashes
  var dishKey = path; // e.g. "restaurant/branch/dish"
  var ua = navigator.userAgent || '';
  var device = /iphone|ipad|ipod/i.test(ua) ? 'iphone' : (/android/i.test(ua) ? 'android' : 'other');
  var start = Date.now();
  var sentTime = false;

  function send(type, extra){
    try{
      var body = JSON.stringify(Object.assign({dishKey:dishKey, type:type, device:device}, extra||{}));
      if (navigator.sendBeacon){
        navigator.sendBeacon(TRACK_URL, new Blob([body],{type:'application/json'}));
      } else {
        fetch(TRACK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:true}).catch(function(){});
      }
    }catch(e){}
  }

  // scan = page opened
  send('scan');

  // view_time = when they leave / hide the tab
  function sendViewTime(){
    if (sentTime) return; sentTime = true;
    send('view_time', { viewMs: Date.now() - start });
  }
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'hidden') sendViewTime();
  });
  window.addEventListener('pagehide', sendViewTime);

  // expose so the AR button can flag a launch
  window.__servisionTrackAR = function(){ send('ar_launch'); };
})();

document.getElementById('arBtn').addEventListener('click', function() {
  if (window.__servisionTrackAR) window.__servisionTrackAR();
  if (mv) {
    mv.activateAR();
  }
});
var T = {
  en:{sub:'Tap to bring this dish to life in your space',circle:'See it on<br>your table',view:'👆 Tap here',tap:'Tap the circle',s1:'Tap the circle',s2:'Point at your table',s3:'See it appear',c1:'Works on iPhone & Android',c2:'No app needed'},
  fr:{sub:'Appuyez pour voir ce plat prendre vie dans votre espace',circle:'Sur votre<br>table',view:'👆 Appuyez ici',tap:'Appuyez le cercle',s1:'Appuyez le cercle',s2:'Pointez vers la table',s3:'Le voir apparaître',c1:'Compatible iPhone & Android',c2:'Sans application'}
};
function setLang(l) {
  var t=T[l];
  document.getElementById('txt-sub').textContent=t.sub;
  document.getElementById('txt-circle').innerHTML=t.circle;
  document.getElementById('txt-view').textContent=t.view;
  document.getElementById('txt-tap-label').textContent=t.tap;
  document.getElementById('txt-s1').textContent=t.s1;
  document.getElementById('txt-s2').textContent=t.s2;
  document.getElementById('txt-s3').textContent=t.s3;
  document.getElementById('txt-c1').textContent=t.c1;
  document.getElementById('txt-c2').textContent=t.c2;
  // Review CTA (only present if a review link was set)
  var rev = { en:{revHead:'Enjoyed your meal?',revSub:'Share your experience in 30 seconds',revBtn:'Leave a Google review'}, fr:{revHead:'Vous avez aimé votre repas ?',revSub:'Partagez votre expérience en 30 secondes',revBtn:'Laisser un avis Google'} };
  var rt = rev[l] || rev.en;
  document.querySelectorAll('[data-i18n]').forEach(function(el){ var k=el.getAttribute('data-i18n'); if(rt[k]) el.textContent=rt[k]; });
  document.getElementById('lang-en').classList.toggle('active',l==='en');
  document.getElementById('lang-fr').classList.toggle('active',l==='fr');
}
var lang=(navigator.language||navigator.userLanguage||'').toLowerCase();
if(lang.startsWith('fr')) setLang('fr');
<\/script>
</body>
</html>`;
}
