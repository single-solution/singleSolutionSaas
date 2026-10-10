/**
 * The visitor widget `my_account` (PLAN 0.8.6), for the signed-in user: the profile (name, custom fields, addresses),
 * the password, two-step sign-in, the devices signed in, the terms when there is a new version, Download my data and
 * Delete my account (Data rights) and the orders (Orders tab). Each part shows only while its feature is on.
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { customInputs, datesOf, errorText, fieldMaker, moneyText, setHidden, termsBox, textsOf, webAddress } from './common.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';

/** The address fields, in the order of the form. */
const ADDRESS_FIELDS = /** @type {const} */ ([
	['label', 40],
	['name', 120],
	['line1', 200],
	['line2', 200],
	['city', 100],
	['region', 100],
	['postalCode', 20],
	['country', 2],
	['phone', 40],
]);

/**
 * @typedef {object} MyAccountInput
 * @property {HTMLElement} host
 * @property {Window & typeof globalThis} win
 * @property {import('./widget.js').WidgetConfig} config
 * @property {import('./session.js').Session} session
 */

/** @param {Record<string, unknown>} address */
const addressLine = (address) =>
	[
		address.label,
		address.name,
		address.line1,
		address.line2,
		address.city,
		[address.region, address.postalCode].filter(Boolean).join(' '),
		address.country,
	]
		.filter((part) => typeof part === 'string' && part !== '')
		.join(', ');

/**
 * @param {MyAccountInput} input
 */
export const mountMyAccount = ({ host, win, config, session }) => {
	const t = textsOf(config);
	// dates and money in the website's Format and business time zone, for this browser (PLAN 0.8.10 K7)
	const when = datesOf(config, win);
	const { settings } = config;
	/** @param {string} feature */
	const on = (feature) => config.features.includes(feature);

	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const make = fieldMaker(doc, 'ss-account');
			const box = element(doc, 'section', { class: 'box' });
			root.append(box);
			let generation = 0;

			/** @param {string} text @param {Record<string, string>} [attributes] */
			const button = (text, attributes = {}) => element(doc, 'button', { type: 'button', ...attributes }, text);
			/** @param {string} text @param {string} [className] */
			const para = (text, className = '') => element(doc, 'p', className ? { class: className } : {}, text);
			/** A part of the page with its title and status line (append the status line last). @param {string} title */
			const part = (title) => {
				const section = element(doc, 'section', { class: 'part' });
				section.append(element(doc, 'h3', {}, title));
				return { section, note: element(doc, 'p', { class: 'status', role: 'status' }) };
			};
			/** Run a call while its button is disabled. @param {Element} trigger @param {() => Promise<void>} task */
			const run = async (trigger, task) => {
				trigger.setAttribute('disabled', '');
				try {
					await task();
				} finally {
					trigger.removeAttribute('disabled');
				}
			};
			/** A labelled password field. @param {string} label @param {string} autocomplete */
			const passwordField = (label, autocomplete) =>
				make.field('input', label, {
					type: 'password',
					autocomplete,
					...(autocomplete === 'new-password' ? { minlength: String(settings.passwordMinLength) } : {}),
				});
			/** The two-step code field. */
			const codeField = () =>
				make.field('input', t('twoStep.code'), { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' });

			// ------------------------------------------------------------------------------------------- parts

			/** @param {Record<string, any>} user */
			const termsPart = (user) => {
				const { section, note } = part(t('account.termsTitle'));
				const terms = termsBox(doc, t, settings.terms);
				const accept = button(t('account.termsAccept'));
				section.append(para(t('account.termsAsk')), terms.wrap, accept, note);
				accept.addEventListener('click', () => {
					if (!terms.input.checked) {
						note.textContent = t('terms.tick');
						return;
					}
					void run(accept, async () => {
						const answer = await session.me('POST', '/v1/me/terms', { accept: true });
						if (!answer.ok) {
							note.textContent = errorText(t, answer, when);
							return;
						}
						if (answer.data?.id) session.setUser(answer.data);
						else session.setUser({ ...user, terms: { version: settings.terms?.version } });
						setHidden(terms.wrap, true);
						setHidden(accept, true);
						note.textContent = t('account.termsDone');
					});
				});
				return section;
			};

			/** @param {Record<string, any>} user */
			const profilePart = (user) => {
				const { section, note } = part(t('account.profile'));
				if (user.email) section.append(para(formatText(t('account.email'), { email: user.email }), 'meta'));
				if (user.phone) section.append(para(formatText(t('account.phone'), { phone: user.phone }), 'meta'));
				const form = element(doc, 'form');
				const name = make.field('input', t('fields.name'), { autocomplete: 'name', maxlength: '120' });
				name.input.value = user.name ?? '';
				const custom = customInputs(doc, make, t, settings.customFields, { values: user.custom ?? {} });
				const save = element(doc, 'button', { type: 'submit' }, t('account.save'));
				form.append(name.wrap, ...custom.nodes, save);
				section.append(form, note);
				form.addEventListener('submit', (event) => {
					event.preventDefault();
					void run(save, async () => {
						const answer = await session.me('PATCH', '/v1/me', {
							name: name.input.value.trim(),
							...(settings.customFields.length > 0 ? { custom: custom.read(true) } : {}),
						});
						if (answer.ok) session.setUser(answer.data);
						note.textContent = answer.ok ? t('account.saved') : errorText(t, answer, when);
					});
				});
				return section;
			};

			/** @param {Record<string, any>} user */
			const addressesPart = (user) => {
				const { section, note } = part(t('account.addresses'));
				/** @type {Array<Record<string, any>>} */
				let addresses = Array.isArray(user.addresses) ? user.addresses : [];
				const list = element(doc, 'ul');
				const area = element(doc, 'div');
				const add = button(t('account.addressAdd'), { class: 'secondary' });
				section.append(list, area, add, note);

				/** @param {Array<Record<string, any>>} next @returns {Promise<boolean>} */
				const save = async (next) => {
					const answer = await session.me('PATCH', '/v1/me', { addresses: next });
					if (!answer.ok) {
						note.textContent = errorText(t, answer, when);
						return false;
					}
					addresses = Array.isArray(answer.data?.addresses) ? answer.data.addresses : next;
					session.setUser(answer.data);
					note.textContent = t('account.saved');
					area.replaceChildren();
					paint();
					return true;
				};

				/** @param {Record<string, any> | null} address null: a new one */
				const edit = (address) => {
					const form = element(doc, 'form');
					const fields = ADDRESS_FIELDS.map(([key, max]) => {
						const made = make.field('input', t(`address.${key}`), {
							maxlength: String(max),
							...(key === 'line1' || key === 'city' ? { required: '' } : {}),
						});
						made.input.value = address?.[key] ?? '';
						return /** @type {const} */ ([key, made]);
					});
					const submit = element(doc, 'button', { type: 'submit' }, t('account.addressSave'));
					const cancel = button(t('account.cancel'), { class: 'secondary' });
					cancel.addEventListener('click', () => area.replaceChildren());
					form.append(...fields.map(([, made]) => made.wrap), submit, cancel);
					form.addEventListener('submit', (event) => {
						event.preventDefault();
						/** @type {Record<string, string>} */
						const values = Object.fromEntries(fields.map(([key, made]) => [key, made.input.value.trim()]));
						const next = address
							? addresses.map((each) => (each.id === address.id ? { ...each, ...values } : each))
							: [...addresses, values];
						void run(submit, async () => {
							await save(next);
						});
					});
					area.replaceChildren(form);
				};

				const paint = () => {
					list.replaceChildren(
						...(addresses.length === 0
							? [element(doc, 'li', {}, t('account.noAddresses'))]
							: addresses.map((address) => {
									const item = element(doc, 'li', {}, addressLine(address));
									const change = button(t('account.edit'), { class: 'secondary small' });
									const remove = button(t('account.remove'), { class: 'secondary small' });
									change.addEventListener('click', () => edit(address));
									remove.addEventListener('click', () =>
										run(remove, async () => {
											await save(addresses.filter((each) => each !== address));
										}),
									);
									const actions = element(doc, 'div', { class: 'actions' });
									actions.append(change, remove);
									item.append(actions);
									return item;
								})),
					);
				};
				add.addEventListener('click', () => edit(null));
				paint();
				return section;
			};

			/** @param {Record<string, any>} user */
			const passwordPart = (user) => {
				const { section, note } = part(t('account.password'));
				const form = element(doc, 'form');
				const current = user.hasPassword ? passwordField(t('account.currentPassword'), 'current-password') : null;
				const next = passwordField(t('account.newPassword'), 'new-password');
				next.input.setAttribute('required', '');
				const submit = element(
					doc,
					'button',
					{ type: 'submit' },
					t(user.hasPassword ? 'account.passwordChange' : 'account.passwordSet'),
				);
				form.append(...(current ? [current.wrap] : []), next.wrap, submit);
				section.append(form, note);
				form.addEventListener('submit', (event) => {
					event.preventDefault();
					void run(submit, async () => {
						const answer = await session.me('PUT', '/v1/me/password', {
							...(current ? { current: current.input.value } : {}),
							password: next.input.value,
						});
						note.textContent = answer.ok ? t('account.passwordSaved') : errorText(t, answer, when);
						if (answer.ok) /** @type {HTMLFormElement} */ (form).reset();
					});
				});
				return section;
			};

			/** @param {Record<string, any>} user */
			const twoStepPart = (user) => {
				const { section, note } = part(t('account.twoStep'));
				const area = element(doc, 'div');
				section.append(area, note);
				let enabled = user.twoStep === true;

				const paint = () => {
					if (enabled) {
						const code = codeField();
						const off = button(t('account.twoStepTurnOff'), { class: 'secondary' });
						area.replaceChildren(para(t('account.twoStepIsOn')), code.wrap, off);
						off.addEventListener('click', () =>
							run(off, async () => {
								const answer = await session.me('POST', '/v1/me/two-step/disable', { code: code.input.value.trim() });
								if (answer.ok) {
									enabled = false;
									paint();
								}
								note.textContent = answer.ok ? t('account.twoStepTurnedOff') : errorText(t, answer, when);
							}),
						);
						return;
					}
					const turnOn = button(t('account.twoStepTurnOn'));
					area.replaceChildren(para(t('account.twoStepIsOff')), turnOn);
					turnOn.addEventListener('click', () =>
						run(turnOn, async () => {
							const answer = await session.me('POST', '/v1/me/two-step/setup');
							note.textContent = answer.ok ? '' : errorText(t, answer, when);
							if (answer.ok) setup(answer.data);
						}),
					);
				};

				/** @param {Record<string, any>} data */
				const setup = (data) => {
					const code = codeField();
					const confirm = button(t('account.twoStepConfirm'));
					const cancel = button(t('account.cancel'), { class: 'secondary' });
					cancel.addEventListener('click', paint);
					area.replaceChildren(
						para(t('twoStep.setupHelp')),
						para(formatText(t('twoStep.secret'), { secret: String(data.secret ?? '') }), 'code'),
						para(String(data.otpauthUrl ?? ''), 'code'),
						code.wrap,
						confirm,
						cancel,
					);
					confirm.addEventListener('click', () =>
						run(confirm, async () => {
							const answer = await session.me('POST', '/v1/me/two-step/enable', {
								challenge: data.challenge,
								code: code.input.value.trim(),
							});
							if (!answer.ok) {
								note.textContent = errorText(t, answer, when);
								return;
							}
							enabled = true;
							note.textContent = t('account.twoStepTurnedOn');
							const list = element(doc, 'ul', { class: 'codes' });
							/** @type {unknown[]} */
							const codes = Array.isArray(answer.data?.recoveryCodes) ? answer.data.recoveryCodes : [];
							list.append(...codes.map((each) => element(doc, 'li', { class: 'code' }, String(each))));
							const done = button(t('recovery.done'));
							done.addEventListener('click', paint);
							area.replaceChildren(element(doc, 'h4', {}, t('recovery.title')), para(t('recovery.help')), list, done);
						}),
					);
				};
				paint();
				return section;
			};

			const devicesPart = () => {
				const { section, note } = part(t('account.devices'));
				const list = element(doc, 'ul');
				const everywhere = button(t('account.signOutEverywhere'), { class: 'secondary' });
				section.append(list, everywhere, note);
				const load = async () => {
					const answer = await session.me('GET', '/v1/me/sessions');
					if (!answer.ok) {
						note.textContent = errorText(t, answer, when);
						return;
					}
					/** @type {Array<Record<string, any>>} */
					const items = Array.isArray(answer.data?.items) ? answer.data.items : [];
					list.replaceChildren(
						...items.map((device) => {
							const item = element(doc, 'li', {}, device.device || t('account.unknownDevice'));
							item.append(
								element(
									doc,
									'span',
									{ class: 'meta' },
									[
										formatText(t('account.signedInWith'), { method: t(`method.${device.method}`) }),
										formatText(t('account.lastUsed'), { time: when(device.lastUsedAt ?? device.signedInAt) }),
									].join(' · '),
								),
							);
							if (device.current) item.append(element(doc, 'span', { class: 'tag' }, t('account.thisDevice')));
							else {
								const out = button(t('account.signOutDevice'), { class: 'secondary small' });
								out.addEventListener('click', () =>
									run(out, async () => {
										const done = await session.me('DELETE', `/v1/me/sessions/${encodeURIComponent(device.id)}`);
										note.textContent = done.ok ? t('account.deviceSignedOut') : errorText(t, done, when);
										if (done.ok) await load();
									}),
								);
								item.append(out);
							}
							return item;
						}),
					);
				};
				everywhere.addEventListener('click', () =>
					run(everywhere, async () => {
						const answer = await session.me('POST', '/v1/me/sign-out-everywhere');
						if (answer.ok) session.forget();
						else note.textContent = errorText(t, answer, when);
					}),
				);
				void load();
				return section;
			};

			/** @param {{ dueAt?: string | null }} deletion */
			const deletionText = (deletion) =>
				deletion.dueAt
					? formatText(t('account.deletionDue'), { date: when(deletion.dueAt, 'date') })
					: t('account.deletionWaiting');

			/** @param {Record<string, any>} user */
			const privacyPart = (user) => {
				const { section, note } = part(t('account.privacy'));
				const download = button(t('account.export'), { class: 'secondary' });
				const link = element(doc, 'p');
				const deletion = element(doc, 'div');
				section.append(para(t('account.exportHelp')), download, link, deletion, note);
				download.addEventListener('click', () =>
					run(download, async () => {
						const answer = await session.me('POST', '/v1/me/export');
						const url = answer.ok ? webAddress(answer.data?.url) : null;
						if (!url) {
							note.textContent = errorText(t, answer, when);
							return;
						}
						note.textContent = '';
						link.replaceChildren(
							element(doc, 'a', { href: url, rel: 'noopener noreferrer', download: '' }, t('account.exportLink')),
							element(
								doc,
								'span',
								{ class: 'meta' },
								formatText(t('account.exportExpires'), { time: when(answer.data.expiresAt) }),
							),
						);
					}),
				);
				const paint = () => {
					if (user.deletion) {
						deletion.replaceChildren(para(deletionText(user.deletion)));
						return;
					}
					const ask = button(t('account.delete'), { class: 'secondary danger' });
					ask.addEventListener('click', () => {
						const yes = button(t('account.deleteYes'), { class: 'danger' });
						const no = button(t('account.deleteNo'), { class: 'secondary' });
						no.addEventListener('click', paint);
						yes.addEventListener('click', () =>
							run(yes, async () => {
								const answer = await session.me('POST', '/v1/me/delete');
								if (!answer.ok) {
									note.textContent = errorText(t, answer, when);
									return;
								}
								deletion.replaceChildren(para(deletionText(answer.data ?? {})));
							}),
						);
						deletion.replaceChildren(para(t('account.deleteConfirm')), yes, no);
					});
					deletion.replaceChildren(para(t('account.deleteHelp')), ask);
				};
				paint();
				return section;
			};

			const ordersPart = () => {
				const { section, note } = part(t('account.orders'));
				const list = element(doc, 'ul');
				section.append(list, note);
				void (async () => {
					const answer = await session.me('GET', '/v1/me/orders');
					if (!answer.ok) {
						note.textContent = t('account.ordersFailed');
						return;
					}
					/** @type {unknown[]} */
					const items = Array.isArray(answer.data?.items) ? answer.data.items : [];
					if (items.length === 0) note.textContent = t('account.ordersEmpty');
					list.replaceChildren(
						...items.map((raw) => {
							const order = /** @type {Record<string, unknown>} */ (typeof raw === 'object' && raw !== null ? raw : {});
							const item = element(
								doc,
								'li',
								{},
								formatText(t('account.order'), { number: String(order.number ?? order.id ?? '') }),
							);
							// the amount in this website's Format; else the text Ecommerce made
							const total =
								moneyText(config, win, order.total, order.currency) ??
								[order.totalText, order.total].find((value) => typeof value === 'string' || typeof value === 'number');
							// Ecommerce's statuses are merchant-defined: its label first, else the status key
							const status =
								typeof order.statusLabel === 'string' && order.statusLabel !== ''
									? order.statusLabel
									: typeof order.status === 'string'
										? (config.texts[`order.${order.status}`] ?? order.status)
										: '';
							item.append(
								element(
									doc,
									'span',
									{ class: 'meta' },
									[status, total === undefined ? '' : String(total), when(order.createdAt)]
										.filter((part) => part !== '')
										.join(' · '),
								),
							);
							return item;
						}),
					);
				})();
				return section;
			};

			// ------------------------------------------------------------------------------------------- page

			/** @param {Record<string, any>} user */
			const paint = (user) => {
				const parts = [];
				if (on('terms') && settings.terms && user.terms?.version !== settings.terms.version) parts.push(termsPart(user));
				parts.push(profilePart(user), addressesPart(user));
				if (on('email_password') && user.email) parts.push(passwordPart(user));
				if (on('two_step')) parts.push(twoStepPart(user));
				parts.push(devicesPart());
				if (on('data_rights')) parts.push(privacyPart(user));
				if (on('orders_tab')) parts.push(ordersPart());
				box.replaceChildren(element(doc, 'h2', {}, t('account.title')), ...parts);
			};

			const draw = async () => {
				generation += 1;
				const mine = generation;
				const title = element(doc, 'h2', {}, t('account.title'));
				if (!session.user()) {
					box.replaceChildren(title, element(doc, 'p', { class: 'status', role: 'status' }, t('account.signedOut')));
					return;
				}
				box.replaceChildren(title, element(doc, 'p', { class: 'status', role: 'status' }, t('account.loading')));
				const answer = await session.me('GET', '/v1/me');
				if (mine !== generation) return;
				if (answer.ok) paint(answer.data);
				else
					box.replaceChildren(
						title,
						element(
							doc,
							'p',
							{ class: 'status', role: 'status' },
							session.user() ? t('account.failed') : t('account.signedOut'),
						),
					);
			};

			const off = session.onChange((change) => {
				if (change !== 'user') void draw();
			});
			void draw();
			return () => void off();
		},
	});
};
