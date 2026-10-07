/**
 * Mode A default renderer of the `wallet` element: a pure function of (state, actions, strings, theme, slots) that
 * returns DOM built with the injected `dom` (the Loader passes `document`). Built only on headless/; design tokens
 * only; keyboard operable; announces changes politely; reserves its minimum height (no layout shift).
 * Variants: `badge` (balance and tier) and `panel` (+ tier progress, expiring points, history).
 */
import { createTranslator } from '../headless/strings.js';

/** @typedef {import('../headless/wallet.js').WalletState} WalletState */
/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-wallet { color: var(--ss-color-text); background: var(--ss-color-surface); border-radius: var(--ss-radius-md);
  font: var(--ss-font-body); padding: var(--ss-space-3); min-height: var(--ss-wallet-min-height, 3rem); }
.ss-wallet--badge { display: inline-flex; gap: var(--ss-space-2); align-items: center; padding: var(--ss-space-2); }
.ss-wallet__balance { font-weight: var(--ss-font-weight-bold, 700); color: var(--ss-color-primary); }
.ss-wallet__meta, .ss-wallet__item time { color: var(--ss-color-text-muted); }
.ss-wallet__bar { width: 100%; height: var(--ss-space-2); accent-color: var(--ss-color-primary); }
.ss-wallet__list { list-style: none; margin: 0; padding: 0; }
.ss-wallet__item { display: flex; justify-content: space-between; gap: var(--ss-space-2); padding: var(--ss-space-1) 0; }
.ss-wallet__more { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border-radius: var(--ss-radius-sm); }
.ss-wallet__more:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-wallet__error { color: var(--ss-color-danger); }
@media (prefers-reduced-motion: reduce) { .ss-wallet * { transition: none; } }
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
	for (const child of children) node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/**
 * Render the element.
 * @param {{ state: WalletState, actions: { loadMore: () => Promise<unknown> }, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'badge' ? 'badge' : 'panel';
	const balance = el(dom, 'span', { class: 'ss-wallet__balance', 'aria-label': t('wallet.balance.label') }, [state.balanceText]);
	const tier = state.showTier && state.tierText ? [el(dom, 'span', { class: 'ss-wallet__meta' }, [state.tierText])] : [];
	const status = el(
		dom,
		'p',
		{ class: 'ss-wallet__error', role: 'status', 'aria-live': 'polite' },
		state.error ? [state.error] : [],
	);
	const root = (/** @type {any[]} */ children) =>
		el(
			dom,
			'section',
			{
				class: `ss-wallet ss-wallet--${variant}`,
				role: 'region',
				'aria-label': t('wallet.title'),
				'aria-busy': String(state.status === 'loading'),
			},
			[...(slots.before ? [slots.before] : []), ...children, status, ...(slots.after ? [slots.after] : [])],
		);
	if (variant === 'badge') return root([balance, ...tier]);

	const body = [el(dom, 'h2', { class: 'ss-wallet__title' }, [t('wallet.title')]), balance, ...tier];
	if (state.status === 'loading') body.push(el(dom, 'p', { class: 'ss-wallet__meta' }, [t('wallet.loading')]));
	if (state.showTier && state.nextTierText) {
		body.push(el(dom, 'p', { class: 'ss-wallet__meta' }, [state.nextTierText]));
		if (state.progress !== null)
			body.push(
				el(dom, 'progress', {
					class: 'ss-wallet__bar',
					max: '100',
					value: String(state.progress),
					'aria-label': t('wallet.tier.progress'),
				}),
			);
	}
	if (state.expiringText) body.push(el(dom, 'p', { class: 'ss-wallet__meta', role: 'note' }, [state.expiringText]));
	if (state.showHistory) {
		body.push(el(dom, 'h3', { class: 'ss-wallet__subtitle' }, [t('wallet.history.title')]));
		if (state.status === 'ready' && state.history.length === 0)
			body.push(slots.empty ?? el(dom, 'p', { class: 'ss-wallet__meta' }, [t('wallet.history.empty')]));
		else
			body.push(
				el(
					dom,
					'ul',
					{ class: 'ss-wallet__list', 'aria-label': t('wallet.history.title') },
					state.history.map((item) =>
						el(dom, 'li', { class: 'ss-wallet__item' }, [
							el(dom, 'span', {}, [item.label]),
							el(dom, 'time', { datetime: item.occurredAt }, [item.occurredAt.slice(0, 10)]),
							el(dom, 'span', {}, [item.pointsText]),
						]),
					),
				),
			);
		if (state.hasMore) {
			const more = el(dom, 'button', { type: 'button', class: 'ss-wallet__more' }, [t('wallet.history.more')]);
			if (state.loadingMore) more.setAttribute('disabled', '');
			more.addEventListener('click', () => actions.loadMore());
			body.push(more);
		}
	}
	return root(body);
};
