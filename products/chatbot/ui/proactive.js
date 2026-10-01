/**
 * Mode A default renderer of `proactive` messages: a small teaser bubble near the launcher with the message, a reply
 * button (opens the chat) and a dismiss button. Built only on headless/proactive.js; tokens only; announced politely.
 * @module
 */
import { createTranslator } from '../headless/strings.js';
import { el, richText } from './notes.js';

/** @typedef {import('../headless/proactive.js').ProactiveState} ProactiveState */

/** Token-only stylesheet. */
export const styles = `
.ss-teaser { position: fixed; inset-block-end: var(--ss-teaser-y, 88px); inset-inline-end: var(--ss-launcher-x, 20px);
  max-inline-size: min(320px, calc(100vw - 40px)); padding: var(--ss-space-3); border-radius: var(--ss-radius-lg);
  background: var(--ss-color-surface); color: var(--ss-color-text); box-shadow: var(--ss-shadow-md); font: var(--ss-font-body);
  z-index: var(--ss-z-overlay, 2147483000); }
.ss-teaser[hidden] { display: none; }
.ss-teaser__actions { display: flex; gap: var(--ss-space-2); justify-content: flex-end; margin-block-start: var(--ss-space-2); }
.ss-teaser__reply { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border: 0; border-radius: var(--ss-radius-sm); padding: var(--ss-space-1) var(--ss-space-2); cursor: pointer; }
.ss-teaser__dismiss { background: transparent; color: var(--ss-color-text-muted); border: 0; cursor: pointer; }
.ss-teaser button:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-chat__line { margin: 0; }
@media (prefers-reduced-motion: reduce) { .ss-teaser, .ss-teaser * { transition: none; animation: none; } }
`;

/**
 * @param {{ state: ProactiveState, actions: { reply: () => Promise<unknown>, dismiss: () => Promise<unknown> }, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./notes.js').DomLike }} params
 */
export const render = ({ state, actions, strings, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const reply = el(dom, 'button', { type: 'button', class: 'ss-teaser__reply' }, [t('proactive.reply')]);
	reply.addEventListener('click', () => actions.reply());
	const dismiss = el(dom, 'button', { type: 'button', class: 'ss-teaser__dismiss', 'aria-label': t('proactive.dismiss') }, [
		'×',
	]);
	dismiss.addEventListener('click', () => actions.dismiss());
	const root = el(
		dom,
		'aside',
		{ class: 'ss-teaser', role: 'status', 'aria-live': 'polite', 'aria-label': t('proactive.label') },
		[
			slots.before ?? null,
			...(state.message ? richText(dom, state.message.message) : []),
			el(dom, 'div', { class: 'ss-teaser__actions' }, [dismiss, reply]),
			slots.after ?? null,
		],
	);
	if (state.status !== 'shown' || !state.message) root.setAttribute('hidden', '');
	return root;
};
