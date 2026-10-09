/**
 * Entry of the widget bundle (`ss app assets` → `server/widget-script.js`, served as /widget.js). It runs once while the
 * script loads, so `document.currentScript` is this script tag (its `data-token`, if any, is the browser token).
 * @module
 */
import { startWidget } from './widget.js';

startWidget({ window, script: /** @type {HTMLScriptElement | null} */ (document.currentScript) });
