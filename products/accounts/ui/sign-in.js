/**
 * The visitor widget `sign_in` (PLAN 0.8.6): the switched-on sign-in methods (e-mail + password with sign-up and
 * Forgot password, phone code, e-mail code, Google, Apple, Facebook), the two-step step (code, recovery code or the
 * first setup), the pages Accounts links to (password reset, invite, magic link, a social sign-in's hand-over) and,
 * once signed in, "Signed in as …" with Sign out.
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { PROVIDERS } from '../core/widgets.js';
import {
	customInputs,
	datesOf,
	errorText,
	fieldMaker,
	problemCode,
	say,
	setHidden,
	termsBox,
	textsOf,
	webAddress,
} from './common.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';

/** The methods with a form, in the order of their tabs. */
const FORM_METHODS = /** @type {const} */ (['email_password', 'phone_code', 'email_code']);

/** @typedef {{ kind: 'handoff' | 'magic' | 'reset' | 'invite' | 'error', value: string }} Link */
/** @typedef {import('./common.js').Answer} Answer */

/**
 * @typedef {object} SignInInput
 * @property {HTMLElement} host
 * @property {Window & typeof globalThis} win
 * @property {import('./widget.js').WidgetConfig} config
 * @property {import('./session.js').Session} session
 * @property {Link | null} [link] the link this page was opened with (only the first sign-in widget gets it)
 */

/**
 * @param {SignInInput} input
 */
export const mountSignIn = ({ host, win, config, session, link = null }) => {
	const t = textsOf(config);
	// dates in the website's Format and business time zone, for this browser (PLAN 0.8.10 K7)
	const when = datesOf(config, win);
	const { settings } = config;
	/** @param {string} feature */
	const on = (feature) => config.features.includes(feature);
	const methods = FORM_METHODS.filter(on);
	const providers = PROVIDERS.filter(on);
	const signUpOpen = settings.signUp.mode !== 'invite';
	/** @param {'name' | 'email' | 'phone'} name */
	const required = (name) => settings.signUp.requiredFields.includes(name);
	const returnTo = () => win.location.href.split('#')[0];

	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const make = fieldMaker(doc, 'ss-sign-in');
			const box = element(doc, 'section', { class: 'box' });
			root.append(box);
			/** One "Remember me" box: it keeps its choice from view to view. */
			const remember = make.check(t('signIn.remember'));
			/** @type {(typeof methods)[number] | undefined} */
			let method = methods[0];
			let signUp = false;
			/** @type {string[] | null} recovery codes to show once */
			let recovery = null;
			let showing = '';

			/** @param {string} text @param {Record<string, string>} [attributes] */
			const button = (text, attributes = {}) => element(doc, 'button', { type: 'button', ...attributes }, text);
			/** @param {string} text @param {string} [className] */
			const para = (text, className = '') => element(doc, 'p', className ? { class: className } : {}, text);

			/**
			 * Show one view: its title, its nodes and a status line (returned).
			 * @param {string} name @param {string} title @param {Node[]} nodes @param {string} [message]
			 */
			const view = (name, title, nodes, message = '') => {
				showing = name;
				const note = element(doc, 'p', { class: 'status', role: 'status' }, message);
				box.replaceChildren(element(doc, 'h2', {}, title), ...nodes, note);
				return note;
			};

			/**
			 * Run a call while its button is disabled.
			 * @param {Element} trigger @param {HTMLElement} note @param {() => Promise<void>} task
			 */
			const run = async (trigger, note, task) => {
				trigger.setAttribute('disabled', '');
				say(note, t('signIn.working'));
				try {
					await task();
				} finally {
					trigger.removeAttribute('disabled');
				}
			};

			/** The fields every sign-in call sends. */
			const extras = () => ({ remember: remember.input.checked, deviceId: session.deviceId() });

			/**
			 * Carry on after an answer of a sign-in call.
			 * @param {Answer} answer @param {HTMLElement} note
			 * @param {ReturnType<typeof termsBox> | null} terms shown when the terms must be accepted first
			 */
			const handle = (answer, note, terms) => {
				if (!answer.ok) {
					if (terms && problemCode(answer.data) === 'terms_required') {
						terms.point(answer.data?.url ?? settings.terms?.url);
						setHidden(terms.wrap, false);
					}
					say(note, errorText(t, answer, when));
					return;
				}
				const data = answer.data ?? {};
				if (data.status === 'signed_in') {
					recovery = Array.isArray(data.recoveryCodes) && data.recoveryCodes.length > 0 ? data.recoveryCodes : null;
					// the session tells every widget, which shows the recovery codes or "Signed in as …"
					session.accept(data);
				} else if (data.status === 'two_step' || data.status === 'two_step_setup') twoStep(data);
				else if (data.status === 'pending') pending();
				else say(note, t('error.generic'));
			};

			// ------------------------------------------------------------------------------------------- views

			/** @param {string} [message] */
			const home = (message = '') => {
				if (recovery) return showRecovery();
				const user = session.user();
				if (user) return signedIn(user);
				return start(message);
			};

			/** @param {Record<string, any>} user */
			const signedIn = (user) => {
				const out = button(t('signIn.signOut'), { class: 'secondary' });
				const note = view('signed-in', t('signedIn.title'), [
					para(formatText(t('signedIn.as'), { name: user.name || user.email || user.phone || '' })),
					out,
				]);
				out.addEventListener('click', () => void run(out, note, () => session.signOut()));
			};

			const showRecovery = () => {
				const list = element(doc, 'ul', { class: 'codes' });
				list.append(...(recovery ?? []).map((code) => element(doc, 'li', { class: 'code' }, code)));
				const done = button(t('recovery.done'));
				done.addEventListener('click', () => {
					recovery = null;
					home();
				});
				view('recovery', t('recovery.title'), [para(t('recovery.help')), list, done]);
			};

			/** @param {string} [message] */
			const start = (message = '') => {
				/** @type {Node[]} */
				const nodes = [];
				if (methods.length > 1) {
					const tabs = element(doc, 'div', { class: 'tabs', role: 'group' });
					for (const each of methods) {
						const tab = button(t(`method.${each}`), {
							class: 'tab',
							'aria-pressed': String(each === method),
						});
						tab.addEventListener('click', () => {
							method = each;
							start();
						});
						tabs.append(tab);
					}
					nodes.push(tabs);
				}
				const area = element(doc, 'div');
				nodes.push(area, remember.wrap);
				/** @type {HTMLElement[]} */
				const socials = providers.map((provider) => button(t(`social.${provider}`), { class: 'secondary social' }));
				if (socials.length > 0) {
					const group = element(doc, 'div', { class: 'socials' });
					if (methods.length > 0) group.append(para(t('signIn.or'), 'meta'));
					group.append(...socials);
					nodes.push(group);
				}
				const note = view(
					'start',
					t(signUp && method === 'email_password' ? 'signUp.title' : 'signIn.title'),
					nodes,
					message,
				);
				providers.forEach((provider, index) => {
					const trigger = /** @type {HTMLElement} */ (socials[index]);
					trigger.addEventListener('click', () =>
						run(trigger, note, async () => {
							const answer = await session.call('POST', `/v1/sign-in/${provider}/start`, {
								returnTo: returnTo(),
								...extras(),
							});
							const url = answer.ok ? webAddress(answer.data?.url) : null;
							if (url) win.location.assign(url);
							else say(note, errorText(t, answer, when));
						}),
					);
				});
				if (method === 'email_password') passwordForm(area, note);
				else if (method) codeForm(area, note, method === 'phone_code' ? 'phone' : 'email');
			};

			/** @param {HTMLElement} area @param {HTMLElement} note */
			const passwordForm = (area, note) => {
				const form = element(doc, 'form');
				const creating = signUp && signUpOpen;
				const email = make.field('input', t('fields.email'), {
					type: 'email',
					autocomplete: 'email',
					maxlength: '254',
					required: '',
				});
				const password = make.field('input', t('fields.password'), {
					type: 'password',
					autocomplete: creating ? 'new-password' : 'current-password',
					required: '',
					...(creating ? { minlength: String(settings.passwordMinLength) } : {}),
				});
				const terms = termsBox(doc, t, settings.terms);
				setHidden(terms.wrap, !(creating && settings.terms));
				const submit = element(doc, 'button', { type: 'submit' }, t(creating ? 'signUp.submit' : 'signIn.submit'));
				if (creating) {
					const name = make.field('input', t('fields.name'), {
						autocomplete: 'name',
						maxlength: '120',
						...(required('name') ? { required: '' } : {}),
					});
					const phone = required('phone')
						? make.field('input', t('fields.phone'), { type: 'tel', autocomplete: 'tel', required: '' })
						: null;
					const custom = customInputs(doc, make, t, settings.customFields, { required: true });
					if (settings.terms) terms.input.setAttribute('required', '');
					form.append(
						name.wrap,
						email.wrap,
						...(phone ? [phone.wrap] : []),
						...custom.nodes,
						password.wrap,
						terms.wrap,
						submit,
					);
					form.addEventListener('submit', (event) => {
						event.preventDefault();
						const values = custom.read();
						void run(submit, note, async () =>
							handle(
								await session.call('POST', '/v1/sign-up/password', {
									email: email.input.value.trim(),
									password: password.input.value,
									...(name.input.value.trim() ? { name: name.input.value.trim() } : {}),
									...(phone?.input.value.trim() ? { phone: phone.input.value.trim() } : {}),
									...(Object.keys(values).length > 0 ? { custom: values } : {}),
									acceptTerms: terms.input.checked,
									...extras(),
								}),
								note,
								terms,
							),
						);
					});
				} else {
					const forgot = button(t('signIn.forgot'), { class: 'link' });
					forgot.addEventListener('click', () => forgotView(email.input.value));
					form.append(email.wrap, password.wrap, terms.wrap, submit, forgot);
					form.addEventListener('submit', (event) => {
						event.preventDefault();
						void run(submit, note, async () =>
							handle(
								await session.call('POST', '/v1/sign-in/password', {
									email: email.input.value.trim(),
									password: password.input.value,
									acceptTerms: terms.input.checked,
									...extras(),
								}),
								note,
								terms,
							),
						);
					});
				}
				const nodes = [form];
				if (signUpOpen) {
					const toggle = button(t(creating ? 'signUp.toSignIn' : 'signIn.toSignUp'), { class: 'link' });
					toggle.addEventListener('click', () => {
						signUp = !creating;
						start();
					});
					nodes.push(toggle);
				}
				area.replaceChildren(...nodes);
			};

			/**
			 * Ask for a code by SMS/WhatsApp or e-mail.
			 * @param {'phone' | 'email'} kind @param {string} value
			 */
			const requestCode = (kind, value) =>
				kind === 'phone'
					? session.call('POST', '/v1/sign-in/phone/code', { phone: value })
					: session.call('POST', '/v1/sign-in/email/code', { email: value, returnTo: returnTo() });

			/** @param {HTMLElement} area @param {HTMLElement} note @param {'phone' | 'email'} kind */
			const codeForm = (area, note, kind) => {
				const form = element(doc, 'form');
				const target =
					kind === 'phone'
						? make.field('input', t('fields.phone'), { type: 'tel', autocomplete: 'tel', maxlength: '40', required: '' })
						: make.field('input', t('fields.email'), {
								type: 'email',
								autocomplete: 'email',
								maxlength: '254',
								required: '',
							});
				const send = element(doc, 'button', { type: 'submit' }, t('code.send'));
				form.append(target.wrap, send);
				form.addEventListener('submit', (event) => {
					event.preventDefault();
					const value = target.input.value.trim();
					void run(send, note, async () => {
						const answer = await requestCode(kind, value);
						if (answer.ok) codeStep(area, note, kind, value);
						else say(note, errorText(t, answer, when));
					});
				});
				area.replaceChildren(form);
			};

			/**
			 * The code step; a new user also gives the sign-up details here (a code works once).
			 * @param {HTMLElement} area @param {HTMLElement} note @param {'phone' | 'email'} kind @param {string} value
			 */
			const codeStep = (area, note, kind, value) => {
				const sent = formatText(t(kind === 'phone' ? 'code.sentPhone' : 'code.sentEmail'), { to: value });
				say(note, sent);
				const form = element(doc, 'form');
				const code = make.field('input', t('code.code'), {
					inputmode: 'numeric',
					autocomplete: 'one-time-code',
					maxlength: '12',
					required: '',
				});
				form.append(code.wrap);
				const other = kind === 'phone' ? 'email' : 'phone';
				/** @type {() => Record<string, unknown>} */
				let profile = () => ({});
				if (signUpOpen) {
					const name = make.field('input', t('fields.name'), { autocomplete: 'name', maxlength: '120' });
					const extra = required(other)
						? make.field(
								'input',
								t(other === 'email' ? 'fields.email' : 'fields.phone'),
								other === 'email' ? { type: 'email', autocomplete: 'email' } : { type: 'tel', autocomplete: 'tel' },
							)
						: null;
					const custom = customInputs(doc, make, t, settings.customFields);
					const details = element(doc, 'div', { class: 'details' });
					details.append(para(t('code.newHere'), 'meta'), name.wrap, ...(extra ? [extra.wrap] : []), ...custom.nodes);
					form.append(details);
					profile = () => {
						const values = custom.read();
						return {
							...(name.input.value.trim() ? { name: name.input.value.trim() } : {}),
							...(extra?.input.value.trim() ? { [other]: extra.input.value.trim() } : {}),
							...(Object.keys(values).length > 0 ? { custom: values } : {}),
						};
					};
				}
				const terms = termsBox(doc, t, settings.terms);
				setHidden(terms.wrap, !settings.terms);
				const submit = element(doc, 'button', { type: 'submit' }, t('code.submit'));
				const again = button(t('code.again'), { class: 'link' });
				const back = button(t('code.back'), { class: 'link' });
				form.append(terms.wrap, submit, again, back);
				form.addEventListener('submit', (event) => {
					event.preventDefault();
					void run(submit, note, async () =>
						handle(
							await session.call('POST', kind === 'phone' ? '/v1/sign-in/phone' : '/v1/sign-in/email', {
								[kind]: value,
								code: code.input.value.trim(),
								...profile(),
								acceptTerms: terms.input.checked,
								...extras(),
							}),
							note,
							terms,
						),
					);
				});
				again.addEventListener('click', () =>
					run(again, note, async () => {
						const answer = await requestCode(kind, value);
						say(note, answer.ok ? sent : errorText(t, answer, when));
					}),
				);
				back.addEventListener('click', () => codeForm(area, note, kind));
				area.replaceChildren(form);
			};

			/** @param {Record<string, any>} data a `two_step` or `two_step_setup` answer */
			const twoStep = (data) => {
				const setup = data.status === 'two_step_setup';
				const form = element(doc, 'form');
				const code = make.field('input', t('twoStep.code'), {
					autocomplete: 'one-time-code',
					maxlength: '20',
					required: '',
				});
				const label = /** @type {HTMLElement} */ (code.wrap.firstChild);
				let useRecovery = false;
				const submit = element(doc, 'button', { type: 'submit' }, t('twoStep.submit'));
				if (setup)
					form.append(
						para(t('twoStep.setupHelp')),
						para(formatText(t('twoStep.secret'), { secret: String(data.secret ?? '') }), 'code'),
						para(String(data.otpauthUrl ?? ''), 'code'),
					);
				else form.append(para(t('twoStep.help')));
				form.append(code.wrap, submit);
				if (!setup) {
					const toggle = button(t('twoStep.useRecovery'), { class: 'link' });
					toggle.addEventListener('click', () => {
						useRecovery = !useRecovery;
						label.textContent = t(useRecovery ? 'twoStep.recoveryCode' : 'twoStep.code');
						toggle.textContent = t(useRecovery ? 'twoStep.useCode' : 'twoStep.useRecovery');
						code.input.value = '';
					});
					form.append(toggle);
				}
				const back = button(t('signIn.back'), { class: 'link' });
				back.addEventListener('click', () => start());
				form.append(back);
				const note = view('two-step', t('twoStep.title'), [form]);
				form.addEventListener('submit', (event) => {
					event.preventDefault();
					const value = code.input.value.trim();
					void run(submit, note, async () =>
						handle(
							await session.call('POST', '/v1/sign-in/two-step', {
								challenge: data.challenge,
								...(useRecovery ? { recoveryCode: value } : { code: value }),
							}),
							note,
							null,
						),
					);
				});
			};

			const pending = () => {
				const back = button(t('signIn.back'), { class: 'secondary' });
				back.addEventListener('click', () => start());
				view('pending', t('pending.title'), [para(t('pending.text')), back]);
			};

			/** @param {string} prefill */
			const forgotView = (prefill) => {
				const form = element(doc, 'form');
				const email = make.field('input', t('fields.email'), { type: 'email', autocomplete: 'email', required: '' });
				email.input.value = prefill;
				const submit = element(doc, 'button', { type: 'submit' }, t('forgot.submit'));
				const back = button(t('signIn.back'), { class: 'link' });
				back.addEventListener('click', () => start());
				form.append(para(t('forgot.help')), email.wrap, submit, back);
				const note = view('forgot', t('forgot.title'), [form]);
				form.addEventListener('submit', (event) => {
					event.preventDefault();
					void run(submit, note, async () => {
						const answer = await session.call('POST', '/v1/password/forgot', {
							email: email.input.value.trim(),
							returnTo: returnTo(),
						});
						say(note, answer.ok ? t('forgot.sent') : errorText(t, answer, when));
					});
				});
			};

			/** @param {string} token */
			const resetView = (token) => {
				const form = element(doc, 'form');
				const password = make.field('input', t('reset.password'), {
					type: 'password',
					autocomplete: 'new-password',
					minlength: String(settings.passwordMinLength),
					required: '',
				});
				const submit = element(doc, 'button', { type: 'submit' }, t('reset.submit'));
				form.append(password.wrap, submit);
				const note = view('reset', t('reset.title'), [form]);
				form.addEventListener('submit', (event) => {
					event.preventDefault();
					void run(submit, note, async () => {
						const answer = await session.call('POST', '/v1/password/reset', { token, password: password.input.value });
						if (answer.ok) {
							method = methods.includes('email_password') ? 'email_password' : method;
							signUp = false;
							start(t('reset.done'));
						} else say(note, errorText(t, answer, when));
					});
				});
			};

			/** @param {string} token */
			const inviteView = (token) => {
				const form = element(doc, 'form');
				const name = make.field('input', t('fields.name'), { autocomplete: 'name', maxlength: '120' });
				const password = on('email_password')
					? make.field('input', t('invite.password'), {
							type: 'password',
							autocomplete: 'new-password',
							minlength: String(settings.passwordMinLength),
						})
					: null;
				const terms = termsBox(doc, t, settings.terms);
				setHidden(terms.wrap, !settings.terms);
				const submit = element(doc, 'button', { type: 'submit' }, t('invite.submit'));
				form.append(
					para(t('invite.help')),
					name.wrap,
					...(password ? [password.wrap] : []),
					terms.wrap,
					remember.wrap,
					submit,
				);
				const note = view('invite', t('invite.title'), [form]);
				form.addEventListener('submit', (event) => {
					event.preventDefault();
					void run(submit, note, async () =>
						handle(
							await session.call('POST', '/v1/invites/accept', {
								token,
								...(name.input.value.trim() ? { name: name.input.value.trim() } : {}),
								...(password?.input.value ? { password: password.input.value } : {}),
								acceptTerms: terms.input.checked,
								...extras(),
							}),
							note,
							terms,
						),
					);
				});
			};

			/**
			 * A sign-in from a link: a social sign-in's hand-over code or a magic link.
			 * @param {'handoff' | 'magic'} kind @param {string} value @param {boolean} acceptTerms
			 */
			const linkSignIn = async (kind, value, acceptTerms) => {
				const note = view('link', t('signIn.title'), [], t('signIn.working'));
				const terms = acceptTerms ? { acceptTerms: true } : {};
				const answer =
					kind === 'handoff'
						? await session.call('POST', '/v1/sign-in/exchange', { code: value, ...terms })
						: await session.call('POST', '/v1/sign-in/email', { link: value, ...terms, ...extras() });
				if (!answer.ok && problemCode(answer.data) === 'terms_required')
					termsStep(answer.data, () => void linkSignIn(kind, value, true));
				else if (!answer.ok) start(errorText(t, answer, when));
				else handle(answer, note, null);
			};

			/** Accept the terms before a link sign-in goes on. @param {Record<string, any>} data @param {() => void} retry */
			const termsStep = (data, retry) => {
				const terms = termsBox(doc, t, data);
				const go = button(t('terms.continue'));
				const back = button(t('signIn.back'), { class: 'link' });
				back.addEventListener('click', () => start());
				const note = view('terms', t('terms.title'), [para(t('error.terms_required')), terms.wrap, go, back]);
				go.addEventListener('click', () => {
					if (terms.input.checked) retry();
					else say(note, t('terms.tick'));
				});
			};

			const off = session.onChange((change) => {
				if (change !== 'user' || showing === 'signed-in') home();
			});
			if (link?.kind === 'reset') resetView(link.value);
			else if (link?.kind === 'invite') inviteView(link.value);
			else if (link?.kind === 'handoff' || link?.kind === 'magic') void linkSignIn(link.kind, link.value, false);
			else if (link?.kind === 'error')
				home(errorText(t, { ok: false, status: 0, data: { type: `/problems/${link.value}` } }, when));
			else home();
			return () => void off();
		},
	});
};
