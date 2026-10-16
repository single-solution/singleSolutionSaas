/**
 * The widgets' CSS, injected into their shadow roots only. The controls, buttons, fields and cards are the kit's
 * (`CONTROLS_CSS`, `ADMIN_KIT_CSS`); colors, font and corner radius come from the website's theme
 * (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), with fallbacks for light and dark.
 * @module
 */
import { ADMIN_KIT_CSS, CONTROLS_CSS } from '@ss/app-kit/widget';

export const WIDGET_CSS = `${CONTROLS_CSS}${ADMIN_KIT_CSS}
:host { display: block; font-family: var(--ss-font-family, inherit); color: var(--ss-color-text, #1f2937); }
:host([data-ss-mode='dark']) { color: var(--ss-color-text, #f3f4f6); }
h2 { font-size: 1.15em; font-weight: 650; margin: 0 0 12px; }
button { margin-top: 12px; }
.row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; } .row > * { flex: 1 1 140px; }
.row .field { margin-top: 0; } .row > button { flex: 0 0 auto; margin-top: 0; }
.status { margin: 12px 0 0; font-size: 0.9em; }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 10px 0; border-top: 1px solid var(--ss-kit-hair); overflow-wrap: anywhere; } li:first-child { border-top: 0; }
.meta { display: block; font-size: 0.8em; opacity: 0.7; }
.preview { margin-top: 8px; padding: 12px; border: 1px dashed var(--ss-kit-line); border-radius: var(--ss-kit-r);
  white-space: pre-wrap; overflow-wrap: anywhere; }
.preview p { margin: 4px 0 0; }
.count { margin: 8px 0 0; font-size: 0.85em; opacity: 0.8; }
details > summary { cursor: pointer; }
dl { margin: 8px 0 0; font-size: 0.85em; } dt { font-weight: 600; margin-top: 4px; } dd { margin: 0; white-space: pre-wrap; }
`;
