/**
 * The admin widgets' CSS, added after the shared widget CSS inside their shadow roots: tabs, field grids, chips,
 * image thumbnails and tables that scroll sideways on small screens (from 360 px). Colours come from the theme.
 * @module
 */
export const ADMIN_CSS = `
[hidden] { display: none !important; }
.admin { overflow-wrap: anywhere; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--ss-color-border, #e5e7eb); margin: 4px 0 12px; }
.tabs button { margin-top: 0; background: transparent; color: inherit; border-radius: var(--ss-radius, 8px) var(--ss-radius, 8px) 0 0; }
.tabs button[aria-selected='true'] { background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); }
.head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.head h3 { margin: 8px 0; font-size: 1em; }
.field { flex: 1 1 160px; min-width: 0; }
.row.inline { align-items: end; } .row.inline > button { flex: 0 0 auto; }
.fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 0 12px; }
fieldset { border: 1px solid var(--ss-color-border, #e5e7eb); border-radius: var(--ss-radius, 8px); margin: 12px 0 0; padding: 8px 12px; min-width: 0; }
legend { font-weight: 600; padding: 0 4px; }
.scroll { overflow-x: auto; max-width: 100%; }
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
dl { display: grid; grid-template-columns: minmax(100px, max-content) 1fr; gap: 4px 12px; margin: 8px 0; }
dt { opacity: 0.7; } dd { margin: 0; }
`;
