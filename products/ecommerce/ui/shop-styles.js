/**
 * The shopper widgets' own CSS (added after `WIDGET_CSS`, inside their shadow roots only): the grid's filters, cards
 * and listing footer, the product page's gallery, buy box, grade, video, FAQs and Size guide, the cart's lines and
 * totals, the order pages. Colors, font and corner radius come from the website's theme, with fallbacks for light and
 * dark; the theme's accent is the only accent (green, amber and red only for status). Everything fits from 360 px, and
 * layouts follow the widget's own width (container queries), not the screen's: the grid puts its filters beside the
 * products, and the product page its gallery beside the buy box, where the widget is wide. Motion runs only when the
 * shopper has not asked for less (`prefers-reduced-motion`).
 * @module
 */
export const SHOP_CSS = `
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
a { color: var(--ss-color-accent, #4f46e5); }
:host([data-ss-mode='dark']) a { color: var(--ss-color-accent, #a5b4fc); }
.hint { margin: 8px 0; padding: 8px 12px; border-radius: var(--ss-radius, 8px); background: rgba(127, 127, 127, 0.1); }
.stack { display: flex; flex-direction: column; gap: 12px; }
.stack > button { align-self: flex-start; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
.toolbar > * { flex: 1 1 160px; min-width: 0; }
.toolbar button { flex: 0 0 auto; }
button.link { background: transparent; color: var(--ss-color-accent, #4f46e5); padding: 4px 0; margin-top: 4px; }
.shop-frame { container-type: inline-size; }
.listing { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; margin-top: 12px; }
.filter-panel { padding: 4px 12px 12px; border-radius: calc(var(--ss-radius, 8px) * 2); background: rgba(127, 127, 127, 0.06); min-width: 0; }
.filter-panel:not([data-open]) { display: none; }
.filter-panel fieldset { border: 0; padding: 0; margin: 12px 0 0; min-width: 0; }
.filter-panel legend { font-weight: 600; font-size: 0.9em; padding: 0; margin-bottom: 4px; }
.filter-panel .values { display: flex; flex-direction: column; gap: 2px; }
.filter-panel label.check { margin: 2px 0; }
.filter-panel > button.secondary { width: 100%; }
.flags { margin-top: 12px; }
@container (min-width: 880px) {
  .listing { grid-template-columns: 240px minmax(0, 1fr); align-items: start; }
  .filter-panel:not([data-open]) { display: block; }
  .filter-panel { position: sticky; top: 12px; }
  .filter-toggle { display: none; }
}
.grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 140px), 1fr)); }
.card a.pic { display: block; }
.card a.name { color: inherit; font-weight: 600; text-decoration: none; }
.card a.name:hover, .card a.name:focus-visible { text-decoration: underline; }
.card .actions button, .icon { margin-top: 0; padding: 6px 10px; }
.quad { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; aspect-ratio: 1 / 1; overflow: hidden; border-radius: var(--ss-radius, 8px); }
.quad img { width: 100%; height: 100%; aspect-ratio: auto; object-fit: cover; border-radius: 0; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.badge { display: inline-block; font-size: 0.8em; padding: 2px 8px; border-radius: 999px; background: rgba(127, 127, 127, 0.15); }
.badge.accent { background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); }
.badge.danger { color: var(--ss-color-danger, #b91c1c); }
.icon[aria-pressed='true'] { background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); }
.icon[aria-pressed='false'] { background: transparent; color: inherit; border: 1px solid var(--ss-color-border, #d1d5db); }
.more { display: block; margin: 16px auto 0; }
.foot { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; margin-top: 16px; }
.foot .more { margin: 0; }
.foot .meta:empty { display: none; }
.pages { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.pages button { margin: 0; padding: 4px 10px; min-width: 36px; }
.pages button[aria-current='page'] { background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); border-color: transparent; }
.pages .gap { padding: 0 4px; opacity: 0.6; }
.page-frame { container-type: inline-size; }
.page { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@container (min-width: 720px) { .page { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .page > .wide { grid-column: 1 / -1; } }
.gallery .main { position: relative; }
.gallery .main img, .gallery .main video { width: 100%; height: auto; aspect-ratio: 1 / 1; object-fit: contain; border-radius: var(--ss-radius, 8px); background: rgba(127, 127, 127, 0.06); }
img.blur { background-size: cover; background-position: center; background-repeat: no-repeat; }
.gallery .nav { display: flex; justify-content: space-between; gap: 8px; }
.gallery .thumbs { display: flex; gap: 6px; overflow-x: auto; margin-top: 8px; }
.gallery .thumbs button { margin: 0; padding: 0; border: 2px solid transparent; background: none; width: 64px; height: 64px; flex: 0 0 auto; }
.gallery .thumbs button[aria-current='true'] { border-color: var(--ss-color-accent, #4f46e5); }
.gallery .thumbs img { width: 100%; height: 100%; object-fit: cover; border-radius: var(--ss-radius, 8px); }
.big { font-size: 1.4em; }
.save { color: var(--ss-color-success, #15803d); font-weight: 600; }
.pickers { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 160px), 1fr)); gap: 0 12px; }
.stock { margin: 0; font-weight: 600; }
.stock.success { color: var(--ss-color-success, #15803d); }
.stock.warning { color: var(--ss-color-warning, #b45309); }
.stock.danger { color: var(--ss-color-danger, #b91c1c); }
.grade { padding: 8px 12px; border-radius: var(--ss-radius, 8px); background: rgba(127, 127, 127, 0.08); }
.grade p { margin: 4px 0; }
.grade-name { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.swatch { width: 14px; height: 14px; flex: 0 0 auto; border-radius: 50%; border: 1px solid rgba(127, 127, 127, 0.4); }
.bullets { list-style: disc; padding-left: 20px; } .bullets li { border: 0; padding: 2px 0; }
.player { aspect-ratio: 16 / 9; max-width: 800px; }
.player iframe, .player video { width: 100%; height: 100%; border: 0; border-radius: var(--ss-radius, 8px); background: #000000; }
.faqs details { border-top: 1px solid var(--ss-color-border, #e5e7eb); padding: 8px 0; }
.faqs summary { cursor: pointer; font-weight: 600; }
.description ul, .description ol, .rich ul, .rich ol { list-style: revert; padding-left: 20px; }
.description li, .rich li { border: 0; padding: 2px 0; }
blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--ss-color-border, #d1d5db); }
.overlay { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 16px; background: rgba(15, 23, 42, 0.45); }
.sheet { width: min(720px, 100%); max-height: 90vh; overflow: auto; box-sizing: border-box; padding: 20px;
  border-radius: calc(var(--ss-radius, 8px) * 2); background: var(--ss-color-background, #ffffff); }
:host([data-ss-mode='dark']) .sheet { background: var(--ss-color-background, #111827); }
.sheet-head { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.sheet-head h2 { margin: 0; }
.sheet-head button { margin: 0; }
.sheet h3 { font-size: 1em; margin: 16px 0 4px; }
.sizes th, .sizes td { white-space: nowrap; }
@media (max-width: 639px) { .overlay { padding: 0; } .sheet { width: 100%; height: 100%; max-height: none; border-radius: 0; } }
.stepper { display: inline-flex; align-items: center; gap: 4px; }
.stepper button { margin: 0; padding: 4px 10px; }
.stepper input { width: 64px; text-align: center; }
.lines > li { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px 12px; }
.lines > li.problem { padding: 8px; border-radius: var(--ss-radius, 8px); background: rgba(220, 38, 38, 0.05); }
.lines img { width: 64px; height: 64px; object-fit: cover; border-radius: var(--ss-radius, 8px); }
.lines .body { display: flex; flex-direction: column; gap: 4px; }
.lines .body strong a { color: inherit; }
.lines .end { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.totals { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; margin: 8px 0; }
.totals dt { margin: 0; } .totals dd { margin: 0; text-align: right; }
.totals .total { font-weight: 600; font-size: 1.1em; }
.choices { display: flex; flex-direction: column; gap: 4px; }
section { margin-top: 16px; }
.scroll { overflow-x: auto; max-width: 100%; }
.compare th, .compare td { min-width: 140px; vertical-align: top; }
.compare img { width: 96px; height: 96px; object-fit: cover; border-radius: var(--ss-radius, 8px); }
.review { display: flex; flex-direction: column; gap: 4px; }
.reply { margin-left: 12px; padding-left: 8px; border-left: 3px solid var(--ss-color-border, #d1d5db); }
code { overflow-wrap: anywhere; }
@media (prefers-reduced-motion: no-preference) {
  .card { transition: box-shadow 150ms ease-out, transform 150ms ease-out; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(15, 23, 42, 0.08); }
  .overlay { animation: ss-shop-fade 150ms ease-out; }
  .sheet { animation: ss-shop-rise 180ms ease-out; }
}
@keyframes ss-shop-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ss-shop-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
`;
