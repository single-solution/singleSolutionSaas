/**
 * The CSS of the admin widget building blocks (admin.js), shared by every product so a status badge, a More menu, a dialog or an empty state looks and
 * behaves the same in Accounts, Ecommerce, Growth and Payments. A product puts it right after `CONTROLS_CSS` (which has
 * the tokens it uses) in its own widget CSS and adds only what is its own. Colors come from the website's theme
 * (`--ss-color-<name>`) with a fallback for light and dark; the status colors (green, amber, red) mean status only.
 * Spacing uses logical properties (`inline-start`, `inline-end`, `text-align: start`), so the blocks follow the page's
 * direction when it is right to left. A product that uses `split` makes its widget a size container
 * (`container-type: inline-size`): the list sits beside the detail from 720 px of the widget's own width.
 * @module
 */
export const ADMIN_KIT_CSS = `
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
.split > .pane { box-sizing: border-box; padding: 16px 18px; border: 1px solid var(--ss-kit-hair); border-radius: var(--ss-kit-rc);
  background: var(--ss-kit-card); box-shadow: var(--ss-kit-shadow); }
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
  padding: 6px; border: 1px solid var(--ss-kit-hair); border-radius: var(--ss-kit-rc); background: var(--ss-kit-card);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18); animation: ss-pop 120ms ease-out; }
.menu button { display: block; width: 100%; margin: 0; padding: 8px 12px; font-weight: 500; text-align: start; background: transparent; color: inherit; }
.menu button:hover, .menu button:focus-visible { background: rgba(127, 127, 127, 0.12); }
.menu button.danger { color: var(--ss-kit-bad); }
.overlay { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 16px;
  background: rgba(15, 23, 42, 0.45); backdrop-filter: blur(2px); animation: ss-fade 150ms ease-out; }
.dialog { width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box; padding: 22px 24px;
  border: 1px solid var(--ss-kit-hair); border-radius: var(--ss-kit-rc); background: var(--ss-kit-card);
  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.3); animation: ss-pop 150ms ease-out; container-type: inline-size; }
.dialog.wide { width: min(920px, 100%); }
.dialog h3 { margin: 0 0 12px; font-size: 1.1em; font-weight: 600; }
.dialog .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.dialog .actions button { margin-top: 0; }
@media (max-width: 639px) { .overlay { padding: 0; } .dialog, .dialog.wide { width: 100%; height: 100%; max-height: none; border-radius: 0; } }
@keyframes ss-pop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }
@keyframes ss-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ss-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .menu, .overlay, .dialog { animation: none; } .state.loading::before { animation-duration: 3s; } }
`;
