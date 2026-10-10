/**
 * The admin widgets' CSS, added after the shared widget CSS inside their shadow roots: the section picker (a list beside
 * the section in a wide widget, a select above it in a narrow one, by the widget's own width), field grids, chips,
 * image thumbnails and tables that scroll sideways on small screens (from 360 px). Colours come from the theme.
 * @module
 */
export const ADMIN_CSS = `
[hidden] { display: none !important; }
.admin { overflow-wrap: anywhere; }
.picker { container-type: inline-size; margin-top: 4px; }
.picker > .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px 20px; }
.sections ul { display: none; }
.sections .field { max-width: 360px; }
.sections li { padding: 0; border: 0; }
.sections li button { display: block; width: 100%; margin: 0 0 2px; padding: 8px 12px; text-align: left; background: transparent;
  color: inherit; border-radius: var(--ss-radius, 8px); }
.sections li button:hover { background: rgba(127, 127, 127, 0.1); }
.sections li button[aria-current='true'] { background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); }
@container (min-width: 720px) {
  .picker > .layout:not(.single) { grid-template-columns: 180px minmax(0, 1fr); align-items: start; }
  .sections ul { display: block; }
  .sections .field { display: none; }
}
.head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.head h3 { margin: 8px 0; font-size: 1em; }
.field { flex: 1 1 160px; min-width: 0; }
.row.inline { align-items: end; } .row.inline > button { flex: 0 0 auto; }
.fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 0 12px; }
fieldset { border: 1px solid var(--ss-color-border, #e5e7eb); border-radius: var(--ss-radius, 8px); margin: 12px 0 0; padding: 8px 12px; min-width: 0; }
legend { font-weight: 600; padding: 0 4px; }
.scroll { overflow-x: auto; max-width: 100%; }
/* table cells keep one line and a table wider than its box scrolls inside it rather than squeezing words */
.scroll th, .scroll td { white-space: nowrap; overflow-wrap: normal; vertical-align: top; }
td input, td select { min-width: 90px; padding: 4px 6px; }
td label.check { margin: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0; }
.chips li { display: inline-flex; gap: 6px; align-items: center; padding: 2px 8px; border: 1px solid var(--ss-color-border, #d1d5db); border-radius: 999px; }
.chips button { margin-top: 0; padding: 2px 8px; }
.rows li { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.rows li > .what { flex: 1 1 200px; min-width: 0; }
.rows li button { margin-top: 0; }
.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; margin-top: 8px; }
.thumbs figure { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.thumbs img, .photo { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: var(--ss-radius, 8px); }
.thumbs button { margin-top: 0; padding: 4px 8px; }
.ok { color: var(--ss-color-success, #15803d); }
.pill { display: inline-block; padding: 0 8px; border-radius: 999px; border: 1px solid var(--ss-color-border, #d1d5db); font-size: 0.85em; }
.pill.warn { border-color: var(--ss-color-danger, #b91c1c); color: var(--ss-color-danger, #b91c1c); }
dl { display: grid; grid-template-columns: fit-content(40%) minmax(0, 1fr); gap: 4px 12px; margin: 8px 0; }
dt { opacity: 0.7; } dd { margin: 0; }
/* list and detail, badges, More menus, dialogs and masonry (PLAN 0.6); indigo is the theme's accent, status colours only for status */
.admin { container-type: inline-size; }
.split { display: grid; gap: 16px; margin-top: 12px; }
.split[data-view='list'] .detail-pane, .split[data-view='detail'] .list-pane { display: none; }
.back { margin: 0 0 8px; }
@container (min-width: 720px) {
  .split { grid-template-columns: minmax(240px, 2fr) 3fr; align-items: start; }
  .split[data-view] .list-pane, .split[data-view] .detail-pane { display: block; }
  .back { display: none; }
}
.pane { min-width: 0; }
li.item { display: grid; grid-template-columns: auto 1fr auto; gap: 2px 10px; align-items: center; padding: 10px 8px;
  cursor: pointer; border-radius: var(--ss-radius, 8px); border-top: 0; transition: background-color 120ms ease-out; }
li.item:hover { background: rgba(127, 127, 127, 0.08); }
li.item:focus-visible { outline: 2px solid var(--ss-color-accent, #4f46e5); outline-offset: -2px; }
li.item[aria-current='true'] { background: rgba(79, 70, 229, 0.1); }
li.item .meta { grid-column: 2 / -1; }
.name { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.figure { font-weight: 600; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
.dot.success { background: #16a34a; } .dot.warning { background: #d97706; } .dot.danger { background: #dc2626; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.75em; font-weight: 600;
  background: rgba(127, 127, 127, 0.14); white-space: nowrap; }
.badge.success { color: #15803d; background: rgba(22, 163, 74, 0.14); }
.badge.warning { color: #b45309; background: rgba(217, 119, 6, 0.14); }
.badge.danger { color: #b91c1c; background: rgba(220, 38, 38, 0.14); }
.count { display: inline-block; min-width: 1.6em; margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: 0.75em;
  text-align: center; background: rgba(79, 70, 229, 0.12); color: var(--ss-color-accent, #4f46e5); }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px 16px; margin: 12px 0; }
.facts > div { min-width: 0; } .facts dt { font-size: 0.8em; } .facts dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.detail-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.detail-head h3 { margin: 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.detail-head .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.detail-head .actions button { margin-top: 0; }
.masonry { columns: 1; column-gap: 16px; }
@container (min-width: 640px) { .masonry { columns: 2; } }
@container (min-width: 1040px) { .masonry { columns: 3; } }
.masonry > .card { break-inside: avoid; margin: 0 0 16px; padding: 12px 16px; border-radius: calc(var(--ss-radius, 8px) * 2);
  background: rgba(127, 127, 127, 0.06); }
.card h4 { margin: 0 0 8px; font-size: 0.95em; }
button.link { background: transparent; color: var(--ss-color-accent, #4f46e5); padding: 0; margin-top: 0; }
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
.dialog { width: min(560px, 100%); max-height: 90vh; overflow: auto; box-sizing: border-box; padding: 20px;
  border-radius: calc(var(--ss-radius, 8px) * 2); background: var(--ss-color-background, #ffffff);
  animation: ss-pop 150ms ease-out; container-type: inline-size; }
.dialog.wide { width: min(920px, 100%); }
.dialog h3 { margin: 0 0 8px; }
.dialog .actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 639px) { .overlay { padding: 0; } .dialog, .dialog.wide { width: 100%; height: 100%; max-height: none; border-radius: 0; } }
@keyframes ss-pop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }
@keyframes ss-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .menu, .overlay, .dialog, li.item { animation: none; transition: none; } }
/* list heads with their count, filter chips with counts, row checkboxes and more filters (ui/admin-lists.js) */
.list-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.list-head h3 { margin: 0; display: flex; align-items: center; gap: 2px; }
.list-head .actions button { margin-top: 0; }
.chipbar { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.chipbar button { margin: 0; padding: 4px 12px; border-radius: 999px; background: transparent; color: inherit;
  border: 1px solid var(--ss-color-border, #d1d5db); transition: background-color 120ms ease-out; }
.chipbar button[aria-pressed='true'] { background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff);
  border-color: transparent; }
.chipbar button[aria-pressed='true'] .count { background: rgba(255, 255, 255, 0.25); color: inherit; }
li.item .lead { display: inline-flex; gap: 8px; align-items: center; } li.item .lead input { width: auto; margin: 0; }
.selectbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin: 8px 0; }
.selectbar label.check { margin: 0; } .selectbar button { margin-top: 0; }
details.filters { margin: 4px 0 8px; } details.filters > summary { cursor: pointer; font-size: 0.9em; padding: 4px 0; }
.empty { padding: 24px 0; text-align: center; }
@media (prefers-reduced-motion: reduce) { .chipbar button { transition: none; } }
/* catalog: list tools, card heads, checkbox groups, FAQs, the rich text editor and preview (ui/admin-screen.js, ui/admin-fields.js) */
.tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; justify-content: space-between; }
.tools > .row, .tools > form { flex: 1 1 260px; } .tools > button { flex: 0 0 auto; }
.card-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.card-head h4 { margin: 0; } .card-head button { margin-top: 0; padding: 4px 12px; }
.checks { display: flex; flex-wrap: wrap; gap: 4px 16px; } .checks label.check { margin: 4px 0; }
li.item label.check { margin: 0; }
.faq { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 12px; padding: 4px 0 8px; }
.faq > button { justify-self: start; margin-top: 4px; }
dl.faqs { display: block; } dl.faqs dt { opacity: 1; font-weight: 600; margin-top: 8px; } dl.faqs dd { margin: 2px 0 0; }
.prose { white-space: pre-line; margin: 0 0 8px; } .summary-line { font-weight: 500; }
.toolbar { display: flex; flex-wrap: wrap; gap: 4px; } .toolbar button { margin-top: 0; padding: 4px 10px; font-size: 0.85em; }
.rich > :first-child { margin-top: 0; } .rich a { color: var(--ss-color-accent, #4f46e5); }
.rich.preview { padding: 8px 12px; border-radius: var(--ss-radius, 8px); background: rgba(127, 127, 127, 0.06); min-height: 2em; }
.editor > .detail-head { position: sticky; top: 0; z-index: 2; padding: 8px 0; background: var(--ss-color-background, #ffffff); }
:host([data-ss-mode='dark']) .editor > .detail-head { background: var(--ss-color-background, #111827); }
`;
