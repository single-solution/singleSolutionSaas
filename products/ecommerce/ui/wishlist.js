/**
 * The wishlist (visitor widget `wishlist`, feature wishlist; PLAN 0.8.8 Shopper extras): the signed-in shopper's saved
 * products as cards, each with Remove and, while the cart is on, Add to cart (a product with several variants is
 * then chosen in the cart). Signed out, the sign-in hint shows. It follows saves made by the grid and the product page.
 * Add to cart dispatches Growth's `ss:add_to_cart` (PLAN 0.8.9) at the card's price.
 * @module
 */
import { GROWTH_EVENTS, growthItem, itemsDetail } from '../core/growth-events.js';
import { announce, button, currencyOf, h, mountShop, productCard, settingsOf, textsOf } from './shop-common.js';
import { savedOf } from './shop-saved.js';

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountWishlist = async ({ host, config, shop, win }) => {
	const t = textsOf(config);
	const settings = settingsOf(config);
	const saved = savedOf(shop);

	mountShop({
		host,
		config,
		name: 'wishlist',
		render: (root) => {
			const doc = root.ownerDocument;
			const status = h(doc, 'p', { class: 'status', role: 'status' });
			const list = h(doc, 'ul', { class: 'grid', 'aria-label': t('wishlist.title') });
			root.append(h(doc, 'h2', {}, t('wishlist.title')), status, list);
			let seq = 0;

			/** @param {any[]} items */
			const show = (items) => {
				list.replaceChildren(
					...items.map((item) =>
						productCard(doc, t, item, [
							shop.has('checkout')
								? button(
										doc,
										t('wishlist.addToCart'),
										() => {
											shop.cart.add({ productId: item.id, variantId: null, quantity: 1 });
											announce(
												win,
												GROWTH_EVENTS.addToCart,
												itemsDetail(currencyOf(settings, item.currency), [
													growthItem({ productId: item.id, name: item.name, price: item.price, quantity: 1 }),
												]),
											);
											status.textContent = t('page.addedStatus', { name: item.name });
										},
										{ 'aria-label': t('wishlist.addToCartLabel', { name: item.name }) },
									)
								: null,
							button(
								doc,
								t('wishlist.remove'),
								async () => {
									const done = await saved.toggle(item.id);
									status.textContent = done.ok ? t('wishlist.removed', { name: item.name }) : t('wishlist.failed');
								},
								{ class: 'secondary', 'aria-label': t('wishlist.removeLabel', { name: item.name }) },
							),
						]),
					),
				);
				if (items.length === 0) status.textContent = t('wishlist.empty');
			};

			const load = async () => {
				seq += 1;
				const mine = seq;
				if (!shop.signIn()) {
					list.replaceChildren();
					status.textContent = t('wishlist.signIn');
					return;
				}
				status.textContent = t('wishlist.loading');
				const answer = await shop.call('/v1/shop/wishlist');
				if (mine !== seq) return;
				if (!answer.ok) {
					list.replaceChildren();
					status.textContent = t('wishlist.error');
					return;
				}
				status.textContent = '';
				show(answer.data.items);
			};

			const stops = [shop.onIdentity(() => void load()), saved.onChange(() => void load())];
			void load();
			return () => {
				for (const stop of stops) stop();
			};
		},
	});
};
