/**
 * The admin widget `send_message` (permission `messages.send`): a member of the merchant's staff sends a one-off
 * message by e-mail, SMS or WhatsApp to one person. It is a required, urgent message (it ignores unsubscribes and quiet
 * hours, never send limits) and is kept in the delivery log like every other.
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig }} input
 */
export const mountSendMessage = ({ host, api, config }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const channels = ['email', 'sms', 'whatsapp'].filter((channel) => config.features.includes(channel));
			const channel = /** @type {HTMLSelectElement} */ (element(doc, 'select', { id: 'send-channel' }));
			channel.append(...channels.map((value) => element(doc, 'option', { value }, t(`channel.${value}`))));
			const to = /** @type {HTMLInputElement} */ (
				element(doc, 'input', { id: 'send-to', autocomplete: 'off', maxlength: '254' })
			);
			const subject = /** @type {HTMLInputElement} */ (element(doc, 'input', { id: 'send-subject', maxlength: '200' }));
			const subjectLabel = element(doc, 'label', { for: 'send-subject' }, t('send.subject'));
			const text = /** @type {HTMLTextAreaElement} */ (
				element(doc, 'textarea', { id: 'send-text', rows: '5', maxlength: '4096' })
			);
			const button = element(doc, 'button', { type: 'submit' }, t('send.submit'));
			const note = element(doc, 'p', { class: 'status', role: 'status' });
			const form = element(doc, 'form', { class: 'box' });
			form.append(
				element(doc, 'h2', {}, t('send.title')),
				element(doc, 'label', { for: 'send-channel' }, t('send.channel')),
				channel,
				element(doc, 'label', { for: 'send-to' }, t('send.to')),
				to,
				subjectLabel,
				subject,
				element(doc, 'label', { for: 'send-text' }, t('send.text')),
				text,
				button,
				note,
			);
			root.append(form);
			const showSubject = () => {
				const email = channel.value === 'email';
				for (const node of [subject, subjectLabel]) {
					if (email) node.removeAttribute('hidden');
					else node.setAttribute('hidden', '');
				}
			};
			channel.addEventListener('change', showSubject);
			showSubject();

			form.addEventListener('submit', async (event) => {
				event.preventDefault();
				if (!api.tickets.current()) {
					note.textContent = t('send.signedOut');
					return;
				}
				button.setAttribute('disabled', '');
				note.textContent = t('send.sending');
				const answer = await adminCall(api, 'POST', '/v1/admin/messages', {
					channel: channel.value,
					to: to.value.trim(),
					...(channel.value === 'email' ? { subject: subject.value } : {}),
					text: text.value,
				});
				button.removeAttribute('disabled');
				if (!answer.ok) {
					note.textContent = answer.data?.detail
						? formatText(t('send.notSent'), { reason: answer.data.detail })
						: t('send.failed');
					return;
				}
				const message = answer.data;
				if (message.status === 'sent') {
					note.textContent = t('send.done');
					/** @type {HTMLFormElement} */ (form).reset();
					showSubject();
				} else if (message.status === 'queued' || message.status === 'retrying') note.textContent = t('send.later');
				else note.textContent = formatText(t('send.notSent'), { reason: message.reason ?? message.status });
			});
			return undefined;
		},
	});
};
