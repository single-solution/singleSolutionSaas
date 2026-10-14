/**
 * The widgets' CSS, injected into their shadow roots only. Colors, font and corner radius come from the website's
 * theme (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), with fallbacks for light and dark. The admin widgets
 * follow the dashboards' style (PLAN 0.6 "A + B"): grid sections with a heading and a lighter line under it, soft
 * tinted tiles with a round icon badge, one solid hero card with a bar chart, rounded surfaces, no borders or shadows;
 * one accent (the theme's), green, amber and red only for status; cards of different heights in a masonry; filter chips
 * with counts; the More menu (⋯); dialogs (full-screen sheets on phones); short motion that respects reduced motion;
 * every layout follows the widget's own width (container queries), not the screen's.
 * @module
 */
export const WIDGET_CSS = `
:host { display: block; font-family: var(--ss-font-family, inherit); color: var(--ss-color-text, #1f2937); }
:host([data-ss-mode='dark']) { color: var(--ss-color-text, #f3f4f6); }
[hidden] { display: none !important; }
.box { border-radius: calc(var(--ss-radius, 8px) * 2); padding: 16px; background: var(--ss-color-background, #ffffff); }
:host([data-ss-mode='dark']) .box { background: var(--ss-color-background, #111827); }
h2 { font-size: 1.1em; margin: 0 0 4px; }
h3 { font-size: 1em; margin: 0; }
p { margin: 4px 0; }
.lead { opacity: 0.7; font-size: 0.9em; margin: 0 0 12px; }
label { display: block; font-size: 0.9em; margin: 8px 0 4px; }
textarea, input, select { width: 100%; box-sizing: border-box; font: inherit; color: inherit; background: rgba(127, 127, 127, 0.08);
  padding: 8px; border: 0; border-radius: var(--ss-radius, 8px); }
label.check { display: flex; gap: 8px; align-items: flex-start; } label.check input { width: auto; margin-top: 3px; }
button { font: inherit; padding: 8px 16px; border: 0; border-radius: var(--ss-radius, 8px); cursor: pointer;
  background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); }
button.secondary { background: rgba(127, 127, 127, 0.14); color: inherit; }
button.link { background: transparent; color: inherit; padding: 4px 8px; text-decoration: underline; }
button[disabled] { opacity: 0.6; cursor: default; }
a { color: var(--ss-color-accent, #4f46e5); }
:host([data-ss-mode='dark']) a { color: var(--ss-color-accent, #a5b4fc); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.status { margin: 8px 0 0; font-size: 0.9em; }
ul { list-style: none; margin: 0; padding: 0; }
.meta { display: block; font-size: 0.8em; opacity: 0.7; overflow-wrap: anywhere; }

/* consent banner */
.banner { position: fixed; left: 16px; right: 16px; z-index: 2147483000; max-width: 720px; margin: 0 auto;
  border-radius: calc(var(--ss-radius, 8px) * 2); padding: 16px; background: var(--ss-color-background, #ffffff);
  box-shadow: 0 8px 32px rgba(15, 23, 42, 0.18); }
:host([data-ss-mode='dark']) .banner { background: var(--ss-color-background, #111827); }
.banner.bottom { bottom: 16px; } .banner.top { top: 16px; }
.choices { display: grid; gap: 8px; margin-top: 8px; }
.choices .help { display: block; font-size: 0.85em; opacity: 0.7; }

/* notice bar */
.notice { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: center; padding: 8px 16px;
  background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); text-align: center; }
.notice a { color: inherit; font-weight: 600; }
.notice button { background: transparent; color: inherit; padding: 2px 8px; font-size: 1.1em; line-height: 1; }

/* admin widgets */
.head { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; justify-content: space-between; margin-bottom: 16px; }
.head .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
.head .row label { margin-top: 0; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
.section { margin-top: 24px; }
/* one accent (PLAN 0.6): every tile takes the website's accent tint; green and red only for status (Web Vitals) */
.tile { border-radius: calc(var(--ss-radius, 8px) * 2); padding: 16px;
  --badge: var(--ss-color-accent, #4f46e5); background: color-mix(in srgb, var(--badge) 10%, transparent); }
.tile .badge { display: inline-flex; width: 32px; height: 32px; border-radius: 999px; align-items: center; justify-content: center;
  background: var(--badge); color: var(--ss-color-onAccent, #ffffff); font-weight: 700; font-size: 0.9em; }
.tile .value { display: block; font-size: 1.6em; font-weight: 700; margin-top: 8px; }
.tile .label { display: block; font-size: 0.9em; opacity: 0.75; }
.tile.good { --badge: #16a34a; }
.tile.poor { --badge: #dc2626; }
.tile.good .badge, .tile.poor .badge { color: #ffffff; }
.hero { border-radius: calc(var(--ss-radius, 8px) * 2); padding: 20px; background: var(--ss-color-accent, #4f46e5);
  color: var(--ss-color-onAccent, #ffffff); grid-column: 1 / -1; }
.hero .value { display: block; font-size: 2.2em; font-weight: 700; }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 72px; margin-top: 12px; }
.bars span { flex: 1 1 0; min-width: 2px; border-radius: 3px 3px 0 0; background: rgba(255, 255, 255, 0.75); }
.list li { display: flex; gap: 8px; justify-content: space-between; padding: 6px 0; overflow-wrap: anywhere; }
.list li span:last-child { font-variant-numeric: tabular-nums; opacity: 0.8; }
.checks li { padding: 12px; margin-top: 8px; border-radius: calc(var(--ss-radius, 8px) * 1.5); background: rgba(127, 127, 127, 0.07); }
.pill { display: inline-block; padding: 0 10px; border-radius: 999px; font-size: 0.8em; font-weight: 600; margin-right: 8px; }
.pill.pass { background: rgba(34, 197, 94, 0.16); color: #15803d; }
.pill.warn { background: rgba(245, 158, 11, 0.18); color: #b45309; }
.pill.fail { background: rgba(239, 68, 68, 0.16); color: #b91c1c; }
:host([data-ss-mode='dark']) .pill.pass { color: #86efac; }
:host([data-ss-mode='dark']) .pill.warn { color: #fcd34d; }
:host([data-ss-mode='dark']) .pill.fail { color: #fca5a5; }
.reason { margin: 4px 0 0; font-size: 0.9em; opacity: 0.85; overflow-wrap: anywhere; }
.fix { margin-top: 6px; font-size: 0.9em; overflow-wrap: anywhere; }
.fix button { margin-left: 8px; }
.card-head .kind { display: block; font-size: 0.8em; opacity: 0.7; margin-top: 2px; }

/* PLAN 0.6 admin widgets: container sizing, masonry, chips, the More menu, dialogs and motion */
.box { container-type: inline-size; }
.head h2 { margin: 0; }
.head + .chips { margin: -4px 0 8px; }
.head .actions { margin-top: 0; align-items: center; }
.sub { display: block; font-size: 0.85em; opacity: 0.7; margin: -4px 0 12px; }
.section > p.sub { margin: 2px 0 12px; }
.tiles { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); }
@container (min-width: 30rem) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (min-width: 48rem) { .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.tiles .hero { grid-column: 1 / -1; }
/* a card after the tiles takes the rest of their last row (--rest2, --rest4: the columns left), else a row of its own */
.tiles > .rest { grid-column: 1 / -1; }
@container (min-width: 30rem) { .tiles > .rest { grid-column: span var(--rest2, 2); } }
@container (min-width: 48rem) { .tiles > .rest { grid-column: span var(--rest4, 4); } }
.stack { display: grid; gap: 16px; align-items: start; }
.tile .value { white-space: nowrap; font-size: clamp(1.1em, 4cqi, 1.6em); }
.tile .hint { display: block; font-size: 0.8em; opacity: 0.7; margin-top: 4px; }
.masonry { column-width: 16rem; column-gap: 16px; }
.masonry > * { break-inside: avoid; display: inline-block; width: 100%; box-sizing: border-box; margin: 0 0 16px; }
.card { border-radius: calc(var(--ss-radius, 8px) * 2); padding: 14px 16px;
  background: color-mix(in srgb, var(--ss-color-accent, #4f46e5) 6%, transparent); }
.card-head { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.card-head h3, .card-head h4 { margin: 0; overflow-wrap: anywhere; }
.card .actions { margin-top: 8px; }
ul.rank li { padding: 6px 0; }
ul.rank .line { display: flex; gap: 8px; justify-content: space-between; overflow-wrap: anywhere; }
ul.rank .figure { font-variant-numeric: tabular-nums; opacity: 0.8; white-space: nowrap; }
ul.rank .share { display: block; height: 4px; margin-top: 4px; border-radius: 999px; width: var(--share, 0%);
  background: var(--ss-color-accent, #4f46e5); opacity: 0.55; transition: width 300ms ease-out; animation: ss-grow 400ms ease-out; }
ul.rank li.empty { opacity: 0.7; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; }
.chip { padding: 4px 12px; border-radius: 999px; background: rgba(127, 127, 127, 0.12); color: inherit; }
.chip[aria-pressed='true'] { background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); }
.chip .count { margin-left: 6px; font-size: 0.85em; opacity: 0.8; font-variant-numeric: tabular-nums; }
button.icon { padding: 6px 12px; line-height: 1; }
button.small { padding: 4px 10px; font-size: 0.9em; }
button.danger { background: #dc2626; color: #ffffff; }
button.link.remove { color: #dc2626; padding: 4px 0; margin-top: 8px; }
.more { position: relative; display: inline-block; }
.menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 5; min-width: 220px; padding: 4px;
  border-radius: var(--ss-radius, 8px); background: var(--ss-color-background, #ffffff);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16); animation: ss-pop 120ms ease-out; transform-origin: top right; }
:host([data-ss-mode='dark']) .menu, :host([data-ss-mode='dark']) .dialog { background: var(--ss-color-background, #111827); }
.menu button { display: block; width: 100%; padding: 8px 12px; text-align: left; background: transparent; color: inherit; }
.menu button:hover, .menu button:focus-visible { background: rgba(127, 127, 127, 0.12); }
.menu button.danger { color: #dc2626; background: transparent; }
.overlay { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 16px;
  background: rgba(15, 23, 42, 0.45); animation: ss-fade 150ms ease-out; }
.dialog { width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box; padding: 20px;
  border-radius: calc(var(--ss-radius, 8px) * 2); background: var(--ss-color-background, #ffffff); animation: ss-pop 150ms ease-out;
  container-type: inline-size; }
.dialog.wide { width: min(760px, 100%); }
.dialog h3 { margin: 0 0 12px; }
.form-grid { display: grid; gap: 0 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 180px), 1fr)); }
.form-grid .wide { grid-column: 1 / -1; }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 160px), 1fr)); gap: 10px 16px; margin: 0 0 12px; }
.fields dt { font-size: 0.8em; opacity: 0.7; } .fields dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.live { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
.live .value { font-size: 1.6em; font-weight: 700; font-variant-numeric: tabular-nums; }
.pulse { width: 10px; height: 10px; border-radius: 999px; background: #16a34a; flex: none;
  box-shadow: 0 0 0 0 rgba(22, 163, 74, 0.5); animation: ss-pulse 1.6s ease-out infinite; }
.pulse.idle { background: #9ca3af; animation: none; }
.steps { display: grid; gap: 10px; }
.step .line { display: flex; gap: 8px; justify-content: space-between; }
.step .bar { display: block; height: 10px; margin-top: 4px; border-radius: 999px; width: var(--share, 0%);
  background: var(--ss-color-accent, #4f46e5); transition: width 300ms ease-out; animation: ss-grow 400ms ease-out; }
ul.rows li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; align-items: center; padding: 10px 8px;
  border-radius: var(--ss-radius, 8px); cursor: pointer; }
ul.rows li:hover, ul.rows li:focus-visible { background: rgba(127, 127, 127, 0.08); outline: none; }
ul.rows li .meta { grid-column: 1 / -1; }
ul.rows .figure { font-variant-numeric: tabular-nums; opacity: 0.8; white-space: nowrap; }
ol.timeline { list-style: none; margin: 0 0 12px; padding: 0 0 0 16px; border-left: 2px solid color-mix(in srgb, var(--ss-color-accent, #4f46e5) 35%, transparent); }
ol.timeline li { position: relative; padding: 4px 0 8px 8px; }
ol.timeline li::before { content: ''; position: absolute; left: -23px; top: 9px; width: 10px; height: 10px; border-radius: 999px;
  background: var(--ss-color-accent, #4f46e5); }
.swap { animation: ss-rise 200ms ease-out; }
@media (max-width: 639px) { .overlay { padding: 0; } .dialog, .dialog.wide { width: 100%; height: 100%; max-height: none; border-radius: 0; } }
@keyframes ss-pop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }
@keyframes ss-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ss-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes ss-grow { from { width: 0; } }
@keyframes ss-pulse { 0% { box-shadow: 0 0 0 0 rgba(22, 163, 74, 0.5); } 70% { box-shadow: 0 0 0 8px rgba(22, 163, 74, 0); } 100% { box-shadow: 0 0 0 0 rgba(22, 163, 74, 0); } }
@media (prefers-reduced-motion: reduce) {
  .menu, .overlay, .dialog, .swap, ul.rank .share, .step .bar, .pulse { animation: none; transition: none; }
}
`;
