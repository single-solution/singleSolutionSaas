/**
 * The widgets' CSS, injected into their shadow roots only. Colors, font and corner radius come from the website's
 * theme (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), with fallbacks for light and dark.
 * @module
 */
import { CONTROLS_CSS } from '@ss/app-kit/widget';

export const WIDGET_CSS = `${CONTROLS_CSS}
.price { font-weight: 600; } .was { text-decoration: line-through; opacity: 0.6; margin-inline-start: 6px; font-weight: 400; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--ss-kit-hair); border-radius: var(--ss-kit-rc); padding: 10px; background: var(--ss-kit-card); display: flex; flex-direction: column; gap: 6px; }
.card img, .gallery img { width: 100%; height: auto; aspect-ratio: 1 / 1; object-fit: cover; border-radius: var(--ss-kit-r); }
.muted { opacity: 0.7; font-size: 0.9em; }
.error { color: var(--ss-kit-bad); }
table { width: 100%; border-collapse: collapse; } th, td { text-align: start; padding: 8px 6px; border-top: 1px solid var(--ss-kit-hair); }
:host { display: block; font-family: var(--ss-font-family, inherit); color: var(--ss-color-text, #1f2937); }
:host([data-ss-mode='dark']) { color: var(--ss-color-text, #f3f4f6); }
h2 { font-size: 1.15em; font-weight: 650; margin: 0 0 12px; }
button { margin-top: 12px; }
.row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; } .row > * { flex: 1 1 140px; }
.status { margin: 8px 0 0; font-size: 0.9em; }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 10px 0; border-top: 1px solid var(--ss-kit-hair); overflow-wrap: anywhere; }
.meta { display: block; font-size: 0.8em; opacity: 0.7; }
.amount { font-size: 1.3em; font-weight: 600; margin: 4px 0 8px; }
.details { margin-top: 8px; padding: 10px 12px; border-radius: var(--ss-kit-r); background: var(--ss-kit-soft); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; } .actions button { margin-top: 8px; }
`;
