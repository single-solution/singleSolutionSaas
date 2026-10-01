/**
 * Mode A default renderer of the `notes` element: a pure function of (state, actions, strings, theme, slots) that
 * returns DOM built with the injected `dom` (the Loader passes `document`). Built only on headless/; styles come from
 * design tokens (CSS variables) — no hard-coded colours or fonts. Keyboard operable, labelled, reduced-motion safe.
 */
import { createTranslator } from '../headless/strings.js';

/** @typedef {import('../headless/notes.js').NotesState} NotesState */
/**
 * @typedef {object} DomLike
 * @property {(tag: string) => any} createElement
 * @property {(text: string) => any} createTextNode
 */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe, no inline scripts). */
export const styles = `
.ss-notes { color: var(--ss-color-text); background: var(--ss-color-surface); border-radius: var(--ss-radius-md);
  padding: var(--ss-space-3); font: var(--ss-font-body); min-height: var(--ss-notes-min-height, 8rem); }
.ss-notes__form { display: flex; gap: var(--ss-space-2); }
.ss-notes__input { flex: 1; border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); padding: var(--ss-space-2); }
.ss-notes__button { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border-radius: var(--ss-radius-sm); }
.ss-notes__button:focus-visible, .ss-notes__input:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-notes__error { color: var(--ss-color-danger); }
.ss-notes--compact .ss-notes__meta { display: none; }
@media (prefers-reduced-motion: reduce) { .ss-notes * { transition: none; } }
`;

/**
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {Array<any>} [children]
 */
const el = (dom, tag, attributes = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
	for (const child of children) node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/**
 * Render the element.
 * @param {{ state: NotesState, actions: ReturnType<typeof import('../headless/notes.js').createNotes>['actions'],
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'compact' ? 'compact' : 'list';
	const input = el(dom, 'input', {
		class: 'ss-notes__input',
		type: 'text',
		name: 'text',
		'aria-label': t('notes.input.label'),
		placeholder: t('notes.input.placeholder'),
	});
	input.value = state.draft;
	input.addEventListener('input', (/** @type {{ target: { value: string } }} */ event) => actions.setDraft(event.target.value));
	const submit = el(dom, 'button', { class: 'ss-notes__button', type: 'submit' }, [t('notes.add')]);
	if (!state.canAdd) submit.setAttribute('disabled', '');
	const form = el(dom, 'form', { class: 'ss-notes__form', 'aria-label': t('notes.form.label') }, [input, submit]);
	form.addEventListener('submit', (/** @type {{ preventDefault: () => void }} */ event) => {
		event.preventDefault();
		actions.add();
	});

	const items = state.notes.map((note) => {
		const pin = el(dom, 'button', { type: 'button', class: 'ss-notes__pin', 'aria-pressed': String(note.pinned) }, [
			note.pinned ? t('notes.unpin') : t('notes.pin'),
		]);
		pin.addEventListener('click', () => actions.togglePin(note.id));
		const remove = el(
			dom,
			'button',
			{ type: 'button', class: 'ss-notes__remove', 'aria-label': t('notes.remove.label', { text: note.text }) },
			[t('notes.remove')],
		);
		remove.addEventListener('click', () => actions.remove(note.id));
		const meta = state.showTimestamps
			? [el(dom, 'time', { class: 'ss-notes__meta', datetime: note.createdAt }, [note.createdAt.slice(0, 10)])]
			: [];
		return el(dom, 'li', { class: 'ss-notes__item' }, [
			el(dom, 'span', { class: 'ss-notes__text' }, [note.text]),
			...meta,
			pin,
			remove,
		]);
	});
	const body =
		state.status === 'ready' && state.notes.length === 0
			? (slots.empty ?? el(dom, 'p', { class: 'ss-notes__empty' }, [t('notes.empty')]))
			: el(dom, 'ul', { class: 'ss-notes__list', 'aria-label': t('notes.list.label') }, items);
	const status = el(
		dom,
		'p',
		{ class: 'ss-notes__error', role: 'status', 'aria-live': 'polite' },
		state.error ? [state.error] : [],
	);
	const loading = state.status === 'loading' ? [el(dom, 'p', { class: 'ss-notes__loading' }, [t('notes.loading')])] : [];

	return el(dom, 'section', { class: `ss-notes ss-notes--${variant}`, role: 'region', 'aria-label': t('notes.title') }, [
		...(slots.before ? [slots.before] : []),
		el(dom, 'h2', { class: 'ss-notes__title' }, [t('notes.title')]),
		form,
		status,
		...loading,
		body,
		...(slots.after ? [slots.after] : []),
	]);
};
