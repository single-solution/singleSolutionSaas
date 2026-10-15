/**
 * The product page blocks (visitor widget `product_page`, feature catalog; PLAN 0.8.8 Shopper widgets, 0.8.10 E3–E13):
 * placed as `<div data-ss-ecommerce="product_page" data-product="<id or slug>"></div>`. A product whose slug changed
 * answers `moved` (`kind: 'product'`), and the page reads it again by its new slug (the widget runs on the merchant's
 * page, which does the redirect for search engines); a retired product that leads to its category (`kind: 'category'`)
 * shows as not available with a link to the category.
 *
 * Gallery (each photo's detail and thumb sizes, width and height, and its blur placeholder while loading; a variant's
 * own photos replace the product's while it is picked), name, Featured, brand, the price range, the price after
 * automatic deals as the page answer gives it (the same as cards, structured data and the cart: with the "was" price,
 * the saving and the deal), the variant picker (option axes, or the variants' attributes, and the condition when
 * variants differ only by grade; it opens at the variant the page's address names — the catalog setting variantQuery,
 * E13 — else the first in stock; a pick that has no exact variant moves to the nearest one), the grade's details, the stock ("Only N left", "N in stock", Sold out: shown and not added to
 * the cart), the warranty of the variant, the Size guide, the quantity and Add to cart, the time picker of a booking
 * product, the note of a digital item, back-in-stock and price-drop alerts (`alerts`: signed in, an alert already set
 * shows with Stop; a guest gives a phone while the `alerts` setting `guests` allows; a price-drop alert names an
 * optional price while `targetPrice` allows, EN-1), the wishlist and compare toggles, the specs, the rich description
 * (rebuilt from the allowed tags) or the plain one, the video, the FAQs and the reviews block (`reviews`).
 * Growth's events (PLAN 0.8.9): `ss:view_item` once when the product is shown (the variant it opens at; a variant
 * change does not fire it again) and `ss:add_to_cart` on each Add to cart, at the price shown.
 * @module
 */
import { GROWTH_EVENTS, growthItem, itemsDetail } from '../core/growth-events.js';
import { quantityText, toThousandths } from '../core/measure.js';
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
	paragraphs,
	priceNode,
	problemText,
	ratingText,
	richText,
	safeHref,
	settingsOf,
	textsOf,
	warrantyText,
} from './shop-common.js';
import { compareIds, onCompareChange, toggleCompare } from './shop-compare-store.js';
import {
	alertsOf,
	axesOf,
	buyable,
	faqBlock,
	gradeDetails,
	nearestVariant,
	photoOf,
	pickVariant,
	sizeGuide,
	stockText,
	variantAt,
	videoBlock,
} from './shop-page-parts.js';
import { renderReviews } from './shop-reviews.js';
import { savedOf } from './shop-saved.js';
import { renderSlots } from './shop-slots.js';

/** @typedef {import('./shop-page-parts.js').PageVariant} PageVariant */
/** @typedef {import('./shop-page-parts.js').PageMedia} PageMedia */

/** Moves followed before the page gives up (an earlier slug answers `moved` to the current one). */
const MAX_MOVES = 3;

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
	// the product's name is the page's h1, unless the page has its own (data-heading="h2", G3)
	const heading = ['h2', 'h3'].includes(host.dataset.heading ?? '') ? String(host.dataset.heading) : 'h1';
	const saved = savedOf(shop);
	const alerts = alertsOf(shop);

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
				let at = ref;
				for (let hop = 0; hop <= MAX_MOVES; hop += 1) {
					const answer = await shop.call(`/v1/shop/products/${encodeURIComponent(at)}`);
					if (!answer.ok) {
						status.textContent = t(answer.status === 404 ? 'page.notFound' : 'page.error');
						return;
					}
					const moved = answer.data?.moved;
					if (!moved) return show(answer.data);
					if (moved.kind === 'category') {
						// a retired product leads to its category: the page links there
						const link = typeof moved.url === 'string' ? safeHref(moved.url) : '';
						status.textContent = t('page.notFound');
						if (link) status.append(' ', h(doc, 'a', { href: link }, t('page.movedLink')));
						return;
					}
					if (typeof moved.slug !== 'string' || !moved.slug || moved.slug === at) break;
					at = moved.slug;
				}
				status.textContent = t('page.notFound');
			};

			/** @param {any} item */
			const show = (item) => {
				const currency = currencyOf(settings, item.currency);
				const booking = Boolean(item.booking) && shop.has('bookings');
				/** @type {PageVariant[]} */
				const variants = Array.isArray(item.variants) ? item.variants : [];
				const axes = axesOf({ options: Array.isArray(item.options) ? item.options : [], variants });
				// the variant the page's address names (a link from a feed, a search result or a share), else the first in stock
				const first = variantAt(variants, shop.location()) ?? variants.find((v) => buyable(v)) ?? variants[0] ?? null;
				/** @type {Record<string, string>} */
				const chosen = {};
				/** @param {PageVariant} of */
				const choose = (of) => {
					for (const axis of axes) chosen[axis.key] = axis.of(of);
				};
				if (first) choose(first);
				/** @type {string | null} */
				let slot = null;
				// sold in a unit of its own: an amount in thousandths of the unit, from the least
				/** @type {{ unit: string, decimals: number, step: number, min: number, max: number | null } | null} */
				const measure = item.measure ?? null;
				// the quantities a shopper may buy (the server's limits: pieces, or thousandths of the unit, E4)
				const limits = item.limits ?? { step: measure?.step ?? 1, min: measure?.min ?? 1, max: measure?.max ?? MAX_QUANTITY };
				let quantity = limits.min;
				let added = false;
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
								price: of ? of.price : item.price,
								quantity: count,
								measure,
							}),
						]),
					);
				const variant = () => pickVariant(axes, variants, chosen);

				// ------------------------------------------------------------------------------------------ gallery
				/** @type {PageMedia[]} */
				const productMedia = (Array.isArray(item.media) ? item.media : []).filter((/** @type {PageMedia} */ m) => m.url);
				/** The photos shown: the picked variant's own, else the product's (E6); `from` is that variant's id or ''. */
				const mediaNow = () => {
					const current = variant();
					const own = (current?.media ?? []).filter((m) => m.url);
					return own.length > 0 ? { from: String(current?.id), list: own } : { from: '', list: productMedia };
				};
				let shownFrom = mediaNow().from;
				let media = mediaNow().list;
				const gallery = h(doc, 'section', { class: 'gallery', 'aria-label': t('page.gallery') });
				let index = 0;
				/** @param {PageMedia} m */
				const isClip = (m) => String(m.type ?? '').startsWith('video/');
				const renderGallery = () => {
					const current = media[index];
					if (!current) {
						gallery.replaceChildren();
						return;
					}
					const main = isClip(current)
						? h(doc, 'video', { src: String(current.url), controls: '', 'aria-label': current.alt, preload: 'metadata' })
						: photoOf(doc, current, 'detail', current.alt);
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
								...media.map((m, i) => {
									const thumb = button(
										doc,
										isClip(m) ? String(i + 1) : '',
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
									if (!isClip(m)) thumb.append(photoOf(doc, m, 'thumb', ''));
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
				const pickers = h(doc, 'div', { class: 'pickers' });
				const facts = h(doc, 'div', { class: 'stack' });
				const slotBox = h(doc, 'div');
				const addBox = h(doc, 'div');
				const extras = h(doc, 'div', { class: 'stack' });
				const said = h(doc, 'p', { class: 'status', role: 'status' });
				/**
				 * What the shopper typed for an alert (phone, target price), kept across re-renders (EN-1).
				 * @type {Map<string, string>}
				 */
				const typed = new Map();
				const layer = h(doc, 'div');
				const rating = ratingText(t, item.rating);
				const priceMax = Number(item.priceMax ?? 0);
				fill(
					buy,
					item.featured
						? h(doc, 'span', { class: 'tags' }, h(doc, 'span', { class: 'badge accent' }, t('shop.featured')))
						: null,
					h(doc, heading, { class: 'big' }, item.name),
					item.brand ? h(doc, 'span', { class: 'meta' }, item.brand.name) : null,
					rating ? h(doc, 'span', { class: 'meta' }, rating) : null,
					item.summary ? h(doc, 'p', {}, item.summary) : null,
					variants.length > 1 && priceMax > item.price
						? h(
								doc,
								'span',
								{ class: 'meta' },
								t('shop.priceRange', { min: money(item.price, currency), max: money(priceMax, currency) }),
							)
						: null,
					priceBox,
					pickers,
					facts,
					item.sizeChart ? sizeGuide({ doc, t, chart: item.sizeChart, layer }) : null,
					slotBox,
					addBox,
					said,
					extras,
					layer,
				);

				const renderPrice = () => {
					const current = variant();
					if (!current) {
						priceBox.replaceChildren(h(doc, 'p', { class: 'muted' }, t('page.noVariant')));
						return;
					}
					priceBox.replaceChildren(
						priceNode(doc, t, formats, {
							price: current.price,
							was: current.compareAtPrice,
							currency,
							big: true,
							unit: measure?.unit ?? null,
						}),
						...(current.deal
							? [
									h(doc, 'p', { class: 'save' }, t('page.save', { amount: money(current.deal.savings, currency) })),
									h(doc, 'span', { class: 'badge' }, current.deal.name),
								]
							: []),
					);
				};

				const renderPickers = () => {
					const groups = axes.map((axis, i) => {
						const control = /** @type {HTMLSelectElement} */ (h(doc, 'select', { 'data-focus': `option${i}` }));
						for (const { value, text } of axis.values) {
							const exact = pickVariant(axes, variants, { ...chosen, [axis.key]: value });
							const any = variants.some((other) => axis.of(other) === value);
							const shown = axis.grade && !text ? t('page.gradeNone') : text;
							const node = h(
								doc,
								'option',
								{ value },
								exact?.soldOut === true
									? t('page.optionSoldOut', { value: shown })
									: exact && !exact.inStock
										? t('page.optionOutOfStock', { value: shown })
										: shown,
							);
							if (!any) node.setAttribute('disabled', '');
							control.append(node);
						}
						control.value = chosen[axis.key] ?? '';
						control.addEventListener('change', () => {
							const next = nearestVariant(axes, variants, chosen, axis, control.value);
							if (next) choose(next);
							else chosen[axis.key] = control.value;
							added = false;
							refresh();
						});
						return field(doc, `ss-page-option-${i}`, axis.grade ? t('page.condition') : axis.label, control);
					});
					pickers.replaceChildren(...groups);
				};

				const renderFacts = () => {
					const current = variant();
					const stock = current ? stockText(t, current, settings.catalog.lowStockShown, measure) : null;
					const warranty = current ? warrantyText(t, current.warrantyTime) : '';
					fill(
						facts,
						current?.grade ? gradeDetails(doc, t, current.grade) : null,
						stock ? h(doc, 'p', { class: `stock ${stock.tone}` }, stock.text) : null,
						warranty ? h(doc, 'p', { class: 'meta' }, warranty) : null,
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
					if (measure) {
						// an amount of the unit in its steps, between its least and most
						const unit = measure.unit;
						const input = /** @type {HTMLInputElement} */ (
							h(doc, 'input', { type: 'text', inputmode: 'decimal', size: '6', 'data-focus': 'qty' })
						);
						input.value = quantityText(quantity, measure);
						/** @param {number} next thousandths */
						const setAmount = (next) => {
							quantity = Math.max(limits.min, Math.min(limits.max, Math.round(next / limits.step) * limits.step));
							input.value = quantityText(quantity, measure);
						};
						input.addEventListener('change', () => setAmount(toThousandths(input.value) ?? quantity));
						parts.push(
							h(doc, 'label', { for: 'ss-page-qty' }, t('page.amount', { unit })),
							h(
								doc,
								'div',
								{ class: 'stepper' },
								button(doc, '−', () => setAmount(quantity - measure.step), {
									class: 'secondary',
									'aria-label': t('page.less'),
								}),
								input,
								button(doc, '+', () => setAmount(quantity + measure.step), {
									class: 'secondary',
									'aria-label': t('page.more'),
								}),
							),
							h(
								doc,
								'p',
								{ class: 'hint' },
								t('page.amountHelp', {
									step: quantityText(measure.step, measure),
									min: quantityText(measure.min, measure),
									unit,
								}),
							),
						);
						input.id = 'ss-page-qty';
					} else if (!booking) {
						const input = /** @type {HTMLInputElement} */ (
							h(doc, 'input', {
								type: 'number',
								min: String(limits.min),
								max: String(limits.max),
								step: String(limits.step),
								inputmode: 'numeric',
								'data-focus': 'qty',
							})
						);
						input.value = String(quantity);
						/** @param {number} wanted */
						const setPieces = (wanted) => {
							quantity = Math.max(limits.min, Math.min(limits.max, Math.round(wanted / limits.step) * limits.step));
							input.value = String(quantity);
						};
						input.addEventListener('change', () => setPieces(Math.floor(Number(input.value)) || limits.min));
						/** @param {number} step */
						const stepBy = (step) => setPieces(quantity + step * limits.step);
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
						if (limits.step > 1 || limits.min > 1)
							parts.push(h(doc, 'p', { class: 'hint' }, t('page.quantityHelp', { step: limits.step, min: limits.min })));
						input.id = 'ss-page-qty';
					}
					const ready = current !== null && buyable(current) && (!booking || slot !== null);
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
								...(measure ? { measured: true } : {}),
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

				/**
				 * A text field of the alert row whose value outlives a re-render (`typed`).
				 * @param {string} id @param {string} label @param {Record<string, string>} attributes
				 */
				const alertField = (id, label, attributes) => {
					const input = /** @type {HTMLInputElement} */ (h(doc, 'input', { ...attributes, 'data-focus': id }));
					input.value = typed.get(id) ?? '';
					input.addEventListener('input', () => void typed.set(id, input.value));
					return field(doc, `ss-page-${id}`, label, input);
				};

				/**
				 * The alert buttons: set one, or see the one already set with Stop. A guest gives the contact guests are known by
				 * (`settings.alerts.contact`: a phone, an email address or either, E15) while guests may (they cannot list
				 * their alerts); a price-drop alert names an optional price while the setting allows (EN-1).
				 * @param {PageVariant | null} current
				 */
				const alertRow = async (current) => {
					const member = Boolean(shop.signIn());
					if (!member && !settings.alerts.guests) return h(doc, 'p', { class: 'hint' }, t('alerts.signIn'));
					const mine = member
						? (await alerts.list()).filter(
								(entry) =>
									entry.status === 'waiting' &&
									entry.productId === item.id &&
									(entry.variantId === null || entry.variantId === current?.id),
							)
						: [];
					/** @param {'back_in_stock' | 'price_drop'} kind @param {string} text */
					const set = (kind, text) =>
						button(
							doc,
							text,
							async (event) => {
								const node = /** @type {HTMLButtonElement} */ (event.currentTarget);
								const target =
									kind === 'price_drop' && settings.alerts.targetPrice ? (typed.get('alert-target') ?? '').trim() : '';
								const targetPrice = target === '' ? null : formats.amountOf(target, currency);
								if (target !== '' && targetPrice === null) return void (said.textContent = t('alerts.targetInvalid'));
								node.setAttribute('disabled', '');
								const answer = await shop.call('/v1/shop/alerts', {
									method: 'POST',
									body: {
										kind,
										productId: item.id,
										variantId: variant()?.id ?? null,
										...(member || settings.alerts.contact === 'email' ? {} : { phone: typed.get('alert-phone') ?? '' }),
										...(member || settings.alerts.contact === 'phone' ? {} : { email: typed.get('alert-email') ?? '' }),
										...(targetPrice === null ? {} : { targetPrice }),
									},
									idempotencyKey: shop.newKey(),
								});
								node.removeAttribute('disabled');
								said.textContent = answer.ok
									? t(kind === 'back_in_stock' ? 'alerts.stockSet' : 'alerts.priceSet')
									: !member && codeOf(answer) === 'validation_failed'
										? t('alerts.checkContact')
										: problemText(config, 'alerts.problem.', codeOf(answer), 'alerts.failed');
								if (answer.ok && member) {
									alerts.forget();
									void renderExtras();
								}
							},
							{ class: 'secondary', 'data-focus': kind },
						);
					/** @param {import('./shop-page-parts.js').ShopAlert} entry @param {string} text */
					const active = (entry, text) =>
						h(
							doc,
							'p',
							{ class: 'meta' },
							text,
							' ',
							button(
								doc,
								t('alerts.stop'),
								async () => {
									const answer = await shop.call(`/v1/shop/alerts/${encodeURIComponent(entry.id)}`, {
										method: 'DELETE',
									});
									said.textContent = t(answer.ok ? 'alerts.stopped' : 'alerts.stopFailed');
									alerts.forget();
									void renderExtras();
								},
								{ class: 'link', 'data-focus': `stop.${entry.kind}` },
							),
						);
					const stockAlert = mine.find((entry) => entry.kind === 'back_in_stock');
					const priceAlert = mine.find((entry) => entry.kind === 'price_drop');
					return h(
						doc,
						'div',
						{ class: 'actions' },
						member || settings.alerts.contact === 'email'
							? null
							: alertField('alert-phone', t('alerts.phone'), { type: 'tel', autocomplete: 'tel' }),
						member || settings.alerts.contact === 'phone'
							? null
							: alertField('alert-email', t('alerts.email'), { type: 'email', autocomplete: 'email' }),
						priceAlert || !settings.alerts.targetPrice
							? null
							: alertField('alert-target', t('alerts.targetPrice'), { inputmode: 'decimal' }),
						current && !buyable(current)
							? stockAlert
								? active(stockAlert, t('alerts.stockActive'))
								: set('back_in_stock', t('alerts.backInStock'))
							: null,
						priceAlert ? active(priceAlert, t('alerts.priceActive')) : set('price_drop', t('alerts.priceDrop')),
					);
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
					if (shop.has('alerts')) row.push(await alertRow(current));
					keepFocus(root, () => extras.replaceChildren(...row));
				};

				const refresh = () => {
					const now = mediaNow();
					if (now.from !== shownFrom) {
						shownFrom = now.from;
						media = now.list;
						index = 0;
					}
					keepFocus(root, () => {
						renderGallery();
						renderPickers();
						renderFacts();
						renderAdd();
					});
					renderPrice();
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

				// ------------------------------------------------------------------- specs, description, video, FAQs
				const blocks = [];
				const specs = Array.isArray(item.specs) ? item.specs : [];
				if (specs.length > 0)
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
										...specs.map((/** @type {{ name: string, value: unknown, unit: string, label?: string }} */ spec) =>
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
														: spec.label
															? spec.label
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
				const rich = richText(doc, item.descriptionHtml);
				const plainText = paragraphs(doc, item.description);
				if (rich.childNodes.length > 0 || plainText.length > 0)
					blocks.push(
						h(
							doc,
							'section',
							{ class: 'wide description' },
							h(doc, 'h2', {}, t('page.description')),
							...(rich.childNodes.length > 0 ? [rich] : plainText),
						),
					);
				blocks.push(videoBlock(doc, t, item.video, item.name), faqBlock(doc, t, item.faqs));
				/** @type {{ identity: () => void } | null} */
				let reviews = null;
				if (shop.has('reviews')) {
					const box = h(doc, 'section', { class: 'wide', 'aria-label': t('reviews.title') });
					blocks.push(box);
					reviews = renderReviews({ box, t, shop, config, productId: item.id });
				}

				// the frame is the size container: two columns where the widget itself is wide, not the screen
				root.replaceChildren(
					h(
						doc,
						'div',
						{ class: 'page-frame' },
						h(
							doc,
							'div',
							{ class: 'page' },
							gallery,
							buy,
							.../** @type {HTMLElement[]} */ (blocks.filter((block) => block !== null)),
						),
					),
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
