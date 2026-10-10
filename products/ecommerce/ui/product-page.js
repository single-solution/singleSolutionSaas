/**
 * The product page blocks (visitor widget `product_page`, feature catalog; PLAN 0.8.8 Shopper widgets): placed as
 * `<div data-ss-ecommerce="product_page" data-product="<id or slug>"></div>`. Gallery, name and brand, the price after
 * automatic deals (with the "was" price and the saving, while `deals` is on), the variant picker (options → variant;
 * combinations that do not exist are disabled), the condition grade, the stock state, the quantity and Add to cart,
 * the time picker of a booking product, the note of a digital item, back-in-stock and price-drop alerts (`alerts`,
 * signed in), the wishlist and compare toggles, the specs, the description and the reviews block (`reviews`).
 * Growth's events (PLAN 0.8.9): `ss:view_item` once when the product is shown (its first in-stock variant; a variant
 * change does not fire it again) and `ss:add_to_cart` on each Add to cart, at the price shown.
 * @module
 */
import { GROWTH_EVENTS, growthItem, itemsDetail } from '../core/growth-events.js';
import { MAX_QUANTITY } from './cart-store.js';
import {
	announce,
	button,
	codeOf,
	currencyOf,
	field,
	fill,
	formatsOf,
	h,
	keepFocus,
	mountShop,
	priceNode,
	problemText,
	ratingText,
	settingsOf,
	textsOf,
} from './shop-common.js';
import { compareIds, onCompareChange, toggleCompare } from './shop-compare-store.js';
import { renderReviews } from './shop-reviews.js';
import { savedOf } from './shop-saved.js';
import { renderSlots } from './shop-slots.js';

/**
 * @typedef {{ id: string, name: string, options: Record<string, string>, price: number, compareAtPrice: number | null,
 *   inStock: boolean, grade: { key: string, label: string, description: string } | null }} PageVariant
 */

/**
 * The variant of the chosen options (the only one when the product has no options).
 * @param {{ options: Array<{ name: string }>, variants: PageVariant[] }} item
 * @param {Record<string, string>} chosen
 * @returns {PageVariant | null}
 */
export const variantFor = (item, chosen) =>
	item.variants.find((variant) => item.options.every((option) => variant.options[option.name] === chosen[option.name])) ?? null;

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountProductPage = async ({ host, config, shop, win }) => {
	const t = textsOf(config);
	const settings = settingsOf(config);
	const formats = formatsOf(config, win);
	const { money } = formats;
	const ref = host.dataset.product ?? '';
	const saved = savedOf(shop);

	mountShop({
		host,
		config,
		name: 'product-page',
		render: (root) => {
			const doc = root.ownerDocument;
			const status = h(doc, 'p', { class: 'status', role: 'status' }, t('page.loading'));
			root.append(status);
			/** @type {Array<() => void>} */
			const stops = [];

			const load = async () => {
				if (!ref) {
					status.textContent = t('page.notFound');
					return;
				}
				const answer = await shop.call(`/v1/shop/products/${encodeURIComponent(ref)}`);
				if (!answer.ok) {
					status.textContent = t(answer.status === 404 ? 'page.notFound' : 'page.error');
					return;
				}
				show(answer.data);
			};

			/** @param {any} item */
			const show = (item) => {
				const currency = currencyOf(settings, item.currency);
				const booking = item.kind === 'booking' && shop.has('bookings');
				const first = item.variants.find((/** @type {PageVariant} */ v) => v.inStock) ?? item.variants[0] ?? null;
				/** @type {Record<string, string>} */
				const chosen = { ...(first?.options ?? {}) };
				/** @type {string | null} */
				let slot = null;
				let quantity = 1;
				let added = false;
				/** @type {Map<string, any>} */
				const quotes = new Map();
				/** @param {PageVariant} of the price shown for a variant (after automatic deals, once quoted) */
				const shownPrice = (of) => {
					const quote = quotes.get(of.id);
					return quote?.savings > 0 ? quote.priceAfterDeals : of.price;
				};
				/** @param {string} name @param {PageVariant | null} of @param {number} count */
				const tell = (name, of, count) =>
					announce(
						win,
						name,
						itemsDetail(currency, [
							growthItem({
								productId: item.id,
								variantId: of?.id ?? null,
								name: item.name,
								price: of ? shownPrice(of) : item.price,
								quantity: count,
							}),
						]),
					);

				// ------------------------------------------------------------------------------------------ gallery
				const media = item.media.filter((/** @type {{ url: string | null }} */ m) => m.url);
				const gallery = h(doc, 'section', { class: 'gallery', 'aria-label': t('page.gallery') });
				let index = 0;
				const renderGallery = () => {
					const current = media[index];
					if (!current) {
						gallery.replaceChildren();
						return;
					}
					const main = current.type.startsWith('video/')
						? h(doc, 'video', { src: current.url, controls: '', 'aria-label': current.alt, preload: 'metadata' })
						: h(doc, 'img', { src: current.url, alt: current.alt });
					const parts = [h(doc, 'div', { class: 'main' }, main)];
					if (media.length > 1) {
						/** @param {number} step */
						const go = (step) => {
							index = (index + step + media.length) % media.length;
							keepFocus(root, renderGallery);
						};
						parts.push(
							h(
								doc,
								'div',
								{ class: 'nav' },
								button(doc, t('page.prevImage'), () => go(-1), { class: 'secondary icon', 'data-focus': 'prev' }),
								h(doc, 'span', { class: 'meta' }, t('page.imageCount', { n: index + 1, total: media.length })),
								button(doc, t('page.nextImage'), () => go(1), { class: 'secondary icon', 'data-focus': 'next' }),
							),
							h(
								doc,
								'div',
								{ class: 'thumbs' },
								...media.map((/** @type {{ url: string, alt: string, type: string }} */ m, /** @type {number} */ i) => {
									const thumb = button(
										doc,
										m.type.startsWith('video/') ? String(i + 1) : '',
										() => {
											index = i;
											keepFocus(root, renderGallery);
										},
										{
											'aria-label': t('page.showImage', { n: i + 1, total: media.length }),
											'aria-current': String(i === index),
											'data-focus': `thumb${i}`,
										},
									);
									if (!m.type.startsWith('video/')) thumb.append(h(doc, 'img', { src: m.url, alt: '' }));
									return thumb;
								}),
							),
						);
					}
					gallery.replaceChildren(...parts);
				};
				renderGallery();

				// ---------------------------------------------------------------------------------------- buy box
				const buy = h(doc, 'section', { class: 'stack', 'aria-label': t('page.buy') });
				const priceBox = h(doc, 'div');
				const pickers = h(doc, 'div');
				const facts = h(doc, 'div');
				const slotBox = h(doc, 'div');
				const addBox = h(doc, 'div');
				const extras = h(doc, 'div', { class: 'stack' });
				const said = h(doc, 'p', { class: 'status', role: 'status' });
				fill(
					buy,
					h(doc, 'h2', { class: 'big' }, item.name),
					item.brand ? h(doc, 'span', { class: 'meta' }, item.brand.name) : null,
					ratingText(t, item.rating) ? h(doc, 'span', { class: 'meta' }, ratingText(t, item.rating)) : null,
					item.summary ? h(doc, 'p', {}, item.summary) : null,
					priceBox,
					pickers,
					facts,
					slotBox,
					addBox,
					said,
					extras,
				);
				const variant = () => variantFor(item, chosen);

				const renderPrice = async () => {
					const current = variant();
					if (!current) {
						priceBox.replaceChildren(h(doc, 'p', { class: 'muted' }, t('page.noVariant')));
						return;
					}
					const plain = () =>
						priceBox.replaceChildren(
							priceNode(doc, t, formats, { price: current.price, was: current.compareAtPrice, currency, big: true }),
						);
					if (!shop.has('deals')) return plain();
					let quote = quotes.get(current.id);
					if (!quote) {
						const answer = await shop.call(
							`/v1/shop/products/${encodeURIComponent(item.id)}/quote?variantId=${encodeURIComponent(current.id)}`,
						);
						if (!answer.ok) return plain();
						quote = answer.data;
						quotes.set(current.id, quote);
					}
					if (variant()?.id !== current.id) return;
					if (!(quote.savings > 0)) return plain();
					const was = Math.max(quote.price, current.compareAtPrice ?? 0);
					priceBox.replaceChildren(
						priceNode(doc, t, formats, {
							price: quote.priceAfterDeals,
							was,
							currency: currencyOf(settings, quote.currency, currency),
							big: true,
						}),
						h(doc, 'p', { class: 'save' }, t('page.save', { amount: money(quote.savings, currency) })),
						...quote.deals.map((/** @type {{ name: string }} */ deal) => h(doc, 'span', { class: 'badge' }, deal.name)),
					);
				};
				const renderPickers = () => {
					const groups = item.options.map(
						(/** @type {{ name: string, values: string[] }} */ option, /** @type {number} */ i) => {
							const control = /** @type {HTMLSelectElement} */ (h(doc, 'select', { 'data-focus': `option${i}` }));
							for (const value of option.values) {
								const match = variantFor(item, { ...chosen, [option.name]: value });
								const node = h(
									doc,
									'option',
									{ value },
									match && !match.inStock ? t('page.optionOutOfStock', { value }) : value,
								);
								if (!match) node.setAttribute('disabled', '');
								control.append(node);
							}
							control.value = chosen[option.name] ?? '';
							control.addEventListener('change', () => {
								chosen[option.name] = control.value;
								added = false;
								refresh();
							});
							return field(doc, `ss-page-option-${i}`, option.name, control);
						},
					);
					pickers.replaceChildren(...groups);
				};

				const renderFacts = () => {
					const current = variant();
					fill(
						facts,
						current?.grade
							? h(
									doc,
									'p',
									{},
									t('page.grade', { grade: current.grade.label }),
									current.grade.description ? h(doc, 'span', { class: 'meta' }, current.grade.description) : null,
								)
							: null,
						current
							? h(
									doc,
									'p',
									{ class: current.inStock ? 'save' : 'error' },
									t(current.inStock ? 'page.inStock' : 'page.outOfStock'),
								)
							: null,
						item.kind === 'digital' ? h(doc, 'p', { class: 'hint' }, t('page.digitalNote')) : null,
						item.booking
							? h(doc, 'p', { class: 'meta' }, t('page.duration', { minutes: item.booking.durationMinutes }))
							: null,
					);
				};

				const renderAdd = () => {
					if (!shop.has('checkout')) {
						addBox.replaceChildren();
						return;
					}
					const current = variant();
					const parts = [];
					if (!booking) {
						const input = /** @type {HTMLInputElement} */ (
							h(doc, 'input', {
								type: 'number',
								min: '1',
								max: String(MAX_QUANTITY),
								inputmode: 'numeric',
								'data-focus': 'qty',
							})
						);
						input.value = String(quantity);
						input.addEventListener('change', () => {
							quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(Number(input.value)) || 1));
							input.value = String(quantity);
						});
						/** @param {number} step */
						const stepBy = (step) => {
							quantity = Math.max(1, Math.min(MAX_QUANTITY, quantity + step));
							input.value = String(quantity);
						};
						parts.push(
							h(doc, 'label', { for: 'ss-page-qty' }, t('page.quantity')),
							h(
								doc,
								'div',
								{ class: 'stepper' },
								button(doc, '−', () => stepBy(-1), { class: 'secondary', 'aria-label': t('page.less') }),
								input,
								button(doc, '+', () => stepBy(1), { class: 'secondary', 'aria-label': t('page.more') }),
							),
						);
						input.id = 'ss-page-qty';
					}
					const ready = Boolean(current?.inStock) && (!booking || slot !== null);
					const add = button(
						doc,
						t(added ? 'page.added' : 'page.addToCart'),
						() => {
							const now = variant();
							if (!now) return;
							shop.cart.add({
								productId: item.id,
								variantId: now.id,
								quantity: booking ? 1 : quantity,
								...(booking && slot ? { slot } : {}),
							});
							tell(GROWTH_EVENTS.addToCart, now, booking ? 1 : quantity);
							added = true;
							said.textContent = t('page.addedStatus', { name: item.name });
							keepFocus(root, renderAdd);
						},
						{ 'data-focus': 'add' },
					);
					if (!ready) add.setAttribute('disabled', '');
					parts.push(add);
					if (booking && slot === null) parts.push(h(doc, 'p', { class: 'meta' }, t('page.chooseSlotFirst')));
					addBox.replaceChildren(...parts);
				};

				const renderExtras = async () => {
					const current = variant();
					const parts = [];
					if (shop.has('wishlist')) {
						const ids = await saved.ids();
						const on = ids.has(item.id);
						parts.push(
							button(
								doc,
								t(on ? 'page.wishlistSaved' : 'page.wishlistSave'),
								async () => {
									if (!shop.signIn()) return void (said.textContent = t('wishlist.signIn'));
									const done = await saved.toggle(item.id);
									said.textContent = done.ok
										? t(done.saved ? 'wishlist.added' : 'wishlist.removed', { name: item.name })
										: t('wishlist.failed');
								},
								{ class: 'icon', 'aria-pressed': String(on), 'data-focus': 'wish' },
							),
						);
					}
					if (shop.has('compare')) {
						const on = compareIds(win).includes(item.id);
						parts.push(
							button(
								doc,
								t('page.compare'),
								() => {
									const done = toggleCompare(win, item.id, settings.compare.max);
									if (!done.ok) said.textContent = t('compare.full', { max: settings.compare.max });
								},
								{ class: 'icon', 'aria-pressed': String(on), 'data-focus': 'compare' },
							),
						);
					}
					const row = parts.length > 0 ? [h(doc, 'div', { class: 'actions' }, ...parts)] : [];
					if (shop.has('alerts')) {
						if (!shop.signIn()) row.push(h(doc, 'p', { class: 'hint' }, t('alerts.signIn')));
						else {
							/** @param {'back_in_stock' | 'price_drop'} kind @param {string} text */
							const alert = (kind, text) =>
								button(
									doc,
									text,
									async (event) => {
										const node = /** @type {HTMLButtonElement} */ (event.currentTarget);
										node.setAttribute('disabled', '');
										const answer = await shop.call('/v1/shop/alerts', {
											method: 'POST',
											body: { kind, productId: item.id, variantId: variant()?.id ?? null },
											idempotencyKey: shop.newKey(),
										});
										node.removeAttribute('disabled');
										said.textContent = answer.ok
											? t(kind === 'back_in_stock' ? 'alerts.stockSet' : 'alerts.priceSet')
											: problemText(config, 'alerts.problem.', codeOf(answer), 'alerts.failed');
									},
									{ class: 'secondary', 'data-focus': kind },
								);
							row.push(
								h(
									doc,
									'div',
									{ class: 'actions' },
									current && !current.inStock ? alert('back_in_stock', t('alerts.backInStock')) : null,
									alert('price_drop', t('alerts.priceDrop')),
								),
							);
						}
					}
					keepFocus(root, () => extras.replaceChildren(...row));
				};

				const refresh = () => {
					keepFocus(root, () => {
						renderPickers();
						renderFacts();
						renderAdd();
					});
					void renderPrice();
					void renderExtras();
				};

				if (booking)
					renderSlots({
						box: slotBox,
						t,
						formats,
						shop,
						productId: item.id,
						now: () => Date.now(),
						onChoose: (start) => {
							slot = start;
							added = false;
							keepFocus(root, renderAdd);
						},
					});

				// ------------------------------------------------------------------------------- specs, description
				const blocks = [];
				if (item.specs.length > 0)
					blocks.push(
						h(
							doc,
							'section',
							{ class: 'wide' },
							h(doc, 'h2', {}, t('page.specs')),
							h(
								doc,
								'div',
								{ class: 'scroll' },
								h(
									doc,
									'table',
									{},
									h(
										doc,
										'tbody',
										{},
										...item.specs.map((/** @type {{ name: string, value: unknown, unit: string }} */ spec) =>
											h(
												doc,
												'tr',
												{},
												h(doc, 'th', { scope: 'row' }, spec.name),
												h(
													doc,
													'td',
													{},
													typeof spec.value === 'boolean'
														? t(spec.value ? 'shop.yes' : 'shop.no')
														: spec.unit
															? `${spec.value} ${spec.unit}`
															: String(spec.value),
												),
											),
										),
									),
								),
							),
						),
					);
				const paragraphs = String(item.description ?? '')
					.split(/\n\s*\n/)
					.map((part) => part.trim())
					.filter(Boolean);
				if (paragraphs.length > 0)
					blocks.push(
						h(
							doc,
							'section',
							{ class: 'wide' },
							h(doc, 'h2', {}, t('page.description')),
							...paragraphs.map((text) => h(doc, 'p', {}, text)),
						),
					);
				/** @type {{ identity: () => void } | null} */
				let reviews = null;
				if (shop.has('reviews')) {
					const box = h(doc, 'section', { class: 'wide', 'aria-label': t('reviews.title') });
					blocks.push(box);
					reviews = renderReviews({ box, t, shop, config, productId: item.id });
				}

				// the frame is the size container: two columns where the widget itself is wide, not the screen
				root.replaceChildren(
					h(doc, 'div', { class: 'page-frame' }, h(doc, 'div', { class: 'page' }, gallery, buy, ...blocks)),
				);
				refresh();
				tell(GROWTH_EVENTS.viewItem, first, 1);
				stops.push(
					shop.onIdentity(() => {
						void renderExtras();
						reviews?.identity();
					}),
					saved.onChange(() => void renderExtras()),
					onCompareChange(win, () => void renderExtras()),
				);
			};

			void load();
			return () => {
				for (const stop of stops) stop();
			};
		},
	});
};
