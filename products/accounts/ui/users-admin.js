/**
 * The admin widget `users_admin` (Roles; permissions `users.read` and `users.manage`): the merchant's staff search the
 * user list (by text, role, status, asked to be deleted), open a user to change the name, role, notes and blocked flag,
 * sign them out everywhere, approve or decline sign-ups waiting for approval, invite people (Approval / invite) and
 * approve or reject deletion requests (Data rights).
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { datesOf, errorText, fieldMaker, textsOf } from './common.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig }} input
 */
export const mountUsersAdmin = ({ host, api, config }) => {
	const t = textsOf(config);
	// dates in the website's Format and business time zone, for this browser (PLAN 0.8.10 K7)
	const when = datesOf(config, host.ownerDocument.defaultView);
	/** @param {string} feature */
	const on = (feature) => config.features.includes(feature);
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const make = fieldMaker(doc, 'ss-users');
			/** @type {Array<{ key: string, name: string }>} */
			let roles = [];
			/** @type {string | null} */
			let cursor = null;
			/** @type {HTMLElement[]} the role selects of the filters and the invite form */
			const roleSelects = [];

			/** @param {string} text @param {Record<string, string>} [attributes] */
			const button = (text, attributes = {}) => element(doc, 'button', { type: 'button', ...attributes }, text);
			/** @param {string} key */
			const roleName = (key) => roles.find((role) => role.key === key)?.name ?? key;
			/** @param {Record<string, any>} user */
			const statusOf = (user) => (user.blocked ? 'blocked' : String(user.status ?? 'active'));
			/** @param {import('./common.js').Answer} answer */
			const failure = (answer) =>
				answer.status === 0 && !api.tickets.current() ? t('users.signedOut') : errorText(t, answer, when);
			/** A role select; `all` adds "All roles". @param {string} label @param {boolean} all */
			const roleSelect = (label, all) => {
				const made = make.field('select', label);
				made.input.dataset.all = all ? '1' : '';
				return made;
			};
			/** @param {HTMLElement} select */
			const fillSelect = (select) => {
				const field = /** @type {HTMLSelectElement} */ (select);
				const keep = field.value;
				field.replaceChildren(
					...(field.dataset.all ? [element(doc, 'option', { value: '' }, t('users.allRoles'))] : []),
					...roles.map((each) => element(doc, 'option', { value: each.key }, each.name)),
				);
				if (keep) field.value = keep;
			};
			const fillRoles = () => {
				for (const select of roleSelects) fillSelect(select);
			};

			// filters
			const filters = element(doc, 'form', { class: 'row' });
			const q = make.field('input', t('users.search'), { type: 'search', maxlength: '200' });
			const role = roleSelect(t('users.role'), true);
			roleSelects.push(role.input);
			const status = make.field('select', t('users.status'));
			status.input.append(
				element(doc, 'option', { value: '' }, t('users.allStatuses')),
				...['active', ...(on('approval') ? ['pending', 'invited'] : []), 'blocked'].map((value) =>
					element(doc, 'option', { value }, t(`status.${value}`)),
				),
			);
			const deletion = make.check(t('users.deletionOnly'));
			const search = element(doc, 'button', { type: 'submit' }, t('users.searchButton'));
			filters.append(q.wrap, role.wrap, status.wrap, ...(on('data_rights') ? [deletion.wrap] : []), search);

			const note = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const more = button(t('users.more'), { class: 'secondary', hidden: '' });
			const detail = element(doc, 'div');
			const box = element(doc, 'section', { class: 'box' });
			box.append(element(doc, 'h2', {}, t('users.title')), filters, note, list, more, detail);

			// invites
			if (on('approval')) {
				const form = element(doc, 'form', { class: 'part' });
				const contact = make.field('input', t('users.inviteContact'), { maxlength: '254', required: '' });
				const name = make.field('input', t('fields.name'), { maxlength: '120' });
				const inviteRole = roleSelect(t('users.role'), false);
				roleSelects.push(inviteRole.input);
				const send = element(doc, 'button', { type: 'submit' }, t('users.inviteSend'));
				const inviteNote = element(doc, 'p', { class: 'status', role: 'status' });
				form.append(
					element(doc, 'h3', {}, t('users.inviteTitle')),
					contact.wrap,
					name.wrap,
					inviteRole.wrap,
					send,
					inviteNote,
				);
				form.addEventListener('submit', async (event) => {
					event.preventDefault();
					const value = contact.input.value.trim();
					send.setAttribute('disabled', '');
					const answer = await adminCall(api, 'POST', '/v1/admin/users/invite', {
						...(value.includes('@') ? { email: value } : { phone: value }),
						...(name.input.value.trim() ? { name: name.input.value.trim() } : {}),
						role: inviteRole.input.value,
					});
					send.removeAttribute('disabled');
					inviteNote.textContent = answer.ok ? formatText(t('users.invited'), { to: value }) : failure(answer);
					if (answer.ok) {
						/** @type {HTMLFormElement} */ (form).reset();
						await load(true);
					}
				});
				box.append(form);
			}
			root.append(box);

			/** @param {boolean} reset */
			const load = async (reset) => {
				const query = new URLSearchParams({ limit: '25' });
				if (q.input.value.trim()) query.set('q', q.input.value.trim());
				if (role.input.value) query.set('role', role.input.value);
				if (status.input.value) query.set('status', status.input.value);
				if (deletion.input.checked) query.set('deletion', '1');
				if (!reset && cursor) query.set('cursor', cursor);
				const answer = await adminCall(api, 'GET', `/v1/admin/users?${query.toString()}`);
				if (reset) list.replaceChildren();
				if (!answer.ok) {
					note.textContent = failure(answer);
					more.setAttribute('hidden', '');
					return;
				}
				/** @type {Array<Record<string, any>>} */
				const items = answer.data.items;
				cursor = answer.data.nextCursor;
				note.textContent = reset && items.length === 0 ? t('users.empty') : '';
				for (const user of items) {
					const item = element(doc, 'li', {}, user.name || user.email || user.phone || user.id);
					item.append(
						element(
							doc,
							'span',
							{ class: 'meta' },
							[
								user.name ? (user.email ?? '') : '',
								user.name || user.email ? (user.phone ?? '') : '',
								roleName(user.role),
								t(`status.${statusOf(user)}`),
								user.deletion ? t('users.deletionAsked') : '',
								user.lastSignInAt ? formatText(t('users.lastSignIn'), { time: when(user.lastSignInAt) }) : '',
							]
								.filter((part) => part !== '')
								.join(' · '),
						),
					);
					const open = button(t('users.open'), { class: 'secondary small' });
					open.addEventListener('click', () => show(user));
					item.append(open);
					list.append(item);
				}
				if (answer.data.hasMore) more.removeAttribute('hidden');
				else more.setAttribute('hidden', '');
			};

			/** One user, to change. @param {Record<string, any>} user */
			const show = (user) => {
				const panel = element(doc, 'section', { class: 'part' });
				const form = element(doc, 'form');
				const name = make.field('input', t('fields.name'), { maxlength: '120' });
				name.input.value = user.name ?? '';
				const userRole = roleSelect(t('users.role'), false);
				fillSelect(userRole.input);
				userRole.input.value = user.role;
				const notes = make.field('textarea', t('users.notes'), { rows: '3', maxlength: '2000' });
				notes.input.value = user.notes ?? '';
				const blocked = make.check(t('users.blocked'));
				blocked.input.checked = Boolean(user.blocked);
				const reason = make.field('input', t('users.blockedReason'), { maxlength: '200' });
				reason.input.value = user.blocked?.reason ?? '';
				const save = element(doc, 'button', { type: 'submit' }, t('users.save'));
				const panelNote = element(doc, 'p', { class: 'status', role: 'status' });
				form.append(name.wrap, userRole.wrap, notes.wrap, blocked.wrap, reason.wrap, save);
				const actions = element(doc, 'div', { class: 'actions' });

				/**
				 * An action button that calls a route, then reloads the list.
				 * @param {string} label @param {string} path @param {string} done @param {string} [className]
				 */
				const action = (label, path, done, className = 'secondary') => {
					const trigger = button(label, { class: className });
					trigger.addEventListener('click', async () => {
						trigger.setAttribute('disabled', '');
						const answer = await adminCall(api, 'POST', `/v1/admin/users/${encodeURIComponent(user.id)}${path}`);
						trigger.removeAttribute('disabled');
						panelNote.textContent = answer.ok ? done : failure(answer);
						if (answer.ok) await load(true);
					});
					actions.append(trigger);
				};
				action(t('users.signOut'), '/sign-out', t('users.signedOutUser'));
				if (on('approval') && user.status === 'pending') {
					action(t('users.approve'), '/approve', t('users.approved'), '');
					action(t('users.decline'), '/decline', t('users.declined'));
				}
				if (on('data_rights') && user.deletion) {
					action(t('users.deletionApprove'), '/deletion/approve', t('users.deletionApproved'), 'danger');
					action(t('users.deletionReject'), '/deletion/reject', t('users.deletionRejected'));
				}
				const close = button(t('users.close'), { class: 'secondary' });
				close.addEventListener('click', () => detail.replaceChildren());
				actions.append(close);
				panel.append(
					element(doc, 'h3', {}, user.name || user.email || user.phone || user.id),
					element(
						doc,
						'p',
						{ class: 'meta' },
						[user.email ?? '', user.phone ?? '', t(`status.${statusOf(user)}`)].filter((part) => part !== '').join(' · '),
					),
					...(user.deletion
						? [element(doc, 'p', {}, formatText(t('users.deletionRequested'), { time: when(user.deletion.requestedAt) }))]
						: []),
					form,
					actions,
					panelNote,
				);
				form.addEventListener('submit', async (event) => {
					event.preventDefault();
					save.setAttribute('disabled', '');
					const answer = await adminCall(api, 'PATCH', `/v1/admin/users/${encodeURIComponent(user.id)}`, {
						name: name.input.value.trim(),
						role: userRole.input.value,
						notes: notes.input.value,
						blocked: blocked.input.checked,
						blockedReason: blocked.input.checked ? reason.input.value.trim() : '',
					});
					save.removeAttribute('disabled');
					panelNote.textContent = answer.ok ? t('users.saved') : failure(answer);
					if (answer.ok) await load(true);
				});
				detail.replaceChildren(panel);
			};

			filters.addEventListener('submit', (event) => {
				event.preventDefault();
				void load(true);
			});
			more.addEventListener('click', () => void load(false));
			const off = api.tickets.onChange((signedIn) => {
				if (!signedIn) {
					list.replaceChildren();
					detail.replaceChildren();
					more.setAttribute('hidden', '');
					note.textContent = t('users.signedOut');
				}
			});
			void (async () => {
				const answer = await adminCall(api, 'GET', '/v1/admin/roles');
				roles = answer.ok && Array.isArray(answer.data?.items) ? answer.data.items : [];
				fillRoles();
				await load(true);
			})();
			return () => void off();
		},
	});
};
