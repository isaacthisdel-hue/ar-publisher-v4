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
const { buildSocialRow, SOCIAL_CSS, buildReviewBlock, REVIEW_CSS } = require('./social');

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
    reviewUrl: dish._reviewUrl != null ? dish._reviewUrl : (manifest.reviewUrl || ''),
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

// Accent/case-insensitive text used for client-side menu search matching
// (so "café" and "cafe", "Salmon" and "salmon" etc. all line up).
function normalizeForSearch(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
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

  // Group dishes by collection ("Breakfast", "Supper", ...), which the
  // restaurant owner sets from their private /manage dashboard. Dishes with
  // no collection assigned render first with no header, so a menu nobody
  // has organized yet still looks exactly like the old flat list.
  const groupOrder = [];
  const groupedDishes = {};
  dishes.forEach(function (d) {
    const key = d.collection || '';
    if (!(key in groupedDishes)) { groupedDishes[key] = []; groupOrder.push(key); }
    groupedDishes[key].push(d);
  });
  if (groupOrder.indexOf('') !== -1) {
    groupOrder.splice(groupOrder.indexOf(''), 1);
    groupOrder.unshift('');
  }

  let cardIndex = 0;
  const cards = groupOrder.map(function (collectionName) {
    const dishCards = groupedDishes[collectionName].map(function (d) {
      const i = cardIndex++;
      const href = esc(basePath + d.slug + '/');
      const label = d.label ? '<div class="dish-label">' + esc(d.label) + '</div>' : '';
      const searchText = esc(normalizeForSearch((d.name || '') + ' ' + (d.label || '')));
      return (
        '<a class="dish" href="' + href + '" data-search="' + searchText + '" style="animation-delay:' + (i * 55) + 'ms">' +
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
    const head = collectionName ? '<div class="collection-head">' + esc(collectionName) + '</div>' : '';
    return '<div class="collection-group">' + head + dishCards + '</div>';
  }).join('');

  const emptyState =
    '<div class="empty">' +
      '<div class="empty-title" data-i18n="emptyTitle">No dishes yet</div>' +
      '<div class="empty-sub" data-i18n="emptySub">This menu is being prepared.</div>' +
    '</div>';

  // Always show search once there's at least one dish — a 2-item menu costs
  // nothing to have it on, and hiding it below a threshold just confused
  // testing ("I don't see a search bar" on a small test menu).
  const showSearch = dishes.length > 0;
  const searchBar = showSearch
    ? '<div class="search-wrap">' +
        '<svg class="search-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>' +
        '<input class="search-input" id="menuSearch" type="search" inputmode="search" enterkeyhint="search" ' +
          'autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Search menu" ' +
          'data-i18n-placeholder="searchPlaceholder" oninput="filterMenu(this.value)">' +
      '</div>'
    : '';

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
.search-wrap{position:relative;margin:18px 0 4px}
.search-input{width:100%;background:var(--surface);border:1px solid var(--border);border-radius:12px;
  padding:13px 16px 13px 42px;font-family:inherit;font-size:15px;color:var(--fg);outline:none;
  -webkit-appearance:none;appearance:none;transition:border-color .15s ease}
.search-input::placeholder{color:var(--muted)}
.search-input:focus{border-color:color-mix(in srgb, var(--accent) 55%, transparent)}
.search-icon{position:absolute;left:15px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}
.lang{position:absolute;top:max(env(safe-area-inset-top),16px);right:16px;display:flex;border:1px solid var(--border);border-radius:7px;overflow:hidden}
.lang button{background:none;border:none;color:var(--muted);font-family:inherit;font-size:10px;font-weight:700;letter-spacing:.06em;padding:6px 11px;cursor:pointer;transition:.15s}
.lang button.on{background:color-mix(in srgb, var(--accent) 16%, transparent);color:var(--accent)}
.list{display:flex;flex-direction:column;gap:22px}
.collection-group{display:flex;flex-direction:column;gap:10px}
.collection-head{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);padding:0 2px}
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
${REVIEW_CSS}
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
  ${searchBar}
  <div class="list" id="menuList">
    ${dishes.length ? cards : emptyState}
  </div>
  <div class="empty" id="noResults" style="display:none">
    <div class="empty-title" data-i18n="noResultsTitle">No dishes match</div>
    <div class="empty-sub" data-i18n="noResultsSub">Try a different word, or clear the search.</div>
  </div>
  <footer>
    <span data-i18n="f1">Works on iPhone &amp; Android</span><span class="dot"></span><span data-i18n="f2">No app needed</span>
    ${buildReviewBlock(manifest.reviewUrl, 'en')}
    ${buildSocialRow(manifest.socials)}
    <div style="margin-top:8px;opacity:.6">Servision</div>
  </footer>
</div>
<script>
var T={
  en:{kicker:'AR Menu',lead:'Tap any dish to see it in 3D on your table.',f1:'Works on iPhone & Android',f2:'No app needed',emptyTitle:'No dishes yet',emptySub:'This menu is being prepared.',searchPlaceholder:'Search the menu…',noResultsTitle:'No dishes match',noResultsSub:'Try a different word, or clear the search.'},
  fr:{kicker:'Menu RA',lead:'Appuyez sur un plat pour le voir en 3D sur votre table.',f1:'Compatible iPhone & Android',f2:'Sans application',emptyTitle:'Aucun plat pour le moment',emptySub:'Ce menu est en préparation.',searchPlaceholder:'Rechercher dans le menu…',noResultsTitle:'Aucun plat trouvé',noResultsSub:'Essayez un autre mot, ou effacez la recherche.'}
};
function setLang(l){
  var t=T[l]||T.en;
  document.querySelectorAll('[data-i18n]').forEach(function(el){
    var k=el.getAttribute('data-i18n'); if(t[k]) el.innerHTML=t[k];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el){
    var k=el.getAttribute('data-i18n-placeholder'); if(t[k]) el.placeholder=t[k];
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

// ── Menu search — fully client-side, no backend/service needed ─────────────
// The whole dish list is already rendered into the page (see data-search on
// each .dish), so matching against it is instant with zero network calls.
// This handles: substrings, multi-word queries in any order, and light typo
// tolerance (Levenshtein distance) so "samon" still finds "Salmon".
function svNormalize(s){
  return String(s||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().trim();
}
function svLevenshtein(a,b){
  if(a===b) return 0;
  var al=a.length, bl=b.length;
  if(!al) return bl;
  if(!bl) return al;
  var prev=[]; for(var j=0;j<=bl;j++) prev[j]=j;
  for(var i=1;i<=al;i++){
    var cur=[i];
    for(var j2=1;j2<=bl;j2++){
      var cost = a.charAt(i-1)===b.charAt(j2-1) ? 0 : 1;
      cur[j2] = Math.min(prev[j2]+1, cur[j2-1]+1, prev[j2-1]+cost);
    }
    prev=cur;
  }
  return prev[bl];
}
// Higher score = better match. 0 = no match at all (every query word has to
// hit something, so "chicken xyz123" won't match "Chicken Wings").
function svMatchScore(dishText, query){
  if(!query) return 1;
  var words = query.split(/\\s+/).filter(Boolean);
  var tokens = dishText.split(/\\s+/).filter(Boolean);
  var total = 0;
  for(var i=0;i<words.length;i++){
    var w = words[i];
    if(dishText.indexOf(w) !== -1){
      total += (dishText.indexOf(' '+w) !== -1 || dishText.indexOf(w) === 0) ? 12 : 8;
      continue;
    }
    var best = Infinity;
    for(var t=0;t<tokens.length;t++){
      var tok = tokens[t];
      if(Math.abs(tok.length - w.length) > 3) continue;
      var d = svLevenshtein(w, tok);
      if(d < best) best = d;
    }
    var maxAllowed = w.length <= 3 ? 1 : (w.length <= 6 ? 2 : 3);
    if(best <= maxAllowed){ total += Math.max(1, 6 - best*2); }
    else { return 0; }
  }
  return total;
}
var svSearchTimer = null, svLastNoResultQuery = '';
function filterMenu(raw){
  var list = document.getElementById('menuList');
  var noResults = document.getElementById('noResults');
  if(!list) return;
  var q = svNormalize(raw);
  var groups = Array.prototype.slice.call(list.querySelectorAll('.collection-group'));
  var totalVisible = 0;
  groups.forEach(function(group){
    var items = Array.prototype.slice.call(group.querySelectorAll('.dish'));
    var groupVisible = 0;
    items.forEach(function(el){
      var show = !q || svMatchScore(el.getAttribute('data-search')||'', q) > 0;
      el.style.display = show ? '' : 'none';
      if(show) groupVisible++;
    });
    group.style.display = groupVisible === 0 ? 'none' : '';
    totalVisible += groupVisible;
  });
  if(noResults) noResults.style.display = (q && totalVisible===0) ? 'block' : 'none';

  clearTimeout(svSearchTimer);
  if(q && totalVisible===0 && q!==svLastNoResultQuery){
    svSearchTimer = setTimeout(function(){
      svLastNoResultQuery = q;
      if(window.__svSend) window.__svSend('menu_search_noresults',{query:raw.slice(0,60)});
    }, 900);
  }
}

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
  window.__svSend = send; // used by the search box below to report misses
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

// Renders the owner's private "manage my menu" dashboard — no GitHub
// login, reached via a capability URL (.../manage/<token>). Lets the
// restaurant toggle dishes on/off (86'd items disappear from the customer
// menu instantly) and sort dishes into collections, without calling
// Servision. All data loading/saving happens client-side against
// /api/manage/:slug/... — this function only renders the shell.
function buildManagePage(opts) {
  const t = MENU_THEMES[opts.theme] || MENU_THEMES['dark-elegant'];
  const restaurantName = opts.restaurantName || 'Your menu';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<title>${esc(restaurantName)} — Manage Menu</title>
<meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=${t.fonts}&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{${t.vars}}
html,body{min-height:100%;background:var(--bg);color:var(--fg);font-family:${t.body};-webkit-font-smoothing:antialiased}
body{padding:max(env(safe-area-inset-top),22px) 18px max(env(safe-area-inset-bottom),40px)}
.wrap{max-width:560px;margin:0 auto}
header{margin-bottom:22px}
.brand-name{font-family:${t.display};font-size:26px;font-weight:600;line-height:1.15}
.kicker{font-size:10.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);margin-top:4px}
.lead{font-size:13px;color:var(--muted);margin-top:8px;line-height:1.5}
.status-msg{font-size:12.5px;color:var(--accent);min-height:16px;margin-top:10px}
.group{margin-bottom:22px}
.group-head{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin-bottom:8px;padding:0 2px}
.row{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:8px}
.row-name{flex:1;min-width:0;font-size:15px;overflow-wrap:anywhere}
.row-name.off{color:var(--muted);text-decoration:line-through}
.collection-input{width:120px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:7px 9px;
  font-family:inherit;font-size:12px;color:var(--fg);outline:none}
.collection-input:focus{border-color:color-mix(in srgb, var(--accent) 55%, transparent)}
.toggle{position:relative;width:42px;height:24px;border-radius:12px;background:var(--border);border:none;cursor:pointer;flex-shrink:0;transition:background .15s ease}
.toggle.on{background:var(--accent)}
.toggle-knob{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--surface);transition:transform .15s ease}
.toggle.on .toggle-knob{transform:translateX(18px)}
.empty{text-align:center;padding:52px 20px;border:1px dashed var(--border);border-radius:14px;color:var(--muted);font-size:13px}
.error{text-align:center;padding:40px 20px;color:var(--muted);font-size:13px}
footer{text-align:center;margin-top:30px;font-size:10.5px;color:var(--muted)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand-name">${esc(restaurantName)}</div>
    <div class="kicker">Manage your menu</div>
    <p class="lead">Turn a dish off if you're out for the day — it disappears from your table QR menu instantly. Group dishes into sections like "Breakfast" or "Supper" by typing a section name next to each dish.</p>
    <div class="status-msg" id="statusMsg"></div>
  </header>
  <div id="menuBody">Loading your menu…</div>
  <footer>Servision — changes here take effect immediately, no need to call us.</footer>
</div>
<datalist id="collectionOptions"></datalist>
<script>
var STATE = {
  slug: ${JSON.stringify(opts.restaurantSlug)},
  branch: ${JSON.stringify(opts.branchSlug || '')},
  token: ${JSON.stringify(opts.token)}
};

function apiUrl(path) {
  var sep = path.indexOf('?') === -1 ? '?' : '&';
  return path + sep + 'branch=' + encodeURIComponent(STATE.branch) + '&token=' + encodeURIComponent(STATE.token);
}

function showStatus(msg) {
  var el = document.getElementById('statusMsg');
  if (!el) return;
  el.textContent = msg;
  if (msg) setTimeout(function() { if (el.textContent === msg) el.textContent = ''; }, 2200);
}

function loadMenu() {
  fetch(apiUrl('/api/manage/' + STATE.slug + '/dishes'))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var body = document.getElementById('menuBody');
      if (data.error) { body.innerHTML = '<div class="error">' + data.error + '</div>'; return; }
      renderMenu(data.dishes || []);
    })
    .catch(function() {
      document.getElementById('menuBody').innerHTML = '<div class="error">Could not load your menu. Check your connection and reload.</div>';
    });
}

function renderMenu(dishes) {
  var body = document.getElementById('menuBody');
  if (dishes.length === 0) { body.innerHTML = '<div class="empty">No dishes published yet.</div>'; return; }

  var order = [], groups = {};
  dishes.forEach(function(d) {
    var key = d.collection || '';
    if (!(key in groups)) { groups[key] = []; order.push(key); }
    groups[key].push(d);
  });
  if (order.indexOf('') !== -1) { order.splice(order.indexOf(''), 1); order.unshift(''); }

  var collectionNames = order.filter(function(k) { return k; });
  document.getElementById('collectionOptions').innerHTML =
    collectionNames.map(function(c) { return '<option value="' + c.replace(/"/g,'&quot;') + '">'; }).join('');

  body.innerHTML = order.map(function(key) {
    var head = key ? '<div class="group-head">' + key.replace(/</g,'&lt;') + '</div>' : '';
    var rows = groups[key].map(function(d) { return dishRowHtml(d); }).join('');
    return '<div class="group">' + head + rows + '</div>';
  }).join('');

  order.forEach(function(key) {
    groups[key].forEach(function(d) { wireDishRow(d); });
  });
}

function dishRowHtml(d) {
  var nameClass = d.available ? 'row-name' : 'row-name off';
  return (
    '<div class="row" data-slug="' + d.slug + '">' +
      '<span class="' + nameClass + '" id="name-' + d.slug + '">' + d.name.replace(/</g,'&lt;') + '</span>' +
      '<input class="collection-input" list="collectionOptions" placeholder="Section" value="' + (d.collection||'').replace(/"/g,'&quot;') + '" id="coll-' + d.slug + '">' +
      '<button type="button" class="toggle' + (d.available ? ' on' : '') + '" id="toggle-' + d.slug + '" aria-label="Toggle availability"><span class="toggle-knob"></span></button>' +
    '</div>'
  );
}

function wireDishRow(d) {
  var toggle = document.getElementById('toggle-' + d.slug);
  var collInput = document.getElementById('coll-' + d.slug);
  var nameEl = document.getElementById('name-' + d.slug);
  if (toggle) {
    toggle.addEventListener('click', function() {
      var nowOn = !toggle.classList.contains('on');
      toggle.classList.toggle('on', nowOn);
      if (nameEl) nameEl.className = nowOn ? 'row-name' : 'row-name off';
      saveDish(d.slug, { available: nowOn });
    });
  }
  if (collInput) {
    var lastSaved = collInput.value;
    collInput.addEventListener('change', function() {
      var val = collInput.value.trim();
      if (val === lastSaved) return;
      lastSaved = val;
      saveDish(d.slug, { collection: val }, true);
    });
  }
}

function saveDish(slug, patch, reloadAfter) {
  var body = Object.assign({ branch: STATE.branch, token: STATE.token }, patch);
  fetch('/api/manage/' + STATE.slug + '/dish/' + slug, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showStatus('Failed to save — try again.'); return; }
      showStatus('Saved.');
      if (reloadAfter) loadMenu();
    })
    .catch(function() { showStatus('Failed to save — try again.'); });
}

loadMenu();
</script>
</body>
</html>`;
}

module.exports = { manifestPath, upsertDish, buildMenuPage, buildManagePage, MANIFEST };
