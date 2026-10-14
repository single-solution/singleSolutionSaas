/**
 * The visitor widget `role_request` (Role requests, PLAN 0.8.10 A5): a visitor without an account asks for a role the
 * merchant offers (for example membership) with their name, phone number or email address and a note; staff answer
 * in the Users admin widget.
 * @module
 */
import { mountWidget } from '@ss/app-kit/widget';
import { datesOf, errorText, fieldMaker, say, textsOf } from './common.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';

/**
 * @param {{ host: HTMLElement, win: Window, config: import('./widget.js').WidgetConfig,
 *   call: import('./session.js').Session['call'] }} input `call`: a visitor call with the browser token
 */
export const mountRoleRequest = ({ host, win, config, call }) => {
	const t = textsOf(config);
	const when = datesOf(config, win);
	const offer = config.settings.roleRequests;
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const make = fieldMaker(doc, 'ss-request');
			const box = element(doc, 'section', { class: 'box' });
			const form = element(doc, 'form', { class: 'grid' });
			const role = make.field('select', t('request.role'));
			role.input.append(...(offer?.roles ?? []).map((each) => element(doc, 'option', { value: each.key }, each.name)));
			const name = make.field('input', t('fields.name'), { autocomplete: 'name', maxlength: '120', required: '' });
			const phone = make.field('input', t('fields.phone'), { type: 'tel', autocomplete: 'tel', maxlength: '40' });
			const email = make.field('input', t('fields.email'), { type: 'email', autocomplete: 'email', maxlength: '254' });
			const note = make.field('textarea', t('request.note'), {
				rows: '3',
				maxlength: '1000',
				...(offer?.requireNote ? { required: '' } : {}),
			});
			note.wrap.classList.add('wide');
			const submit = element(doc, 'button', { type: 'submit' }, t('request.submit'));
			const status = element(doc, 'p', { class: 'status wide', role: 'status' });
			form.append(
				...((offer?.roles.length ?? 0) > 1 ? [role.wrap] : []),
				name.wrap,
				phone.wrap,
				email.wrap,
				note.wrap,
				submit,
				status,
			);
			box.append(element(doc, 'h2', {}, t('request.title')), form);
			root.append(box);
			form.addEventListener('submit', async (event) => {
				event.preventDefault();
				submit.setAttribute('disabled', '');
				const answer = await call('POST', '/v1/role-requests', {
					role: role.input.value,
					name: name.input.value.trim(),
					...(phone.input.value.trim() ? { phone: phone.input.value.trim() } : {}),
					...(email.input.value.trim() ? { email: email.input.value.trim() } : {}),
					note: note.input.value.trim(),
				});
				submit.removeAttribute('disabled');
				if (answer.ok) form.replaceChildren(element(doc, 'p', { class: 'wide' }, t('request.sent')));
				else say(status, errorText(t, answer, when));
			});
		},
	});
};
