/**
 * Renderer of `price_block`: price, struck compare-at price (screen-reader label), savings, availability, taxes and
 * financing copy. Follows the configured variant event (`SS.on(update_event)`).
 */
import { createTranslator } from '../headless/strings.js';
import { BASE_STYLES, el, loaderApi, once } from './dom.js';
import { pageSource } from './page.js';

/** @typedef {ReturnType<import('../headless/priceBlock.js').createPriceBlock>} PriceBlock */

export const styles = `${BASE_STYLES}
.ss-price{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--ss-space-1) var(--ss-space-2);min-height:1.5em}
.ss-price__now{font-size:var(--ss-font-size-lg,1.5em);font-weight:var(--ss-font-weight-bold)}.ss-price__was{color:var(--ss-color-text-muted)}
.ss-price__save{color:var(--ss-color-success);font-weight:var(--ss-font-weight-bold)}
.ss-price__note{flex-basis:100%;margin:0;font-size:var(--ss-font-size-sm);color:var(--ss-color-text-muted)}
.ss-price__note--out_of_stock,.ss-price__note--discontinued{color:var(--ss-color-danger)}`;

/**
 * @param {{ state: ReturnType<PriceBlock['state']>, actions: PriceBlock['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike }} props
 * @returns {any}
 */
export const render = ({ state, actions, strings, dom }) => {
	const t = createTranslator(strings);
	once(actions, async () => {
		await actions.load(pageSource(dom, 'price_block'));
		if (state.updateEvent)
			loaderApi(dom)?.on?.(state.updateEvent, (/** @type {any} */ event) => actions.setVariant(event?.data));
	});
	const { view } = state;
	const root = el(dom, 'div', {
		class: 'ss-pdp ss-price',
		role: 'group',
		'aria-label': t('price_block.label'),
		hidden: state.status === 'empty',
	});
	if (state.status !== 'ready') return root;
	/** @param {string} kind @param {string} text */
	const note = (kind, text) => el(dom, 'p', { class: `ss-price__note ss-price__note--${kind}` }, [text]);
	const saving = view.saving
		? {
				none: '',
				amount: t('price_block.save_amount', { amount: view.saving }),
				percent: t('price_block.save_percent', view),
				both: t('price_block.save_both', { amount: view.saving, percent: view.percent }),
			}[state.savings]
		: '';
	const parts = [
		el(dom, 'span', { class: 'ss-price__now' }, [view.price]),
		view.compareAt
			? el(dom, 'span', { class: 'ss-price__was' }, [
					el(dom, 'span', { class: 'ss-pdp__sr' }, [t('price_block.was')]),
					el(dom, 's', {}, [view.compareAt]),
				])
			: '',
		saving ? el(dom, 'span', { class: 'ss-price__save' }, [saving]) : '',
		state.showAvailability && view.availability
			? note(view.availability, t(`price_block.availability.${view.availability}`))
			: '',
		state.showTaxes ? note('taxes', t('price_block.taxes')) : '',
		state.showFinancing ? note('financing', t('price_block.financing')) : '',
	];
	root.append(...parts.filter(Boolean));
	return root;
};
