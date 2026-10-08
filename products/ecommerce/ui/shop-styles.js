/**
 * The shopper widgets' own CSS (added after `WIDGET_CSS`, inside their shadow roots only): the grid's filters and
 * cards, the product page's gallery and buy box, the cart's lines and totals, the order pages. Colours, font and
 * corner radius come from the website's theme, with fallbacks for light and dark; everything fits from 360 px.
 * @module
 */
export const SHOP_CSS = `
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
a { color: var(--ss-color-accent, #4f46e5); }
:host([data-ss-mode='dark']) a { color: var(--ss-color-accent, #a5b4fc); }
.hint { margin: 8px 0; padding: 8px 12px; border-radius: var(--ss-radius, 8px); background: rgba(127, 127, 127, 0.1); }
.stack { display: flex; flex-direction: column; gap: 12px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
.toolbar > * { flex: 1 1 160px; }
.toolbar button { flex: 0 0 auto; }
.filters { margin: 8px 0; }
.filters summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
.filters fieldset { border: 0; padding: 0; margin: 8px 0 0; }
.filters legend { font-size: 0.9em; padding: 0; margin-bottom: 4px; }
.filters .values { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.card a.name { color: inherit; font-weight: 600; text-decoration: none; }
.card a.name:hover, .card a.name:focus-visible { text-decoration: underline; }
.card .actions button, .icon { margin-top: 0; padding: 6px 10px; }
.badge { display: inline-block; font-size: 0.8em; padding: 2px 8px; border-radius: 999px; background: rgba(127, 127, 127, 0.15); }
.badge.danger { color: var(--ss-color-danger, #b91c1c); }
.icon[aria-pressed='true'] { background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); }
.icon[aria-pressed='false'] { background: transparent; color: inherit; border: 1px solid var(--ss-color-border, #d1d5db); }
.more { display: block; margin: 16px auto 0; }
.page { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@media (min-width: 720px) { .page { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .page > .wide { grid-column: 1 / -1; } }
.gallery .main { position: relative; }
.gallery .main img, .gallery .main video { width: 100%; aspect-ratio: 1 / 1; object-fit: contain; border-radius: var(--ss-radius, 8px); background: rgba(127, 127, 127, 0.06); }
.gallery .nav { display: flex; justify-content: space-between; gap: 8px; }
.gallery .thumbs { display: flex; gap: 6px; overflow-x: auto; margin-top: 8px; }
.gallery .thumbs button { margin: 0; padding: 0; border: 2px solid transparent; background: none; width: 64px; height: 64px; flex: 0 0 auto; }
.gallery .thumbs button[aria-current='true'] { border-color: var(--ss-color-accent, #4f46e5); }
.gallery .thumbs img { width: 100%; height: 100%; object-fit: cover; border-radius: var(--ss-radius, 8px); }
.big { font-size: 1.4em; }
.save { color: var(--ss-color-success, #15803d); font-weight: 600; }
.stepper { display: inline-flex; align-items: center; gap: 4px; }
.stepper button { margin: 0; padding: 4px 10px; }
.stepper input { width: 64px; text-align: center; }
.lines > li { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px 12px; }
.lines img { width: 64px; height: 64px; object-fit: cover; border-radius: var(--ss-radius, 8px); }
.lines .body { display: flex; flex-direction: column; gap: 4px; }
.lines .end { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.totals { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; margin: 8px 0; }
.totals dt { margin: 0; } .totals dd { margin: 0; text-align: right; }
.totals .total { font-weight: 600; font-size: 1.1em; }
.choices { display: flex; flex-direction: column; gap: 4px; }
section { margin-top: 16px; }
.scroll { overflow-x: auto; }
.compare th, .compare td { min-width: 140px; vertical-align: top; }
.compare img { width: 96px; height: 96px; object-fit: cover; border-radius: var(--ss-radius, 8px); }
.review { display: flex; flex-direction: column; gap: 4px; }
.reply { margin-left: 12px; padding-left: 8px; border-left: 3px solid var(--ss-color-border, #d1d5db); }
code { overflow-wrap: anywhere; }
`;
