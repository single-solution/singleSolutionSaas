/**
 * The admin widget `roles_admin` (Roles; permission `roles.manage`): the merchant's staff edit the roles (name,
 * description, the permissions ticked per product, two-step, session lengths), copy one into a new role, add and delete
 * their own roles, and name their own permissions (the `site` group).
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { errorText, fieldMaker, setHidden, textsOf } from './common.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/** Every permission (Owner). */
const ALL = '*';
/** The group of the merchant's own permission names. */
const OWN_SOURCE = 'site';

/**
 * @typedef {object} RoleView
 * @property {string} key
 * @property {string} name
 * @property {string} description
 * @property {string[]} permissions
 * @property {'optional' | 'required'} twoStep
 * @property {number} sessionHours
 * @property {number} rememberDays
 * @property {boolean} ready a ready-made role (cannot be deleted)
 */
/** @typedef {{ source: string, permissions: Array<{ key: string, name: string }> }} PermissionGroup */

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig }} input
 */
export const mountRolesAdmin = ({ host, api, config }) => {
	const t = textsOf(config);
	const twoStepOn = config.features.includes('two_step');
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const make = fieldMaker(doc, 'ss-roles');
			/** @type {RoleView[]} */
			let roles = [];
			/** @type {PermissionGroup[]} */
			let groups = [];
			/** @type {string[]} */
			let unavailable = [];
			/** @type {Map<string, HTMLInputElement>} */
			let boxes = new Map();
			/** @type {string | null} the key of the role being changed; null for a new role */
			let editing = null;
			/** @type {'optional' | 'required'} */
			let twoStep = 'optional';

			/** @param {string} text @param {Record<string, string>} [attributes] */
			const button = (text, attributes = {}) => element(doc, 'button', { type: 'button', ...attributes }, text);
			/** @param {import('./common.js').Answer} answer */
			const failure = (answer) =>
				answer.status === 0 && !api.tickets.current() ? t('roles.signedOut') : errorText(t, answer);

			// the list
			const note = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');

			// the role form
			const form = element(doc, 'form', { class: 'part' });
			const heading = element(doc, 'h3');
			const key = make.field('input', t('roles.key'), { maxlength: '40', pattern: '[a-z][a-z0-9_]{1,39}', required: '' });
			const name = make.field('input', t('roles.name'), { maxlength: '60', required: '' });
			const description = make.field('textarea', t('roles.description'), { rows: '2', maxlength: '300' });
			const twoStepField = make.field('select', t('roles.twoStep'));
			twoStepField.input.append(
				element(doc, 'option', { value: 'optional' }, t('roles.twoStepOptional')),
				element(doc, 'option', { value: 'required' }, t('roles.twoStepRequired')),
			);
			const sessionHours = make.field('input', t('roles.sessionHours'), {
				type: 'number',
				min: '1',
				max: '720',
				step: '1',
				required: '',
			});
			const rememberDays = make.field('input', t('roles.rememberDays'), {
				type: 'number',
				min: '0',
				max: '365',
				step: '1',
				required: '',
			});
			const all = make.check(t('roles.allPermissions'));
			const permissionArea = element(doc, 'div', { class: 'permissions' });
			const save = element(doc, 'button', { type: 'submit' }, t('roles.save'));
			const fresh = button(t('roles.new'), { class: 'secondary' });
			const formNote = element(doc, 'p', { class: 'status', role: 'status' });
			const lengths = element(doc, 'div', { class: 'row' });
			lengths.append(sessionHours.wrap, rememberDays.wrap);
			form.append(
				heading,
				key.wrap,
				name.wrap,
				description.wrap,
				...(twoStepOn ? [twoStepField.wrap] : []),
				lengths,
				element(doc, 'h4', {}, t('roles.permissions')),
				all.wrap,
				permissionArea,
				save,
				fresh,
				formNote,
			);

			// the merchant's own permission names
			const own = element(doc, 'section', { class: 'part' });
			const ownRows = element(doc, 'div');
			const ownAdd = button(t('roles.ownAdd'), { class: 'secondary' });
			const ownSave = button(t('roles.ownSave'));
			const ownNote = element(doc, 'p', { class: 'status', role: 'status' });
			own.append(
				element(doc, 'h3', {}, t('roles.ownTitle')),
				element(doc, 'p', { class: 'meta' }, t('roles.ownHelp')),
				ownRows,
				ownAdd,
				ownSave,
				ownNote,
			);

			const box = element(doc, 'section', { class: 'box' });
			box.append(element(doc, 'h2', {}, t('roles.title')), note, list, form, own);
			root.append(box);

			/** @param {string[]} selected */
			const paintPermissions = (selected) => {
				boxes = new Map();
				const known = new Set(groups.flatMap((group) => group.permissions.map((permission) => permission.key)));
				const others = selected.filter((permission) => permission !== ALL && !known.has(permission));
				/** @param {string} legend @param {Array<{ key: string, name: string }>} permissions */
				const fieldset = (legend, permissions) => {
					const set = element(doc, 'fieldset');
					set.append(element(doc, 'legend', {}, legend));
					for (const permission of permissions) {
						const made = make.check(permission.name);
						made.input.value = permission.key;
						made.input.checked = selected.includes(permission.key);
						boxes.set(permission.key, made.input);
						set.append(made.wrap);
					}
					return set;
				};
				permissionArea.replaceChildren(
					...groups
						.filter((group) => group.permissions.length > 0)
						.map((group) => fieldset(group.source === OWN_SOURCE ? t('roles.ownGroup') : group.source, group.permissions)),
					...(others.length > 0
						? [
								fieldset(
									t('roles.otherGroup'),
									others.map((permission) => ({ key: permission, name: permission })),
								),
							]
						: []),
					...(unavailable.length > 0
						? [
								element(
									doc,
									'p',
									{ class: 'meta' },
									formatText(t('roles.unavailable'), { products: unavailable.join(', ') }),
								),
							]
						: []),
				);
				all.input.checked = selected.includes(ALL);
				setHidden(permissionArea, all.input.checked);
			};

			/**
			 * Fill the form with a role, a copy of one (a new key), or nothing (a new role).
			 * @param {RoleView | null} role @param {boolean} [copy]
			 */
			const fill = (role, copy = false) => {
				editing = role && !copy ? role.key : null;
				key.input.value = role ? (copy ? `${role.key}_copy`.slice(0, 40) : role.key) : '';
				if (editing) key.input.setAttribute('readonly', '');
				else key.input.removeAttribute('readonly');
				name.input.value = role ? (copy ? formatText(t('roles.copyName'), { name: role.name }).slice(0, 60) : role.name) : '';
				description.input.value = role?.description ?? '';
				twoStep = role?.twoStep ?? 'optional';
				twoStepField.input.value = twoStep;
				sessionHours.input.value = String(role?.sessionHours ?? 24);
				rememberDays.input.value = String(role?.rememberDays ?? 30);
				heading.textContent = editing ? formatText(t('roles.editing'), { name: role?.name ?? '' }) : t('roles.newRole');
				paintPermissions(role?.permissions ?? []);
			};

			const paintList = () => {
				list.replaceChildren(
					...roles.map((role) => {
						const item = element(doc, 'li', {}, role.name);
						item.append(
							element(
								doc,
								'span',
								{ class: 'meta' },
								[
									role.key,
									role.permissions.includes(ALL)
										? t('roles.allPermissions')
										: formatText(t('roles.permissionCount'), { count: role.permissions.length }),
									role.ready ? t('roles.readyMade') : '',
								]
									.filter((part) => part !== '')
									.join(' · '),
							),
						);
						const actions = element(doc, 'div', { class: 'actions' });
						const change = button(t('roles.edit'), { class: 'secondary small' });
						const copy = button(t('roles.copy'), { class: 'secondary small' });
						change.addEventListener('click', () => fill(role));
						copy.addEventListener('click', () => fill(role, true));
						actions.append(change, copy);
						if (!role.ready) {
							const remove = button(t('roles.delete'), { class: 'secondary small' });
							remove.addEventListener('click', async () => {
								const answer = await adminCall(api, 'DELETE', `/v1/admin/roles/${encodeURIComponent(role.key)}`);
								if (answer.ok) {
									if (editing === role.key) fill(null);
									await load();
								}
								note.textContent = answer.ok ? formatText(t('roles.deleted'), { name: role.name }) : failure(answer);
							});
							actions.append(remove);
						}
						item.append(actions);
						return item;
					}),
				);
			};

			/** @param {{ key: string, name: string }} [permission] */
			const ownRow = (permission) => {
				const row = element(doc, 'div', { class: 'row own' });
				const rowKey = make.field('input', t('roles.ownKey'), { maxlength: '64', pattern: '[a-z][a-z0-9_.]{0,63}' });
				const rowName = make.field('input', t('roles.ownName'), { maxlength: '80' });
				rowKey.input.value = permission ? permission.key.slice(OWN_SOURCE.length + 1) : '';
				rowName.input.value = permission?.name ?? '';
				const remove = button(t('roles.ownRemove'), { class: 'secondary small' });
				remove.addEventListener('click', () => row.remove());
				row.append(rowKey.wrap, rowName.wrap, remove);
				return row;
			};
			const paintOwn = () => {
				const mine = groups.find((group) => group.source === OWN_SOURCE)?.permissions ?? [];
				ownRows.replaceChildren(...mine.map((permission) => ownRow(permission)));
			};

			const load = async () => {
				const [rolesAnswer, catalogAnswer] = await Promise.all([
					adminCall(api, 'GET', '/v1/admin/roles'),
					adminCall(api, 'GET', '/v1/admin/roles/permissions'),
				]);
				if (!rolesAnswer.ok || !catalogAnswer.ok) {
					list.replaceChildren();
					note.textContent = failure(rolesAnswer.ok ? catalogAnswer : rolesAnswer);
					return false;
				}
				roles = Array.isArray(rolesAnswer.data?.items) ? rolesAnswer.data.items : [];
				groups = Array.isArray(catalogAnswer.data?.groups) ? catalogAnswer.data.groups : [];
				unavailable = Array.isArray(catalogAnswer.data?.unavailable) ? catalogAnswer.data.unavailable : [];
				note.textContent = '';
				paintList();
				paintOwn();
				return true;
			};

			/** The permissions ticked in the form now. */
			const selectedNow = () =>
				all.input.checked ? [ALL] : [...boxes].filter(([, input]) => input.checked).map(([permission]) => permission);

			all.input.addEventListener('change', () => setHidden(permissionArea, all.input.checked));
			twoStepField.input.addEventListener('change', () => {
				twoStep = twoStepField.input.value === 'required' ? 'required' : 'optional';
			});
			fresh.addEventListener('click', () => fill(null));
			form.addEventListener('submit', async (event) => {
				event.preventDefault();
				const roleKey = key.input.value.trim();
				const selected = selectedNow();
				save.setAttribute('disabled', '');
				const answer = await adminCall(api, 'PUT', `/v1/admin/roles/${encodeURIComponent(roleKey)}`, {
					name: name.input.value.trim(),
					description: description.input.value.trim(),
					permissions: selected,
					twoStep,
					sessionHours: Number(sessionHours.input.value),
					rememberDays: Number(rememberDays.input.value),
				});
				save.removeAttribute('disabled');
				formNote.textContent = answer.ok ? t('roles.saved') : failure(answer);
				if (answer.ok && (await load())) fill(roles.find((role) => role.key === roleKey) ?? answer.data);
			});
			ownAdd.addEventListener('click', () => ownRows.append(ownRow()));
			ownSave.addEventListener('click', async () => {
				const permissions = [...ownRows.querySelectorAll('.own')]
					.map((row) => {
						const [rowKey, rowName] = /** @type {HTMLInputElement[]} */ ([...row.querySelectorAll('input')]);
						return { key: rowKey?.value.trim() ?? '', name: rowName?.value.trim() ?? '' };
					})
					.filter((permission) => permission.key !== '' || permission.name !== '');
				ownSave.setAttribute('disabled', '');
				const answer = await adminCall(api, 'PUT', '/v1/admin/roles/permissions', { permissions });
				ownSave.removeAttribute('disabled');
				ownNote.textContent = answer.ok ? t('roles.ownSaved') : failure(answer);
				if (answer.ok && (await load())) paintPermissions(selectedNow());
			});
			const off = api.tickets.onChange((signedIn) => {
				if (!signedIn) {
					list.replaceChildren();
					note.textContent = t('roles.signedOut');
				}
			});
			fill(null);
			void (async () => {
				if (await load()) fill(null);
			})();
			return () => void off();
		},
	});
};
