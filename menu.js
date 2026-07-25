// ============================================================
// MENU — the single-QR "whole menu" system.
//
// HOW IT WORKS
// Each restaurant repo carries a small manifest file at:
//     <branch>/dishes.json     (or  dishes.json  at repo root when no branch)
//
// Every /publish updates that manifest. The menu page is then served
// LIVE by this server at:
//     ar.servision.ca/<restaurant>/<branch>/
// reading the manifest through the existing GitHub Pages proxy.
//
// WHY A MANIFEST INSTEAD OF THE GITHUB API
//  • No API rate limits (public menu pages could be hit constantly)
//  • No auth needed at view time
//  • Survives Railway redeploys — GitHub is the source of truth,
//    not the server's memory
//  • One QR code on the table stays valid forever: dishes can be
//    added, renamed or removed and the QR never changes
// ============================================================

const MANIFEST = 'dishes.json';
const { buildSocialRow, SOCIAL_CSS } = require('./social');

// Build the manifest path for a branch ('' = repo root).
function manifestPath(branchSlug) {
  return branchSlug ? branchSlug + '/' + MANIFEST : MANIFEST;
}

// Merge a newly published dish into an existing manifest object.
// Keeps dishes sorted by their display order, then name.
function upsertDish(manifest, dish) {
  const list = Array.isArray(manifest.dishes) ? manifest.dishes.slice() : [];
  const idx = list.findIndex(d => d.slug === dish.slug);
  if (idx >= 0) {
    // Preserve any existing order value if the new one wasn't set
    dish.order = dish.order != null ? dish.order : list[idx].order;
    list[idx] = { ...list[idx], ...dish };
  } else {
    list.push(dish);
  }
  list.sort((a, b) => {
    const ao = a.order != null ? a.order : 9999;
    const bo = b.order != null ? b.order : 9999;
    if (ao !== bo) return ao - bo;
    return (a.name || '').localeCompare(b.name || '');
  });
  return {
    version: 1,
    restaurant: dish._restaurant || manifest.restaurant || '',
    branch: dish._branch || manifest.branch || '',
    brandName: dish._brandName || manifest.brandName || '',
    logo: dish._logo || manifest.logo || null,
    theme: dish._theme || manifest.theme || 'dark-elegant',
    socials: dish._socials || manifest.socials || {},
    updated: new Date().toISOString(),
    dishes: list.map(d => ({
      slug: d.slug,
      name: d.name,
      label: d.label || '',
      order: d.order != null ? d.order : null,
    })),
  };
}

// ── Menu page ────────────────────────────────────────────────────────────────
// Themes mirror buildARPage so the menu matches the dish pages.
const MENU_THEMES = {
  'dark-elegant': {
    fonts: 'Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=DM+Sans:wght@400;500;600',
    display: "'Cormorant Garamond',serif",
    body: "'DM Sans',sans-serif",
    vars: "--accent:#C8873A;--bg:#111009;--surface:#1A1812;--border:rgba(200,135,58,0.18);--fg:#F2EDE4;--muted:rgba(242,237,228,0.45)"
  },
  'light-minimal': {
    fonts: 'Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600&family=Inter:wght@400;500;600',
    display: "'Fraunces',serif",
    body: "'Inter',sans-serif",
    vars: "--accent:#B4523A;--bg:#F6F3EE;--surface:#FFFFFF;--border:rgba(30,25,20,0.12);--fg:#1E1914;--muted:rgba(30,25,20,0.5)"
  },
  'bold-modern': {
    fonts: 'Space+Grotesk:wght@400;500;700',
    display: "'Space Grotesk',sans-serif",
    body: "'Space Grotesk',sans-serif",
    vars: "--accent:#E8FF5A;--bg:#0C0C0E;--surface:#161619;--border:rgba(232,255,90,0.18);--fg:#F5F5F5;--muted:rgba(245,245,245,0.5)"
  },
  'warm-trattoria': {
    fonts: 'Playfair+Display:ital,wght@0,400;0,700;1,400&family=Nunito+Sans:wght@400;600;700',
    display: "'Playfair Display',serif",
    body: "'Nunito Sans',sans-serif",
    vars: "--accent:#9C2B2B;--bg:#1C1410;--surface:#271C16;--border:rgba(212,160,90,0.20);--fg:#F5E9D8;--muted:rgba(245,233,216,0.5)"
  }
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Renders the menu index: one QR on the table opens this, every dish inside.
function buildMenuPage(manifest, basePath) {
  const t = MENU_THEMES[manifest.theme] || MENU_THEMES['dark-elegant'];
  const dishes = Array.isArray(manifest.dishes) ? manifest.dishes : [];
  const brand = manifest.brandName || manifest.restaurant || 'Menu';
  const logo = manifest.logo;

  const identity = logo
    ? '<img class="logo" src="' + esc(basePath + logo) + '" alt="' + esc(brand) + '">'
    : '<div class="brand-name">' + esc(brand) + '</div>';

  const cards = dishes.map(function (d, i) {
    const href = esc(basePath + d.slug + '/');
    const label = d.label ? '<div class="dish-label">' + esc(d.label) + '</div>' : '';
    return (
      '<a class="dish" href="' + href + '" style="animation-delay:' + (i * 55) + 'ms">' +
        '<div class="dish-main">' +
          label +
          '<div class="dish-name">' + esc(d.name) + '</div>' +
        '</div>' +
        '<div class="dish-go" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M5 12h13M13 6l6 6-6 6"/></svg>' +
        '</div>' +
      '</a>'
    );
  }).join('');

  const emptyState =
    '<div class="empty">' +
      '<div class="empty-title" data-i18n="emptyTitle">No dishes yet</div>' +
      '<div class="empty-sub" data-i18n="emptySub">This menu is being prepared.</div>' +
    '</div>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<title>${esc(brand)} — AR Menu</title>
<meta name="description" content="See ${esc(brand)}'s dishes in 3D on your table.">
<link href="https://fonts.googleapis.com/css2?family=${t.fonts}&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{${t.vars}}
html,body{min-height:100%;background:var(--bg);color:var(--fg);font-family:${t.body};-webkit-font-smoothing:antialiased}
body{background:
  radial-gradient(900px 420px at 50% -8%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 62%),
  var(--bg);
  background-attachment:fixed;
  padding:max(env(safe-area-inset-top),22px) 20px max(env(safe-area-inset-bottom),40px)}
.wrap{max-width:520px;margin:0 auto}
header{text-align:center;margin-bottom:26px}
.logo{max-width:170px;max-height:66px;width:auto;height:auto;object-fit:contain;display:block;margin:0 auto 10px}
.brand-name{font-family:${t.display};font-size:34px;font-weight:600;line-height:1.1;margin-bottom:6px}
.rule{width:44px;height:1px;background:var(--accent);opacity:.5;margin:12px auto}
.kicker{font-size:10.5px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--accent)}
.lead{font-size:13px;color:var(--muted);margin-top:10px;line-height:1.5}
.lang{position:absolute;top:max(env(safe-area-inset-top),16px);right:16px;display:flex;border:1px solid var(--border);border-radius:7px;overflow:hidden}
.lang button{background:none;border:none;color:var(--muted);font-family:inherit;font-size:10px;font-weight:700;letter-spacing:.06em;padding:6px 11px;cursor:pointer;transition:.15s}
.lang button.on{background:color-mix(in srgb, var(--accent) 16%, transparent);color:var(--accent)}
.list{display:flex;flex-direction:column;gap:10px}
.dish{display:flex;align-items:center;gap:14px;background:var(--surface);border:1px solid var(--border);border-radius:14px;
  padding:17px 18px;text-decoration:none;color:inherit;
  transition:transform .16s ease, border-color .16s ease, background .16s ease;
  opacity:0;animation:rise .45s ease forwards;-webkit-tap-highlight-color:transparent}
.dish:active{transform:scale(.985)}
@media(hover:hover){.dish:hover{border-color:color-mix(in srgb, var(--accent) 55%, transparent);transform:translateY(-1px)}}
.dish-main{flex:1;min-width:0}
.dish-label{font-size:9.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin-bottom:4px;opacity:.85}
.dish-name{font-family:${t.display};font-size:22px;font-weight:600;line-height:1.2;overflow-wrap:anywhere}
.dish-go{flex-shrink:0;width:34px;height:34px;border-radius:50%;border:1px solid var(--border);
  display:flex;align-items:center;justify-content:center;color:var(--accent)}
.empty{text-align:center;padding:52px 20px;border:1px dashed var(--border);border-radius:14px}
.empty-title{font-family:${t.display};font-size:22px;margin-bottom:6px}
.empty-sub{font-size:13px;color:var(--muted)}
footer{text-align:center;margin-top:30px;font-size:10.5px;color:var(--muted);line-height:1.7}
.dot{display:inline-block;width:2px;height:2px;border-radius:50%;background:var(--muted);vertical-align:middle;margin:0 7px}
@keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
${SOCIAL_CSS}
@media (prefers-reduced-motion:reduce){.dish{animation:none;opacity:1}}
</style>
</head>
<body>
<div class="lang">
  <button id="l-en" class="on" onclick="setLang('en')">EN</button>
  <button id="l-fr" onclick="setLang('fr')">FR</button>
</div>
<div class="wrap">
  <header>
    ${identity}
    <div class="rule"></div>
    <div class="kicker" data-i18n="kicker">AR Menu</div>
    <p class="lead" data-i18n="lead">Tap any dish to see it in 3D on your table.</p>
  </header>
  <div class="list">
    ${dishes.length ? cards : emptyState}
  </div>
  <footer>
    <span data-i18n="f1">Works on iPhone &amp; Android</span><span class="dot"></span><span data-i18n="f2">No app needed</span>
    ${buildSocialRow(manifest.socials)}
    <div style="margin-top:8px;opacity:.6">Servision</div>
  </footer>
</div>
<script>
var T={
  en:{kicker:'AR Menu',lead:'Tap any dish to see it in 3D on your table.',f1:'Works on iPhone & Android',f2:'No app needed',emptyTitle:'No dishes yet',emptySub:'This menu is being prepared.'},
  fr:{kicker:'Menu RA',lead:'Appuyez sur un plat pour le voir en 3D sur votre table.',f1:'Compatible iPhone & Android',f2:'Sans application',emptyTitle:'Aucun plat pour le moment',emptySub:'Ce menu est en préparation.'}
};
function setLang(l){
  var t=T[l]||T.en;
  document.querySelectorAll('[data-i18n]').forEach(function(el){
    var k=el.getAttribute('data-i18n'); if(t[k]) el.innerHTML=t[k];
  });
  document.getElementById('l-en').className = l==='en'?'on':'';
  document.getElementById('l-fr').className = l==='fr'?'on':'';
  document.documentElement.lang=l;
  try{localStorage.setItem('sv_lang',l);}catch(e){}
}
(function(){
  var saved=null; try{saved=localStorage.getItem('sv_lang');}catch(e){}
  var l=saved||((navigator.language||'en').toLowerCase().indexOf('fr')===0?'fr':'en');
  setLang(l);
})();

// ── Analytics: menu opened + which dish was tapped ──────────────────────
(function(){
  var TRACK='https://ar.servision.ca/track';
  var key=location.pathname.replace(/^\\/+|\\/+$/g,'');
  var ua=navigator.userAgent||'';
  var device=/iphone|ipad|ipod/i.test(ua)?'iphone':(/android/i.test(ua)?'android':'other');
  function send(type,extra){
    try{
      var body=JSON.stringify(Object.assign({dishKey:key,type:type,device:device},extra||{}));
      if(navigator.sendBeacon){navigator.sendBeacon(TRACK,new Blob([body],{type:'application/json'}));}
      else{fetch(TRACK,{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:true}).catch(function(){});}
    }catch(e){}
  }
  send('menu_open');
  document.querySelectorAll('a.dish').forEach(function(a){
    a.addEventListener('click',function(){
      var href=a.getAttribute('href')||'';
      var slug=href.replace(/\\/+$/,'').split('/').pop();
      send('menu_tap',{dishSlug:slug});
    });
  });
  var start=Date.now(),sent=false;
  function bye(){ if(sent)return; sent=true; send('view_time',{viewMs:Date.now()-start}); }
  document.addEventListener('visibilitychange',function(){ if(document.visibilityState==='hidden') bye(); });
  window.addEventListener('pagehide',bye);
})();
</script>
</body>
</html>`;
}

module.exports = { manifestPath, upsertDish, buildMenuPage, MANIFEST };
