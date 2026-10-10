/**
 * The admin widget `users_admin` (Roles; permissions `users.read` and `users.manage`), a list-and-detail screen (PLAN
 * 0.6): status chips with their counts, search and filters (phone number, roles, a permission, joined after, hide
 * blocked, asked to be deleted), the list with each user's status dot and last sign-in, and the picked user's detail
 * (the first one until another is picked) as cards: contact, account, profile, addresses, notes, blocked and deletion.
 * Edit and the main actions sit in the header; the rest in its More menu: a sign-in code and a setup link (Staff
 * sign-in codes and setup links), sign out everywhere, approve or decline a sign-up, keep or delete on a deletion
 * request, block or unblock, and Delete user (typed confirmation). Add user and Invite (Approval / invite, the link
 * sent or handed to staff) open dialogs. With Role requests on, the requests list sits below with its own chips:
 * invite (the setup link to send), decline, open again. PLAN 0.8.6, 0.8.10 A3–A5.
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { customInputs, datesOf, errorText, fieldMaker, setHidden, textsOf } from './common.js';
import { element } from './dom.js';
import { card, chips, copyable, dot, moreMenu, openDialog } from './parts.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/** The status chips of the users list: a status, or `deletion` for users who asked to be deleted. */
const USER_CHIPS = /** @type {const} */ (['', 'active', 'pending', 'invited', 'blocked', 'deletion']);
/** The status chips of role requests. */
const REQUEST_CHIPS = /** @type {const} */ (['', 'pending', 'invited', 'expired', 'completed', 'declined']);
/** Address fields as the edit dialog shows them. */
const ADDRESS_FIELDS = /** @type {const} */ ([
	'label',
	'name',
	'line1',
	'line2',
	'area',
	'city',
	'region',
	'postalCode',
	'country',
	'phone',
]);

/** @typedef {import('./common.js').Answer} Answer */
/** @typedef {Record<string, any>} User */

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig }} input
 */
export const mountUsersAdmin = ({ host, api, config }) => {
	const t = textsOf(config);
	const win = host.ownerDocument.defaultView;
	// dates in the website's Format and business time zone, for this browser (PLAN 0.8.10 K7)
	const when = datesOf(config, win);
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
			/** @type {Array<{ key: string, name: string, permissions: string[] }>} */
			let roles = [];
			/** @type {string | null} */
			let cursor = null;
			let chip = '';
			/** @type {User[]} */
			let shown = [];
			/** @type {string | null} */
			let picked = null;

			/** @param {string} text @param {Record<string, string>} [attributes] */
			const button = (text, attributes = {}) => element(doc, 'button', { type: 'button', ...attributes }, text);
			/** @param {string} key */
			const roleName = (key) => roles.find((role) => role.key === key)?.name ?? key;
			/** @param {User} user */
			const nameOf = (user) => user.name || user.email || user.phone || user.id;
			/** @param {User} user */
			const statusOf = (user) => (user.blocked ? 'blocked' : String(user.status ?? 'active'));
			/** @param {User} user */
			const toneOf = (user) => {
				const status = statusOf(user);
				return status === 'blocked' ? 'bad' : status === 'active' ? (user.deletion ? 'wait' : 'good') : 'wait';
			};
			/** @param {Answer} answer */
			const failure = (answer) =>
				answer.status === 0 && !api.tickets.current() ? t('users.signedOut') : errorText(t, answer, when);
			/** @param {string} method @param {string} path @param {unknown} [body] */
			const call = (method, path, body) => adminCall(api, method, path, body);
			/** A role select. @param {string} label @param {string} [value] */
			const roleField = (label, value = '') => {
				const made = make.field('select', label);
				made.input.append(...roles.map((role) => element(doc, 'option', { value: role.key }, role.name)));
				made.input.value = value || (roles[0]?.key ?? '');
				return made;
			};
			/**
			 * A dialog with a form: its fields, a submit button and a status line; `send` answers the call.
			 * @param {string} title @param {Node[]} fields @param {string} submitText
			 * @param {(done: () => void, note: HTMLElement) => Promise<Answer | null>} send
			 * @param {string} [className] the submit button's class
			 */
			const formDialog = (title, fields, submitText, send, className = '') => {
				const form = element(doc, 'form', { class: 'grid' });
				const note = element(doc, 'p', { class: 'status wide', role: 'status' });
				const go = element(doc, 'button', { type: 'submit', ...(className ? { class: className } : {}) }, submitText);
				form.append(...fields, go, note);
				const dialog = openDialog(root, { title, nodes: [form], closeLabel: t('users.close') });
				form.addEventListener('submit', async (event) => {
					event.preventDefault();
					go.setAttribute('disabled', '');
					const answer = await send(dialog.close, note);
					go.removeAttribute('disabled');
					if (answer && !answer.ok) note.textContent = failure(answer);
				});
				return dialog;
			};
			/**
			 * A dialog that hands staff a code or a link, with a Copy button.
			 * @param {string} title @param {string} help @param {string} value
			 */
			const handOver = (title, help, value) =>
				openDialog(root, {
					title,
					nodes: [
						element(doc, 'p', {}, help),
						copyable(doc, value, { copy: t('users.copy'), copied: t('users.copied') }, win?.navigator),
					],
					closeLabel: t('users.close'),
				});

			// ------------------------------------------------------------------------------------------- the frame

			const box = element(doc, 'section', { class: 'box' });
			const head = element(doc, 'div', { class: 'head' });
			const mainActions = element(doc, 'div', { class: 'actions' });
			const add = button(t('users.add'));
			mainActions.append(add);
			const inviteButton = button(t('users.invite'), { class: 'secondary' });
			if (on('approval')) mainActions.append(inviteButton);
			head.append(element(doc, 'h2', {}, t('users.title')), mainActions);
			const statusChips = chips(
				doc,
				USER_CHIPS.filter(
					(value) =>
						(on('approval') || (value !== 'pending' && value !== 'invited')) && (on('data_rights') || value !== 'deletion'),
				).map((value) => ({
					value,
					label: value === '' ? t('users.allChip') : value === 'deletion' ? t('users.deletionChip') : t(`status.${value}`),
				})),
				(value) => {
					chip = value;
					statusChips.pick(chip);
					void load(true);
				},
			);
			statusChips.pick('');

			// filters
			const filters = element(doc, 'form', { class: 'grid' });
			const q = make.field('input', t('users.search'), { type: 'search', maxlength: '200' });
			const digits = make.field('input', t('users.phoneDigits'), { type: 'tel', maxlength: '40' });
			const roleFilter = make.field('select', t('users.roles'), { multiple: '', size: '3' });
			const permission = make.field('select', t('users.permission'));
			const joined = make.field('input', t('users.joinedAfter'), { type: 'date' });
			const hideBlocked = make.check(t('users.hideBlocked'));
			const search = element(doc, 'button', { type: 'submit' }, t('users.searchButton'));
			filters.append(q.wrap, digits.wrap, roleFilter.wrap, permission.wrap, joined.wrap, hideBlocked.wrap, search);

			const note = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const more = button(t('users.more'), { class: 'secondary', hidden: '' });
			const listPane = element(doc, 'div', { class: 'list-pane' });
			listPane.append(filters, note, list, more);
			const detail = element(doc, 'div', { class: 'detail-pane' });
			const layout = element(doc, 'div', { class: 'layout' });
			layout.append(listPane, detail);
			box.append(head, statusChips.group, layout);
			root.append(box);

			const fillRoleFilters = () => {
				const pick = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ (roleFilter.input));
				pick.replaceChildren(...roles.map((role) => element(doc, 'option', { value: role.key }, role.name)));
				const granted = [...new Set(roles.flatMap((role) => role.permissions).filter((each) => each !== '*'))].sort();
				permission.input.replaceChildren(
					element(doc, 'option', { value: '' }, t('users.anyPermission')),
					...granted.map((each) => element(doc, 'option', { value: each }, each)),
				);
			};

			// ------------------------------------------------------------------------------------------- the list

			/** The query of the list's filters (the chip and the fields). */
			const query = () => {
				const out = new URLSearchParams();
				if (q.input.value.trim()) out.set('q', q.input.value.trim());
				if (digits.input.value.trim()) out.set('phoneDigits', digits.input.value.trim());
				const chosen = [.../** @type {HTMLSelectElement} */ (/** @type {unknown} */ (roleFilter.input)).selectedOptions].map(
					(option) => option.value,
				);
				if (chosen.length > 0) out.set('roles', chosen.join(','));
				if (permission.input.value) out.set('permission', permission.input.value);
				if (joined.input.value) out.set('createdAfter', `${joined.input.value}T00:00:00Z`);
				if (hideBlocked.input.checked) out.set('blocked', 'false');
				if (chip === 'deletion') out.set('deletion', '1');
				else if (chip) out.set('status', chip);
				return out;
			};

			/** The counts on the chips: by status, blocked and asked to be deleted, with the other filters. */
			const loadCounts = async () => {
				const base = query();
				base.delete('status');
				base.delete('deletion');
				const [byStatus, blocked, deletion] = await Promise.all([
					call('GET', `/v1/admin/users/counts?by=status&${base.toString()}`),
					call('GET', `/v1/admin/users/count?status=blocked&${base.toString()}`),
					call('GET', `/v1/admin/users/count?deletion=1&${base.toString()}`),
				]);
				if (!byStatus.ok) return;
				const groups = byStatus.data.groups ?? {};
				statusChips.counts({
					'': byStatus.data.total,
					active: groups.active ?? 0,
					pending: groups.pending ?? 0,
					invited: groups.invited ?? 0,
					blocked: blocked.ok ? blocked.data.count : null,
					deletion: deletion.ok ? deletion.data.count : null,
				});
			};

			/** @param {boolean} reset */
			const load = async (reset) => {
				const params = query();
				params.set('limit', '25');
				if (!reset && cursor) params.set('cursor', cursor);
				const answer = await call('GET', `/v1/admin/users?${params.toString()}`);
				if (reset) {
					list.replaceChildren();
					shown = [];
					void loadCounts();
				}
				if (!answer.ok) {
					note.textContent = failure(answer);
					more.setAttribute('hidden', '');
					return;
				}
				/** @type {User[]} */
				const items = answer.data.items;
				cursor = answer.data.nextCursor;
				shown = [...shown, ...items];
				note.textContent = reset && items.length === 0 ? t('users.empty') : '';
				for (const user of items) list.append(row(user));
				setHidden(more, !answer.data.hasMore);
				// wide widgets open the first user of the list, so the detail side is never empty
				const keep = shown.find((user) => user.id === picked);
				if (reset) show(keep ?? shown[0] ?? null, false);
			};

			/** @param {User} user */
			const row = (user) => {
				const item = element(doc, 'li', { class: 'row-item', tabindex: '0', 'data-id': user.id });
				const who = element(doc, 'div', { class: 'who' });
				who.append(
					element(doc, 'span', {}, nameOf(user)),
					element(
						doc,
						'span',
						{ class: 'meta' },
						[
							user.name ? (user.email ?? user.phone ?? '') : '',
							roleName(user.role),
							user.deletion ? t('users.deletionAsked') : '',
						]
							.filter((part) => part !== '')
							.join(' · '),
					),
				);
				item.append(
					dot(doc, toneOf(user), t(`status.${statusOf(user)}`)),
					who,
					element(doc, 'span', { class: 'figure' }, user.lastSignInAt ? when(user.lastSignInAt, 'date') : t('users.never')),
				);
				const open = () => show(user, true);
				item.addEventListener('click', open);
				item.addEventListener('keydown', (event) => {
					if (/** @type {KeyboardEvent} */ (event).key === 'Enter') open();
				});
				return item;
			};

			// ------------------------------------------------------------------------------------------ the detail

			/**
			 * Show one user (null: the empty state). `chosen`: picked by staff (narrow widgets then show the detail alone).
			 * @param {User | null} user @param {boolean} chosen
			 */
			const show = (user, chosen) => {
				picked = user?.id ?? null;
				for (const item of list.querySelectorAll('li.row-item'))
					item.setAttribute('aria-current', String(item.getAttribute('data-id') === picked));
				if (chosen) layout.classList.add('picked');
				if (!user) {
					detail.replaceChildren(element(doc, 'p', { class: 'meta' }, t('users.emptyDetail')));
					return;
				}
				const panelNote = element(doc, 'p', { class: 'status', role: 'status' });
				const back = button(t('users.back'), { class: 'link back' });
				back.addEventListener('click', () => layout.classList.remove('picked'));

				/** After a change: the list again, with this user picked. @param {string} message */
				const done = async (message) => {
					await load(true);
					panelNote.textContent = message;
					const fresh = shown.find((each) => each.id === user.id);
					if (fresh) show(fresh, false);
					/** @type {HTMLElement | null} */ (detail.querySelector('[role="status"]'))?.replaceChildren(message);
				};
				/** A POST on the user, then the list again. @param {string} path @param {string} message */
				const act = async (path, message) => {
					const answer = await call('POST', `/v1/admin/users/${encodeURIComponent(user.id)}${path}`);
					if (answer.ok) await done(message);
					else panelNote.textContent = failure(answer);
				};

				const edit = button(t('users.edit'));
				edit.addEventListener('click', () => editDialog(user, done));
				/** @type {import('./parts.js').MenuItem[]} */
				const items = [];
				if (on('staff_links') && !user.blocked) {
					items.push({
						label: t('users.signInCode'),
						run: async () => {
							const answer = await call('POST', `/v1/admin/users/${encodeURIComponent(user.id)}/sign-in-code`);
							if (!answer.ok) panelNote.textContent = failure(answer);
							else
								handOver(
									t('users.signInCodeTitle'),
									formatText(t('users.signInCodeHelp'), { name: nameOf(user), time: when(answer.data.expiresAt) }),
									String(answer.data.code),
								);
						},
					});
					items.push({
						label: t('users.setupLink'),
						run: async () => {
							const answer = await call('POST', `/v1/admin/users/${encodeURIComponent(user.id)}/setup-link`);
							if (!answer.ok) panelNote.textContent = failure(answer);
							else
								handOver(
									t('users.setupLinkTitle'),
									formatText(t('users.setupLinkHelp'), { name: nameOf(user), time: when(answer.data.expiresAt) }),
									String(answer.data.url),
								);
						},
					});
				}
				items.push({ label: t('users.signOut'), run: () => act('/sign-out', t('users.signedOutUser')) });
				if (on('approval') && user.status === 'pending') {
					items.push({ label: t('users.approve'), run: () => act('/approve', t('users.approved')) });
					items.push({ label: t('users.decline'), run: () => act('/decline', t('users.declined')) });
				}
				if (on('data_rights') && user.deletion) {
					items.push({ label: t('users.deletionReject'), run: () => act('/deletion/reject', t('users.deletionRejected')) });
					items.push({
						label: t('users.deletionApprove'),
						run: () => act('/deletion/approve', t('users.deletionApproved')),
						danger: true,
					});
				}
				items.push(
					user.blocked
						? {
								label: t('users.unblock'),
								run: async () => {
									const answer = await call('PATCH', `/v1/admin/users/${encodeURIComponent(user.id)}`, {
										blocked: false,
									});
									if (answer.ok) await done(t('users.unblocked'));
									else panelNote.textContent = failure(answer);
								},
							}
						: { label: t('users.block'), run: () => blockDialog(user, done) },
				);
				items.push({ label: t('users.delete'), run: () => deleteDialog(user, done), danger: true });

				const header = element(doc, 'div', { class: 'head' });
				const title = element(doc, 'div');
				title.append(element(doc, 'h3', {}, nameOf(user)), dot(doc, toneOf(user), t(`status.${statusOf(user)}`)));
				const actions = element(doc, 'div', { class: 'actions' });
				actions.append(edit, moreMenu(doc, t('users.moreActions'), items));
				header.append(title, actions);

				/** @param {unknown} value */
				const date = (value) => (typeof value === 'string' ? when(value) : '');
				/** @param {string | null} value @param {boolean} verified */
				const contact = (value, verified) => (value ? (verified ? formatText(t('users.verified'), { value }) : value) : '');
				const cards = element(doc, 'div', { class: 'cards' });
				cards.append(
					card(doc, t('users.contact'), [
						[t('fields.email'), contact(user.email, user.emailVerified)],
						[t('fields.phone'), contact(user.phone, user.phoneVerified)],
					]),
					card(doc, t('users.account'), [
						[t('users.role'), roleName(user.role)],
						[t('users.roleSince'), date(user.roleSince)],
						[t('users.joined'), date(user.createdAt)],
						[t('users.lastSignInLabel'), user.lastSignInAt ? date(user.lastSignInAt) : t('users.never')],
						[t('users.password'), user.hasPassword ? t('users.yes') : t('users.no')],
						[
							t('users.twoStepLabel'),
							user.twoStep ? formatText(t('users.twoStepOn'), { count: user.recoveryCodesLeft ?? 0 }) : t('users.no'),
						],
						[t('users.lockedUntil'), user.lockedUntil ? date(user.lockedUntil) : ''],
						[t('users.providers'), (user.providers ?? []).map((/** @type {string} */ p) => t(`method.${p}`)).join(', ')],
						[t('users.termsLabel'), user.terms ? `${user.terms.version} · ${date(user.terms.acceptedAt)}` : ''],
					]),
				);
				const custom = (config.settings.customFields ?? []).map(
					(field) =>
						/** @type {[string, string]} */ ([
							field.label,
							user.custom?.[field.key] === undefined ? '' : String(user.custom[field.key]),
						]),
				);
				if (custom.some(([, value]) => value !== '')) cards.append(card(doc, t('users.profile'), custom));
				if ((user.addresses ?? []).length > 0)
					cards.append(
						card(
							doc,
							t('users.addresses'),
							user.addresses.map((/** @type {Record<string, any>} */ address) => [
								address.label || (address.default ? t('account.defaultAddress') : t('users.addresses')),
								[
									address.line1,
									address.line2,
									address.area,
									address.city,
									address.region,
									address.postalCode,
									address.country,
								]
									.filter(Boolean)
									.join(', '),
							]),
						),
					);
				if (user.notes) cards.append(card(doc, t('users.notesCard'), [[t('users.notes'), user.notes]]));
				if (user.blocked)
					cards.append(
						card(doc, t('users.blockedCard'), [
							[formatText(t('users.blockedSince'), { time: date(user.blocked.at) }), user.blocked.reason || '—'],
						]),
					);
				if (user.deletion)
					cards.append(
						card(doc, t('users.deletionCard'), [
							[
								t('users.deletionAsked'),
								formatText(t('users.deletionRequested'), { time: date(user.deletion.requestedAt) }),
							],
							[
								'',
								user.deletion.dueAt
									? formatText(t('users.deletionDue'), { date: when(user.deletion.dueAt, 'date') })
									: '',
							],
						]),
					);
				detail.replaceChildren(back, header, panelNote, cards);
			};

			// ---------------------------------------------------------------------------------------------- dialogs

			/** The fields of a user's contacts, role, notes and password. @param {User | null} user */
			const userFields = (user) => {
				const name = make.field('input', t('fields.name'), { maxlength: '120', required: '' });
				const email = make.field('input', t('fields.email'), { type: 'email', maxlength: '254' });
				const phone = make.field('input', t('fields.phone'), { type: 'tel', maxlength: '40' });
				const role = roleField(t('users.role'), user?.role);
				const password = make.field('input', user ? t('users.newPassword') : t('fields.password'), {
					type: 'password',
					autocomplete: 'new-password',
				});
				const notes = make.field('textarea', t('users.notes'), { rows: '3', maxlength: '5000' });
				notes.wrap.classList.add('wide');
				name.input.value = user?.name ?? '';
				email.input.value = user?.email ?? '';
				phone.input.value = user?.phone ?? '';
				notes.input.value = user?.notes ?? '';
				const custom = customInputs(doc, make, t, config.settings.customFields ?? [], { values: user?.custom ?? {} });
				return {
					nodes: [name.wrap, email.wrap, phone.wrap, role.wrap, password.wrap, ...custom.nodes, notes.wrap],
					/** The body: unchanged contacts are left out of an edit; an emptied one is removed. */
					read: () => {
						/** @type {Record<string, unknown>} */
						const out = { name: name.input.value.trim(), role: role.input.value, notes: notes.input.value };
						for (const [key, field] of /** @type {const} */ ([
							['email', email],
							['phone', phone],
						])) {
							const value = field.input.value.trim();
							if (user ? value !== (user[key] ?? '') : value !== '') out[key] = value === '' ? null : value;
						}
						if (password.input.value) out.password = password.input.value;
						const values = custom.read(Boolean(user));
						if (Object.keys(values).length > 0) out.custom = values;
						return out;
					},
				};
			};

			/** The addresses of a user, to change in the edit dialog. @param {Array<Record<string, any>>} addresses */
			const addressEditor = (addresses) => {
				const area = element(doc, 'div', { class: 'wide' });
				/** @type {Array<{ id?: string, inputs: Record<string, HTMLInputElement>, isDefault: HTMLInputElement, node: HTMLElement }>} */
				const rows = [];
				/** @param {Record<string, any>} [address] */
				const addRow = (address = {}) => {
					const fieldset = element(doc, 'fieldset', { class: 'grid' });
					fieldset.append(element(doc, 'legend', {}, t('users.addresses')));
					/** @type {Record<string, HTMLInputElement>} */
					const inputs = {};
					for (const key of ADDRESS_FIELDS) {
						const made = make.field('input', t(`address.${key === 'label' ? 'label' : key}`), { maxlength: '200' });
						made.input.value = address[key] ?? '';
						inputs[key] = made.input;
						fieldset.append(made.wrap);
					}
					const isDefault = make.check(t('address.default'));
					isDefault.input.checked = address.default === true;
					const remove = button(t('account.remove'), { class: 'secondary small' });
					const entry = { id: address.id, inputs, isDefault: isDefault.input, node: fieldset };
					remove.addEventListener('click', () => {
						fieldset.remove();
						rows.splice(rows.indexOf(entry), 1);
					});
					fieldset.append(isDefault.wrap, remove);
					rows.push(entry);
					area.insertBefore(fieldset, addButton);
				};
				const addButton = button(t('account.addressAdd'), { class: 'secondary small' });
				area.append(addButton);
				addButton.addEventListener('click', () => addRow());
				for (const address of addresses) addRow(address);
				return {
					node: area,
					read: () =>
						rows.map((entry) => ({
							...(entry.id ? { id: entry.id } : {}),
							...Object.fromEntries(Object.entries(entry.inputs).map(([key, input]) => [key, input.value.trim()])),
							default: entry.isDefault.checked,
						})),
				};
			};

			/** @param {User} user @param {(message: string) => Promise<void>} done */
			const editDialog = (user, done) => {
				const fields = userFields(user);
				const addresses = addressEditor(user.addresses ?? []);
				formDialog(
					formatText(t('users.editTitle'), { name: nameOf(user) }),
					[...fields.nodes, addresses.node],
					t('users.save'),
					async (close) => {
						const answer = await call('PATCH', `/v1/admin/users/${encodeURIComponent(user.id)}`, {
							...fields.read(),
							addresses: addresses.read(),
						});
						if (answer.ok) {
							close();
							await done(t('users.saved'));
						}
						return answer;
					},
				);
			};

			/** @param {User} user @param {(message: string) => Promise<void>} done */
			const blockDialog = (user, done) => {
				const reason = make.field('input', t('users.blockedReason'), { maxlength: '200' });
				reason.wrap.classList.add('wide');
				formDialog(
					formatText(t('users.blockTitle'), { name: nameOf(user) }),
					[reason.wrap],
					t('users.blockSubmit'),
					async (close) => {
						const answer = await call('PATCH', `/v1/admin/users/${encodeURIComponent(user.id)}`, {
							blocked: true,
							blockedReason: reason.input.value.trim(),
						});
						if (answer.ok) {
							close();
							await done(t('users.saved'));
						}
						return answer;
					},
					'danger',
				);
			};

			/** Delete a user behind a typed confirmation (their name). @param {User} user @param {(message: string) => Promise<void>} done */
			const deleteDialog = (user, done) => {
				const confirmWord = nameOf(user);
				const reason = make.field('input', t('users.deleteReason'), { maxlength: '300' });
				const typed = make.field('input', t('users.typeToConfirm'), { autocomplete: 'off', required: '' });
				for (const made of [reason, typed]) made.wrap.classList.add('wide');
				formDialog(
					formatText(t('users.deleteTitle'), { name: confirmWord }),
					[
						element(doc, 'p', { class: 'wide' }, formatText(t('users.deleteHelp'), { confirm: confirmWord })),
						reason.wrap,
						typed.wrap,
					],
					t('users.deleteSubmit'),
					async (close, dialogNote) => {
						if (typed.input.value.trim() !== confirmWord) {
							dialogNote.replaceChildren(formatText(t('users.deleteHelp'), { confirm: confirmWord }));
							return null;
						}
						const answer = await call('DELETE', `/v1/admin/users/${encodeURIComponent(user.id)}`, {
							reason: reason.input.value.trim(),
						});
						if (answer.ok) {
							close();
							picked = null;
							await done(t('users.deleted'));
						}
						return answer;
					},
					'danger',
				);
			};

			add.addEventListener('click', () => {
				const fields = userFields(null);
				formDialog(t('users.addTitle'), fields.nodes, t('users.add'), async (close) => {
					const answer = await call('POST', '/v1/admin/users', fields.read());
					if (answer.ok) {
						close();
						picked = answer.data.id;
						chip = '';
						statusChips.pick('');
						await load(true);
						note.textContent = t('users.created');
					}
					return answer;
				});
			});

			inviteButton.addEventListener('click', () => {
				const contactField = make.field('input', t('users.inviteContact'), { maxlength: '254', required: '' });
				const name = make.field('input', t('fields.name'), { maxlength: '120' });
				const role = roleField(t('users.role'));
				const keep = make.check(t('users.inviteReturn'));
				keep.wrap.classList.add('wide');
				formDialog(
					t('users.inviteTitle'),
					[contactField.wrap, name.wrap, role.wrap, keep.wrap],
					t('users.inviteSend'),
					async (close) => {
						const value = contactField.input.value.trim();
						const answer = await call('POST', '/v1/admin/users/invite', {
							...(value.includes('@') ? { email: value } : { phone: value }),
							...(name.input.value.trim() ? { name: name.input.value.trim() } : {}),
							role: role.input.value,
							...(keep.input.checked ? { deliver: 'return' } : {}),
						});
						if (answer.ok) {
							close();
							await load(true);
							if (answer.data?.invite)
								handOver(
									t('users.inviteTitle'),
									formatText(t('users.inviteLink'), {
										name: name.input.value.trim() || value,
										time: when(answer.data.invite.expiresAt),
									}),
									String(answer.data.invite.url),
								);
							else note.textContent = formatText(t('users.invited'), { to: value });
						}
						return answer;
					},
				);
			});

			// ------------------------------------------------------------------------------------- role requests

			const requests = element(doc, 'section', { class: 'part' });
			const requestNote = element(doc, 'p', { class: 'status', role: 'status' });
			const requestList = element(doc, 'ul');
			const requestMore = button(t('users.more'), { class: 'secondary', hidden: '' });
			let requestChip = 'pending';
			/** @type {string | null} */
			let requestCursor = null;
			const requestChips = chips(
				doc,
				REQUEST_CHIPS.map((value) => ({ value, label: t(value === '' ? 'requests.all' : `requests.${value}`) })),
				(value) => {
					requestChip = value;
					requestChips.pick(value);
					void loadRequests(true);
				},
			);
			requestChips.pick(requestChip);
			requests.append(
				element(doc, 'h3', {}, t('requests.title')),
				element(doc, 'p', { class: 'meta' }, t('requests.help')),
				requestChips.group,
				requestNote,
				requestList,
				requestMore,
			);
			if (on('role_requests')) box.append(requests);

			const loadRequestCounts = async () => {
				const [byStatus, expired] = await Promise.all([
					call('GET', '/v1/admin/role-requests/counts?by=status'),
					call('GET', '/v1/admin/role-requests/count?status=expired'),
				]);
				if (!byStatus.ok || !expired.ok) return;
				const groups = byStatus.data.groups ?? {};
				requestChips.counts({
					'': byStatus.data.total,
					pending: groups.pending ?? 0,
					invited: (groups.invited ?? 0) - expired.data.count,
					expired: expired.data.count,
					completed: groups.completed ?? 0,
					declined: groups.declined ?? 0,
				});
			};

			/** @param {boolean} reset */
			const loadRequests = async (reset) => {
				const params = new URLSearchParams({ limit: '25' });
				if (requestChip) params.set('status', requestChip);
				if (!reset && requestCursor) params.set('cursor', requestCursor);
				const answer = await call('GET', `/v1/admin/role-requests?${params.toString()}`);
				if (reset) {
					requestList.replaceChildren();
					void loadRequestCounts();
				}
				if (!answer.ok) {
					requestNote.textContent = failure(answer);
					return;
				}
				requestCursor = answer.data.nextCursor;
				requestNote.textContent = reset && answer.data.items.length === 0 ? t('requests.empty') : '';
				for (const request of answer.data.items) requestList.append(requestRow(request));
				setHidden(requestMore, !answer.data.hasMore);
			};

			/** @param {Record<string, any>} request */
			const requestRow = (request) => {
				const item = element(doc, 'li', { class: 'row-item' });
				const who = element(doc, 'div', { class: 'who' });
				who.append(
					element(doc, 'span', {}, request.name),
					element(
						doc,
						'span',
						{ class: 'meta' },
						[
							roleName(request.role),
							request.phone ?? request.email ?? '',
							formatText(t('requests.asked'), { time: when(request.createdAt, 'date') }),
						]
							.filter(Boolean)
							.join(' · '),
					),
					...(request.note ? [element(doc, 'span', { class: 'meta' }, request.note)] : []),
				);
				const tone =
					request.status === 'completed'
						? 'good'
						: request.status === 'declined'
							? 'bad'
							: request.status === 'expired'
								? 'bad'
								: 'wait';
				/** @param {string} path @param {string} message */
				const move = async (path, message) => {
					const answer = await call('POST', `/v1/admin/role-requests/${encodeURIComponent(request.id)}${path}`);
					if (!answer.ok) {
						requestNote.textContent = failure(answer);
						return null;
					}
					await loadRequests(true);
					requestNote.textContent = message;
					return answer;
				};
				/** @type {import('./parts.js').MenuItem[]} */
				const items = [];
				if (request.status === 'pending') {
					items.push({
						label: t('requests.invite'),
						run: async () => {
							const answer = await move('/invite', '');
							if (!answer) return;
							if (answer.data.setupLink)
								handOver(
									formatText(t('requests.inviteTitle'), { name: request.name }),
									formatText(t('users.setupLinkHelp'), {
										name: request.name,
										time: when(answer.data.setupLink.expiresAt),
									}),
									String(answer.data.setupLink.url),
								);
							else requestNote.textContent = formatText(t('requests.given'), { name: request.name });
						},
					});
					items.push({
						label: t('requests.decline'),
						run: async () => void (await move('/decline', t('requests.declinedDone'))),
						danger: true,
					});
				}
				if (request.status === 'declined' || request.status === 'expired')
					items.push({ label: t('requests.reopen'), run: async () => void (await move('/reopen', t('requests.reopened'))) });
				item.append(dot(doc, tone, t(`requests.${request.status}`)), who, moreMenu(doc, t('users.moreActions'), items));
				return item;
			};

			// ------------------------------------------------------------------------------------------------ start

			filters.addEventListener('submit', (event) => {
				event.preventDefault();
				void load(true);
			});
			more.addEventListener('click', () => void load(false));
			requestMore.addEventListener('click', () => void loadRequests(false));
			const off = api.tickets.onChange((signedIn) => {
				if (!signedIn) {
					list.replaceChildren();
					detail.replaceChildren();
					more.setAttribute('hidden', '');
					note.textContent = t('users.signedOut');
				}
			});
			void (async () => {
				const answer = await call('GET', '/v1/admin/roles');
				roles = answer.ok && Array.isArray(answer.data?.items) ? answer.data.items : [];
				fillRoleFilters();
				await load(true);
				if (on('role_requests')) await loadRequests(true);
			})();
			return () => void off();
		},
	});
};
