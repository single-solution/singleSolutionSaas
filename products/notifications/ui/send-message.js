/**
 * The admin widget `send_message` (permission `messages.send`): a member of the merchant's staff sends a one-off
 * message by email, SMS, WhatsApp, browser push (to a subscriber id) or staff push (to a staff user id) to one person,
 * as transactional (required and urgent: it ignores unsubscribes and quiet hours) or marketing (optional: unsubscribes,
 * quiet hours and send limits apply), fixed-choices N9. It is kept in the delivery log like every other. A refused
 * call or a message that was not sent shows the website's words for why, never the server's English.
 * @module
 */
import { adminCall, element, formatText, mountWidget } from '@ss/app-kit/widget';
import { notSentText, problemText } from './problems.js';
import { WIDGET_CSS } from './styles.js';

/** Each channel and the feature that switches it on. */
const CHANNEL_FEATURES = Object.freeze({
	email: 'email',
	sms: 'sms',
	whatsapp: 'whatsapp',
	push: 'browser_push',
	staff_push: 'staff_push',
});
/** Channels with a subject (email) or title (push). */
const TITLED = Object.freeze(['email', 'push', 'staff_push']);
/** The text naming who a channel sends to. */
const TO_TEXT = Object.freeze({
	email: 'send.to',
	sms: 'send.to',
	whatsapp: 'send.to',
	push: 'send.toPush',
	staff_push: 'send.toStaff',
});

/**
 * @param {{ host: HTMLElement, api: import('@ss/app-kit/widget').AdminApi, config: import('./widget.js').WidgetConfig }} input
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
			const channels = /** @type {Array<keyof typeof CHANNEL_FEATURES>} */ (Object.keys(CHANNEL_FEATURES)).filter((channel) =>
				config.features.includes(CHANNEL_FEATURES[channel]),
			);
			const channel = /** @type {HTMLSelectElement} */ (element(doc, 'select', { id: 'send-channel' }));
			channel.append(...channels.map((value) => element(doc, 'option', { value }, t(`channel.${value}`))));
			const kind = /** @type {HTMLSelectElement} */ (element(doc, 'select', { id: 'send-kind' }));
			kind.append(
				...['transactional', 'marketing'].map((value) => element(doc, 'option', { value }, t(`send.kind.${value}`))),
			);
			const to = /** @type {HTMLInputElement} */ (
				element(doc, 'input', { id: 'send-to', autocomplete: 'off', maxlength: '254' })
			);
			const toLabel = element(doc, 'label', { for: 'send-to' }, t('send.to'));
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
				element(doc, 'label', { for: 'send-kind' }, t('send.kind')),
				kind,
				toLabel,
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
				const titled = TITLED.includes(channel.value);
				for (const node of [subject, subjectLabel]) {
					if (titled) node.removeAttribute('hidden');
					else node.setAttribute('hidden', '');
				}
				toLabel.textContent = t(TO_TEXT[/** @type {keyof typeof TO_TEXT} */ (channel.value)] ?? 'send.to');
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
					kind: kind.value,
					...(TITLED.includes(channel.value) ? { subject: subject.value } : {}),
					text: text.value,
				});
				button.removeAttribute('disabled');
				if (!answer.ok) {
					note.textContent = formatText(t('send.notSent'), { reason: problemText(config.texts, answer) });
					return;
				}
				const message = answer.data;
				if (message.status === 'sent') {
					note.textContent = t('send.done');
					/** @type {HTMLFormElement} */ (form).reset();
					showSubject();
				} else if (message.status === 'queued' || message.status === 'retrying') note.textContent = t('send.later');
				else note.textContent = formatText(t('send.notSent'), { reason: notSentText(config.texts, message) });
			});
			return undefined;
		},
	});
};
