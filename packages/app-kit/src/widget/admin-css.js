/**
 * The CSS of the admin widget building blocks (admin.js), shared by every product so a status badge, a More menu, a
 * dialog or an empty state looks and behaves the same in Accounts, Ecommerce, Growth and Payments. A product puts it
 * first in its own widget CSS and adds only what is its own. Colors come from the website's theme
 * (`--ss-color-<name>`) with a fallback for light and dark; the status colors (green, amber, red) mean status only.
 * Spacing uses logical properties (`inline-start`, `inline-end`, `text-align: start`), so the blocks follow the page's
 * direction when it is right to left. A product that uses `split` makes its widget a size container
 * (`container-type: inline-size`): the list sits beside the detail from 720 px of the widget's own width.
 * @module
 */
export const ADMIN_KIT_CSS = `
[hidden] { display: none !important; }
:host { --ss-kit-focus: var(--ss-color-accent, #4f46e5); --ss-kit-ok: var(--ss-color-success, #15803d);
  --ss-kit-warn: var(--ss-color-warning, #b45309); --ss-kit-bad: var(--ss-color-danger, #b91c1c); }
:host([data-ss-mode='dark']) { --ss-kit-focus: var(--ss-color-accent, #a5b4fc); --ss-kit-ok: var(--ss-color-success, #4ade80);
  --ss-kit-warn: var(--ss-color-warning, #fbbf24); --ss-kit-bad: var(--ss-color-danger, #f87171); }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible,
[tabindex]:not([tabindex='-1']):focus-visible { outline: 2px solid var(--ss-kit-focus); outline-offset: 2px; }
button.icon { padding: 6px 12px; line-height: 1; }
button.danger { background: var(--ss-color-danger, #b91c1c); color: var(--ss-color-onDanger, #ffffff); }
.status.error { color: var(--ss-kit-bad); }
.state { display: grid; justify-items: start; gap: 8px; padding: 12px 0; }
.state p { margin: 0; }
.state.error p { color: var(--ss-kit-bad); }
.state button { margin-top: 0; }
.state.loading { display: flex; align-items: center; gap: 8px; margin: 0; opacity: 0.8; }
.state.loading::before { content: ''; flex: none; width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%;
  border: 2px solid currentColor; border-inline-end-color: transparent; animation: ss-spin 800ms linear infinite; }
.dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--ss-color-muted, #9ca3af); }
.dot.success { background: var(--ss-kit-ok); } .dot.warning { background: var(--ss-kit-warn); } .dot.danger { background: var(--ss-kit-bad); }
.badge { display: inline-block; flex: none; padding: 2px 10px; border-radius: 999px; font-size: 0.75em; font-weight: 600;
  white-space: nowrap; background: rgba(127, 127, 127, 0.14); }
.badge.success { color: var(--ss-kit-ok); background: color-mix(in srgb, var(--ss-kit-ok) 14%, transparent); }
.badge.warning { color: var(--ss-kit-warn); background: color-mix(in srgb, var(--ss-kit-warn) 14%, transparent); }
.badge.danger { color: var(--ss-kit-bad); background: color-mix(in srgb, var(--ss-kit-bad) 14%, transparent); }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 170px), 1fr)); gap: 12px 16px; margin: 12px 0; }
.facts > div { min-width: 0; } .facts dt { font-size: 0.8em; opacity: 0.7; } .facts dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.split { display: grid; gap: 16px; margin-top: 12px; }
.split[data-view='list'] .detail-pane, .split[data-view='detail'] .list-pane { display: none; }
.pane { min-width: 0; }
.back { margin: 0 0 8px; }
@container (min-width: 720px) {
  .split { grid-template-columns: minmax(240px, 2fr) 3fr; align-items: start; }
  .split[data-view] .list-pane, .split[data-view] .detail-pane { display: block; }
  .back { display: none; }
}
.more { position: relative; display: inline-block; }
.menu { position: absolute; inset-inline-end: 0; top: calc(100% + 4px); z-index: 5; min-width: 200px; max-width: calc(100vw - 32px);
  padding: 4px; border-radius: var(--ss-radius, 8px); background: var(--ss-color-background, #ffffff);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16); animation: ss-pop 120ms ease-out; }
:host([data-ss-mode='dark']) .menu, :host([data-ss-mode='dark']) .dialog { background: var(--ss-color-background, #111827); }
.menu button { display: block; width: 100%; margin: 0; padding: 8px 12px; text-align: start; background: transparent; color: inherit; }
.menu button:hover, .menu button:focus-visible { background: rgba(127, 127, 127, 0.12); }
.menu button.danger { color: var(--ss-kit-bad); }
.overlay { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 16px;
  background: rgba(15, 23, 42, 0.45); animation: ss-fade 150ms ease-out; }
.dialog { width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box; padding: 20px;
  border-radius: calc(var(--ss-radius, 8px) * 2); background: var(--ss-color-background, #ffffff);
  animation: ss-pop 150ms ease-out; container-type: inline-size; }
.dialog.wide { width: min(920px, 100%); }
.dialog h3 { margin: 0 0 8px; }
.dialog .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.dialog .actions button { margin-top: 0; }
@media (max-width: 639px) { .overlay { padding: 0; } .dialog, .dialog.wide { width: 100%; height: 100%; max-height: none; border-radius: 0; } }
@keyframes ss-pop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }
@keyframes ss-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ss-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .menu, .overlay, .dialog { animation: none; } .state.loading::before { animation-duration: 3s; } }
`;
