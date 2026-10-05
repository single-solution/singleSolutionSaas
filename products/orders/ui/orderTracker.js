/**
 * Mode A default renderer of the `lifecycle` element: the customer's orders (`list` or `compact`), the open order's
 * timeline, tracking, lines and totals, and a cancel button while cancellation is allowed. Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-orders { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-orders-min-height, 6rem); }
.ss-orders__list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--ss-space-2); }
.ss-orders__order { background: var(--ss-color-surface); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); color: inherit; padding: var(--ss-space-2); text-align: start; width: 100%; }
.ss-orders__order:focus-visible, .ss-orders__button:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-orders__button { background: var(--ss-color-primary); border: 0; border-radius: var(--ss-radius-sm); color: var(--ss-color-on-primary); padding: var(--ss-space-1) var(--ss-space-3); }
.ss-orders__timeline { margin: var(--ss-space-2) 0; padding-inline-start: var(--ss-space-4); }
.ss-orders--compact .ss-orders__meta { display: none; }
`;

/**
 * @param {{ state: import('../headless/orderTracker.js').TrackerState,
 *   actions: { select: (id: string) => unknown, close: () => unknown, cancel: () => unknown, loadMore: () => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'compact' ? 'compact' : 'list';
	const selected = state.selected;
	const detail = selected
		? el(dom, 'article', { class: 'ss-orders__detail', 'aria-label': t('tracker.order', { number: selected.number }) }, [
				el(dom, 'h3', {}, [t('tracker.order', { number: selected.number })]),
				el(dom, 'p', {}, [selected.statusLabel]),
				selected.tracking?.trackingNumber
					? el(dom, 'p', {}, [
							selected.tracking.trackingUrl
								? el(dom, 'a', { href: selected.tracking.trackingUrl, rel: 'noopener noreferrer', target: '_blank' }, [
										t('tracker.track', {
											carrier: selected.tracking.carrier ?? '',
											number: selected.tracking.trackingNumber,
										}),
									])
								: t('tracker.track', {
										carrier: selected.tracking.carrier ?? '',
										number: selected.tracking.trackingNumber,
									}),
						])
					: null,
				el(
					dom,
					'ol',
					{ class: 'ss-orders__timeline' },
					(selected.timeline ?? []).map((/** @type {any} */ entry) =>
						el(dom, 'li', {}, [`${entry.statusLabel} — ${String(entry.at ?? '').slice(0, 10)}`]),
					),
				),
				el(
					dom,
					'ul',
					{},
					(selected.lines ?? []).map((/** @type {any} */ line) => el(dom, 'li', {}, [`${line.quantity} × ${line.title}`])),
				),
				selected.canCancel
					? on(
							el(dom, 'button', { type: 'button', class: 'ss-orders__button', disabled: state.busy ? '' : null }, [
								t('tracker.cancel'),
							]),
							'click',
							() => actions.cancel(),
						)
					: null,
				on(el(dom, 'button', { type: 'button', class: 'ss-orders__order' }, [t('tracker.back')]), 'click', () =>
					actions.close(),
				),
			])
		: null;
	const list =
		state.orders.length === 0 && state.status === 'ready'
			? (slots.empty ?? el(dom, 'p', {}, [t('tracker.empty')]))
			: el(
					dom,
					'ul',
					{ class: 'ss-orders__list' },
					state.orders.map((order) =>
						el(dom, 'li', {}, [
							on(
								el(
									dom,
									'button',
									{
										type: 'button',
										class: 'ss-orders__order',
										'aria-current': selected?.id === order.id ? 'true' : null,
									},
									[
										el(dom, 'strong', {}, [t('tracker.order', { number: order.number })]),
										' ',
										order.statusLabel,
										el(dom, 'span', { class: 'ss-orders__meta' }, [` · ${String(order.placedAt ?? '').slice(0, 10)}`]),
									],
								),
								'click',
								() => actions.select(order.id),
							),
						]),
					),
				);
	return el(
		dom,
		'section',
		{
			class: `ss-orders ss-orders--${variant}`,
			role: 'region',
			'aria-label': t('tracker.title'),
			'aria-busy': String(state.status === 'loading' || state.busy),
		},
		[
			slots.before ?? null,
			el(dom, 'h2', {}, [t('tracker.title')]),
			detail ?? list,
			!selected && state.nextCursor
				? on(el(dom, 'button', { type: 'button', class: 'ss-orders__button' }, [t('tracker.more')]), 'click', () =>
						actions.loadMore(),
					)
				: null,
			statusLine(dom, 'ss-orders', state.error ?? state.notice),
			slots.after ?? null,
		],
	);
};
