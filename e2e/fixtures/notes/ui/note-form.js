/**
 * The visitor widget `note_form`: a visitor writes a note (and an optional e-mail) and sends it with the browser
 * token.
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { checkNote } from '../core/notes.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';

/**
 * @param {{ host: HTMLElement, base: string, token: string, config: import('./widget.js').WidgetConfig,
 *   fetch: typeof fetch }} input
 */
export const mountNoteForm = ({ host, base, token, config, fetch }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const form = element(doc, 'form', { class: 'box' });
			const text = element(doc, 'textarea', { id: 'note-text', rows: '4', maxlength: String(config.settings.maxLength) });
			const email = element(doc, 'input', { id: 'note-email', type: 'email', autocomplete: 'email' });
			const button = element(doc, 'button', { type: 'submit' }, t('form.submit'));
			const status = element(doc, 'p', { class: 'status', role: 'status' });
			form.append(
				element(doc, 'h2', {}, t('form.title')),
				element(doc, 'label', { for: 'note-text' }, t('form.text')),
				text,
				element(doc, 'label', { for: 'note-email' }, t('form.email')),
				email,
				button,
				status,
			);
			root.append(form);
			form.addEventListener('submit', async (event) => {
				event.preventDefault();
				const input = {
					text: /** @type {HTMLTextAreaElement} */ (text).value,
					email: /** @type {HTMLInputElement} */ (email).value,
				};
				const checked = checkNote(input, { maxLength: config.settings.maxLength });
				if (!checked.ok) {
					status.textContent =
						checked.error === 'empty'
							? t('form.empty')
							: checked.error === 'too_long'
								? formatText(t('form.tooLong'), { max: checked.max })
								: t('form.badEmail');
					return;
				}
				button.setAttribute('disabled', '');
				status.textContent = t('form.sending');
				try {
					const response = await fetch(`${base}/v1/notes`, {
						method: 'POST',
						headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
						body: JSON.stringify(checked.value),
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					/** @type {HTMLFormElement} */ (form).reset();
					status.textContent = t('form.sent');
				} catch {
					status.textContent = t('form.failed');
				}
				button.removeAttribute('disabled');
			});
		},
	});
};
