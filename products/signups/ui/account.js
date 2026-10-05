/**
 * Mode A default renderer of the `account_pages` element: a pure function of (state, actions, strings, theme, slots)
 * returning DOM built with the injected `dom`. Built only on headless/; design tokens only; keyboard operable tabs
 * (`role=tablist`, `aria-selected`) or stacked sections; polite announcements; reserves its minimum height.
 * Variants: `tabs` and `stacked`.
 */
import { createTranslator } from '../headless/strings.js';

/** @typedef {import('../headless/account.js').AccountState} AccountState */
/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-account { color: var(--ss-color-text); background: var(--ss-color-surface); border-radius: var(--ss-radius-md);
  font: var(--ss-font-body); padding: var(--ss-space-4); min-height: var(--ss-account-min-height, 16rem); }
.ss-account__tabs { display: flex; gap: var(--ss-space-2); border-bottom: 1px solid var(--ss-color-border); margin-bottom: var(--ss-space-3); }
.ss-account__tab { font: inherit; background: none; border: 0; padding: var(--ss-space-2); cursor: pointer; color: var(--ss-color-text-muted); }
.ss-account__tab[aria-selected="true"] { color: var(--ss-color-primary); border-bottom: 2px solid var(--ss-color-primary); }
.ss-account__list { list-style: none; margin: 0; padding: 0; }
.ss-account__item { display: flex; justify-content: space-between; gap: var(--ss-space-2); padding: var(--ss-space-2) 0; }
.ss-account__button { font: inherit; padding: var(--ss-space-1) var(--ss-space-3); border: 0; border-radius: var(--ss-radius-sm);
  background: var(--ss-color-primary); color: var(--ss-color-on-primary); cursor: pointer; }
.ss-account__button--danger { background: var(--ss-color-danger); color: var(--ss-color-on-danger); }
.ss-account button:focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-account__meta { color: var(--ss-color-text-muted); }
.ss-account__error { color: var(--ss-color-danger); }
@media (prefers-reduced-motion: reduce) { .ss-account * { transition: none; } }
`;

/**
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {Array<any>} [children]
 */
const el = (dom, tag, attributes = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
	for (const child of children) if (child !== null) node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/**
 * @param {DomLike} dom
 * @param {string} label
 * @param {() => unknown} onClick
 * @param {string} [extra] class modifier
 */
const button = (dom, label, onClick, extra = '') => {
	const node = el(dom, 'button', { type: 'button', class: `ss-account__button ${extra}`.trim() }, [label]);
	node.addEventListener('click', () => onClick());
	return node;
};

/**
 * @param {DomLike} dom
 * @param {Array<any>} items
 * @param {any} empty
 */
const list = (dom, items, empty) => (items.length === 0 ? empty : el(dom, 'ul', { class: 'ss-account__list' }, items));

/**
 * One section's content.
 * @param {string} page
 * @param {{ state: AccountState, actions: Record<string, (...args: any[]) => Promise<unknown>>, t: (key: string, params?: Record<string, string | number>) => string, dom: DomLike, slots: Record<string, any> }} input
 */
const section = (page, { state, actions, t, dom, slots }) => {
	const customer = state.customer ?? {};
	const date = (/** @type {string | null | undefined} */ value) => (value ? String(value).slice(0, 10) : '—');
	const empty = (/** @type {string} */ key) => slots.empty ?? el(dom, 'p', { class: 'ss-account__meta' }, [t(key)]);
	switch (page) {
		case 'profile': {
			const badge = (/** @type {string} */ kind) =>
				el(dom, 'span', { class: 'ss-account__meta' }, [
					t(customer.verified?.[kind] === 'verified' ? 'account.profile.verified' : 'account.profile.unverified'),
				]);
			const rows = [
				el(dom, 'li', { class: 'ss-account__item' }, [
					t('account.profile.email'),
					customer.email ?? '—',
					customer.email ? badge('email') : null,
				]),
				el(dom, 'li', { class: 'ss-account__item' }, [
					t('account.profile.phone'),
					customer.phone ?? '—',
					customer.phone ? badge('phone') : null,
				]),
				...state.fields.map((field) =>
					el(dom, 'li', { class: 'ss-account__item' }, [
						String(field.label ?? field.key),
						String(customer.profile?.[field.key] ?? '—'),
					]),
				),
			];
			return el(dom, 'ul', { class: 'ss-account__list' }, rows);
		}
		case 'addresses':
			return list(
				dom,
				(customer.addresses ?? []).map((/** @type {Record<string, string>} */ a) =>
					el(dom, 'li', { class: 'ss-account__item' }, [
						[a.label, a.line1, a.line2, a.city, a.region, a.postal_code, a.country].filter(Boolean).join(', '),
					]),
				),
				empty('account.addresses.empty'),
			);
		case 'sessions':
			return el(dom, 'div', {}, [
				list(
					dom,
					state.sessions.map((s) =>
						el(dom, 'li', { class: 'ss-account__item' }, [
							el(dom, 'span', {}, [String(s.device?.label ?? '')]),
							el(dom, 'span', { class: 'ss-account__meta' }, [
								s.current ? t('account.sessions.current') : t('account.sessions.last_used', { date: date(s.lastUsedAt) }),
							]),
							s.current ? null : button(dom, t('account.sessions.revoke'), () => actions.revokeSession?.(s.id)),
						]),
					),
					empty('account.signin_required'),
				),
				button(dom, t('account.sessions.revoke_all'), () => actions.revokeAll?.(), 'ss-account__button--danger'),
			]);
		case 'orders':
			return list(
				dom,
				state.orders.map((o) =>
					el(dom, 'li', { class: 'ss-account__item' }, [
						String(o.number ?? o.orderId),
						t(`account.orders.status.${o.status}`),
						el(dom, 'span', { class: 'ss-account__meta' }, [date(o.placedAt ?? o.updatedAt)]),
					]),
				),
				empty('account.orders.empty'),
			);
		case 'consents':
			return list(
				dom,
				state.consents.map((c) =>
					el(dom, 'li', { class: 'ss-account__item' }, [
						String(c.title ?? c.key),
						c.accepted
							? el(dom, 'span', { class: 'ss-account__meta' }, [
									t('account.consents.accepted', { version: c.accepted.version, date: date(c.accepted.acceptedAt) }),
								])
							: button(dom, t('signin.consent.continue'), () =>
									actions.acceptConsents?.([{ key: c.key, version: c.version }]),
								),
					]),
				),
				empty('account.signin_required'),
			);
		default: {
			const data = state.data ?? { export: false, delete: false, pendingDeletion: null };
			return el(dom, 'div', {}, [
				data.export ? button(dom, t('account.data.export'), () => actions.exportData?.()) : null,
				data.pendingDeletion
					? el(dom, 'p', { role: 'status' }, [
							t('account.data.delete_pending', { date: date(data.pendingDeletion.effectiveAt) }),
							' ',
							button(dom, t('account.data.cancel'), () => actions.cancelDeletion?.()),
						])
					: data.delete
						? button(dom, t('account.data.delete'), () => actions.requestDeletion?.(), 'ss-account__button--danger')
						: null,
			]);
		}
	}
};

/**
 * Render the element.
 * @param {{ state: AccountState, actions: Record<string, (...args: any[]) => Promise<unknown>>, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = (theme.variant ?? state.layout) === 'stacked' ? 'stacked' : 'tabs';
	const status = el(
		dom,
		'p',
		{ class: state.error ? 'ss-account__error' : 'ss-account__meta', role: 'status', 'aria-live': 'polite' },
		[state.error ?? state.notice ?? (state.status === 'loading' ? t('account.loading') : '')],
	);
	/** @type {any[]} */
	const body = [el(dom, 'h2', { class: 'ss-account__title', id: 'ss-account-title' }, [t('account.title')])];
	if (state.status === 'ready' && state.customer) {
		const ctx = { state, actions, t, dom, slots };
		if (variant === 'tabs') {
			body.push(
				el(
					dom,
					'div',
					{ class: 'ss-account__tabs', role: 'tablist', 'aria-label': t('account.title') },
					state.pages.map((page) => {
						const tab = el(
							dom,
							'button',
							{
								type: 'button',
								class: 'ss-account__tab',
								role: 'tab',
								id: `ss-account-tab-${page}`,
								'aria-selected': String(page === state.page),
								'aria-controls': `ss-account-panel-${page}`,
								tabindex: page === state.page ? '0' : '-1',
							},
							[t(`account.page.${page}`)],
						);
						tab.addEventListener('click', () => actions.setPage?.(page));
						return tab;
					}),
				),
			);
			body.push(
				el(
					dom,
					'div',
					{ role: 'tabpanel', id: `ss-account-panel-${state.page}`, 'aria-labelledby': `ss-account-tab-${state.page}` },
					[section(state.page, ctx)],
				),
			);
		} else {
			for (const page of state.pages)
				body.push(
					el(dom, 'section', { 'aria-label': t(`account.page.${page}`) }, [
						el(dom, 'h3', {}, [t(`account.page.${page}`)]),
						section(page, ctx),
					]),
				);
		}
	} else if (state.status === 'signed_out') body.push(el(dom, 'p', {}, [t('account.signin_required')]));
	return el(
		dom,
		'section',
		{
			class: `ss-account ss-account--${variant}`,
			role: 'region',
			'aria-labelledby': 'ss-account-title',
			'aria-busy': String(state.busy || state.status === 'loading'),
		},
		[...(slots.before ? [slots.before] : []), ...body, status, ...(slots.after ? [slots.after] : [])],
	);
};
