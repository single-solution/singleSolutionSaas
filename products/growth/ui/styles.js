/**
 * The widgets' CSS, injected into their shadow roots only. Colours, font and corner radius come from the website's
 * theme (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), with fallbacks for light and dark. The admin widgets
 * follow the dashboards' style (PLAN 0.6 "A + B"): grid sections with a heading and a lighter line under it, soft
 * tinted tiles with a round icon badge, one solid hero card with a bar chart, rounded surfaces, no borders or shadows.
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
.tile { border-radius: calc(var(--ss-radius, 8px) * 2); padding: 16px; background: var(--tint, rgba(99, 102, 241, 0.1)); }
.tile .badge { display: inline-flex; width: 32px; height: 32px; border-radius: 999px; align-items: center; justify-content: center;
  background: var(--badge, #6366f1); color: #ffffff; font-weight: 700; font-size: 0.9em; }
.tile .value { display: block; font-size: 1.6em; font-weight: 700; margin-top: 8px; }
.tile .label { display: block; font-size: 0.9em; opacity: 0.75; }
.tile.teal { --tint: rgba(20, 184, 166, 0.12); --badge: #0d9488; }
.tile.coral { --tint: rgba(251, 113, 133, 0.12); --badge: #e11d48; }
.tile.pink { --tint: rgba(236, 72, 153, 0.12); --badge: #db2777; }
.tile.amber { --tint: rgba(245, 158, 11, 0.14); --badge: #d97706; }
.tile.sky { --tint: rgba(14, 165, 233, 0.12); --badge: #0284c7; }
.tile.violet { --tint: rgba(139, 92, 246, 0.12); --badge: #7c3aed; }
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
.fix { margin-top: 6px; font-size: 0.9em; }
`;
