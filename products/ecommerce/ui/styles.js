/**
 * The widgets' CSS, injected into their shadow roots only. Colours, font and corner radius come from the website's
 * theme (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), with fallbacks for light and dark.
 * @module
 */
export const WIDGET_CSS = `
.price { font-weight: 600; } .was { text-decoration: line-through; opacity: 0.6; margin-left: 6px; font-weight: 400; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--ss-color-border, #e5e7eb); border-radius: var(--ss-radius, 8px); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.card img, .gallery img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: var(--ss-radius, 8px); }
.muted { opacity: 0.7; font-size: 0.9em; }
.error { color: var(--ss-color-danger, #b91c1c); }
table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 6px; border-top: 1px solid var(--ss-color-border, #e5e7eb); }
:host { display: block; font-family: var(--ss-font-family, inherit); color: var(--ss-color-text, #1f2937); }
:host([data-ss-mode='dark']) { color: var(--ss-color-text, #f3f4f6); }
.box { border: 1px solid var(--ss-color-border, #d1d5db); border-radius: var(--ss-radius, 8px); padding: 16px;
  background: var(--ss-color-background, #ffffff); }
:host([data-ss-mode='dark']) .box { background: var(--ss-color-background, #111827); border-color: var(--ss-color-border, #374151); }
h2 { font-size: 1.1em; margin: 0 0 8px; }
label { display: block; font-size: 0.9em; margin: 8px 0 4px; }
textarea, input, select { width: 100%; box-sizing: border-box; font: inherit; color: inherit; background: transparent;
  padding: 8px; border: 1px solid var(--ss-color-border, #d1d5db); border-radius: var(--ss-radius, 8px); }
label.check { display: flex; gap: 8px; align-items: center; } label.check input { width: auto; }
button { margin-top: 12px; font: inherit; padding: 8px 16px; border: 0; border-radius: var(--ss-radius, 8px);
  background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); cursor: pointer; }
button.secondary { background: transparent; color: inherit; border: 1px solid var(--ss-color-border, #d1d5db); }
button[disabled] { opacity: 0.6; cursor: default; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; } .row > * { flex: 1 1 140px; }
.status { margin: 8px 0 0; font-size: 0.9em; }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 8px 0; border-top: 1px solid var(--ss-color-border, #e5e7eb); overflow-wrap: anywhere; }
.meta { display: block; font-size: 0.8em; opacity: 0.7; }
.amount { font-size: 1.3em; font-weight: 600; margin: 4px 0 8px; }
.details { margin-top: 8px; padding: 8px; border-radius: var(--ss-radius, 8px); background: rgba(127, 127, 127, 0.08); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; } .actions button { margin-top: 8px; }
`;
