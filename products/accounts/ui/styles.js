/**
 * The widgets' CSS, injected into their shadow roots only. Colors, font and corner radius come from the website's
 * theme (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), with fallbacks for light and dark. Usable on phones
 * from 360 px wide.
 * @module
 */
import { ADMIN_KIT_CSS, CONTROLS_CSS } from '@ss/app-kit/widget';

export const WIDGET_CSS = `${CONTROLS_CSS}${ADMIN_KIT_CSS}
:host { display: block; font-family: var(--ss-font-family, inherit); color: var(--ss-color-text, #1f2937); }
:host([data-ss-mode='dark']) { color: var(--ss-color-text, #f3f4f6); }
.box { max-width: 100%; box-sizing: border-box; container-type: inline-size; }
h2 { font-size: 1.15em; font-weight: 650; margin: 0 0 12px; } h3 { font-size: 1em; margin: 0 0 8px; } h4 { font-size: 0.95em; margin: 12px 0 4px; }
.part { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--ss-kit-hair); }
label.check a { color: var(--ss-kit-focus); }
button { margin: 12px 0 0; margin-inline-end: 8px; min-height: 40px; }
button.link { color: var(--ss-kit-focus); padding: 8px 0; text-decoration: underline; }
button.small { padding: 4px 10px; min-height: 32px; margin-top: 6px; font-size: 0.9em; }
button.social { display: block; width: 100%; margin-inline-end: 0; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; padding: 3px; border-radius: calc(var(--ss-kit-r) + 3px); background: var(--ss-kit-soft); }
.tabs button { margin: 0; flex: 1 1 90px; background: transparent; color: inherit; box-shadow: none; font-weight: 500; }
.tabs button[aria-pressed='true'] { background: var(--ss-kit-card); font-weight: 600; box-shadow: 0 1px 3px rgb(15 23 42 / 0.14); }
.socials { margin-top: 8px; } .socials .meta { text-align: center; margin: 8px 0 0; }
.details { margin-top: 8px; }
.row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; } .row > * { flex: 1 1 140px; }
.row > button, .row > label.check { flex: 0 0 auto; }
.actions { display: flex; flex-wrap: wrap; }
/* a role's permissions sit in columns where the widget is wide (by its own width, not the screen's) */
.permissions fieldset { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); column-gap: 16px; }
.permissions label.check { align-items: flex-start; }
.status { margin: 8px 0 0; font-size: 0.9em; }
.code { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 10px 0; border-top: 1px solid var(--ss-kit-hair); overflow-wrap: anywhere; } li:first-child { border-top: 0; }
ul.codes { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 4px; }
ul.codes li { border: 0; padding: 4px 0; }
.meta { display: block; font-size: 0.8em; opacity: 0.7; }
p { overflow-wrap: anywhere; }
/* admin widgets (PLAN 0.6): one accent; green, amber and red only for status badges; dialogs; the More menu; masonry */
.head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.head h2, .head h3 { margin: 0; } .head .actions button { margin-top: 0; }
.tools > .chips { margin-bottom: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 4px; }
.chip { margin: 0; padding: 4px 12px; min-height: 32px; background: transparent; color: inherit; box-shadow: inset 0 0 0 1px var(--ss-kit-line); border-radius: 999px; }
.chip[aria-pressed='true'] { background: var(--ss-kit-focus); color: var(--ss-color-onAccent, #ffffff); box-shadow: none; }
.chip .count { display: inline-block; min-width: 1.2em; margin-inline-start: 6px; font-size: 0.8em; opacity: 0.85; }
.chip .count:empty { display: none; }
.layout { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
.layout > :is(.list-pane, .detail-pane) { min-width: 0; box-sizing: border-box; padding: 16px 18px; border: 1px solid var(--ss-kit-hair);
  border-radius: var(--ss-kit-rc); background: var(--ss-kit-card); box-shadow: var(--ss-kit-shadow); }
@container (min-width: 960px) { .layout { grid-template-columns: minmax(280px, 2fr) minmax(0, 3fr); align-items: start; } .layout .back { display: none; } }
@container (max-width: 959px) { .layout.picked .list-pane { display: none; } .layout:not(.picked) .detail-pane { display: none; } }
li.row-item { display: flex; gap: 8px; align-items: center; justify-content: space-between; cursor: pointer; border-radius: var(--ss-kit-r); }
li.row-item:hover { background: var(--ss-kit-soft); }
li.row-item[aria-current='true'] { box-shadow: inset 3px 0 0 var(--ss-kit-focus); padding-inline-start: 8px; }
li.row-item .who { min-width: 0; flex: 1 1 auto; } li.row-item .figure { font-size: 0.8em; opacity: 0.7; white-space: nowrap; }
.cards { column-width: 240px; column-gap: 12px; margin-top: 12px; }
.card { break-inside: avoid; display: inline-block; width: 100%; box-sizing: border-box; margin: 0 0 12px; padding: 12px 14px;
  border: 1px solid var(--ss-kit-hair); border-radius: var(--ss-kit-rc); background: var(--ss-kit-card); box-shadow: var(--ss-kit-shadow); }
.card h4 { margin: 0 0 6px; } dl { margin: 0; } dt { font-size: 0.8em; opacity: 0.7; margin-top: 6px; } dd { margin: 0; overflow-wrap: anywhere; }
.more { position: relative; display: inline-block; } .more > button { margin: 0; }
button.icon { padding: 4px 12px; min-height: 32px; line-height: 1; }
.grid { display: grid; gap: 0 16px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); }
.grid .wide { grid-column: 1 / -1; }
.copy { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; } .big { font-size: 1.3em; margin: 4px 0; }
`;
