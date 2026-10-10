/**
 * Compare products side by side (visitor widget `compare`, feature compare; PLAN 0.8.8 Shopper extras): the products
 * the shopper picked with the grid's and the product page's compare toggles (kept in the browser, at most the
 * `compare` setting's number), as a table of image, name, price, brand, condition grades, rating and every comparable
 * attribute (`GET /v1/shop/compare`). Each product can be taken off, or the whole list cleared.
 * @module
 */
import { button, currencyOf, formatsOf, h, mountShop, priceNode, ratingText, settingsOf, textsOf } from './shop-common.js';
import { clearCompare, compareIds, onCompareChange, removeCompare } from './shop-compare-store.js';

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountCompare = async ({ host, config, shop, win }) => {
	const t = textsOf(config);
	const settings = settingsOf(config);
	const formats = formatsOf(config, win);

	mountShop({
		host,
		config,
		name: 'compare',
		render: (root) => {
			const doc = root.ownerDocument;
			const status = h(doc, 'p', { class: 'status', role: 'status' });
			const table = h(doc, 'div', { class: 'scroll' });
			const clear = button(doc, t('compare.clear'), () => clearCompare(win), { class: 'secondary' });
			root.append(h(doc, 'h2', {}, t('compare.title')), status, table, clear);
			let seq = 0;

			/** @param {unknown} value */
			const valueText = (value) =>
				value === null || value === undefined
					? '—'
					: typeof value === 'boolean'
						? t(value ? 'shop.yes' : 'shop.no')
						: String(value);

			/** @param {{ products: any[], rows: Array<{ name: string, unit: string, values: unknown[] }> }} data */
			const show = (data) => {
				const products = data.products;
				/** @param {string} label @param {Array<string | Node>} cells */
				const row = (label, cells) =>
					h(doc, 'tr', {}, h(doc, 'th', { scope: 'row' }, label), ...cells.map((cell) => h(doc, 'td', {}, cell)));
				const head = h(
					doc,
					'tr',
					{},
					h(doc, 'td', {}),
					...products.map((item) =>
						h(
							doc,
							'th',
							{ scope: 'col' },
							item.image ? h(doc, 'img', { src: item.image, alt: '' }) : null,
							h(doc, 'p', {}, h(doc, 'a', { href: item.url }, item.name)),
							button(doc, t('compare.remove'), () => removeCompare(win, item.id), {
								class: 'secondary icon',
								'aria-label': t('compare.removeLabel', { name: item.name }),
							}),
						),
					),
				);
				const rows = [
					row(
						t('compare.price'),
						products.map((item) =>
							priceNode(doc, t, formats, {
								price: item.price,
								was: item.compareAtPrice,
								currency: currencyOf(settings, item.currency),
							}),
						),
					),
					row(
						t('compare.stock'),
						products.map((item) => t(item.inStock ? 'page.inStock' : 'page.outOfStock')),
					),
				];
				if (products.some((item) => item.brand))
					rows.push(
						row(
							t('compare.brand'),
							products.map((item) => item.brand ?? '—'),
						),
					);
				if (products.some((item) => item.grades?.length > 0))
					rows.push(
						row(
							t('compare.grades'),
							products.map((item) => (item.grades?.length > 0 ? item.grades.join(', ') : '—')),
						),
					);
				rows.push(
					row(
						t('compare.rating'),
						products.map((item) => ratingText(t, item.rating) || t('compare.noRating')),
					),
				);
				for (const spec of data.rows)
					rows.push(
						row(
							spec.unit ? t('compare.withUnit', { name: spec.name, unit: spec.unit }) : spec.name,
							spec.values.map(valueText),
						),
					);
				table.replaceChildren(h(doc, 'table', { class: 'compare' }, h(doc, 'thead', {}, head), h(doc, 'tbody', {}, ...rows)));
			};

			const load = async () => {
				seq += 1;
				const mine = seq;
				const ids = compareIds(win).slice(0, settings.compare.max);
				clear.hidden = ids.length === 0;
				if (ids.length === 0) {
					table.replaceChildren();
					status.textContent = t('compare.empty');
					return;
				}
				status.textContent = t('compare.loading');
				const answer = await shop.call(`/v1/shop/compare?ids=${encodeURIComponent(ids.join(','))}`);
				if (mine !== seq) return;
				if (!answer.ok) {
					table.replaceChildren();
					status.textContent = t('compare.error');
					return;
				}
				status.textContent = answer.data.products.length < 2 ? t('compare.addMore') : '';
				show(answer.data);
			};

			const stop = onCompareChange(win, () => void load());
			void load();
			return stop;
		},
	});
};
