/**
 * The widgets' CSS, injected into their shadow roots only. Colors, font and corner radius come from the website's
 * theme (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), with fallbacks for light and dark. Usable on phones
 * from 360 px wide.
 * @module
 */
import { ADMIN_KIT_CSS } from '@ss/app-kit/widget';

export const WIDGET_CSS = `${ADMIN_KIT_CSS}
:host { display: block; font-family: var(--ss-font-family, inherit); color: var(--ss-color-text, #1f2937); }
:host([data-ss-mode='dark']) { color: var(--ss-color-text, #f3f4f6); }
.box { border: 1px solid var(--ss-color-border, #d1d5db); border-radius: var(--ss-radius, 8px); padding: 16px;
  background: var(--ss-color-background, #ffffff); max-width: 100%; box-sizing: border-box; }
:host([data-ss-mode='dark']) .box { background: var(--ss-color-background, #111827); border-color: var(--ss-color-border, #374151); }
h2 { font-size: 1.1em; margin: 0 0 8px; } h3 { font-size: 1em; margin: 0 0 8px; } h4 { font-size: 0.95em; margin: 12px 0 4px; }
.part { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--ss-color-border, #e5e7eb); }
label { display: block; font-size: 0.9em; margin: 8px 0 4px; }
textarea, input, select { width: 100%; box-sizing: border-box; font: inherit; color: inherit; background: transparent;
  padding: 8px; border: 1px solid var(--ss-color-border, #d1d5db); border-radius: var(--ss-radius, 8px); min-height: 40px; }
label.check { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; } label.check input { width: auto; min-height: 0; }
label.check a { color: var(--ss-color-accent, #4f46e5); }
button { margin: 12px 0 0; margin-inline-end: 8px; font: inherit; padding: 8px 16px; min-height: 40px; border: 0; border-radius: var(--ss-radius, 8px);
  background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); cursor: pointer; }
button.secondary { background: transparent; color: inherit; border: 1px solid var(--ss-color-border, #d1d5db); }
button.link { background: transparent; color: var(--ss-color-accent, #4f46e5); padding: 8px 0; text-decoration: underline; }
button.small { padding: 4px 10px; min-height: 32px; margin-top: 6px; font-size: 0.9em; }
button.social { display: block; width: 100%; margin-inline-end: 0; }
button[disabled] { opacity: 0.6; cursor: default; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
.tabs button { margin: 0; flex: 1 1 90px; background: transparent; color: inherit; border: 1px solid var(--ss-color-border, #d1d5db); }
.tabs button[aria-pressed='true'] { background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); }
.socials { margin-top: 8px; } .socials .meta { text-align: center; margin: 8px 0 0; }
.details { margin-top: 8px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; } .row > * { flex: 1 1 140px; }
.row > button, .row > label.check { flex: 0 0 auto; }
.actions { display: flex; flex-wrap: wrap; }
fieldset { border: 1px solid var(--ss-color-border, #e5e7eb); border-radius: var(--ss-radius, 8px); margin: 8px 0; padding: 4px 12px 8px; }
legend { font-size: 0.9em; padding: 0 4px; }
/* a role's permissions sit in columns where the widget is wide (by its own width, not the screen's) */
.permissions fieldset { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); column-gap: 16px; }
.permissions label.check { flex-wrap: nowrap; align-items: flex-start; } .permissions label.check input { flex: none; margin-top: 3px; }
.status { margin: 8px 0 0; font-size: 0.9em; }
.code { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.tag { display: inline-block; font-size: 0.8em; padding: 2px 8px; margin-top: 4px; border-radius: 999px;
  border: 1px solid var(--ss-color-border, #d1d5db); }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 8px 0; border-top: 1px solid var(--ss-color-border, #e5e7eb); overflow-wrap: anywhere; }
ul.codes { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 4px; }
ul.codes li { border: 0; padding: 4px 0; }
.meta { display: block; font-size: 0.8em; opacity: 0.7; }
p { overflow-wrap: anywhere; }
/* admin widgets (PLAN 0.6): one accent; green, amber and red only for status badges; dialogs; the More menu; masonry */
.box { container-type: inline-size; }
.head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.head h2, .head h3 { margin: 0; } .head .actions button { margin-top: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 4px; }
.chip { margin: 0; padding: 4px 12px; min-height: 32px; background: transparent; color: inherit; border: 1px solid var(--ss-color-border, #d1d5db); border-radius: 999px; }
.chip[aria-pressed='true'] { background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); border-color: transparent; }
.chip .count { display: inline-block; min-width: 1.2em; margin-inline-start: 6px; font-size: 0.8em; opacity: 0.85; }
.chip .count:empty { display: none; }
.layout { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
@container (min-width: 960px) { .layout { grid-template-columns: minmax(280px, 2fr) minmax(0, 3fr); } .layout .back { display: none; } }
@container (max-width: 959px) { .layout.picked .list-pane { display: none; } .layout:not(.picked) .detail-pane { display: none; } }
li.row-item { display: flex; gap: 8px; align-items: center; justify-content: space-between; cursor: pointer; }
li.row-item[aria-current='true'] { box-shadow: inset 3px 0 0 var(--ss-color-accent, #4f46e5); padding-inline-start: 8px; }
li.row-item .who { min-width: 0; flex: 1 1 auto; } li.row-item .figure { font-size: 0.8em; opacity: 0.7; white-space: nowrap; }
.cards { column-width: 240px; column-gap: 12px; margin-top: 12px; }
.card { break-inside: avoid; display: inline-block; width: 100%; box-sizing: border-box; margin: 0 0 12px; padding: 12px;
  border-radius: var(--ss-radius, 8px); background: var(--ss-color-surface, rgba(79, 70, 229, 0.05)); }
.card h4 { margin: 0 0 6px; } dl { margin: 0; } dt { font-size: 0.8em; opacity: 0.7; margin-top: 6px; } dd { margin: 0; overflow-wrap: anywhere; }
.more { position: relative; display: inline-block; } .more > button { margin: 0; }
button.icon { padding: 4px 12px; min-height: 32px; line-height: 1; }
.grid { display: grid; gap: 0 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); }
.grid .wide { grid-column: 1 / -1; }
.copy { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; } .big { font-size: 1.3em; margin: 4px 0; }
`;
