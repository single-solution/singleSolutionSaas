/**
 * Mode A default renderer of the chat `window`: a pure function of (state, actions, strings, theme, slots) returning
 * DOM built with the injected `dom` (the Loader passes `document`). Built only on headless/window.js; design tokens
 * only (no colour literals); keyboard operable (Escape closes, Enter sends, Shift+Enter breaks a line), labelled
 * dialog, polite live region for new messages, reduced-motion safe, RTL-aware (`dir` from the catalog), and it
 * reserves its height so mounting causes no layout shift. Variants: `bubble`, `side_panel`, `full_screen_mobile`.
 * @module
 */
import { createTranslator } from '../headless/strings.js';
import { el, notice, richText } from './notes.js';

/** @typedef {import('../headless/window.js').WindowState} WindowState */
/** @typedef {import('./notes.js').DomLike} DomLike */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-chat { position: fixed; inset-block-end: var(--ss-chat-offset-y, 88px); inset-inline-end: var(--ss-chat-offset-x, 20px);
  inline-size: min(380px, calc(100vw - 2 * var(--ss-space-3))); block-size: min(600px, calc(100vh - 120px));
  display: flex; flex-direction: column; color: var(--ss-color-text); background: var(--ss-color-surface);
  border-radius: var(--ss-radius-lg); box-shadow: var(--ss-shadow-lg); font: var(--ss-font-body); overflow: hidden;
  z-index: var(--ss-z-overlay, 2147483000); }
.ss-chat[hidden] { display: none; }
.ss-chat--side_panel { inset-block: 0; inset-inline-end: 0; block-size: 100vh; border-radius: 0; }
@media (max-width: 640px) { .ss-chat--full_screen_mobile { inset: 0; inline-size: 100vw; block-size: 100dvh; border-radius: 0; } }
.ss-chat__header { display: flex; align-items: center; gap: var(--ss-space-2); padding: var(--ss-space-3);
  background: var(--ss-color-primary); color: var(--ss-color-on-primary); }
.ss-chat__avatar { inline-size: 2rem; block-size: 2rem; border-radius: 50%; object-fit: cover; }
.ss-chat__titles { flex: 1; min-inline-size: 0; }
.ss-chat__title { margin: 0; font-size: var(--ss-font-size-md, 1rem); font-weight: var(--ss-font-weight-bold, 700); }
.ss-chat__status { margin: 0; font-size: var(--ss-font-size-sm, .85rem); opacity: .85; }
.ss-chat__icon-button { background: transparent; color: inherit; border: 0; border-radius: var(--ss-radius-sm); padding: var(--ss-space-1); cursor: pointer; }
.ss-chat__log { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: var(--ss-space-3); display: flex; flex-direction: column; gap: var(--ss-space-2); }
.ss-chat__message { max-inline-size: 85%; padding: var(--ss-space-2) var(--ss-space-3); border-radius: var(--ss-radius-md); background: var(--ss-color-surface-2); }
.ss-chat__message--customer { align-self: flex-end; background: var(--ss-color-primary); color: var(--ss-color-on-primary); }
.ss-chat__message--grouped { margin-block-start: calc(-1 * var(--ss-space-1)); }
.ss-chat__author { display: block; font-size: var(--ss-font-size-xs, .75rem); color: var(--ss-color-text-muted); }
.ss-chat__line { margin: 0; overflow-wrap: anywhere; }
.ss-chat__line a { color: inherit; text-decoration: underline; }
.ss-chat__notice { align-self: center; color: var(--ss-color-text-muted); font-size: var(--ss-font-size-sm, .85rem); text-align: center; }
.ss-chat__quick { display: flex; flex-wrap: wrap; gap: var(--ss-space-1); padding: 0 var(--ss-space-3) var(--ss-space-2); }
.ss-chat__chip { border: 1px solid var(--ss-color-primary); color: var(--ss-color-primary); background: var(--ss-color-surface);
  border-radius: var(--ss-radius-full, 999px); padding: var(--ss-space-1) var(--ss-space-2); cursor: pointer; }
.ss-chat__form, .ss-chat__survey { display: grid; gap: var(--ss-space-2); padding: var(--ss-space-3); border-block-start: 1px solid var(--ss-color-border); }
.ss-chat__field { display: grid; gap: var(--ss-space-1); }
.ss-chat__input { border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); padding: var(--ss-space-2); font: inherit; color: inherit; background: var(--ss-color-surface); }
.ss-chat__composer { display: flex; gap: var(--ss-space-2); padding: var(--ss-space-2) var(--ss-space-3); border-block-start: 1px solid var(--ss-color-border); }
.ss-chat__composer textarea { flex: 1; resize: none; }
.ss-chat__send { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border: 0; border-radius: var(--ss-radius-sm); padding: 0 var(--ss-space-3); cursor: pointer; }
.ss-chat button:focus-visible, .ss-chat textarea:focus-visible, .ss-chat input:focus-visible, .ss-chat select:focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-chat__error { color: var(--ss-color-danger); margin: 0; padding: 0 var(--ss-space-3); }
.ss-chat__typing { color: var(--ss-color-text-muted); font-style: italic; }
.ss-chat__visually-hidden { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .ss-chat, .ss-chat * { transition: none; animation: none; scroll-behavior: auto; } }
`;

/**
 * @param {DomLike} dom
 * @param {Record<string, any>} field
 * @param {(key: string) => string} t
 */
const fieldControl = (dom, field, t) => {
	const id = `ss-chat-field-${field.name}`;
	const label = field.label || t(`lead.field.${field.name}`);
	/** @type {any} */
	let control;
	/** @type {Record<string, string>} */
	const required = field.required ? { required: '', 'aria-required': 'true' } : {};
	if (field.type === 'textarea')
		control = el(dom, 'textarea', { id, name: field.name, rows: '3', class: 'ss-chat__input', ...required });
	else if (field.type === 'select')
		control = el(
			dom,
			'select',
			{ id, name: field.name, class: 'ss-chat__input', ...required },
			(field.options ?? []).map((/** @type {string} */ option) => el(dom, 'option', { value: option }, [option])),
		);
	else
		control = el(
			dom,
			'input',
			/** @type {Record<string, string>} */ ({
				id,
				name: field.name,
				class: 'ss-chat__input',
				type:
					{ email: 'email', phone: 'tel', number: 'number', date: 'date', checkbox: 'checkbox' }[
						/** @type {string} */ (field.type)
					] ?? 'text',
				...(field.type === 'email' ? { autocomplete: 'email' } : field.type === 'phone' ? { autocomplete: 'tel' } : {}),
				...required,
			}),
		);
	return { control, node: el(dom, 'label', { class: 'ss-chat__field', for: id }, [label, control]) };
};

/**
 * Render the window.
 * @param {{ state: WindowState, actions: Record<string, (...args: any[]) => Promise<unknown>>, strings: Record<string, string>,
 *   theme?: { variant?: string, avatarUrl?: string, online?: boolean }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any}
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = ['side_panel', 'full_screen_mobile'].includes(String(theme.variant)) ? String(theme.variant) : 'bubble';
	const titleId = 'ss-chat-title';

	const close = el(dom, 'button', { type: 'button', class: 'ss-chat__icon-button', 'aria-label': t('window.close') }, ['×']);
	close.addEventListener('click', () => actions.close?.());
	const header = el(dom, 'header', { class: 'ss-chat__header' }, [
		theme.avatarUrl ? el(dom, 'img', { class: 'ss-chat__avatar', src: theme.avatarUrl, alt: '' }) : null,
		el(dom, 'div', { class: 'ss-chat__titles' }, [
			el(dom, 'h2', { class: 'ss-chat__title', id: titleId }, [t('window.title')]),
			el(dom, 'p', { class: 'ss-chat__status' }, [
				state.humanRequested
					? t('window.human_requested')
					: t(theme.online === false ? 'window.status.offline' : 'window.status.online'),
			]),
		]),
		slots.header ?? null,
		close,
	]);

	/** @type {any[]} */
	const items = [];
	if (state.hasMoreOlder) {
		const older = el(dom, 'button', { type: 'button', class: 'ss-chat__chip' }, [t('window.load_older')]);
		if (state.loadingOlder) older.setAttribute('disabled', '');
		older.addEventListener('click', () => actions.loadOlder?.());
		items.push(el(dom, 'li', { class: 'ss-chat__notice' }, [older]));
	}
	if (state.messages.length === 0 && state.status !== 'loading')
		items.push(slots.empty ?? el(dom, 'li', { class: 'ss-chat__notice' }, [t('window.empty')]));
	for (const message of state.messages) {
		if (message.author === 'system' || message.kind === 'event') {
			items.push(notice(dom, message.text));
			continue;
		}
		const classes = [
			'ss-chat__message',
			`ss-chat__message--${message.author}`,
			...(message.grouped ? ['ss-chat__message--grouped'] : []),
		];
		items.push(
			el(dom, 'li', { class: classes.join(' '), 'data-id': message.id }, [
				message.grouped ? null : el(dom, 'span', { class: 'ss-chat__author' }, [message.label ?? message.author]),
				...richText(dom, message.text),
				el(dom, 'time', { class: 'ss-chat__visually-hidden', datetime: message.at }, [message.at.slice(11, 16)]),
			]),
		);
	}
	if (state.typing) items.push(el(dom, 'li', { class: 'ss-chat__typing', 'aria-live': 'polite' }, [t('window.typing')]));
	const log = el(
		dom,
		'ol',
		{
			class: 'ss-chat__log',
			role: 'log',
			'aria-live': 'polite',
			'aria-label': t('window.messages.label'),
			'aria-busy': String(state.status === 'loading'),
		},
		[slots.before_messages ?? null, ...items, slots.after_messages ?? null],
	);

	/** @type {any[]} */
	const parts = [header, log];
	if (state.quickReplies.length > 0)
		parts.push(
			el(
				dom,
				'div',
				{ class: 'ss-chat__quick', role: 'group' },
				state.quickReplies.map((reply) => {
					const chip = el(dom, 'button', { type: 'button', class: 'ss-chat__chip' }, [reply.label]);
					chip.addEventListener('click', () => actions.choose?.(reply));
					return chip;
				}),
			),
		);

	if (state.form) {
		const controls = state.form.fields.map((field) => ({ field, ...fieldControl(dom, field, t) }));
		const consent =
			state.form.kind === 'lead'
				? fieldControl(dom, { name: 'consent', type: 'checkbox', label: t('window.form.consent') }, t)
				: null;
		const submit = el(dom, 'button', { type: 'submit', class: 'ss-chat__send' }, [t('window.form.submit')]);
		const form = el(dom, 'form', { class: 'ss-chat__form', 'aria-label': state.form.text || t('lead.title'), novalidate: '' }, [
			state.form.text ? el(dom, 'p', { class: 'ss-chat__line' }, [state.form.text]) : null,
			...controls.map((c) => c.node),
			consent?.node ?? null,
			submit,
		]);
		form.addEventListener('submit', (/** @type {any} */ event) => {
			event?.preventDefault?.();
			/** @type {Record<string, unknown>} */
			const values = {};
			for (const c of controls) {
				const raw = c.field.type === 'checkbox' ? Boolean(c.control.checked) : c.control.value;
				if (raw !== '' && raw !== undefined)
					values[c.field.name] = c.field.type === 'number' && raw !== '' ? Number(raw) : raw;
			}
			void actions.submitForm?.(values, { consent: Boolean(consent?.control.checked) });
		});
		parts.push(form);
	}

	if (state.survey) {
		const scale = state.survey.scale;
		const comment = state.survey.comment
			? el(dom, 'textarea', {
					class: 'ss-chat__input',
					rows: '2',
					'aria-label': t('window.csat.comment'),
					placeholder: t('window.csat.comment'),
				})
			: null;
		const buttons = Array.from({ length: scale }, (_, i) => {
			const button = el(
				dom,
				'button',
				{ type: 'button', class: 'ss-chat__chip', 'aria-label': t('window.csat.score', { score: i + 1, scale }) },
				[String(i + 1)],
			);
			button.addEventListener('click', () => actions.rate?.(i + 1, comment?.value || undefined));
			return button;
		});
		parts.push(
			el(dom, 'div', { class: 'ss-chat__survey', role: 'group', 'aria-label': t('window.csat.title') }, [
				el(dom, 'p', { class: 'ss-chat__line' }, [t('window.csat.title')]),
				el(dom, 'div', { class: 'ss-chat__quick' }, buttons),
				comment,
			]),
		);
	} else if (state.rated) parts.push(el(dom, 'p', { class: 'ss-chat__notice', role: 'status' }, [t('window.csat.thanks')]));

	parts.push(el(dom, 'p', { class: 'ss-chat__error', role: 'alert' }, state.error ? [state.error] : []));

	const closed = state.conversation?.status === 'closed';
	if (closed || state.guestLimitReached) {
		const fresh = el(dom, 'button', { type: 'button', class: 'ss-chat__chip' }, [t('window.new_conversation')]);
		fresh.addEventListener('click', () => actions.newConversation?.());
		parts.push(el(dom, 'div', { class: 'ss-chat__quick' }, [closed ? fresh : null]));
	} else {
		const input = el(dom, 'textarea', {
			class: 'ss-chat__input',
			rows: '1',
			'aria-label': t('window.input.label'),
			placeholder: t('window.input.placeholder'),
			maxlength: String(4000),
		});
		input.value = state.draft;
		input.addEventListener('input', (/** @type {any} */ event) => actions.setDraft?.(event?.target?.value ?? input.value));
		input.addEventListener('keydown', (/** @type {any} */ event) => {
			if (event?.key === 'Enter' && !event.shiftKey) {
				event.preventDefault?.();
				void actions.send?.(input.value);
			}
		});
		const send = el(dom, 'button', { type: 'button', class: 'ss-chat__send' }, [t('window.send')]);
		if (state.sending) send.setAttribute('disabled', '');
		send.addEventListener('click', () => actions.send?.(input.value));
		parts.push(el(dom, 'div', { class: 'ss-chat__composer' }, [input, send]));
	}
	if (slots.footer) parts.push(slots.footer);

	const root = el(
		dom,
		'section',
		{
			class: `ss-chat ss-chat--${variant}`,
			role: 'dialog',
			'aria-modal': 'false',
			'aria-labelledby': titleId,
			dir: strings['window.dir'] === 'rtl' ? 'rtl' : 'ltr',
			lang: strings['window.locale'] ?? 'en',
		},
		parts,
	);
	if (!state.open) root.setAttribute('hidden', '');
	root.addEventListener('keydown', (/** @type {any} */ event) => {
		if (event?.key === 'Escape') void actions.close?.();
	});
	return root;
};
