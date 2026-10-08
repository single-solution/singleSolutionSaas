/**
 * The widgets' CSS, injected into their shadow roots only. Colours, font and corner radius come from the website's
 * theme (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), with fallbacks for light and dark. Usable on phones
 * from 360 px wide.
 * @module
 */
export const WIDGET_CSS = `
:host { display: block; font-family: var(--ss-font-family, inherit); color: var(--ss-color-text, #1f2937); }
:host([data-ss-mode='dark']) { color: var(--ss-color-text, #f3f4f6); }
[hidden] { display: none !important; }
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
button { margin: 12px 8px 0 0; font: inherit; padding: 8px 16px; min-height: 40px; border: 0; border-radius: var(--ss-radius, 8px);
  background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); cursor: pointer; }
button.secondary { background: transparent; color: inherit; border: 1px solid var(--ss-color-border, #d1d5db); }
button.link { background: transparent; color: var(--ss-color-accent, #4f46e5); padding: 8px 0; text-decoration: underline; }
button.danger { background: var(--ss-color-danger, #b91c1c); color: #ffffff; border: 0; }
button.small { padding: 4px 10px; min-height: 32px; margin-top: 6px; font-size: 0.9em; }
button.social { display: block; width: 100%; margin-right: 0; }
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
`;
