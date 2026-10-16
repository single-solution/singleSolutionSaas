/**
 * The shopper's orders (visitor widget `my_orders`, feature checkout; PLAN 0.8.8 "my orders + tracking + invoices +
 * returns"). Signed in, the shopper sees their orders (newest first, more with Load more) and each order's lines,
 * status history, payment (and the way to pay while it waits), delivery and tracking link, totals, the invoice
 * (`invoices`), for a bank transfer its bank details and the transfer proof (E24), downloads and license keys (`digital_goods`), each line's serial numbers and warranty (PLAN 0.8.10
 * E11, E12), Cancel while the order allows it, return or warranty claims (`returns`) with their own list and, with
 * reviews per order line, a review of each delivered item (`reviews`, E34; the line's `canReview`). Above the
 * orders, the loyalty points balance with the points expiring soon and the points history (`loyalty`,
 * `GET /v1/shop/loyalty`). Signed out, the sign-in hint shows, under the guest orders this browser keeps the keys of (E21),
 * which open with their key (paying, canceling, the transfer proof, the invoice, downloads and reviews of items).
 * @module
 */
import { addressLines, countryName } from '../core/address.js';
import {
	button,
	codeOf,
	currencyOf,
	fill,
	formatsOf,
	h,
	keepFocus,
	mountShop,
	problemText,
	quantityShown,
	settingsOf,
	textsOf,
	warrantyText,
} from './shop-common.js';
import { returnUrlOf } from './shop-checkout.js';
import { renderClaimForm, renderClaims } from './shop-returns.js';
import { transferParts } from './shop-payment.js';
import { reviewForm } from './shop-reviews.js';

const PAGE = 10;
/** Roles of an order whose items can be claimed. */
const CLAIMABLE_ROLES = ['delivered', 'refunded'];

/** @typedef {import('./widget.js').Shop} Shop */
/** @typedef {(path: string) => Promise<{ ok: boolean, status: number, text: string }>} DocumentCall */

/**
 * @param {import('./widget.js').VisitorMount} input
 * @returns {Promise<void>}
 */
export const mountMyOrders = async ({ host, config, shop, win }) => {
	const t = textsOf(config);
	const settings = settingsOf(config);
	const { money, dateText } = formatsOf(config, win);
	/** An HTML document behind the browser token (the invoice), when the widget runtime offers it. */
	const fetchDocument = /** @type {{ document?: DocumentCall }} */ (/** @type {unknown} */ (shop)).document;

	mountShop({
		host,
		config,
		name: 'my-orders',
		render: (root) => {
			const doc = root.ownerDocument;
			const pointsBox = h(doc, 'section', { 'aria-label': t('orders.points.title') });
			const listBox = h(doc, 'div');
			const detailBox = h(doc, 'div');
			const claimsBox = h(doc, 'section');
			root.append(pointsBox, listBox, detailBox, claimsBox);
			/** @type {string | null} */
			let cursor = null;
			let seq = 0;

			// ------------------------------------------------------------------------------------------ points

			/**
			 * The loyalty points: the balance and what it is worth, the points expiring soon and the history (none for a
			 * shopper who is not a loyalty member).
			 * @param {number} mine
			 */
			const showPoints = async (mine) => {
				const answer = await shop.call('/v1/shop/loyalty');
				if (mine !== seq) return;
				if (!answer.ok) {
					pointsBox.replaceChildren(h(doc, 'p', { class: 'meta' }, t('orders.points.error')));
					return;
				}
				const account = answer.data;
				// a shopper who is not a loyalty member sees no points (the loyalty setting memberFlag, E47)
				if (account.member === false) {
					pointsBox.replaceChildren();
					return;
				}
				const currency = currencyOf(settings, account.currency);
				const history = Array.isArray(account.history) ? account.history : [];
				const expiring = Array.isArray(account.expiringSoon) ? account.expiringSoon : [];
				/** @param {number} points */
				const signed = (points) => (points > 0 ? `+${points}` : `−${Math.abs(points)}`);
				pointsBox.replaceChildren(
					h(
						doc,
						'div',
						{ class: 'box' },
						h(doc, 'h2', {}, t('orders.points.title')),
						h(
							doc,
							'p',
							{ class: 'amount' },
							t('orders.points.balance', { balance: account.balance, value: money(account.value, currency) }),
						),
						...expiring.map((/** @type {{ points: number, expiresAt: string }} */ entry) =>
							h(
								doc,
								'p',
								{ class: 'meta' },
								t('orders.points.expiring', { points: entry.points, date: dateText(entry.expiresAt, { time: false }) }),
							),
						),
						history.length > 0
							? h(
									doc,
									'details',
									{},
									h(doc, 'summary', {}, t('orders.points.history')),
									h(
										doc,
										'ul',
										{},
										...history.map((/** @type {{ at: string, kind: string, points: number }} */ entry) =>
											h(
												doc,
												'li',
												{},
												t('orders.points.line', {
													change: signed(entry.points),
													kind: t(`orders.points.kind.${entry.kind}`),
													date: dateText(entry.at, { time: false }),
												}),
											),
										),
									),
								)
							: null,
					),
				);
			};

			// -------------------------------------------------------------------------------------------- list

			const showList = async () => {
				seq += 1;
				const mine = seq;
				detailBox.replaceChildren();
				detailBox.hidden = true;
				listBox.hidden = false;
				claimsBox.hidden = false;
				pointsBox.hidden = false;
				if (!shop.signIn()) {
					claimsBox.replaceChildren();
					pointsBox.replaceChildren();
					await showGuestOrders(mine);
					return;
				}
				if (shop.has('loyalty')) void showPoints(mine);
				const list = h(doc, 'ul', { 'aria-label': t('orders.title') });
				const status = h(doc, 'p', { class: 'status', role: 'status' }, t('orders.loading'));
				const more = button(doc, t('orders.more'), () => void page(), { class: 'secondary more' });
				more.hidden = true;
				listBox.replaceChildren(h(doc, 'h2', {}, t('orders.title')), status, list, more);
				cursor = null;
				const page = async () => {
					const query = new URLSearchParams({ limit: String(PAGE) });
					if (cursor) query.set('cursor', cursor);
					const answer = await shop.call(`/v1/shop/orders?${query}`);
					if (mine !== seq) return;
					if (!answer.ok) {
						status.textContent = t('orders.error');
						return;
					}
					list.append(...answer.data.items.map(rowOf));
					cursor = answer.data.nextCursor ?? null;
					more.hidden = !cursor;
					status.textContent = list.children.length === 0 ? t('orders.empty') : '';
				};
				await page();
				if (shop.has('returns') && mine === seq) await renderClaims({ box: claimsBox, t, shop, config, settings, win });
			};

			/**
			 * Signed out: the guest orders whose keys this browser keeps (E21), each read with its key, and the sign-in hint.
			 * @param {number} mine
			 */
			const showGuestOrders = async (mine) => {
				const ids = shop.guestOrders().slice(0, PAGE);
				const hint = h(doc, 'p', { class: 'hint' }, t('orders.signIn'));
				if (ids.length === 0) {
					listBox.replaceChildren(hint);
					return;
				}
				const list = h(doc, 'ul', { 'aria-label': t('orders.guestTitle') });
				listBox.replaceChildren(h(doc, 'h2', {}, t('orders.guestTitle')), list, hint);
				const found = await Promise.all(ids.map((id) => shop.call(`/v1/shop/orders/${encodeURIComponent(id)}`)));
				if (mine !== seq) return;
				for (const answer of found)
					if (answer.ok)
						list.append(
							rowOf({
								id: answer.data.id,
								number: answer.data.number,
								placedAt: answer.data.placedAt,
								statusLabel: answer.data.statusLabel,
								total: answer.data.totals.total,
								currency: answer.data.totals.currency,
								itemCount: answer.data.lines.reduce(
									(/** @type {number} */ sum, /** @type {any} */ line) => sum + line.quantity,
									0,
								),
							}),
						);
			};

			/** @param {any} order */
			const rowOf = (order) =>
				h(
					doc,
					'li',
					{},
					button(doc, t('orders.open', { number: order.number }), () => void showOrder(order.id), { class: 'secondary' }),
					h(
						doc,
						'span',
						{ class: 'meta' },
						t('orders.row', {
							date: dateText(order.placedAt, { time: false }),
							status: order.statusLabel,
							total: money(order.total, currencyOf(settings, order.currency)),
							count: order.itemCount,
						}),
					),
				);

			// ------------------------------------------------------------------------------------------ detail

			/** @param {string} id */
			const showOrder = async (id) => {
				seq += 1;
				const mine = seq;
				listBox.hidden = true;
				claimsBox.hidden = true;
				pointsBox.hidden = true;
				detailBox.hidden = false;
				detailBox.replaceChildren(h(doc, 'p', { class: 'status', role: 'status' }, t('orders.loading')));
				const answer = await shop.call(`/v1/shop/orders/${encodeURIComponent(id)}`);
				if (mine !== seq) return;
				if (!answer.ok) {
					detailBox.replaceChildren(
						button(doc, t('orders.back'), () => void showList(), { class: 'secondary' }),
						h(doc, 'p', { class: 'error', role: 'status' }, t(answer.status === 404 ? 'orders.notFound' : 'orders.error')),
					);
					return;
				}
				renderOrder(answer.data);
			};

			/**
			 * The review of one delivered item (reviews per order line, E34): a button that opens the form.
			 * @param {any} order @param {any} line @param {string} name
			 */
			const reviewBox = (order, line, name) => {
				const box = h(doc, 'div');
				/** @param {string} text */
				const done = (text) => box.replaceChildren(h(doc, 'p', { class: 'hint', role: 'status' }, text));
				const open = () =>
					box.replaceChildren(
						reviewForm({
							doc,
							t,
							shop,
							config,
							target: { orderId: order.id, lineId: line.id },
							idPrefix: `ss-review-${line.id}`,
							heading: t('reviews.writeItem', { name }),
							onDone: (state) => done(t(state === 'approved' ? 'reviews.thanks' : 'reviews.pending')),
							onRefused: (code) =>
								done(
									code === 'already_reviewed'
										? t('reviews.itemReviewed')
										: problemText(config, 'reviews.problem.', code, 'reviews.failed'),
								),
						}),
					);
				box.replaceChildren(
					button(doc, t('orders.review'), open, { class: 'secondary', 'aria-label': t('orders.reviewLabel', { name }) }),
				);
				return box;
			};

			/** @param {any} order */
			const renderOrder = (order) => {
				const currency = currencyOf(settings, order.totals?.currency);
				const status = h(doc, 'p', { class: 'status', role: 'status' });
				const claimBox = h(doc, 'div');
				/** @param {string} text */
				const say = (text) => {
					status.textContent = text;
				};

				const lines = order.lines.map((/** @type {any} */ line) => {
					const downloads = line.downloads.map((/** @type {{ file: string, name: string }} */ file) =>
						button(
							doc,
							t('orders.download', { name: file.name }),
							async () => {
								const got = await shop.call(
									`/v1/shop/orders/${encodeURIComponent(order.id)}/downloads/${encodeURIComponent(line.id)}/${encodeURIComponent(file.file)}`,
								);
								if (got.ok) return shop.go(got.data.url);
								say(problemText(config, 'orders.problem.', codeOf(got), 'orders.downloadFailed'));
							},
							{ class: 'secondary' },
						),
					);
					const warranty = warrantyText(t, line.warrantyTime);
					const lineName = line.variantName ? `${line.name} (${line.variantName})` : line.name;
					return h(
						doc,
						'li',
						{},
						h(doc, 'strong', {}, lineName),
						line.gradeLabel ? h(doc, 'span', { class: 'meta' }, t('cart.grade', { grade: line.gradeLabel })) : null,
						Array.isArray(line.serials) && line.serials.length > 0
							? h(doc, 'span', { class: 'meta' }, t('orders.serials', { serials: line.serials.join(', ') }))
							: null,
						// the units' numbers the merchant shows shoppers, by unit field
						...(Array.isArray(line.unitValues) ? line.unitValues : []).map((/** @type {any} */ entry) =>
							h(
								doc,
								'span',
								{ class: 'meta' },
								t('orders.unitValues', { name: entry.name, values: entry.values.join(', ') }),
							),
						),
						warranty ? h(doc, 'span', { class: 'meta' }, warranty) : null,
						h(
							doc,
							'span',
							{ class: 'meta' },
							t('orders.lineAmount', {
								quantity: quantityShown(t, line),
								price: money(line.unitPrice, currency),
								total: money(line.total, currency),
							}),
						),
						line.booking
							? h(doc, 'span', { class: 'meta' }, t('cart.slot', { start: dateText(line.booking.start) }))
							: null,
						downloads.length > 0 ? h(doc, 'div', { class: 'actions' }, ...downloads) : null,
						line.downloadsLeft !== null && line.downloads.length > 0
							? h(doc, 'span', { class: 'meta' }, t('orders.downloadsLeft', { count: line.downloadsLeft }))
							: null,
						line.licenseKeys.length > 0
							? h(
									doc,
									'div',
									{},
									h(doc, 'span', { class: 'meta' }, t('orders.licenseKeys')),
									...line.licenseKeys.map((/** @type {string} */ key) => h(doc, 'p', {}, h(doc, 'code', {}, key))),
								)
							: null,
						line.canReview === true && shop.has('reviews') ? reviewBox(order, line, lineName) : null,
					);
				});

				const payment = order.payment;
				const paymentParts = [
					h(
						doc,
						'p',
						{},
						t('orders.paymentLine', {
							method: payment.name,
							state: t(`orders.payment.${payment.state}`),
						}),
					),
				];
				if (payment.payBy)
					paymentParts.push(h(doc, 'p', { class: 'meta' }, t('success.payBy', { date: dateText(payment.payBy) })));
				if (payment.payUrl) paymentParts.push(h(doc, 'a', { href: payment.payUrl }, t('success.pay')));
				else if (order.role === 'awaiting_payment' && payment.state === 'pending')
					paymentParts.push(
						button(doc, t('success.retry'), async () => {
							const answer = await shop.call(`/v1/shop/orders/${encodeURIComponent(order.id)}/pay`, {
								method: 'POST',
								body: { returnUrl: returnUrlOf(shop) },
								idempotencyKey: shop.newKey(),
							});
							if (answer.ok && answer.data.next?.kind === 'pay') return shop.go(answer.data.next.url);
							if (answer.ok) return renderOrder(answer.data.order);
							say(problemText(config, 'checkout.problem.', codeOf(answer), 'checkout.problem.failed'));
						}),
					);
				// a bank transfer: the bank details, the shop's note, the proof sent and the proof form (E24)
				paymentParts.push(...transferParts({ doc, t, shop, config, win, order, onOrder: renderOrder }));
				if (payment.refunded > 0)
					paymentParts.push(
						h(doc, 'p', { class: 'meta' }, t('orders.refunded', { amount: money(payment.refunded, currency) })),
					);

				const address = order.address;
				// a stock location for pickup names itself; the settings' pickup point comes with its address and hours (E22)
				const point = order.pickupPoint;
				const deliveryParts =
					order.delivery.method === 'pickup'
						? [
								h(doc, 'p', {}, t('orders.pickupAt', { name: order.delivery.locationName || point?.name || '' })),
								order.delivery.rateName ? h(doc, 'p', { class: 'meta' }, order.delivery.rateName) : null,
								point?.address ? h(doc, 'p', { class: 'meta' }, point.address) : null,
								point?.hours ? h(doc, 'p', { class: 'meta' }, t('checkout.pickupHours', { hours: point.hours })) : null,
							]
						: address
							? [
									h(
										doc,
										'p',
										{},
										// the place as its country writes it, the country by name
										[address.name, ...addressLines(address), countryName(address.country)].filter(Boolean).join(', '),
									),
								]
							: [];
				if (order.shipment) {
					deliveryParts.push(
						h(
							doc,
							'p',
							{},
							t('orders.shipment', { courier: order.shipment.courier, tracking: order.shipment.trackingNumber }),
						),
					);
					if (order.shipment.trackingUrl)
						deliveryParts.push(
							h(doc, 'a', { href: order.shipment.trackingUrl, target: '_blank', rel: 'noopener' }, t('orders.track')),
						);
				}
				// the shop's attachments shoppers see: a packing video, a photo of the parcel … (E20)
				for (const attachment of order.attachments ?? [])
					deliveryParts.push(
						h(
							doc,
							'p',
							{ class: 'meta' },
							h(doc, 'a', { href: attachment.url, target: '_blank', rel: 'noopener' }, attachment.label),
						),
					);
				// the shop's texts: delivery times, packing, and when a pickup is ready (E22)
				const method = order.delivery.method;
				if (method !== 'none')
					for (const line of [
						method === 'delivery' ? order.notes?.delivery : '',
						order.notes?.prep,
						order.notes?.pickupReady,
					])
						if (line) deliveryParts.push(h(doc, 'p', { class: 'meta' }, line));

				const totals = order.totals;
				/** @type {Array<[string, string]>} */
				const rows = [[t('cart.subtotal'), money(totals.subtotal, currency)]];
				if (totals.discount > 0) rows.push([t('orders.discount'), `−${money(totals.discount, currency)}`]);
				// the delivery rate the shopper picked, by its name (E5)
				if (order.delivery.method === 'delivery')
					rows.push([
						order.delivery.rateName ? t('cart.deliveryRate', { rate: order.delivery.rateName }) : t('cart.delivery'),
						money(totals.delivery, currency),
					]);
				if (totals.tax > 0) rows.push([t(totals.taxIncluded ? 'cart.taxIncluded' : 'cart.tax'), money(totals.tax, currency)]);
				rows.push([t('cart.total'), money(totals.total, currency)]);

				/** @type {HTMLElement[]} */
				const actions = [];
				// the order says whether the shopper may open its invoice (invoices on, and shopperFrom)
				if (order.invoice === true && typeof fetchDocument === 'function')
					actions.push(
						button(
							doc,
							t('orders.invoice'),
							async () => {
								const got = await fetchDocument(`/v1/shop/orders/${encodeURIComponent(order.id)}/invoice`);
								if (!got.ok) return say(t('orders.invoiceFailed'));
								const url = win.URL.createObjectURL(new win.Blob([got.text], { type: 'text/html' }));
								if (win.open(url, '_blank')) return;
								status.replaceChildren(
									h(doc, 'a', { href: url, target: '_blank', rel: 'noopener' }, t('orders.openInvoice')),
								);
							},
							{ class: 'secondary' },
						),
					);
				if (order.canCancel)
					actions.push(
						button(
							doc,
							t('orders.cancel'),
							() => {
								status.replaceChildren(
									t('orders.cancelConfirm'),
									' ',
									button(
										doc,
										t('orders.cancelYes'),
										async () => {
											const answer = await shop.call(`/v1/shop/orders/${encodeURIComponent(order.id)}/cancel`, {
												method: 'POST',
											});
											if (answer.ok) return renderOrder(answer.data.order);
											say(problemText(config, 'orders.problem.', codeOf(answer), 'orders.cancelFailed'));
										},
										{ 'data-focus': 'cancelYes' },
									),
									' ',
									button(doc, t('orders.cancelNo'), () => say(''), { class: 'secondary' }),
								);
							},
							{ class: 'secondary' },
						),
					);
				// claims need a sign-in (E21)
				if (shop.has('returns') && shop.signIn() && CLAIMABLE_ROLES.includes(order.role))
					actions.push(
						button(
							doc,
							t('orders.claim'),
							() =>
								void renderClaimForm({
									box: claimBox,
									t,
									shop,
									config,
									settings,
									win,
									orderId: order.id,
									onDone: () => undefined,
								}),
							{ class: 'secondary' },
						),
					);

				keepFocus(root, () =>
					fill(
						detailBox,
						button(doc, t('orders.back'), () => void showList(), { class: 'secondary', 'data-focus': 'back' }),
						h(doc, 'h2', {}, t('orders.number', { number: order.number })),
						h(doc, 'p', {}, t('orders.placed', { date: dateText(order.placedAt), status: order.statusLabel })),
						// the line the shop wrote under this status for the order's payment method
						order.statusText ? h(doc, 'p', { class: 'meta' }, order.statusText) : null,
						h(doc, 'ul', { 'aria-label': t('orders.lines') }, ...lines),
						h(
							doc,
							'dl',
							{ class: 'totals' },
							...rows.flatMap(([label, value]) => [h(doc, 'dt', {}, label), h(doc, 'dd', {}, value)]),
						),
						h(
							doc,
							'section',
							{ 'aria-label': t('orders.paymentTitle') },
							h(doc, 'h2', {}, t('orders.paymentTitle')),
							...paymentParts,
						),
						deliveryParts.length > 0
							? h(
									doc,
									'section',
									{ 'aria-label': t('orders.deliveryTitle') },
									h(doc, 'h2', {}, t('orders.deliveryTitle')),
									...deliveryParts,
								)
							: null,
						order.note ? h(doc, 'p', { class: 'meta' }, t('orders.note', { note: order.note })) : null,
						// the order fields the shop shows its shoppers
						...(Array.isArray(order.fields) ? order.fields : []).map((/** @type {any} */ entry) =>
							h(doc, 'p', { class: 'meta' }, t('orders.fieldValue', { name: entry.name, value: entry.value })),
						),
						h(
							doc,
							'section',
							{ 'aria-label': t('orders.historyTitle') },
							h(doc, 'h2', {}, t('orders.historyTitle')),
							h(
								doc,
								'ul',
								{},
								...order.history.map((/** @type {{ at: string, label: string, note?: string }} */ entry) =>
									h(
										doc,
										'li',
										{},
										t('orders.historyLine', { status: entry.label, date: dateText(entry.at) }),
										// what the shop wrote for the shopper with the move
										entry.note ? h(doc, 'div', { class: 'meta' }, t('orders.historyNote', { note: entry.note })) : null,
									),
								),
							),
						),
						actions.length > 0 ? h(doc, 'div', { class: 'actions' }, ...actions) : null,
						status,
						claimBox,
					),
				);
			};

			const stop = shop.onIdentity(() => void showList());
			void showList();
			return stop;
		},
	});
};
