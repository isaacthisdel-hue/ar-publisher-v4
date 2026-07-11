const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const { mergeNutritionPanel } = require('./mergeNutritionPanel');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());
app.use(cookieParser());

const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_SECRET = 'changeme' } = process.env;

// ── Restaurant store (in-memory, persists while Railway runs) ─────────────────
// { 'bella-italia': { name: 'Bella Italia', branches: { 'downtown': 'Downtown', 'laval': 'Laval' } } }
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
    restaurants[slug] = { name: name.trim(), branches: {} };
  }

  if (branch && branch.trim()) {
    const bSlug = slugify(branch);
    restaurants[slug].branches[bSlug] = branch.trim();
  }

  res.json({ success: true, slug, restaurant: restaurants[slug] });
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
  res.json({ success: true, slug, restaurant: restaurants[slug] });
});

// Delete restaurant
app.delete('/api/restaurants/:slug', (req, res) => {
  if (!getToken(req)) return res.status(401).json({ error: 'Not logged in' });
  delete restaurants[req.params.slug];
  res.json({ success: true });
});

// Delete branch
app.delete('/api/restaurants/:slug/branches/:bSlug', (req, res) => {
  if (!getToken(req)) return res.status(401).json({ error: 'Not logged in' });
  const { slug, bSlug } = req.params;
  if (restaurants[slug]) delete restaurants[slug].branches[bSlug];
  res.json({ success: true });
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
    await pushFile(folderPath + '/index.html', Buffer.from(buildARPage(dishName, brandName, topLabel, logoFileName), 'utf8'));
    await pushFile(folderPath + '/model.glb',  glbFile.buffer);
    await pushFile(folderPath + '/model.usdz', usdzFile.buffer);
    if (logoFile && logoFileName) await pushFile(folderPath + '/' + logoFileName, logoFile.buffer);
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

  res.json({ success: true, repoUrl, liveUrl });
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

  // Check if this is a file request (has extension) or a page request
  const isFile = rest && /\.[a-z0-9]+$/i.test(rest);

  // CRITICAL: if this is a page (not a file) and the URL has no trailing slash,
  // redirect to add one. Without it, the browser resolves relative paths like
  // "model.glb" incorrectly (it drops the last path segment), causing 404s.
  if (!isFile && !req.path.endsWith('/')) {
    return res.redirect(302, req.path + '/');
  }

  const githubPath = isFile
    ? '/' + repoName + '/' + rest          // file: no trailing slash
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log('Servision running on port ' + PORT));

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
    "three": "https://unpkg.com/three@0.170.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.170.0/examples/jsm/"
  }
}
</script>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--amber:#C8873A;--bg:#111009;--surface:#1A1812;--surface2:#211F17;--border:rgba(200,135,58,0.2);--muted:rgba(242,237,228,0.5);--cream:#F2EDE4;--green:#4CAF7D;--red:#e05555}
html,body{min-height:100%;background:var(--bg);color:var(--cream);font-family:'DM Sans',sans-serif}
body{display:flex;flex-direction:column;align-items:center;padding:40px 20px 80px}
header{width:100%;max-width:640px;display:flex;justify-content:space-between;align-items:center;margin-bottom:36px}
.logo{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;letter-spacing:.12em}
.logo span{color:var(--amber)}
.logout-btn{background:none;border:1px solid var(--border);color:var(--muted);font-size:11px;padding:4px 10px;border-radius:4px;cursor:pointer;font-family:inherit;text-decoration:none}

/* TABS */
.tabs{width:100%;max-width:640px;display:flex;gap:4px;margin-bottom:0}
.tab{flex:1;padding:11px;border-radius:8px 8px 0 0;border:1px solid var(--border);border-bottom:none;background:none;color:var(--muted);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s}
.tab.active{background:var(--surface);color:var(--amber);border-color:rgba(200,135,58,.5)}
.card{width:100%;max-width:640px;background:var(--surface);border:1px solid rgba(200,135,58,.3);border-top:none;border-radius:0 0 16px 16px;padding:36px}
.section{display:none}.section.active{display:block}

/* FORM */
.card-title{font-family:'Cormorant Garamond',serif;font-size:26px;font-weight:600;margin-bottom:6px}
.card-sub{font-size:13px;color:var(--muted);margin-bottom:28px;line-height:1.5}
.field{margin-bottom:18px}
.field label{display:block;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--amber);margin-bottom:8px}
.field input[type=text],.field select{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:11px 14px;color:var(--cream);font-family:inherit;font-size:14px;outline:none;-webkit-appearance:none}
.field input[type=text]:focus,.field select:focus{border-color:var(--amber)}
.field input::placeholder{color:var(--muted)}
.field select option{background:#1A1812;color:var(--cream)}
.hint{font-size:11px;color:var(--muted);margin-top:5px;line-height:1.4}
.file-zone{width:100%;background:var(--surface2);border:2px dashed var(--border);border-radius:8px;padding:20px;text-align:center;cursor:pointer;position:relative;transition:border-color .2s}
.file-zone:hover{border-color:var(--amber)}
.file-zone input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.file-zone .label{font-size:13px;color:var(--muted);pointer-events:none}
.file-zone .label strong{display:block;color:var(--cream);margin-bottom:4px}
.file-zone.done{border-color:var(--green);border-style:solid}
.file-zone.done .label strong{color:var(--green)}
.divider{height:1px;background:var(--border);margin:24px 0}
.toggle-row{display:flex;gap:10px;margin-bottom:16px}
.toggle-btn{flex:1;padding:9px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--muted);font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
.toggle-btn.active{border-color:var(--amber);color:var(--amber);background:rgba(200,135,58,.08)}

/* BUTTONS */
.btn{font-family:inherit;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;border:none;cursor:pointer;transition:opacity .15s}
.btn-primary{background:var(--amber);color:#111009;width:100%;padding:14px;margin-top:20px}
.btn-primary:hover{opacity:.88}
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
.status.error{background:rgba(224,85,85,.1);border:1px solid rgba(224,85,85,.3);color:#ff8080}
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

/* LOGIN */
.login-card{width:100%;max-width:640px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:56px 40px;text-align:center}
.github-btn{display:inline-flex;align-items:center;gap:10px;background:var(--cream);color:#111;font-family:inherit;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;border:none;cursor:pointer;text-decoration:none;transition:opacity .15s}
.github-btn:hover{opacity:.88}
</style>
</head>
<body>
<header>
  <div class="logo">Ser<span>vision</span></div>
  ${loggedIn ? '<a href="/auth/logout" class="logout-btn">Log out</a>' : ''}
</header>

${!loggedIn ? `
<div class="login-card">
  <div class="card-title" style="margin-bottom:12px">Publisher</div>
  <div class="card-sub">Connect your GitHub account to get started.</div>
  <a href="/auth/login" class="github-btn">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
    Continue with GitHub
  </a>
</div>
` : `
<div class="tabs">
  <button class="tab active" id="tab-btn-publish" onclick="showTab('publish')">📤 Publish Dish</button>
  <button class="tab" id="tab-btn-restaurants" onclick="showTab('restaurants')">🏪 Restaurants</button>
</div>
<div class="card">

  <!-- PUBLISH TAB -->
  <div id="tab-publish" class="section active">
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
  <div id="tab-restaurants" class="section">
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
`}

<script>
var cachedRestaurants = {};
var currentMode = 'text';

// ── TABS ──────────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active'); });
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('tab-btn-' + name).classList.add('active');
  if (name === 'restaurants') loadRestaurants();
  if (name === 'publish') loadRestaurantDropdown();
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
    return doc.transform(fns.prune(), fns.dedup());
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
      var blob = new Blob([img], { type: tex.getMimeType() || 'image/png' });
      return createImageBitmap(blob).then(function(bitmap) {
        var scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
        var w = Math.max(1, Math.round(bitmap.width * scale));
        var h = Math.max(1, Math.round(bitmap.height * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
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

// ── IN-BROWSER GLB → USDZ CONVERTER ────────────────────────────────────────
// Uses Three.js USDZExporter, loaded on-demand so it never slows the page.
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
      setStatus('convert-status', 'info', '⏳ Converting to USDZ…');
      var exporter = new USDZExporter();
      if (typeof exporter.parseAsync === 'function') {
        return exporter.parseAsync(gltf.scene);
      }
      return exporter.parse(gltf.scene);
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
      setStatus('convert-status', 'success', '✓ USDZ downloaded! Now upload it in the .usdz box below.');
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

    if (!calories && !protein && !carbs && !fat && !allergens) {
      return setStatus('nut-status', 'error', 'Fill in at least one field (calories, macros, or allergens).');
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

// ── RESTAURANT MANAGER ────────────────────────────────────────────────────────
function loadRestaurants() {
  fetch('/api/restaurants')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      cachedRestaurants = data;
      renderRestaurants(data);
    });
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
    var delBtn = document.createElement('button');
    delBtn.className = 'btn-danger';
    delBtn.title = 'Delete restaurant';
    delBtn.textContent = '×';
    delBtn.setAttribute('data-action', 'delete-restaurant');
    delBtn.setAttribute('data-slug', slug);
    headerDiv.appendChild(nameDiv);
    headerDiv.appendChild(delBtn);

    var branchesDiv = document.createElement('div');
    branchesDiv.className = 'branches-list';
    branchesDiv.id = 'branches-' + slug;
    if (bSlugs.length > 0) {
      bSlugs.forEach(function(bSlug) {
        var tag = document.createElement('span');
        tag.className = 'branch-tag';
        tag.textContent = r.branches[bSlug] + ' ';
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
});

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
          setStatus('pub-status', 'success',
            '<strong>🎉 Published!</strong><br>' +
            '<div class="link-box"><div style="flex:1"><div style="font-size:10px;color:var(--muted);margin-bottom:3px">LIVE AR PAGE — ready in ~60 sec</div>' +
            '<a href="' + data.liveUrl + '" target="_blank">' + data.liveUrl + '</a></div>' +
            '<button class="copy-btn" data-action="copy" data-copy="' + data.liveUrl + '">Copy</button></div>' +
            '<div class="link-box"><div style="flex:1"><div style="font-size:10px;color:var(--muted);margin-bottom:3px">GITHUB REPO</div>' +
            '<a href="' + data.repoUrl + '" target="_blank">' + data.repoUrl + '</a></div>' +
            '<button class="copy-btn" data-action="copy" data-copy="' + data.repoUrl + '">Copy</button></div>' +
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

function buildARPage(dishName, brandName, topLabel, logoFileName) {
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
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--amber:#C8873A;--bg:#111009;--surface:#1A1812;--border:rgba(200,135,58,0.15);--border-dim:rgba(255,255,255,0.06);--cream:#F2EDE4;--muted:rgba(242,237,228,0.45)}
html,body{height:100%;width:100%;overflow:hidden;background:var(--bg);color:var(--cream);font-family:'DM Sans',sans-serif}
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
.dish-name{font-family:'Cormorant Garamond',serif;font-size:clamp(34px,10vw,54px);font-weight:600;line-height:1.05;color:var(--cream)}
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
.brand-name{font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:600;color:var(--cream);line-height:1.1;text-align:center;padding:0 16px}
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
</div>
<script>
var mv = document.getElementById('mv');
document.getElementById('arBtn').addEventListener('click', function() {
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
  document.getElementById('lang-en').classList.toggle('active',l==='en');
  document.getElementById('lang-fr').classList.toggle('active',l==='fr');
}
var lang=(navigator.language||navigator.userLanguage||'').toLowerCase();
if(lang.startsWith('fr')) setLang('fr');
<\/script>
</body>
</html>`;
}
