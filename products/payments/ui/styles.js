/**
 * The widgets' CSS, injected into their shadow roots only. Colors, font and corner radius come from the website's
 * theme (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), with fallbacks for light and dark.
 * @module
 */
import { ADMIN_KIT_CSS, CONTROLS_CSS } from '@ss/app-kit/widget';

export const WIDGET_CSS = `${CONTROLS_CSS}${ADMIN_KIT_CSS}
:host { display: block; font-family: var(--ss-font-family, inherit); color: var(--ss-color-text, #1f2937); container-type: inline-size; }
:host([data-ss-mode='dark']) { color: var(--ss-color-text, #f3f4f6); }
h2 { font-size: 1.15em; font-weight: 650; margin: 0 0 12px; }
button { margin-top: 12px; }
.row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; } .row > * { flex: 1 1 140px; }
.row > button { flex: 0 0 auto; margin-top: 0; }
.status { margin: 12px 0 0; font-size: 0.9em; }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 10px 0; border-top: 1px solid var(--ss-kit-hair); overflow-wrap: anywhere; }
.meta { display: block; font-size: 0.8em; opacity: 0.7; }
.amount { font-size: 1.3em; font-weight: 600; margin: 4px 0 8px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; } .actions button { margin-top: 8px; }
.head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.head h2, .head h3 { margin: 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.head .actions button, .head > button { margin-top: 0; }
.tools { margin-bottom: 12px; } .tools > .head { margin-bottom: 12px; }
li.item { display: grid; grid-template-columns: auto 1fr auto; gap: 2px 10px; align-items: center; padding: 10px 12px;
  cursor: pointer; border-top: 0; border-radius: var(--ss-kit-r); transition: background-color 120ms; }
li.item:hover { background: var(--ss-kit-soft); }
li.item:focus-visible { outline: 2px solid var(--ss-kit-focus); outline-offset: -2px; }
li.item[aria-current='true'] { background: color-mix(in srgb, var(--ss-kit-focus) 10%, transparent); }
li.item .meta { grid-column: 2 / -1; }
.name { overflow-wrap: anywhere; } .figure { font-weight: 600; white-space: nowrap; }
.sub h4 { font-size: 0.9em; margin: 12px 0 4px; } ul.plain li { padding: 4px 0; font-size: 0.9em; border-top: 0; }
button.link { background: transparent; color: var(--ss-kit-focus); padding: 0; margin: 0 0 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0 16px; }
.grid .wide { grid-column: 1 / -1; }
`;
