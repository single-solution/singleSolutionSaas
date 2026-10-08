/**
 * The widgets' CSS, injected into their shadow roots only. Colours, font and corner radius come from the website's
 * theme (`--ss-color-<name>`, `--ss-font-family`, `--ss-radius`), with fallbacks for light and dark. Usable on phones
 * from 360 px wide; the visitor chat goes full screen on phones when the merchant chose it.
 * @module
 */
export const WIDGET_CSS = `
:host { display: block; font-family: var(--ss-font-family, inherit); color: var(--ss-color-text, #1f2937);
  --bg: var(--ss-color-background, #ffffff); --line: var(--ss-color-border, #d1d5db); --accent: var(--ss-color-accent, #4f46e5);
  --on-accent: var(--ss-color-onAccent, #ffffff); --soft: var(--ss-color-muted, #f3f4f6); --r: var(--ss-radius, 8px); }
:host([data-ss-mode='dark']) { color: var(--ss-color-text, #f3f4f6); --bg: var(--ss-color-background, #111827);
  --line: var(--ss-color-border, #374151); --soft: var(--ss-color-muted, #1f2937); }
[hidden] { display: none !important; }
.box { border: 1px solid var(--line); border-radius: var(--r); padding: 16px; background: var(--bg); box-sizing: border-box; }
h2 { font-size: 1.1em; margin: 0 0 8px; } h3 { font-size: 1em; margin: 0 0 8px; }
.part { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
label { display: block; font-size: 0.9em; margin: 8px 0 4px; }
textarea, input, select { width: 100%; box-sizing: border-box; font: inherit; color: inherit; background: transparent;
  padding: 8px; border: 1px solid var(--line); border-radius: var(--r); min-height: 40px; }
label.check { display: flex; gap: 8px; align-items: center; } label.check input { width: auto; min-height: 0; }
button { margin: 8px 8px 0 0; font: inherit; padding: 8px 14px; min-height: 40px; border: 0; border-radius: var(--r);
  background: var(--accent); color: var(--on-accent); cursor: pointer; }
button.secondary { background: transparent; color: inherit; border: 1px solid var(--line); }
button.link { background: transparent; color: var(--accent); padding: 4px 0; min-height: 0; margin: 0; text-align: left; }
button.small { padding: 4px 10px; min-height: 32px; font-size: 0.9em; }
button[disabled] { opacity: 0.6; cursor: default; }
button[aria-pressed='true'] { background: var(--accent); color: var(--on-accent); }
a { color: var(--accent); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; } .row > * { flex: 1 1 140px; }
.row > button, .row > label.check { flex: 0 0 auto; }
.status { margin: 8px 0 0; font-size: 0.9em; } .status:empty { display: none; }
.meta { display: block; font-size: 0.8em; opacity: 0.7; }
.tag, .badge { display: inline-block; font-size: 0.75em; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); }
.badge { background: var(--ss-color-danger, #b91c1c); color: #ffffff; border: 0; }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 8px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
p { overflow-wrap: anywhere; }
.chat { position: fixed; bottom: 16px; right: 16px; z-index: 2147483000; display: flex; flex-direction: column;
  align-items: flex-end; gap: 8px; max-width: calc(100vw - 32px); }
.chat[data-position='bottom-left'] { right: auto; left: 16px; align-items: flex-start; }
.launcher { position: relative; margin: 0; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2); }
.launcher.round { width: 56px; height: 56px; border-radius: 50%; padding: 0; }
.launcher svg { width: 26px; height: 26px; fill: currentColor; }
.launcher .badge { position: absolute; top: -4px; right: -4px; }
.nudge { display: flex; gap: 8px; align-items: start; max-width: 280px; padding: 12px; background: var(--bg);
  border: 1px solid var(--line); border-radius: var(--r); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15); }
.window { display: flex; flex-direction: column; width: 360px; max-width: 100%; height: min(600px, calc(100vh - 104px));
  background: var(--bg); border: 1px solid var(--line); border-radius: var(--r); box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2); overflow: hidden; }
.chat[data-style='side_panel'] .window { position: fixed; top: 0; bottom: 0; right: 0; height: auto; width: 400px; border-radius: 0; }
.chat[data-style='side_panel'][data-position='bottom-left'] .window { right: auto; left: 0; }
.head { display: flex; align-items: center; gap: 8px; padding: 12px; background: var(--accent); color: var(--on-accent); }
.head .name { flex: 1; } .head .close { color: inherit; }
.avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; display: inline-grid; place-items: center;
  background: var(--on-accent); color: var(--accent); font-weight: 600; }
.window .log { flex: 1; overflow-y: auto; padding: 8px 12px; }
.msg { border: 0; padding: 4px 0; display: flex; flex-direction: column; align-items: flex-start; }
.msg p { margin: 0; padding: 8px 12px; border-radius: var(--r); background: var(--soft); max-width: 85%; white-space: pre-wrap; }
.msg.visitor { align-items: flex-end; } .msg.visitor p { background: var(--accent); color: var(--on-accent); }
.msg.system p { background: transparent; font-size: 0.85em; opacity: 0.8; }
.msg.note p { border: 1px dashed var(--line); background: transparent; }
.msg img { max-width: 220px; border-radius: var(--r); margin-top: 4px; }
.who { font-size: 0.8em; opacity: 0.8; margin-bottom: 2px; }
.typing { margin: 0 12px; font-size: 0.85em; opacity: 0.7; }
.notices, .slot, .tools { padding: 0 12px; } .notice { margin: 8px 0; font-size: 0.9em; }
.tools { display: flex; flex-wrap: wrap; } .ask { margin: 0 0 4px; }
.choices { display: flex; flex-wrap: wrap; }
.composer { display: flex; gap: 8px; align-items: end; padding: 8px 12px; border-top: 1px solid var(--line); }
.composer textarea { flex: 1; resize: none; } .composer button { margin: 0; }
.window > .status { padding: 0 12px 8px; }
@media (max-width: 480px) {
  .chat[data-full] .window { position: fixed; inset: 0; width: 100%; height: 100%; border-radius: 0; }
}
.conversations li.unread > button { font-weight: 700; }
.facts li { padding: 4px 0; border: 0; }
.numbers { display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; } .numbers dd { margin: 0; font-weight: 600; }
.bars li { display: grid; grid-template-columns: 96px 1fr 48px; gap: 8px; align-items: center; padding: 2px 0; border: 0; }
.bars .bar { display: block; height: 10px; min-width: 2px; background: var(--accent); border-radius: var(--r); }
.bars li.meta { display: block; }
`;
