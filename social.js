// ============================================================
// SOCIAL — renders a row of social-media icons for AR pages and
// the menu page. Only platforms with a filled-in link are shown,
// so there are never blank gaps.
//
// Icons are inline SVG (real brand glyphs) — nothing external to
// load, works offline, scales crisply.
// ============================================================

// The platforms we support, in display order.
const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'x', 'youtube', 'snapchat'];

// Minimal, recognizable brand glyphs. `currentColor` lets them inherit
// the page's accent color so they match every theme.
const ICONS = {
  instagram:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 1.44c-3.15 0-3.52.01-4.76.07-1.15.05-1.77.24-2.19.41-.55.21-.94.47-1.35.88-.41.41-.67.8-.88 1.35-.17.42-.36 1.04-.41 2.19-.06 1.24-.07 1.61-.07 4.76s.01 3.52.07 4.76c.05 1.15.24 1.77.41 2.19.21.55.47.94.88 1.35.41.41.8.67 1.35.88.42.17 1.04.36 2.19.41 1.24.06 1.61.07 4.76.07s3.52-.01 4.76-.07c1.15-.05 1.77-.24 2.19-.41.55-.21.94-.47 1.35-.88.41-.41.67-.8.88-1.35.17-.42.36-1.04.41-2.19.06-1.24.07-1.61.07-4.76s-.01-3.52-.07-4.76c-.05-1.15-.24-1.77-.41-2.19a3.6 3.6 0 0 0-.88-1.35 3.6 3.6 0 0 0-1.35-.88c-.42-.17-1.04-.36-2.19-.41-1.24-.06-1.61-.07-4.76-.07zm0 3.7a4.7 4.7 0 1 1 0 9.4 4.7 4.7 0 0 1 0-9.4zm0 7.75a3.05 3.05 0 1 0 0-6.1 3.05 3.05 0 0 0 0 6.1zm5.99-7.93a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0z"/></svg>',
  facebook:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
    '<path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.9h2.54V9.85c0-2.52 1.5-3.9 3.78-3.9 1.1 0 2.24.19 2.24.19v2.47h-1.26c-1.24 0-1.63.77-1.63 1.57v1.88h2.78l-.44 2.9h-2.34V22c4.78-.76 8.44-4.92 8.44-9.94z"/></svg>',
  tiktok:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
    '<path d="M16.6 5.82a4.28 4.28 0 0 1-1.08-2.82h-3.1v12.6a2.58 2.58 0 0 1-2.58 2.5A2.58 2.58 0 0 1 7.26 15.5a2.58 2.58 0 0 1 3.36-2.46V9.9a5.7 5.7 0 0 0-.78-.05 5.66 5.66 0 1 0 5.66 5.66V9.24a7.3 7.3 0 0 0 4.24 1.36V7.5a4.28 4.28 0 0 1-3.14-1.68z"/></svg>',
  x:
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true">' +
    '<path d="M18.24 2.25h3.31l-7.23 8.26L22.75 21.75h-6.63l-5.19-6.79-5.94 6.79H1.68l7.73-8.84L1.25 2.25h6.8l4.69 6.2 5.5-6.2zm-1.16 17.52h1.83L7.01 4.13H5.05L17.08 19.77z"/></svg>',
  youtube:
    '<svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor" aria-hidden="true">' +
    '<path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.08 0 12 0 12s0 3.92.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.92 24 12 24 12s0-3.92-.5-5.81zM9.6 15.57V8.43L15.82 12 9.6 15.57z"/></svg>',
  snapchat:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
    '<path d="M12.04 2c1.6.01 3.15.72 4.13 2.2.66 1 .6 2.28.56 3.5 0 .16-.02.33-.02.5.08.05.2.08.35.08.3-.02.66-.16 1-.16.3 0 .78.08.9.5.1.36-.1.7-.66.94-.1.04-.24.09-.4.14-.4.13-1 .32-1.16.7-.08.2-.02.46.06.66.02.04.02.06.04.1.02.02.9 2.16 3 2.5.16.03.28.17.26.34-.06.44-.98.8-1.74.98-.14.03-.24.16-.28.42-.02.1-.04.22-.08.34-.06.2-.2.3-.42.3h-.06c-.16 0-.36-.04-.62-.08-.34-.06-.76-.14-1.28-.14-.3 0-.62.02-.94.08-.62.1-1.14.48-1.7.86-.72.52-1.46 1.04-2.62 1.04h-.1c-1.16 0-1.9-.52-2.62-1.04-.56-.38-1.08-.76-1.7-.86a5.6 5.6 0 0 0-.94-.08c-.54 0-.98.1-1.3.16-.24.04-.44.08-.6.08-.28 0-.4-.16-.44-.32-.04-.12-.06-.24-.08-.34-.04-.26-.14-.38-.28-.42-.76-.18-1.68-.54-1.74-.98-.02-.17.1-.31.26-.34 2.1-.34 2.98-2.48 3-2.5l.04-.1c.08-.2.14-.46.06-.66-.16-.38-.76-.57-1.16-.7-.16-.05-.3-.1-.4-.14-.7-.28-.72-.68-.66-.94.1-.4.55-.5.9-.5.32 0 .68.14 1 .16.16 0 .28-.03.36-.08 0-.17-.01-.34-.02-.5-.04-1.22-.1-2.5.56-3.5A5.03 5.03 0 0 1 11.96 2h.08z"/></svg>',
};

// Normalize whatever the user typed into a real, safe URL.
// Accepts full URLs OR bare @handles / usernames.
function normalizeUrl(platform, value) {
  if (!value) return null;
  let v = String(value).trim();
  if (!v) return null;

  // Already a URL
  if (/^https?:\/\//i.test(v)) return v;

  // Strip a leading @
  v = v.replace(/^@/, '');

  const bases = {
    instagram: 'https://instagram.com/',
    facebook: 'https://facebook.com/',
    tiktok: 'https://tiktok.com/@',
    x: 'https://x.com/',
    youtube: 'https://youtube.com/@',
    snapchat: 'https://snapchat.com/add/',
  };
  const base = bases[platform];
  if (!base) return null;
  return base + v;
}

function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Given a socials object { instagram:'...', tiktok:'...' }, return the HTML
// for the icon row. Returns '' when nothing is set (so no empty container).
function buildSocialRow(socials) {
  if (!socials || typeof socials !== 'object') return '';
  const links = [];
  PLATFORMS.forEach(function (p) {
    const url = normalizeUrl(p, socials[p]);
    if (url && ICONS[p]) {
      links.push(
        '<a href="' + escAttr(url) + '" target="_blank" rel="noopener" class="soc" aria-label="' + p + '">' +
        ICONS[p] + '</a>'
      );
    }
  });
  if (!links.length) return '';
  return '<div class="social-row">' + links.join('') + '</div>';
}

// Shared CSS for the social row — inject once per page.
const SOCIAL_CSS =
  '.social-row{display:flex;gap:16px;justify-content:center;align-items:center;margin-top:18px}' +
  '.social-row .soc{color:var(--accent,#C8873A);opacity:.82;transition:opacity .15s, transform .15s;display:inline-flex;-webkit-tap-highlight-color:transparent}' +
  '.social-row .soc:active{transform:scale(.9)}' +
  '@media(hover:hover){.social-row .soc:hover{opacity:1;transform:translateY(-2px)}}';

// Keep only the recognized platform keys from an arbitrary input object.
function cleanSocials(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  PLATFORMS.forEach(function (p) {
    if (input[p] && String(input[p]).trim()) out[p] = String(input[p]).trim();
  });
  return out;
}

// ── REVIEW CTA ───────────────────────────────────────────────────────────────
// A single high-contrast "share your experience" block. Research shows a warm,
// question-style prompt with ONE clear button converts far better than a generic
// "leave a review" link. Only renders when a review URL is set.
function buildReviewBlock(reviewUrl, lang) {
  if (!reviewUrl || !String(reviewUrl).trim()) return '';
  const url = escAttr(String(reviewUrl).trim());
  const t = (lang === 'fr')
    ? { head: 'Vous avez aimé votre repas ?', sub: 'Partagez votre expérience en 30 secondes', btn: 'Laisser un avis Google' }
    : { head: 'Enjoyed your meal?', sub: 'Share your experience in 30 seconds', btn: 'Leave a Google review' };
  const star = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.26L21.6 9.2l-4.8 4.68 1.13 6.6L12 17.3 6.07 20.48l1.13-6.6L2.4 9.2l6.7-.94z"/></svg>';
  return (
    '<a class="review-cta" href="' + url + '" target="_blank" rel="noopener">' +
      '<div class="review-stars">' + star + star + star + star + star + '</div>' +
      '<div class="review-head" data-i18n="revHead">' + t.head + '</div>' +
      '<div class="review-sub" data-i18n="revSub">' + t.sub + '</div>' +
      '<span class="review-btn"><span data-i18n="revBtn">' + t.btn + '</span></span>' +
    '</a>'
  );
}

// Translations for the review block (used by pages that toggle language live).
const REVIEW_I18N = {
  en: { revHead: 'Enjoyed your meal?', revSub: 'Share your experience in 30 seconds', revBtn: 'Leave a Google review' },
  fr: { revHead: 'Vous avez aimé votre repas ?', revSub: 'Partagez votre expérience en 30 secondes', revBtn: 'Laisser un avis Google' }
};

const REVIEW_CSS =
  '.review-cta{display:block;text-decoration:none;margin:22px auto 0;max-width:340px;padding:20px 22px;border-radius:16px;text-align:center;' +
  'background:linear-gradient(145deg, color-mix(in srgb, var(--accent) 22%, transparent), color-mix(in srgb, var(--accent) 7%, transparent));' +
  'border:1px solid color-mix(in srgb, var(--accent) 45%, transparent);transition:transform .16s ease, box-shadow .16s ease;-webkit-tap-highlight-color:transparent}' +
  '.review-cta:active{transform:scale(.98)}' +
  '@media(hover:hover){.review-cta:hover{transform:translateY(-2px);box-shadow:0 12px 30px -12px color-mix(in srgb, var(--accent) 55%, transparent)}}' +
  '.review-stars{display:flex;gap:3px;justify-content:center;color:var(--accent);margin-bottom:9px}' +
  '.review-head{font-family:var(--display,inherit);font-size:19px;font-weight:600;color:var(--fg);line-height:1.2}' +
  '.review-sub{font-size:12.5px;color:var(--muted);margin-top:3px;margin-bottom:14px}' +
  '.review-btn{display:inline-block;background:var(--accent);color:#141008;font-weight:700;font-size:13.5px;letter-spacing:.01em;' +
  'padding:11px 22px;border-radius:9px;transition:filter .15s}' +
  '.review-cta:hover .review-btn{filter:brightness(1.08)}';

module.exports = { PLATFORMS, buildSocialRow, SOCIAL_CSS, cleanSocials, normalizeUrl, buildReviewBlock, REVIEW_CSS, REVIEW_I18N };
