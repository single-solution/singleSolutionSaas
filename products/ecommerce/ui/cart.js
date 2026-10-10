/**
 * The cart, checkout and success page (visitor widget `cart`, feature checkout; PLAN 0.8.8). The cart lives in the
 * shopper's browser and is priced by the server (`POST /v1/shop/cart/quote`) whenever it changes (a short pause first,
 * so quick changes make one quote): lines with their problems, quantities, the coupon, loyalty points, the delivery
 * method (delivery to an address, or pickup), the address, the payment methods the quote allows, a note, the policies
 * and the totals. Placing the order needs the shopper's sign-in; the Idempotency-Key is kept while the same attempt
 * is retried after a lost answer. Then the shopper pays on Payments' page (`next.kind === 'pay'`), sees the success
 * page (`done`), or can start the payment again (`retry`). Coming back from Payments, the page's `ss_order` shows that
 * order's success page (reading it rechecks its payment). Growth's events (PLAN 0.8.9): `ss:begin_checkout` the first
 * time the shopper presses Place order (once per cart widget, with the quoted lines), and `ss:purchase` as soon as
 * `POST /v1/shop/orders` answers that the order is placed (before the payment page or the success page).
 * @module
 */
import { GROWTH_EVENTS, growthItem, itemsDetail, purchaseDetail } from '../core/growth-events.js';
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
	problemText,
	settingsOf,
	textsOf,
} from './shop-common.js';
import { addressForm, renderSuccess, returnUrlOf } from './shop-checkout.js';

/** The pause after a change before the cart is priced again (ms). */
const QUOTE_DELAY = 300;
const ORDER_ID = /^ord_[A-Za-z0-9_-]{1,64}$/;
/** Problems that mean the cart changed on the server: it is priced again at once. */
const REQUOTE = ['out_of_stock', 'offer_unavailable', 'points_changed', 'slot_taken', 'cod_not_allowed', 'validation_failed'];

/** @typedef {import('./cart-store.js').CartLine} CartLine */

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountCart = async ({ host, config, shop, win }) => {
	const t = textsOf(config);
	const settings = settingsOf(config);
	const { money, dateText } = formatsOf(config, win);
	const cart = shop.cart;

	mountShop({
		host,
		config,
		name: 'cart',
		render: (root) => {
			const doc = root.ownerDocument;
			/** @type {'cart' | 'success'} */
			let view = 'cart';
			/** @type {any} */
			let quote = null;
			let quoteFailed = false;
			let points = 0;
			/** @type {{ method: 'delivery' | 'pickup', locationId: string | null }} */
			let delivery = { method: 'delivery', locationId: null };
			/** @type {string | null} */
			let payment = null;
			/** @type {string | null} */
			let attemptKey = null;
			let placing = false;
			let checkoutBegun = false;
			let waitingForSignIn = false;
			let seq = 0;
			/** @type {number | null} */
			let timer = null;

			const cartBox = h(doc, 'div', { class: 'stack' });
			const successBox = h(doc, 'div');
			const status = h(doc, 'p', { class: 'status', role: 'status', 'aria-live': 'polite' });
			const linesBox = h(doc, 'div');
			const couponBox = h(doc, 'div');
			const pointsBox = h(doc, 'div');
			const deliveryBox = h(doc, 'div');
			const paymentBox = h(doc, 'div');
			const totalsBox = h(doc, 'div');
			const placeBox = h(doc, 'div');
			const placeStatus = h(doc, 'p', { class: 'status', role: 'status' });
			const address = addressForm({ doc, t, settings, onPlace: () => requote() });
			const note = /** @type {HTMLTextAreaElement} */ (h(doc, 'textarea', { maxlength: '1000', rows: '3' }));
			note.addEventListener('input', () => {
				attemptKey = null;
			});
			const policies = Object.entries(settings.checkout.policies).filter(
				([, text]) => typeof text === 'string' && text.trim(),
			);
			const checkoutBox = h(
				doc,
				'div',
				{ class: 'stack' },
				deliveryBox,
				address.node,
				paymentBox,
				field(doc, 'ss-cart-note', t('checkout.note'), note),
				policies.length > 0
					? h(
							doc,
							'section',
							{ 'aria-label': t('checkout.policies') },
							...policies.map(([key, text]) =>
								h(
									doc,
									'details',
									{},
									h(doc, 'summary', {}, t(`checkout.policy.${key}`)),
									...text.split(/\n\s*\n/).map((p) => h(doc, 'p', {}, p.trim())),
								),
							),
						)
					: null,
			);
			cartBox.append(
				h(doc, 'h2', {}, t('cart.title')),
				status,
				linesBox,
				couponBox,
				pointsBox,
				checkoutBox,
				totalsBox,
				placeBox,
			);
			root.append(cartBox, successBox);

			const currency = () => currencyOf(settings, quote?.currency);

			// ------------------------------------------------------------------------------------------ quoting

			/** The cart as the quote and the order take it. */
			const cartBody = () => {
				const state = cart.state();
				return {
					lines: state.lines.map((line) => ({
						productId: line.productId,
						variantId: line.variantId,
						quantity: line.quantity,
						...(line.slot ? { slot: line.slot } : {}),
					})),
					coupon: state.coupon,
					points,
					delivery: {
						method: delivery.method,
						city: address.value('city'),
						area: address.value('area'),
						country: address.value('country'),
						locationId: delivery.method === 'pickup' ? delivery.locationId : null,
					},
					payment,
				};
			};

			const priceNow = async () => {
				timer = null;
				seq += 1;
				const mine = seq;
				if (cart.state().lines.length === 0) {
					quote = null;
					quoteFailed = false;
					return renderAll();
				}
				const answer = await shop.call('/v1/shop/cart/quote', { method: 'POST', body: cartBody() });
				if (mine !== seq) return;
				quoteFailed = !answer.ok;
				if (answer.ok) quote = answer.data;
				renderAll();
			};

			/** Price the cart again after a short pause (quick changes make one quote). */
			const requote = () => {
				attemptKey = null;
				if (timer !== null) win.clearTimeout(timer);
				timer = win.setTimeout(() => void priceNow(), QUOTE_DELAY);
			};

			/**
			 * The cart line a quoted line came from (lines are quoted in cart order; merged lines are found by product).
			 * @param {any} line
			 * @param {number} index
			 * @returns {CartLine | undefined}
			 */
			const cartLineOf = (line, index) => {
				const lines = cart.state().lines;
				if (quote && quote.lines.length === lines.length) return lines[index];
				return lines.find(
					(entry) => entry.productId === line.productId && (entry.variantId === line.variantId || entry.variantId === null),
				);
			};

			// ------------------------------------------------------------------------------------------- views

			const renderLines = () => {
				if (!quote) {
					fill(linesBox, quoteFailed ? button(doc, t('cart.retry'), () => void priceNow(), { class: 'secondary' }) : null);
					return;
				}
				const cur = currency();
				const items = quote.lines.map((/** @type {any} */ line, /** @type {number} */ index) => {
					const source = cartLineOf(line, index);
					const name = line.name || t('cart.unknownItem');
					const controls = [];
					if (source && line.kind !== 'booking') {
						const input = /** @type {HTMLInputElement} */ (
							h(doc, 'input', {
								type: 'number',
								min: '1',
								max: String(MAX_QUANTITY),
								inputmode: 'numeric',
								'aria-label': t('cart.quantity', { name }),
								'data-focus': `qty${index}`,
							})
						);
						input.value = String(source.quantity);
						input.addEventListener('change', () => cart.set(source, Math.max(1, Math.floor(Number(input.value)) || 1)));
						controls.push(
							h(
								doc,
								'div',
								{ class: 'stepper' },
								button(doc, '−', () => cart.set(source, source.quantity - 1), {
									class: 'secondary',
									'aria-label': t('cart.less', { name }),
									'data-focus': `less${index}`,
								}),
								input,
								button(doc, '+', () => cart.set(source, source.quantity + 1), {
									class: 'secondary',
									'aria-label': t('cart.more', { name }),
									'data-focus': `more${index}`,
									...(source.quantity >= MAX_QUANTITY ? { disabled: '' } : {}),
								}),
							),
						);
					}
					if (source)
						controls.push(
							button(doc, t('cart.remove'), () => cart.set(source, 0), {
								class: 'secondary icon',
								'aria-label': t('cart.removeLabel', { name }),
							}),
						);
					return h(
						doc,
						'li',
						{},
						line.image ? h(doc, 'img', { src: line.image, alt: '' }) : h(doc, 'span'),
						h(
							doc,
							'div',
							{ class: 'body' },
							h(doc, 'strong', {}, name),
							line.variantName ? h(doc, 'span', { class: 'meta' }, line.variantName) : null,
							line.gradeLabel ? h(doc, 'span', { class: 'meta' }, t('cart.grade', { grade: line.gradeLabel })) : null,
							line.slot ? h(doc, 'span', { class: 'meta' }, t('cart.slot', { start: dateText(line.slot.start) })) : null,
							line.unitPrice > 0
								? h(doc, 'span', { class: 'meta' }, t('cart.unitPrice', { price: money(line.unitPrice, cur) }))
								: null,
							line.discount > 0
								? h(doc, 'span', { class: 'save' }, t('cart.lineDiscount', { amount: money(line.discount, cur) }))
								: null,
							...line.problems.map((/** @type {{ code: string }} */ problem) =>
								h(
									doc,
									'span',
									{ class: 'error' },
									problemText(config, 'cart.problem.', problem.code, 'cart.problem.unavailable'),
								),
							),
							h(
								doc,
								'div',
								{ class: 'end' },
								...controls,
								line.total > 0 ? h(doc, 'strong', {}, money(line.total, cur)) : null,
							),
						),
					);
				});
				linesBox.replaceChildren(h(doc, 'ul', { class: 'lines', 'aria-label': t('cart.lines') }, ...items));
			};

			const renderCoupon = () => {
				if (!settings.checkout.coupons || !quote) {
					couponBox.replaceChildren();
					return;
				}
				const code = cart.state().coupon;
				const problem = quote.promotions?.couponProblem;
				if (code) {
					couponBox.replaceChildren(
						h(
							doc,
							'div',
							{ class: 'row' },
							h(
								doc,
								'p',
								{ class: problem ? 'error' : 'save' },
								problem
									? problemText(config, 'cart.coupon.', problem.code, 'cart.coupon.coupon_not_applicable')
									: t('cart.couponApplied', { code }),
							),
							button(doc, t('cart.couponRemove'), () => cart.setCoupon(''), {
								class: 'secondary',
								'data-focus': 'couponRemove',
							}),
						),
					);
					return;
				}
				const input = /** @type {HTMLInputElement} */ (
					h(doc, 'input', { maxlength: '40', autocomplete: 'off', 'data-focus': 'coupon' })
				);
				const form = h(
					doc,
					'form',
					{ class: 'toolbar' },
					field(doc, 'ss-cart-coupon', t('cart.coupon'), input),
					h(doc, 'button', { type: 'submit', class: 'secondary' }, t('cart.couponApply')),
				);
				form.addEventListener('submit', (event) => {
					event.preventDefault();
					if (input.value.trim()) cart.setCoupon(input.value);
				});
				couponBox.replaceChildren(form);
			};

			const renderPoints = () => {
				const found = quote?.points;
				if (!settings.checkout.loyalty || !shop.signIn() || !found) {
					pointsBox.replaceChildren();
					return;
				}
				const parts = [h(doc, 'p', {}, t('cart.points.balance', { balance: found.balance }))];
				if (found.max > 0) {
					const input = /** @type {HTMLInputElement} */ (
						h(doc, 'input', {
							type: 'number',
							min: '0',
							max: String(found.max),
							inputmode: 'numeric',
							'data-focus': 'points',
						})
					);
					input.value = String(points);
					const form = h(
						doc,
						'form',
						{ class: 'toolbar' },
						field(doc, 'ss-cart-points', t('cart.points.use', { max: found.max }), input),
						h(doc, 'button', { type: 'submit', class: 'secondary' }, t('cart.points.apply')),
					);
					form.addEventListener('submit', (event) => {
						event.preventDefault();
						points = Math.max(0, Math.min(found.max, Math.floor(Number(input.value)) || 0));
						requote();
					});
					parts.push(form);
				}
				if (found.used > 0)
					parts.push(
						h(
							doc,
							'p',
							{ class: 'save' },
							t('cart.points.used', { points: found.used, amount: money(found.value, currency()) }),
						),
					);
				else if (points > 0) parts.push(h(doc, 'p', { class: 'error' }, t('cart.points.notEnough')));
				pointsBox.replaceChildren(h(doc, 'div', { class: 'box' }, ...parts));
			};

			const physical = () => Boolean(quote && quote.deliveryOptions.length > 0);

			const renderDelivery = () => {
				address.node.hidden = !physical() || quote.delivery.method !== 'delivery';
				if (!physical()) {
					deliveryBox.replaceChildren();
					return;
				}
				const cur = currency();
				const choices = quote.deliveryOptions.map((/** @type {any} */ option, /** @type {number} */ index) => {
					const pickup = option.method === 'pickup';
					const radio = /** @type {HTMLInputElement} */ (
						h(doc, 'input', { type: 'radio', name: 'ss-cart-delivery', 'data-focus': `delivery${index}` })
					);
					radio.checked =
						quote.delivery.method === option.method && (!pickup || quote.delivery.locationId === option.locationId);
					radio.addEventListener('change', () => {
						delivery = { method: option.method, locationId: option.locationId };
						requote();
					});
					const fee = option.fee > 0 ? money(option.fee, cur) : t('checkout.free');
					const days =
						option.minDays !== null && option.maxDays !== null
							? t('checkout.days', { min: option.minDays, max: option.maxDays })
							: '';
					return h(
						doc,
						'label',
						{ class: 'check' },
						radio,
						pickup
							? t('checkout.pickupAt', { name: option.name })
							: t('checkout.deliver', { fee, zone: option.name || t('checkout.zoneUnknown') }),
						days ? h(doc, 'span', { class: 'meta' }, days) : null,
					);
				});
				deliveryBox.replaceChildren(
					h(
						doc,
						'fieldset',
						{ class: 'box' },
						h(doc, 'legend', {}, t('checkout.delivery')),
						h(doc, 'div', { class: 'choices' }, ...choices),
						quote.deliveryProblem
							? h(
									doc,
									'p',
									{ class: 'error' },
									problemText(
										config,
										'checkout.deliveryProblem.',
										quote.deliveryProblem,
										'checkout.deliveryProblem.choose_pickup_location',
									),
								)
							: null,
					),
				);
			};

			const renderPayment = () => {
				const available = (quote?.paymentMethods ?? []).filter((/** @type {any} */ option) => option.available);
				if (!quote) {
					paymentBox.replaceChildren();
					return;
				}
				if (!available.some((/** @type {any} */ option) => option.method === payment)) payment = available[0]?.method ?? null;
				const choices = available.map((/** @type {any} */ option) => {
					const radio = /** @type {HTMLInputElement} */ (
						h(doc, 'input', {
							type: 'radio',
							name: 'ss-cart-payment',
							value: option.method,
							'data-focus': `pay-${option.method}`,
						})
					);
					radio.checked = option.method === payment;
					radio.addEventListener('change', () => {
						payment = option.method;
						attemptKey = null;
					});
					return h(
						doc,
						'label',
						{ class: 'check' },
						radio,
						t(`checkout.method.${option.method}`),
						option.advance > 0
							? h(doc, 'span', { class: 'meta' }, t('checkout.codAdvance', { amount: money(option.advance, currency()) }))
							: null,
					);
				});
				paymentBox.replaceChildren(
					h(
						doc,
						'fieldset',
						{ class: 'box' },
						h(doc, 'legend', {}, t('checkout.payment')),
						choices.length > 0
							? h(doc, 'div', { class: 'choices' }, ...choices)
							: h(doc, 'p', { class: 'error' }, t('checkout.noPayment')),
					),
				);
			};

			const renderTotals = () => {
				if (!quote) {
					totalsBox.replaceChildren();
					return;
				}
				const cur = currency();
				const { totals } = quote;
				/** @type {Array<[string, string, string?]>} */
				const rows = [[t('cart.subtotal'), money(totals.subtotal, cur)]];
				for (const applied of quote.promotions?.applied ?? [])
					rows.push([
						t('cart.applied', { name: applied.name }),
						applied.amount > 0 ? `−${money(applied.amount, cur)}` : t('cart.freeDelivery'),
					]);
				if (quote.points?.value > 0) rows.push([t('cart.pointsDiscount'), `−${money(quote.points.value, cur)}`]);
				if (physical() && quote.delivery.method === 'delivery')
					rows.push([t('cart.delivery'), totals.delivery > 0 ? money(totals.delivery, cur) : t('checkout.free')]);
				if (totals.tax > 0)
					rows.push(
						totals.taxIncluded ? [t('cart.taxIncluded'), money(totals.tax, cur)] : [t('cart.tax'), money(totals.tax, cur)],
					);
				rows.push([t('cart.total'), money(totals.total, cur), 'total']);
				totalsBox.replaceChildren(
					h(
						doc,
						'dl',
						{ class: 'totals' },
						...rows.flatMap(([label, value, kind]) => [
							h(doc, 'dt', kind ? { class: kind } : {}, label),
							h(doc, 'dd', kind ? { class: kind } : {}, value),
						]),
					),
				);
			};

			const renderPlace = () => {
				if (!quote) {
					placeBox.replaceChildren();
					return;
				}
				const notReady = quote.ready ? null : h(doc, 'p', { class: 'error' }, t('cart.notReady'));
				if (!shop.signIn()) {
					fill(placeBox, notReady, h(doc, 'p', { class: 'hint' }, t('checkout.signIn')), placeStatus);
					return;
				}
				const place = button(doc, t(placing ? 'checkout.placing' : 'checkout.place'), () => void placeOrder(), {
					'data-focus': 'place',
				});
				if (placing || !quote.ready || payment === null) place.setAttribute('disabled', '');
				fill(placeBox, notReady, place, placeStatus);
			};

			const renderAll = () => {
				if (view === 'success') return;
				const empty = cart.state().lines.length === 0;
				status.textContent = empty ? t('cart.empty') : quoteFailed ? t('cart.quoteError') : quote ? '' : t('cart.loading');
				checkoutBox.hidden = empty || !quote;
				if (empty) quote = null;
				keepFocus(root, () => {
					renderLines();
					renderCoupon();
					renderPoints();
					renderDelivery();
					renderPayment();
					renderTotals();
					renderPlace();
				});
			};

			// ------------------------------------------------------------------------------------------ placing

			/** @param {any} order */
			const showSuccess = (order) => {
				view = 'success';
				cartBox.hidden = true;
				successBox.hidden = false;
				renderSuccess({ box: successBox, t, shop, config, settings, order });
			};

			/** @param {string} text */
			const sayPlace = (text) => {
				placeStatus.textContent = text;
			};

			const placeOrder = async () => {
				if (placing || !shop.signIn()) return;
				if (!checkoutBegun) {
					checkoutBegun = true;
					announce(win, GROWTH_EVENTS.beginCheckout, itemsDetail(currency(), quote.lines.map(growthItem)));
				}
				const isDelivery = physical() && quote.delivery.method === 'delivery';
				const missing = isDelivery ? address.missing() : null;
				if (missing) {
					sayPlace(t('checkout.missing', { field: t(`checkout.field.${missing}`) }));
					address.focus(missing);
					return;
				}
				attemptKey ??= shop.newKey();
				placing = true;
				renderPlace();
				sayPlace(t('checkout.placing'));
				const answer = await shop.call('/v1/shop/orders', {
					method: 'POST',
					body: {
						...cartBody(),
						payment,
						note: note.value.trim(),
						...(isDelivery ? { address: address.values() } : {}),
						returnUrl: returnUrlOf(shop),
					},
					idempotencyKey: attemptKey,
				});
				placing = false;
				// a lost answer or a server failure: the same attempt is retried with the same key
				if (answer.status !== 0 && answer.status < 500) attemptKey = null;
				if (answer.ok) {
					announce(win, GROWTH_EVENTS.purchase, purchaseDetail(answer.data.order));
					sayPlace('');
					cart.clear();
					if (answer.data.next?.kind === 'pay') return shop.go(answer.data.next.url);
					return showSuccess(answer.data.order);
				}
				const code = codeOf(answer);
				const path = answer.data?.errors?.[0]?.path;
				sayPlace(
					code === 'validation_failed' && typeof path === 'string' && path.startsWith('/address')
						? t('checkout.problem.address')
						: problemText(config, 'checkout.problem.', code, 'checkout.problem.failed'),
				);
				renderPlace();
				if (REQUOTE.includes(code)) void priceNow();
			};

			// --------------------------------------------------------------------------------------- the success page

			/** @param {string} id */
			const loadOrder = async (id) => {
				view = 'success';
				cartBox.hidden = true;
				waitingForSignIn = !shop.signIn();
				if (waitingForSignIn) {
					successBox.replaceChildren(h(doc, 'p', { class: 'hint' }, t('success.signIn')));
					return;
				}
				successBox.replaceChildren(h(doc, 'p', { class: 'status', role: 'status' }, t('success.loading')));
				const answer = await shop.call(`/v1/shop/orders/${encodeURIComponent(id)}`);
				if (!answer.ok) {
					successBox.replaceChildren(
						h(
							doc,
							'p',
							{ class: 'error', role: 'status' },
							t(answer.status === 404 ? 'success.notFound' : 'success.error'),
						),
					);
					return;
				}
				cart.clear();
				showSuccess(answer.data);
			};

			const returning = shop.location().searchParams.get('ss_order') ?? '';
			const pendingOrder = ORDER_ID.test(returning) ? returning : null;

			const stops = [
				cart.onChange((state) => {
					if (view === 'success' && state.lines.length > 0) {
						view = 'cart';
						waitingForSignIn = false;
						cartBox.hidden = false;
						successBox.hidden = true;
					}
					renderAll();
					requote();
				}),
				shop.onIdentity(() => {
					if (waitingForSignIn && pendingOrder) {
						void loadOrder(pendingOrder);
						return;
					}
					if (view === 'cart') requote();
				}),
			];
			if (pendingOrder) void loadOrder(pendingOrder);
			else {
				renderAll();
				void priceNow();
			}
			return () => {
				if (timer !== null) win.clearTimeout(timer);
				for (const stop of stops) stop();
			};
		},
	});
};
