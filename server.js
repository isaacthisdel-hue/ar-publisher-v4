const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cookieParser = require('cookie-parser');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());
app.use(cookieParser());

const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_SECRET = 'changeme' } = process.env;

function signToken(token) {
  return Buffer.from(COOKIE_SECRET + '|' + token).toString('base64');
}
function unsignToken(signed) {
  try {
    const decoded = Buffer.from(signed, 'base64').toString('utf8');
    const [secret, ...rest] = decoded.split('|');
    if (secret !== COOKIE_SECRET) return null;
    return rest.join('|');
  } catch { return null; }
}

app.get('/', (req, res) => {
  const signed = req.cookies.gh_token;
  const token = signed ? unsignToken(signed) : null;
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buildHTML(!!token));
});

app.get('/auth/login', (req, res) => {
  res.redirect('https://github.com/login/oauth/authorize?client_id=' + GITHUB_CLIENT_ID + '&scope=repo');
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/');
  try {
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      { client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code },
      { headers: { Accept: 'application/json' } }
    );
    const accessToken = tokenRes.data.access_token;
    if (!accessToken) return res.redirect('/');
    res.cookie('gh_token', signToken(accessToken), {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/');
  }
});

app.get('/auth/logout', (req, res) => {
  res.clearCookie('gh_token');
  res.redirect('/');
});

app.post('/publish', upload.fields([
  { name: 'glbFile',   maxCount: 1 },
  { name: 'usdzFile',  maxCount: 1 },
  { name: 'logoFile',  maxCount: 1 }
]), async (req, res) => {
  const signed = req.cookies.gh_token;
  if (!signed) return res.status(401).json({ error: 'Not logged in' });
  const token = unsignToken(signed);
  if (!token) return res.status(401).json({ error: 'Invalid session' });

  const dishName   = (req.body.dishName   || 'My Dish').trim();
  const brandName  = (req.body.brandName  || '').trim();
  const topLabel   = (req.body.topLabel   || '').trim();
  const glbFile    = req.files?.glbFile?.[0];
  const usdzFile   = req.files?.usdzFile?.[0];
  const logoFile   = req.files?.logoFile?.[0];

  if (!glbFile)  return res.status(400).json({ error: 'Missing .glb file' });
  if (!usdzFile) return res.status(400).json({ error: 'Missing .usdz file' });
  if (!brandName && !logoFile) return res.status(400).json({ error: 'Please enter a company name or upload a logo' });

  let username;
  try {
    const { data } = await axios.get('https://api.github.com/user', {
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'AR-Publisher' },
      timeout: 8000
    });
    username = data.login;
  } catch (err) {
    return res.status(401).json({ error: 'Could not verify GitHub user' });
  }

  const slug = dishName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const repoName = 'ar-' + slug;
  const ghHeaders = {
    Authorization: 'Bearer ' + token,
    'User-Agent': 'AR-Publisher',
    Accept: 'application/vnd.github+json'
  };

  try {
    await axios.post('https://api.github.com/user/repos', {
      name: repoName,
      description: 'AR viewer for ' + dishName,
      private: false,
      auto_init: false
    }, { headers: ghHeaders });
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    if (!msg.includes('already exists')) {
      return res.status(500).json({ error: 'Could not create repo: ' + msg });
    }
  }

  async function pushFile(filePath, contentBuffer) {
    const url = 'https://api.github.com/repos/' + username + '/' + repoName + '/contents/' + filePath;
    let sha;
    try {
      const existing = await axios.get(url, { headers: ghHeaders });
      sha = existing.data.sha;
    } catch {}
    const body = { message: 'Add ' + filePath, content: contentBuffer.toString('base64') };
    if (sha) body.sha = sha;
    await axios.put(url, body, { headers: ghHeaders });
  }

  // Determine logo: if file uploaded, use logo.png, otherwise use text
  let logoFileName = null;
  if (logoFile) {
    const ext = logoFile.originalname.split('.').pop().toLowerCase();
    logoFileName = 'logo.' + ext;
  }

  try {
    await pushFile('index.html', Buffer.from(buildARPage(dishName, brandName, topLabel, logoFileName), 'utf8'));
    await pushFile('model.glb',  glbFile.buffer);
    await pushFile('model.usdz', usdzFile.buffer);
    if (logoFile && logoFileName) {
      await pushFile(logoFileName, logoFile.buffer);
    }
  } catch (err) {
    console.error('Push error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to push files: ' + (err.response?.data?.message || err.message) });
  }

  try {
    await axios.post(
      'https://api.github.com/repos/' + username + '/' + repoName + '/pages',
      { source: { branch: 'main', path: '/' } },
      { headers: ghHeaders }
    );
  } catch (err) {
    if (err.response?.status !== 409) {
      console.error('Pages error:', err.response?.data || err.message);
    }
  }

  res.json({
    success: true,
    repoUrl: 'https://github.com/' + username + '/' + repoName,
    liveUrl: 'https://' + username + '.github.io/' + repoName
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log('AR Publisher running on port ' + PORT));

// ── PUBLISHER UI ─────────────────────────────────────────────────────────────

function buildHTML(loggedIn) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AR Publisher</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--amber:#C8873A;--bg:#111009;--surface:#1A1812;--surface2:#211F17;--border:rgba(200,135,58,0.2);--muted:rgba(242,237,228,0.5);--cream:#F2EDE4;--green:#4CAF7D;}
html,body{min-height:100%;background:var(--bg);color:var(--cream);font-family:'DM Sans',sans-serif}
body{display:flex;flex-direction:column;align-items:center;padding:48px 20px 80px}
header{width:100%;max-width:520px;display:flex;justify-content:space-between;align-items:center;margin-bottom:48px}
.logo{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;letter-spacing:.12em}
.logo span{color:var(--amber)}
.logout-btn{background:none;border:1px solid var(--border);color:var(--muted);font-size:11px;padding:4px 10px;border-radius:4px;cursor:pointer;font-family:inherit;text-decoration:none}
.card{width:100%;max-width:520px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:40px}
.card-title{font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:600;margin-bottom:6px}
.card-sub{font-size:13px;color:var(--muted);margin-bottom:32px;line-height:1.5}
.github-btn{display:inline-flex;align-items:center;gap:10px;background:var(--cream);color:#111;font-family:inherit;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;border:none;cursor:pointer;text-decoration:none}
.field{margin-bottom:20px}
.field label{display:block;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--amber);margin-bottom:8px}
.hint{font-size:11px;color:var(--muted);margin-top:5px;line-height:1.4}
.field input[type=text]{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:11px 14px;color:var(--cream);font-family:inherit;font-size:14px;outline:none}
.field input[type=text]:focus{border-color:var(--amber)}
.field input[type=text]::placeholder{color:var(--muted)}
.file-zone{width:100%;background:var(--surface2);border:2px dashed var(--border);border-radius:8px;padding:24px;text-align:center;cursor:pointer;position:relative;transition:border-color .2s}
.file-zone:hover{border-color:var(--amber)}
.file-zone input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.file-zone .label{font-size:13px;color:var(--muted);pointer-events:none}
.file-zone .label strong{display:block;color:var(--cream);margin-bottom:4px}
.file-zone.done{border-color:var(--green);border-style:solid}
.file-zone.done .label strong{color:var(--green)}
.divider{height:1px;background:var(--border);margin:28px 0}
.or-divider{display:flex;align-items:center;gap:12px;margin:16px 0}
.or-divider span{font-size:11px;color:var(--muted);flex-shrink:0}
.or-divider::before,.or-divider::after{content:'';flex:1;height:1px;background:var(--border)}
.toggle-row{display:flex;gap:10px;margin-bottom:16px}
.toggle-btn{flex:1;padding:9px;border-radius:6px;border:1px solid var(--border);background:none;color:var(--muted);font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
.toggle-btn.active{border-color:var(--amber);color:var(--amber);background:rgba(200,135,58,.08)}
.publish-btn{width:100%;background:var(--amber);color:#111009;font-family:inherit;font-size:15px;font-weight:600;padding:15px;border-radius:8px;border:none;cursor:pointer;margin-top:28px}
.publish-btn:disabled{opacity:.4;cursor:not-allowed}
#status{margin-top:20px;padding:14px 16px;border-radius:8px;font-size:13px;line-height:1.6;display:none}
#status.info{background:rgba(200,135,58,.1);border:1px solid var(--border);color:var(--cream)}
#status.error{background:rgba(224,85,85,.1);border:1px solid rgba(224,85,85,.3);color:#ff8080}
#status.success{background:rgba(76,175,125,.1);border:1px solid rgba(76,175,125,.3);color:var(--cream)}
.link-box{margin-top:10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:12px 14px;font-size:12px}
.link-box a{color:var(--amber);text-decoration:none;word-break:break-all}
.tip{margin-top:10px;font-size:11.5px;color:var(--muted)}
</style>
</head>
<body>
<header>
  <div class="logo">AR <span>Publisher</span></div>
  ${loggedIn ? '<a href="/auth/logout" class="logout-btn">Log out</a>' : ''}
</header>
<div class="card">
  <div class="card-title">Publish AR Experience</div>
  <div class="card-sub">Upload your 3D model, fill in the details, and get a live shareable link.</div>

  ${!loggedIn ? `
  <div style="text-align:center;padding:20px 0">
    <p style="color:var(--muted);font-size:14px;margin-bottom:20px">Connect your GitHub account to get started.</p>
    <a href="/auth/login" class="github-btn">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
      Continue with GitHub
    </a>
  </div>
  ` : `
  <div class="field">
    <label>Dish Name</label>
    <input type="text" id="dishName" placeholder="e.g. Margherita Pizza" maxlength="60">
  </div>

  <div class="field">
    <label>Menu Section <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">(small label at top of page)</span></label>
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
      <div class="hint">Shown at the top of the AR page in elegant uppercase lettering.</div>
    </div>

    <div id="mode-logo" style="display:none">
      <div class="file-zone" id="zone-logo">
        <input type="file" id="logoFile" accept=".png,.jpg,.jpeg,.svg,.webp">
        <div class="label">
          <strong>Click to choose logo image</strong>
          PNG or SVG with transparent background works best.<br>
          Max displayed size: 160px wide — will never be stretched or cropped.
        </div>
      </div>
    </div>
  </div>

  <div class="divider"></div>

  <div class="field">
    <label>3D Model — .glb file</label>
    <div class="file-zone" id="zone-glb">
      <input type="file" id="glbFile" accept=".glb">
      <div class="label"><strong>Click to choose .glb file</strong>From Polycam export</div>
    </div>
  </div>

  <div class="field">
    <label>AR Model — .usdz file <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">(iPhone AR)</span></label>
    <div class="file-zone" id="zone-usdz">
      <input type="file" id="usdzFile" accept=".usdz">
      <div class="label"><strong>Click to choose .usdz file</strong>From Polycam export</div>
    </div>
  </div>

  <button class="publish-btn" id="publishBtn">Publish to GitHub Pages →</button>
  <div id="status"></div>
  `}
</div>

<script>
var currentMode = 'text';

function switchMode(mode) {
  currentMode = mode;
  document.getElementById('mode-text').style.display = mode === 'text' ? 'block' : 'none';
  document.getElementById('mode-logo').style.display = mode === 'logo' ? 'block' : 'none';
  document.getElementById('btn-text').classList.toggle('active', mode === 'text');
  document.getElementById('btn-logo').classList.toggle('active', mode === 'logo');
}

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

var btn = document.getElementById('publishBtn');
if (btn) {
  btn.addEventListener('click', function() {
    var dishName  = document.getElementById('dishName').value.trim();
    var topLabel  = document.getElementById('topLabel').value.trim() || '';
    var brandName = currentMode === 'text' ? document.getElementById('brandName').value.trim() : '';
    var glbFile   = document.getElementById('glbFile').files[0];
    var usdzFile  = document.getElementById('usdzFile').files[0];
    var logoFile  = currentMode === 'logo' ? document.getElementById('logoFile').files[0] : null;

    if (!dishName)                        return setStatus('error', 'Please enter a dish name.');
    if (currentMode === 'text' && !brandName) return setStatus('error', 'Please enter a company name.');
    if (currentMode === 'logo' && !logoFile)  return setStatus('error', 'Please upload a logo file.');
    if (!glbFile)                         return setStatus('error', 'Please select a .glb file.');
    if (!usdzFile)                        return setStatus('error', 'Please select a .usdz file.');

    btn.disabled = true;
    btn.textContent = 'Publishing…';
    setStatus('info', '⏳ Uploading files and creating your GitHub repo… takes about 30 seconds.');

    var form = new FormData();
    form.append('dishName',  dishName);
    form.append('brandName', brandName);
    form.append('topLabel',  topLabel);
    form.append('glbFile',   glbFile);
    form.append('usdzFile',  usdzFile);
    if (logoFile) form.append('logoFile', logoFile);

    fetch('/publish', { method: 'POST', body: form })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) {
          setStatus('error', '❌ ' + data.error);
        } else {
          setStatus('success',
            '<strong>🎉 Published!</strong><br>' +
            '<div class="link-box"><div style="font-size:10px;color:var(--muted);margin-bottom:4px">LIVE AR PAGE — ready in ~60 seconds</div>' +
            '<a href="' + data.liveUrl + '" target="_blank">' + data.liveUrl + '</a></div>' +
            '<div class="link-box"><div style="font-size:10px;color:var(--muted);margin-bottom:4px">GITHUB REPO</div>' +
            '<a href="' + data.repoUrl + '" target="_blank">' + data.repoUrl + '</a></div>' +
            '<div class="tip">⏱ GitHub Pages takes ~60 seconds to activate on first publish.</div>'
          );
        }
        btn.disabled = false;
        btn.textContent = 'Publish to GitHub Pages →';
      })
      .catch(function(err) {
        setStatus('error', '❌ Network error: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Publish to GitHub Pages →';
      });
  });
}

function setStatus(type, html) {
  var el = document.getElementById('status');
  el.className = type;
  el.style.display = 'block';
  el.innerHTML = html;
}
</script>
</body>
</html>`;
}

// ── AR PAGE ──────────────────────────────────────────────────────────────────

function buildARPage(dishName, brandName, topLabel, logoFileName) {
  // Top identity: logo image or text name
  const identityHTML = logoFileName
    ? `<img src="${logoFileName}" alt="logo" style="max-width:160px;max-height:60px;width:auto;height:auto;object-fit:contain;display:block;margin:0 auto">`
    : `<span class="top-text">${brandName}</span>`;

  // Top label line (menu section) — only show if provided
  const topLabelHTML = topLabel
    ? `<div class="top-label">
    <div class="top-line"></div>
    ${identityHTML}
    <div class="top-line"></div>
  </div>
  <div class="section-label">${topLabel}</div>`
    : `<div class="top-label">
    <div class="top-line"></div>
    ${identityHTML}
    <div class="top-line"></div>
  </div>`;

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
.page{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;padding:max(env(safe-area-inset-top),22px) 28px max(env(safe-area-inset-bottom),30px)}
.top-label{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.top-line{flex:1;height:1px;max-width:40px;background:var(--border)}
.top-text{font-size:13px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--amber)}
.section-label{font-size:10px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);text-align:center;margin-top:2px}
.title-block{text-align:center;margin-top:12px}
.dish-name{font-family:'Cormorant Garamond',serif;font-size:clamp(38px,11vw,58px);font-weight:600;line-height:1.05;color:var(--cream)}
.dish-sub{font-size:12px;color:var(--muted);margin-top:6px;letter-spacing:.04em}
.center-wrap{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%}
.tap-hint{font-size:11px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-bottom:24px}
.ar-btn{position:relative;width:min(62vw,250px);height:min(62vw,250px);border-radius:50%;background:none;border:none;cursor:pointer;-webkit-tap-highlight-color:transparent;display:flex;align-items:center;justify-content:center}
.ring1{position:absolute;inset:-18px;border-radius:50%;border:1px solid rgba(200,135,58,.12);animation:breathe 4s ease-in-out infinite}
.ring2{position:absolute;inset:-36px;border-radius:50%;border:1px solid rgba(200,135,58,.06);animation:breathe 4s .8s ease-in-out infinite}
.face{position:relative;width:100%;height:100%;border-radius:50%;border:1px solid var(--border);background:radial-gradient(circle at 38% 32%,rgba(200,135,58,.1) 0%,transparent 55%),radial-gradient(circle at 65% 72%,rgba(200,135,58,.05) 0%,transparent 45%),#1A1812;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;overflow:hidden;animation:glow 4s ease-in-out infinite}
.ar-btn:active .face{transform:scale(.96)}
.face::after{content:'';position:absolute;top:-40%;left:-50%;width:35%;height:180%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.04),transparent);transform:skewX(-15deg);animation:sweep 5s ease-in-out infinite}
.rim{position:absolute;inset:14px;border-radius:50%;border:1px solid rgba(200,135,58,.12);pointer-events:none}
.brand{display:flex;flex-direction:column;align-items:center;gap:6px;z-index:1}
.brand-name{font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:600;letter-spacing:.06em;color:var(--cream);line-height:1.1;opacity:.92;text-align:center;padding:0 16px}
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
</style>
</head>
<body>
<model-viewer src="model.glb" ios-src="model.usdz" ar ar-modes="webxr scene-viewer quick-look">
  <button slot="ar-button" id="ar-trigger" style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px"></button>
</model-viewer>
<div class="page">
  ${topLabelHTML}
  <div class="title-block">
    <div class="dish-name">${dishName}</div>
    <div class="dish-sub">Tap to bring this dish to life in your space</div>
  </div>
  <div class="center-wrap">
    <div class="tap-hint">Tap to preview</div>
    <button class="ar-btn" id="arBtn">
      <div class="ring1"></div><div class="ring2"></div>
      <div class="face">
        <div class="rim"></div>
        <div class="brand">
          <div class="brand-name">See it on<br>your table</div>
          <div class="brand-div"></div>
          <div class="brand-sub">View in AR</div>
        </div>
      </div>
    </button>
    <div class="steps">
      <div class="step"><div class="step-n">1</div><div class="step-l">Tap the circle</div></div>
      <div class="step-line"></div>
      <div class="step"><div class="step-n">2</div><div class="step-l">Point at your table</div></div>
      <div class="step-line"></div>
      <div class="step"><div class="step-n">3</div><div class="step-l">See it appear</div></div>
    </div>
  </div>
  <div class="compat"><span>Works on iPhone & Android</span><span class="dot"></span><span>No app needed</span></div>
</div>
<script>
document.getElementById('arBtn').addEventListener('click', function() {
  var mv = document.querySelector('model-viewer');
  if (mv && mv.canActivateAR) mv.activateAR();
  else document.getElementById('ar-trigger').click();
});
<\/script>
</body>
</html>`;
}
