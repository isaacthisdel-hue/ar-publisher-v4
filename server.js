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
  res.setHeader('Content-Type', 'text/html');
  res.send(getAppHTML());
});

app.get('/auth/login', (req, res) => {
  res.redirect(`https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=repo`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      { client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code },
      { headers: { Accept: 'application/json' } }
    );
    const accessToken = tokenRes.data.access_token;
    if (!accessToken) return res.redirect('/?error=no_token');
    res.cookie('gh_token', signToken(accessToken), { httpOnly: true, maxAge: 30*24*60*60*1000, sameSite: 'lax' });
    res.redirect('/');
  } catch { res.redirect('/?error=oauth_failed'); }
});

app.get('/auth/me', async (req, res) => {
  const signed = req.cookies.gh_token;
  if (!signed) return res.json({ loggedIn: false });
  const token = unsignToken(signed);
  if (!token) return res.json({ loggedIn: false });
  try {
    const { data } = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'AR-Publisher' },
      timeout: 5000
    });
    console.log('auth/me success:', data.login);
    res.json({ loggedIn: true, username: data.login, avatar: data.avatar_url });
  } catch (err) {
    console.error('auth/me failed:', err.message);
    res.json({ loggedIn: false });
  }
});

app.get('/auth/logout', (req, res) => { res.clearCookie('gh_token'); res.redirect('/'); });

app.post('/publish', upload.fields([{ name: 'glbFile', maxCount: 1 }, { name: 'usdzFile', maxCount: 1 }]), async (req, res) => {
  const token = unsignToken(req.cookies.gh_token || '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const dishName  = (req.body.dishName  || 'My Dish').trim();
  const brandName = (req.body.brandName || 'Brand').trim();
  const topLabel  = (req.body.topLabel  || 'On the menu').trim();
  const glbFile   = req.files?.glbFile?.[0];
  const usdzFile  = req.files?.usdzFile?.[0];
  if (!glbFile)  return res.status(400).json({ error: 'Missing .glb file' });
  if (!usdzFile) return res.status(400).json({ error: 'Missing .usdz file' });

  let username;
  try {
    const { data } = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'AR-Publisher' }
    });
    username = data.login;
  } catch { return res.status(401).json({ error: 'Could not fetch GitHub user' }); }

  const slug = dishName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const repoName = `ar-${slug}`;
  const ghHeaders = { Authorization: `Bearer ${token}`, 'User-Agent': 'AR-Publisher', Accept: 'application/vnd.github+json' };

  try {
    await axios.post('https://api.github.com/user/repos', { name: repoName, description: `AR viewer for ${dishName}`, private: false, auto_init: false }, { headers: ghHeaders });
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    if (!msg.includes('already exists')) return res.status(500).json({ error: `Could not create repo: ${msg}` });
  }

  async function pushFile(filePath, contentBuffer) {
    const url = `https://api.github.com/repos/${username}/${repoName}/contents/${filePath}`;
    let sha;
    try { const e = await axios.get(url, { headers: ghHeaders }); sha = e.data.sha; } catch {}
    const body = { message: `Add ${filePath}`, content: contentBuffer.toString('base64') };
    if (sha) body.sha = sha;
    await axios.put(url, body, { headers: ghHeaders });
  }

  try {
    await pushFile('index.html', Buffer.from(getARTemplate(dishName, brandName, topLabel), 'utf8'));
    await pushFile('model.glb',  glbFile.buffer);
    await pushFile('model.usdz', usdzFile.buffer);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to push files to GitHub: ' + (err.response?.data?.message || err.message) });
  }

  try {
    await axios.post(`https://api.github.com/repos/${username}/${repoName}/pages`, { source: { branch: 'main', path: '/' } }, { headers: ghHeaders });
  } catch (err) {
    if (err.response?.status !== 409) console.error('Pages error:', err.response?.data || err.message);
  }

  res.json({ success: true, repoUrl: `https://github.com/${username}/${repoName}`, liveUrl: `https://${username}.github.io/${repoName}` });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`AR Publisher running on port ${PORT}`));

function getAppHTML() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>AR Publisher</title><link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"><style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--amber:#C8873A;--bg:#111009;--surface:#1A1812;--surface2:#211F17;--border:rgba(200,135,58,0.2);--text:#F2EDE4;--muted:rgba(242,237,228,0.5);--cream:#F2EDE4;--green:#4CAF7D}html,body{min-height:100%;background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif}body{display:flex;flex-direction:column;align-items:center;padding:48px 20px 80px}header{width:100%;max-width:520px;display:flex;justify-content:space-between;align-items:center;margin-bottom:48px}.logo{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;letter-spacing:.12em;color:var(--cream)}.logo span{color:var(--amber)}.user-area{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted)}.user-area img{width:28px;height:28px;border-radius:50%;border:1px solid var(--border)}.logout-btn{background:none;border:1px solid var(--border);color:var(--muted);font-size:11px;padding:4px 10px;border-radius:4px;cursor:pointer;font-family:inherit;text-decoration:none}.card{width:100%;max-width:520px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:40px}.card-title{font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:600;color:var(--cream);margin-bottom:6px}.card-sub{font-size:13px;color:var(--muted);margin-bottom:32px;line-height:1.5}#login-view{display:flex;flex-direction:column;align-items:center;text-align:center;padding:20px 0;gap:16px}.github-btn{display:flex;align-items:center;gap:10px;background:var(--cream);color:#111;font-family:inherit;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;border:none;cursor:pointer;text-decoration:none}#form-view{display:none}.field{margin-bottom:20px}.field label{display:block;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--amber);margin-bottom:8px}.field input[type=text]{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:11px 14px;color:var(--cream);font-family:inherit;font-size:14px;outline:none}.field input[type=text]::placeholder{color:var(--muted)}.file-zone{width:100%;background:var(--surface2);border:1px dashed var(--border);border-radius:8px;padding:20px;text-align:center;cursor:pointer;position:relative}.file-zone input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}.file-zone-label{font-size:12px;color:var(--muted);pointer-events:none}.file-zone-label strong{display:block;color:var(--cream);font-size:13px;margin-bottom:4px}.file-zone.has-file{border-color:var(--green);border-style:solid}.file-zone.has-file .file-zone-label strong{color:var(--green)}.divider{height:1px;background:var(--border);margin:28px 0}.publish-btn{width:100%;background:var(--amber);color:#111009;font-family:inherit;font-size:14px;font-weight:600;padding:14px;border-radius:8px;border:none;cursor:pointer}.publish-btn:disabled{opacity:.4;cursor:not-allowed}#status{margin-top:20px;padding:14px 16px;border-radius:8px;font-size:13px;display:none}#status.info{background:rgba(200,135,58,.1);border:1px solid var(--border);color:var(--cream)}#status.error{background:rgba(224,85,85,.1);border:1px solid rgba(224,85,85,.3);color:#E05555}#status.success{background:rgba(76,175,125,.1);border:1px solid rgba(76,175,125,.3);color:var(--cream)}.result-links{margin-top:12px;display:flex;flex-direction:column;gap:8px}.result-link{display:flex;align-items:center;justify-content:space-between;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:12px}.result-link a{color:var(--amber);text-decoration:none;word-break:break-all}.copy-btn{background:none;border:1px solid var(--border);color:var(--muted);font-size:10px;padding:3px 8px;border-radius:4px;cursor:pointer;font-family:inherit;flex-shrink:0;margin-left:8px}.notice{margin-top:10px;font-size:11.5px;color:var(--muted);line-height:1.5}</style></head><body><header><div class="logo">AR <span>Publisher</span></div><div class="user-area" id="user-area" style="display:none"><img id="user-avatar" src="" alt=""><span id="user-name"></span><a href="/auth/logout" class="logout-btn">Log out</a></div></header><div class="card"><div class="card-title">Publish AR Experience</div><div class="card-sub">Upload your 3D model, fill in the details, and get a live shareable link in seconds.</div><div id="login-view"><p style="font-size:14px;color:var(--muted);line-height:1.6;max-width:320px">Connect your GitHub account. The app creates a public repo and enables GitHub Pages automatically.</p><a href="/auth/login" class="github-btn"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>Continue with GitHub</a></div><div id="form-view"><div class="field"><label>Dish Name</label><input type="text" id="dishName" placeholder="e.g. Margherita Pizza" maxlength="60"></div><div class="field"><label>Brand Name</label><input type="text" id="brandName" placeholder="e.g. NOSTRA" maxlength="20"></div><div class="field"><label>Top Label</label><input type="text" id="topLabel" placeholder="e.g. On the menu" maxlength="30"></div><div class="divider"></div><div class="field"><label>3D Model — .glb file</label><div class="file-zone" id="glb-zone"><input type="file" id="glbFile" accept=".glb"><div class="file-zone-label"><strong>Choose .glb file</strong>Click to browse or drag & drop</div></div></div><div class="field"><label>AR Model — .usdz file</label><div class="file-zone" id="usdz-zone"><input type="file" id="usdzFile" accept=".usdz"><div class="file-zone-label"><strong>Choose .usdz file</strong>Click to browse or drag & drop</div></div></div><div style="margin-top:28px"><button class="publish-btn" id="publish-btn" onclick="publish()">Publish to GitHub Pages →</button></div><div id="status"></div></div></div><script>(async()=>{try{const r=await fetch('/auth/me');const d=await r.json();if(d.loggedIn)showForm(d);else document.getElementById('login-view').style.display='flex';}catch{document.getElementById('login-view').style.display='flex';}})();function showForm(user){document.getElementById('login-view').style.display='none';document.getElementById('form-view').style.display='block';const ua=document.getElementById('user-area');ua.style.display='flex';document.getElementById('user-avatar').src=user.avatar;document.getElementById('user-name').textContent=user.username;}['glb','usdz'].forEach(type=>{const input=document.getElementById(type+'File');const zone=document.getElementById(type+'-zone');const label=zone.querySelector('strong');input.addEventListener('change',()=>{if(input.files[0]){zone.classList.add('has-file');label.textContent='✓ '+input.files[0].name;}});zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over');});zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag-over');const file=e.dataTransfer.files[0];if(file){const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;zone.classList.add('has-file');label.textContent='✓ '+file.name;}});});async function publish(){const dishName=document.getElementById('dishName').value.trim();const brandName=document.getElementById('brandName').value.trim();const topLabel=document.getElementById('topLabel').value.trim();const glbFile=document.getElementById('glbFile').files[0];const usdzFile=document.getElementById('usdzFile').files[0];if(!dishName)return showStatus('error','Please enter a dish name.');if(!brandName)return showStatus('error','Please enter a brand name.');if(!glbFile)return showStatus('error','Please select a .glb file.');if(!usdzFile)return showStatus('error','Please select a .usdz file.');const btn=document.getElementById('publish-btn');btn.disabled=true;btn.textContent='Publishing…';showStatus('info','⏳ Uploading and creating repo…');const form=new FormData();form.append('dishName',dishName);form.append('brandName',brandName);form.append('topLabel',topLabel||'On the menu');form.append('glbFile',glbFile);form.append('usdzFile',usdzFile);try{const res=await fetch('/publish',{method:'POST',body:form});const data=await res.json();if(!res.ok||data.error)showStatus('error','❌ '+(data.error||'Something went wrong.'));else showResult(data);}catch(err){showStatus('error','❌ Network error: '+err.message);}btn.disabled=false;btn.textContent='Publish to GitHub Pages →';}function showStatus(type,msg){const el=document.getElementById('status');el.className=type;el.style.display='block';el.innerHTML=msg;}function showResult(data){const el=document.getElementById('status');el.className='success';el.style.display='block';el.innerHTML='<strong>🎉 Published!</strong><div class="result-links"><div class="result-link"><div><div style="font-size:10px;color:var(--muted);margin-bottom:2px">LIVE AR PAGE (ready in ~60 sec)</div><a href="'+data.liveUrl+'" target="_blank">'+data.liveUrl+'</a></div><button class="copy-btn" onclick="copyText(\''+data.liveUrl+'\',this)">Copy</button></div><div class="result-link"><div><div style="font-size:10px;color:var(--muted);margin-bottom:2px">GITHUB REPO</div><a href="'+data.repoUrl+'" target="_blank">'+data.repoUrl+'</a></div><button class="copy-btn" onclick="copyText(\''+data.repoUrl+'\',this)">Copy</button></div></div><div class="notice">⏱ GitHub Pages takes ~60 seconds to go live after first publish.</div>';}function copyText(text,btn){navigator.clipboard.writeText(text).then(()=>{btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',1500);});}</script></body></html>`;
}

function getARTemplate(dishName, brandName, topLabel) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"><title>${dishName} — AR</title><script type="module" src="https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js"><\/script><link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"><style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--amber:#C8873A;--bg:#111009;--surface:#1A1812;--border:rgba(200,135,58,0.15);--border-dim:rgba(255,255,255,0.06);--cream:#F2EDE4;--muted:rgba(242,237,228,0.45)}html,body{height:100%;width:100%;overflow:hidden;background:var(--bg);color:var(--cream);font-family:'DM Sans',sans-serif}model-viewer{position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:0;left:0}.page{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;padding-top:max(env(safe-area-inset-top),22px);padding-bottom:max(env(safe-area-inset-bottom),30px);padding-left:28px;padding-right:28px}.top-label{display:flex;align-items:center;gap:10px;animation:fadeDown .6s ease both}.top-line{flex:1;height:1px;max-width:40px;background:var(--border)}.top-text{font-size:10px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--amber);opacity:.85}.title-block{text-align:center;margin-top:16px;animation:fadeDown .6s .1s ease both}.dish-name{font-family:'Cormorant Garamond',serif;font-size:clamp(44px,13vw,62px);font-weight:600;line-height:1;color:var(--cream)}.dish-sub{font-size:12.5px;color:var(--muted);margin-top:8px;letter-spacing:.04em}.center-wrap{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%}.tap-hint{font-size:11px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-bottom:24px;animation:fadeIn .8s .5s ease both}.ar-circle-btn{position:relative;width:min(66vw,270px);height:min(66vw,270px);border-radius:50%;background:none;border:none;cursor:pointer;-webkit-tap-highlight-color:transparent;display:flex;align-items:center;justify-content:center;animation:fadeIn .7s .2s ease both}.ring-slow{position:absolute;inset:-18px;border-radius:50%;border:1px solid rgba(200,135,58,.12);animation:breathe-ring 4s ease-in-out infinite}.ring-slow-2{position:absolute;inset:-36px;border-radius:50%;border:1px solid rgba(200,135,58,.06);animation:breathe-ring 4s .8s ease-in-out infinite}.circle-face{position:relative;width:100%;height:100%;border-radius:50%;border:1px solid var(--border);background:radial-gradient(circle at 38% 32%,rgba(200,135,58,.1) 0%,transparent 55%),radial-gradient(circle at 65% 72%,rgba(200,135,58,.05) 0%,transparent 45%),#1A1812;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;overflow:hidden;transition:transform .18s ease,border-color .18s ease;animation:plate-breathe 4s ease-in-out infinite}.ar-circle-btn:active .circle-face{transform:scale(.96);border-color:rgba(200,135,58,.5)}.circle-face::after{content:'';position:absolute;top:-40%;left:-50%;width:35%;height:180%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.04),transparent);transform:skewX(-15deg);animation:soft-sweep 5s ease-in-out infinite}.plate-rim{position:absolute;inset:14px;border-radius:50%;border:1px solid rgba(200,135,58,.12);pointer-events:none}.brand-area{display:flex;flex-direction:column;align-items:center;gap:6px;z-index:1}.brand-name{font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:600;letter-spacing:.18em;color:var(--cream);line-height:1;opacity:.92}.brand-divider{width:32px;height:1px;background:var(--border)}.brand-sub{font-size:9.5px;font-weight:600;letter-spacing:.25em;text-transform:uppercase;color:var(--amber);opacity:.8}.steps{display:flex;align-items:flex-start;gap:8px;margin-top:32px;animation:fadeUp .6s .45s ease both}.step{display:flex;flex-direction:column;align-items:center;gap:6px;width:72px}.step-num{width:24px;height:24px;border-radius:50%;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--amber)}.step-label{font-size:10.5px;color:var(--muted);text-align:center;line-height:1.4}.step-line{width:16px;height:1px;background:var(--border-dim);margin-top:12px;flex-shrink:0}.compat{margin-top:20px;display:flex;align-items:center;gap:12px;font-size:10.5px;color:var(--muted);animation:fadeUp .6s .55s ease both}.compat-sep{width:2px;height:2px;border-radius:50%;background:var(--border)}@keyframes fadeDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes breathe-ring{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.03)}}@keyframes plate-breathe{0%,100%{box-shadow:0 4px 40px rgba(200,135,58,.08)}50%{box-shadow:0 4px 70px rgba(200,135,58,.18)}}@keyframes soft-sweep{0%{left:-50%;opacity:0}20%{opacity:1}60%{left:130%;opacity:0}100%{left:130%;opacity:0}}</style></head><body><model-viewer src="model.glb" ios-src="model.usdz" ar ar-modes="webxr scene-viewer quick-look"><button slot="ar-button" id="hidden-ar-trigger" style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;"></button></model-viewer><div class="page"><div class="top-label"><div class="top-line"></div><span class="top-text">${topLabel}</span><div class="top-line"></div></div><div class="title-block"><div class="dish-name">See it<br>on your table</div><div class="dish-sub">Tap to bring this dish to life in your space</div></div><div class="center-wrap"><div class="tap-hint">Tap to preview</div><button class="ar-circle-btn" onclick="launchAR()" aria-label="Preview in AR"><div class="ring-slow"></div><div class="ring-slow-2"></div><div class="circle-face"><div class="plate-rim"></div><div class="brand-area"><div class="brand-name">${brandName}</div><div class="brand-divider"></div><div class="brand-sub">View in AR</div></div></div></button><div class="steps"><div class="step"><div class="step-num">1</div><div class="step-label">Tap the circle</div></div><div class="step-line"></div><div class="step"><div class="step-num">2</div><div class="step-label">Point at your table</div></div><div class="step-line"></div><div class="step"><div class="step-num">3</div><div class="step-label">See it appear</div></div></div></div><div class="compat"><span>Works on iPhone & Android</span><span class="compat-sep"></span><span>No app needed</span></div></div><script>function launchAR(){const mv=document.querySelector('model-viewer');if(mv&&mv.canActivateAR)mv.activateAR();else document.getElementById('hidden-ar-trigger').click();}<\/script></body></html>`;
}
