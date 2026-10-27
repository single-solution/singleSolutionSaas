/**
 * The admin widgets' CSS, added after the shared widget CSS inside their shadow roots: the section picker (a list beside
 * the section in a wide widget, a select above it in a narrow one, by the widget's own width), field grids, chips,
 * image thumbnails and tables that scroll sideways on small screens (from 360 px). Colors come from the theme.
 * @module
 */
import { ADMIN_KIT_CSS } from '@ss/app-kit/widget';

export const ADMIN_CSS = `${ADMIN_KIT_CSS}
.admin { overflow-wrap: anywhere; }
.picker { container-type: inline-size; margin-top: 4px; }
.picker > .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px 20px; }
.sections ul { display: none; }
.sections .field { max-width: none; }
.sections li { padding: 0; border: 0; }
.sections li button { display: block; width: 100%; margin: 0 0 2px; padding: 9px 12px; text-align: start; background: transparent;
  color: inherit; font-weight: 500; border-radius: var(--ss-kit-r); }
.sections li button:hover { background: var(--ss-kit-soft); filter: none; }
.sections li button[aria-current='true'] { background: color-mix(in srgb, var(--ss-kit-focus) 12%, transparent); color: var(--ss-kit-focus); font-weight: 600; }
@container (min-width: 720px) {
  .picker > .layout:not(.single) { grid-template-columns: 200px minmax(0, 1fr); align-items: start; }
  .sections { position: sticky; top: 8px; padding: 8px; border: 1px solid var(--ss-kit-hair); border-radius: var(--ss-kit-rc); background: var(--ss-kit-card); box-shadow: var(--ss-kit-shadow); }
  .sections ul { display: block; }
  .sections .field { display: none; }
}
.head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.head h3 { margin: 8px 0; font-size: 1em; }
.row > .field { flex: 1 1 160px; margin-top: 0; }
.row.inline { align-items: end; } .row.inline > button { flex: 0 0 auto; }
.scroll { overflow-x: auto; max-width: 100%; }
/* table cells keep one line and a table wider than its box scrolls inside it rather than squeezing words */
.scroll th, .scroll td { white-space: nowrap; overflow-wrap: normal; vertical-align: top; }
td input, td select { min-width: 90px; min-height: 32px; padding: 4px 8px; }
td label.check { margin: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0; }
.chips li { display: inline-flex; gap: 6px; align-items: center; padding: 2px 10px; border: 0; border-radius: 999px; background: var(--ss-kit-soft); }
.chips button { margin-top: 0; padding: 2px 8px; }
.rows li { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.rows li > .what { flex: 1 1 200px; min-width: 0; }
.rows li button { margin-top: 0; }
.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; margin-top: 8px; }
.thumbs figure { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.thumbs img, .photo { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: var(--ss-radius, 0.35rem); }
.thumbs button { margin-top: 0; padding: 4px 8px; }
.ok { color: var(--ss-color-success, #15803d); }
dl { display: grid; grid-template-columns: fit-content(40%) minmax(0, 1fr); gap: 4px 12px; margin: 8px 0; }
dt { opacity: 0.7; } dd { margin: 0; }
/* list and detail rows and masonry (PLAN 0.6); the badges, dots, facts, More menus and dialogs are the kit's (ADMIN_KIT_CSS); indigo is the theme's accent, status colors only for status */
@media (prefers-reduced-motion: reduce) { li.item { animation: none; transition: none; } }
.admin { container-type: inline-size; }
li.item { display: grid; grid-template-columns: auto 1fr auto; gap: 2px 10px; align-items: center; padding: 10px 8px;
  cursor: pointer; border-radius: var(--ss-radius, 0.35rem); border-top: 0; transition: background-color 120ms ease-out; }
li.item:hover { background: var(--ss-kit-soft); }
li.item:focus-visible { outline: 2px solid var(--ss-kit-focus); outline-offset: -2px; }
li.item[aria-current='true'] { background: color-mix(in srgb, var(--ss-kit-focus) 10%, transparent); }
li.item .meta { grid-column: 2 / -1; }
.name { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.figure { font-weight: 600; white-space: nowrap; }
.count { display: inline-block; min-width: 1.6em; margin-inline-start: 6px; padding: 0 6px; border-radius: 999px; font-size: 0.75em;
  text-align: center; background: color-mix(in srgb, var(--ss-kit-focus) 12%, transparent); color: var(--ss-kit-focus); }
.detail-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.detail-head h3 { margin: 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.detail-head .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.detail-head .actions button { margin-top: 0; }
.masonry { columns: 1; column-gap: 16px; }
@container (min-width: 640px) { .masonry { columns: 2; } }
@container (min-width: 1040px) { .masonry { columns: 3; } }
.masonry > .card { break-inside: avoid; margin: 0 0 16px; padding: 12px 16px; border: 1px solid var(--ss-kit-hair);
  border-radius: var(--ss-kit-rc); background: var(--ss-kit-card); box-shadow: var(--ss-kit-shadow); }
.card h4 { margin: 0 0 8px; font-size: 0.95em; }
button.link { color: var(--ss-kit-focus); padding: 0; margin-top: 0; }
/* list heads with their count, filter chips with counts, row checkboxes and more filters (ui/admin-screen.js) */
.list-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.list-head h3 { margin: 0; display: flex; align-items: center; gap: 2px; }
.list-head .actions button { margin-top: 0; }
.chipbar { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.chipbar button { margin: 0; padding: 5px 14px; border-radius: 999px; background: transparent; color: inherit; font-weight: 500;
  box-shadow: inset 0 0 0 1px var(--ss-kit-line); transition: background-color 120ms ease-out; }
.chipbar button[aria-pressed='true'] { background: var(--ss-kit-focus); color: var(--ss-color-onAccent, #ffffff); box-shadow: none; }
.chipbar button[aria-pressed='true'] .count { background: rgba(255, 255, 255, 0.25); color: inherit; }
li.item .lead { display: inline-flex; gap: 8px; align-items: center; } li.item .lead input { width: auto; margin: 0; }
.selectbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin: 8px 0; }
.selectbar label.check { margin: 0; } .selectbar button { margin-top: 0; }
details.filters { margin: 4px 0 8px; } details.filters > summary { cursor: pointer; font-size: 0.9em; padding: 4px 0; }
.detail-pane > .state.empty { justify-items: center; padding: 24px 0; text-align: center; }
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
.rich > :first-child { margin-top: 0; } .rich a { color: var(--ss-kit-focus); }
.rich.preview { padding: 10px 14px; border-radius: var(--ss-kit-r); background: var(--ss-kit-soft); min-height: 2em; }
.editor > .detail-head { position: sticky; top: 0; z-index: 2; padding: 8px 0; background: var(--ss-kit-card); }
`;
