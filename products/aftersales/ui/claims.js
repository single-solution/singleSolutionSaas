/**
 * Mode A default renderer of the `claims` element: a pure function of (state, actions, strings, theme, slots) that
 * returns DOM built with the injected `dom` (the Loader passes `document`). Built only on headless/; design tokens only;
 * keyboard operable (native controls, labelled); announces changes politely; reserves its minimum height.
 * Variants: `full` (claim form and the shopper's claims), `form` (the form only) and `list` (the claims only).
 */
import { createTranslator } from '../headless/strings.js';
import { day, el } from './dom.js';

/** @typedef {import('../headless/claims.js').ClaimsState} ClaimsState */
/** @typedef {import('./dom.js').DomLike} DomLike */
/**
 * @typedef {object} RenderActions the headless actions the renderer uses
 * @property {(input: { number: string, email?: string, phone?: string }) => unknown} access
 * @property {(purchaseId: string) => unknown} selectPurchase
 * @property {(patch: Record<string, unknown>) => unknown} setDraft
 * @property {(file: { type: string, size: number, body: unknown }) => unknown} addPhoto
 * @property {(photoId: string) => unknown} removePhoto
 * @property {() => unknown} submit
 * @property {(claimId: string) => unknown} openClaim
 * @property {() => unknown} closeClaim
 * @property {(body: string) => unknown} sendMessage
 */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-claims { color: var(--ss-color-text); background: var(--ss-color-surface); border-radius: var(--ss-radius-md);
  font: var(--ss-font-body); padding: var(--ss-space-3); min-height: var(--ss-claims-min-height, 6rem); }
.ss-claims__list { list-style: none; margin: 0; padding: 0; }
.ss-claims__item { border-top: 1px solid var(--ss-color-border); padding: var(--ss-space-2) 0; }
.ss-claims__meta { color: var(--ss-color-text-muted); }
.ss-claims__field { display: grid; gap: var(--ss-space-1); margin-block: var(--ss-space-2); }
.ss-claims__button { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border-radius: var(--ss-radius-sm); }
.ss-claims__button--quiet { background: none; color: var(--ss-color-primary); }
.ss-claims button:focus-visible, .ss-claims select:focus-visible, .ss-claims input:focus-visible,
.ss-claims textarea:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-claims__error { color: var(--ss-color-danger); }
.ss-claims__notice { color: var(--ss-color-success); }
@media (prefers-reduced-motion: reduce) { .ss-claims * { transition: none; } }
`;

/**
 * @param {DomLike} dom
 * @param {string} id
 * @param {string} label
 * @param {any} control
 */
const field = (dom, id, label, control) =>
	el(dom, 'div', { class: 'ss-claims__field' }, [el(dom, 'label', { for: id }, [label]), control]);

/**
 * The guest form: order number and the e-mail or phone used.
 * @param {DomLike} dom
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 * @param {RenderActions} actions
 */
const accessForm = (dom, t, actions) => {
	/** @type {Record<string, string>} */
	const values = { number: '', email: '', phone: '' };
	const input = (/** @type {string} */ name, /** @type {string} */ type) =>
		el(dom, 'input', {
			id: `ss-claims-${name}`,
			name,
			type,
			autocomplete: name === 'number' ? 'off' : name === 'email' ? 'email' : 'tel',
			oninput: (/** @type {any} */ event) => {
				values[name] = String(event?.target?.value ?? '');
			},
		});
	return el(
		dom,
		'form',
		{
			class: 'ss-claims__access',
			'aria-label': t('claims.access.title'),
			onsubmit: (/** @type {any} */ event) => {
				event?.preventDefault?.();
				void actions.access({ number: values.number ?? '', email: values.email ?? '', phone: values.phone ?? '' });
			},
		},
		[
			el(dom, 'p', {}, [t('claims.access.intro')]),
			field(dom, 'ss-claims-number', t('claims.access.number'), input('number', 'text')),
			field(dom, 'ss-claims-email', t('claims.access.email'), input('email', 'email')),
			field(dom, 'ss-claims-phone', t('claims.access.phone'), input('phone', 'tel')),
			el(dom, 'button', { type: 'submit', class: 'ss-claims__button' }, [t('claims.access.submit')]),
		],
	);
};

/**
 * The claim form for the selected purchase.
 * @param {DomLike} dom
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 * @param {ClaimsState} state
 * @param {RenderActions} actions
 */
const claimForm = (dom, t, state, actions) => {
	const form = /** @type {Record<string, any>} */ (state.form);
	const purchase = state.purchases.find((entry) => entry.id === state.draft.purchaseId);
	const options = (/** @type {Array<Record<string, any>>} */ list, /** @type {string | null} */ current) => [
		el(dom, 'option', { value: '' }, [t('claims.form.choose')]),
		...list.map((entry) =>
			el(dom, 'option', { value: entry.key, ...(entry.key === current ? { selected: 'selected' } : {}) }, [entry.label]),
		),
	];
	const picker = el(
		dom,
		'select',
		{
			id: 'ss-claims-purchase',
			onchange: (/** @type {any} */ event) => actions.selectPurchase(String(event?.target?.value ?? '')),
		},
		[
			el(dom, 'option', { value: '' }, [t('claims.form.choose')]),
			...state.purchases
				.filter((entry) => entry.canClaim)
				.map((entry) =>
					el(dom, 'option', { value: entry.id, ...(entry.id === state.draft.purchaseId ? { selected: 'selected' } : {}) }, [
						t('claims.form.purchase_option', { number: entry.number ?? entry.id, date: day(entry.deliveredAt) }),
					]),
				),
		],
	);
	/** @type {any[]} */
	const body = [field(dom, 'ss-claims-purchase', t('claims.form.purchase'), picker)];
	if (purchase) {
		const type = /** @type {Array<Record<string, any>>} */ (form.types).find((entry) => entry.key === state.draft.type);
		const reasons = /** @type {Array<Record<string, any>>} */ (form.reasons).filter(
			(reason) => !type || reason.types.length === 0 || reason.types.includes(type.key),
		);
		body.push(
			field(
				dom,
				'ss-claims-type',
				t('claims.form.type'),
				el(
					dom,
					'select',
					{
						id: 'ss-claims-type',
						onchange: (/** @type {any} */ e) => actions.setDraft({ type: String(e?.target?.value ?? '') }),
					},
					options(form.types, state.draft.type),
				),
			),
			field(
				dom,
				'ss-claims-reason',
				t('claims.form.reason'),
				el(
					dom,
					'select',
					{
						id: 'ss-claims-reason',
						onchange: (/** @type {any} */ e) => actions.setDraft({ reason: String(e?.target?.value ?? '') }),
					},
					options(reasons, state.draft.reason),
				),
			),
		);
		const lines = /** @type {Array<Record<string, any>>} */ (purchase.lines).filter(
			(line) => line.claimable > 0 && (!type || line.windows[type.key]?.eligible === true),
		);
		body.push(
			el(dom, 'fieldset', {}, [
				el(dom, 'legend', {}, [t('claims.form.lines')]),
				lines.length === 0 ? el(dom, 'p', { class: 'ss-claims__meta' }, [t('claims.form.no_lines')]) : null,
				...lines.map((line) => {
					const id = `ss-claims-qty-${line.lineId}`;
					const closes = type ? line.windows[type.key]?.closesAt : null;
					return el(dom, 'div', { class: 'ss-claims__field' }, [
						el(dom, 'label', { for: id }, [
							`${line.title ?? line.itemId}${closes ? ` · ${t('claims.form.until', { date: day(closes) })}` : ''}`,
						]),
						el(dom, 'input', {
							id,
							type: 'number',
							min: '0',
							max: String(line.claimable),
							value: String(state.draft.quantities[line.lineId] ?? 0),
							onchange: (/** @type {any} */ e) =>
								actions.setDraft({ lineId: line.lineId, quantity: Number(e?.target?.value ?? 0) }),
						}),
						type?.requireSerial
							? field(
									dom,
									`ss-claims-serial-${line.lineId}`,
									t('claims.form.serial'),
									el(dom, 'input', {
										id: `ss-claims-serial-${line.lineId}`,
										value: state.draft.serials[line.lineId] ?? '',
										onchange: (/** @type {any} */ e) =>
											actions.setDraft({ lineId: line.lineId, serial: String(e?.target?.value ?? '') }),
									}),
								)
							: null,
					]);
				}),
			]),
			field(
				dom,
				'ss-claims-details',
				t('claims.form.details'),
				el(
					dom,
					'textarea',
					{
						id: 'ss-claims-details',
						rows: '3',
						maxlength: String(form.details.maxLength),
						onchange: (/** @type {any} */ e) => actions.setDraft({ details: String(e?.target?.value ?? '') }),
					},
					[state.draft.details],
				),
			),
		);
		if (form.photos.enabled)
			body.push(
				field(
					dom,
					'ss-claims-photo',
					t('claims.form.photos', { count: state.draft.photoIds.length, max: form.photos.max }),
					el(dom, 'input', {
						id: 'ss-claims-photo',
						type: 'file',
						accept: form.photos.types.join(','),
						...(state.draft.photoIds.length >= form.photos.max || state.upload === 'uploading'
							? { disabled: 'disabled' }
							: {}),
						onchange: (/** @type {any} */ e) => {
							const file = e?.target?.files?.[0];
							if (file) void actions.addPhoto({ type: file.type, size: file.size, body: file });
						},
					}),
				),
			);
		body.push(
			state.errors.length > 0
				? el(
						dom,
						'ul',
						{ class: 'ss-claims__error', role: 'alert' },
						state.errors.map((error) => el(dom, 'li', {}, [error.message])),
					)
				: null,
			el(
				dom,
				'button',
				{ type: 'submit', class: 'ss-claims__button', ...(state.submit === 'submitting' ? { 'aria-disabled': 'true' } : {}) },
				[t('claims.form.submit')],
			),
		);
	}
	return el(
		dom,
		'form',
		{
			class: 'ss-claims__form',
			'aria-label': t('claims.form.title'),
			onsubmit: (/** @type {any} */ event) => {
				event?.preventDefault?.();
				void actions.submit();
			},
		},
		[el(dom, 'h3', {}, [t('claims.form.title')]), ...body],
	);
};

/**
 * The shopper's claims and the open claim's history and conversation.
 * @param {DomLike} dom
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 * @param {ClaimsState} state
 * @param {RenderActions} actions
 * @param {any} empty slot
 */
const claimList = (dom, t, state, actions, empty) => {
	if (state.claims.length === 0) return empty ?? el(dom, 'p', { class: 'ss-claims__meta' }, [t('claims.empty')]);
	const active = state.active;
	let reply = '';
	return el(dom, 'div', {}, [
		el(dom, 'h3', {}, [t('claims.list.title')]),
		el(
			dom,
			'ul',
			{ class: 'ss-claims__list' },
			state.claims.map((claim) =>
				el(dom, 'li', { class: 'ss-claims__item' }, [
					el(dom, 'strong', {}, [`${claim.reference} · ${claim.typeLabel}`]),
					el(dom, 'p', { class: 'ss-claims__meta' }, [
						t('claims.list.status', { status: claim.statusLabel, date: day(claim.submittedAt) }),
					]),
					claim.statusDescription ? el(dom, 'p', {}, [claim.statusDescription]) : null,
					active?.claim?.id === claim.id
						? el(
								dom,
								'button',
								{
									type: 'button',
									class: 'ss-claims__button ss-claims__button--quiet',
									onclick: () => actions.closeClaim(),
								},
								[t('claims.list.close')],
							)
						: el(
								dom,
								'button',
								{
									type: 'button',
									class: 'ss-claims__button ss-claims__button--quiet',
									onclick: () => actions.openClaim(claim.id),
								},
								[t('claims.list.open')],
							),
				]),
			),
		),
		active
			? el(dom, 'section', { 'aria-label': t('claims.detail.title', { reference: active.claim.reference }) }, [
					el(dom, 'h4', {}, [t('claims.detail.title', { reference: active.claim.reference })]),
					el(
						dom,
						'ol',
						{ class: 'ss-claims__list', 'aria-label': t('claims.detail.history') },
						/** @type {Array<Record<string, any>>} */ (active.claim.history ?? []).map((entry) =>
							el(dom, 'li', {}, [`${day(entry.at)} · ${entry.label}`]),
						),
					),
					state.form?.messages?.enabled
						? el(dom, 'div', {}, [
								el(
									dom,
									'ul',
									{ class: 'ss-claims__list', 'aria-label': t('claims.detail.messages') },
									active.messages.map((message) =>
										el(dom, 'li', { class: 'ss-claims__item' }, [
											el(dom, 'strong', {}, [
												t(message.author === 'staff' ? 'claims.message.staff' : 'claims.message.you'),
											]),
											` ${message.body}`,
										]),
									),
								),
								state.form.messages.customerCanWrite
									? el(
											dom,
											'form',
											{
												onsubmit: (/** @type {any} */ event) => {
													event?.preventDefault?.();
													void actions.sendMessage(reply);
												},
											},
											[
												field(
													dom,
													'ss-claims-reply',
													t('claims.message.label'),
													el(dom, 'textarea', {
														id: 'ss-claims-reply',
														rows: '2',
														maxlength: String(state.form.messages.maxLength),
														oninput: (/** @type {any} */ e) => {
															reply = String(e?.target?.value ?? '');
														},
													}),
												),
												el(dom, 'button', { type: 'submit', class: 'ss-claims__button' }, [t('claims.message.send')]),
											],
										)
									: null,
							])
						: null,
				])
			: null,
	]);
};

/**
 * Render the element.
 * @param {{ state: ClaimsState, actions: RenderActions, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'form' || theme.variant === 'list' ? theme.variant : 'full';
	const status = el(
		dom,
		'p',
		{ class: state.error ? 'ss-claims__error' : 'ss-claims__notice', role: 'status', 'aria-live': 'polite' },
		state.error ? [state.error] : state.message ? [state.message] : [],
	);
	/** @type {any[]} */
	const body = [];
	if (state.status === 'loading' || state.status === 'idle')
		body.push(el(dom, 'p', { class: 'ss-claims__meta' }, [t('claims.loading')]));
	else if (state.mode === 'signin')
		body.push(state.form?.guestAccess ? accessForm(dom, t, actions) : el(dom, 'p', {}, [t('claims.sign_in')]));
	else {
		if (variant !== 'list') body.push(claimForm(dom, t, state, actions));
		if (variant !== 'form') body.push(claimList(dom, t, state, actions, slots.empty));
	}
	return el(
		dom,
		'section',
		{
			class: `ss-claims ss-claims--${variant}`,
			role: 'region',
			'aria-label': t('claims.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[slots.before ?? null, el(dom, 'h2', {}, [t('claims.title')]), ...body, status, slots.after ?? null],
	);
};
