/**
 * The widgets' CSS, injected into their shadow roots only. Colors, font and corner radius come from the website's
 * theme (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), with fallbacks for light and dark.
 * @module
 */
export const WIDGET_CSS = `
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
.actions { display: flex; flex-wrap: wrap; gap: 8px; } .actions button { margin-top: 8px; }
:host { container-type: inline-size; }
.head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.head h2, .head h3 { margin: 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.head .actions button, .head > button { margin-top: 0; }
.split { display: grid; gap: 16px; margin-top: 12px; }
.split[data-view='list'] .detail-pane, .split[data-view='detail'] .list-pane { display: none; }
@container (min-width: 720px) {
  .split { grid-template-columns: minmax(240px, 2fr) 3fr; align-items: start; }
  .split[data-view] .list-pane, .split[data-view] .detail-pane { display: block; }
  .back { display: none; }
}
li.item { display: grid; grid-template-columns: auto 1fr auto; gap: 2px 10px; align-items: center; padding: 10px 8px;
  cursor: pointer; border-radius: var(--ss-radius, 8px); }
li.item:focus-visible { outline: 2px solid var(--ss-color-accent, #4f46e5); outline-offset: -2px; }
li.item[aria-current='true'] { background: rgba(79, 70, 229, 0.08); }
li.item .meta { grid-column: 2 / -1; }
.name { overflow-wrap: anywhere; } .figure { font-weight: 600; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
.dot.success { background: #16a34a; } .dot.warning { background: #d97706; } .dot.danger { background: #dc2626; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.75em; font-weight: 600;
  background: rgba(127, 127, 127, 0.14); }
.badge.success { color: #15803d; background: rgba(22, 163, 74, 0.14); }
.badge.warning { color: #b45309; background: rgba(217, 119, 6, 0.14); }
.badge.danger { color: #b91c1c; background: rgba(220, 38, 38, 0.14); }
.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px 16px; margin: 12px 0; }
.fields dt { font-size: 0.8em; opacity: 0.7; } .fields dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.sub h4 { font-size: 0.9em; margin: 12px 0 4px; } ul.plain li { padding: 4px 0; font-size: 0.9em; border-top: 0; }
button.link { background: transparent; color: var(--ss-color-accent, #4f46e5); padding: 0; margin: 0 0 8px; }
button.icon { padding: 6px 12px; line-height: 1; }
button.danger { background: #dc2626; color: #ffffff; }
.more { position: relative; display: inline-block; }
.menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 5; min-width: 200px; padding: 4px;
  border-radius: var(--ss-radius, 8px); background: var(--ss-color-background, #ffffff);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16); animation: ss-pop 120ms ease-out; transform-origin: top right; }
:host([data-ss-mode='dark']) .menu, :host([data-ss-mode='dark']) .dialog { background: var(--ss-color-background, #111827); }
.menu button { display: block; width: 100%; margin: 0; padding: 8px 12px; text-align: left; background: transparent;
  color: inherit; } .menu button:hover, .menu button:focus-visible { background: rgba(127, 127, 127, 0.12); }
.menu button.danger { color: #dc2626; background: transparent; }
.overlay { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 16px;
  background: rgba(15, 23, 42, 0.45); animation: ss-fade 150ms ease-out; }
.dialog { width: min(520px, 100%); max-height: 90vh; overflow: auto; box-sizing: border-box; padding: 20px;
  border-radius: calc(var(--ss-radius, 8px) * 2); background: var(--ss-color-background, #ffffff);
  animation: ss-pop 150ms ease-out; }
.dialog h3 { margin: 0 0 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0 12px; }
.grid .wide { grid-column: 1 / -1; }
@media (max-width: 639px) { .overlay { padding: 0; } .dialog { width: 100%; height: 100%; max-height: none; border-radius: 0; } }
@keyframes ss-pop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }
@keyframes ss-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .menu, .overlay, .dialog { animation: none; } }
`;
