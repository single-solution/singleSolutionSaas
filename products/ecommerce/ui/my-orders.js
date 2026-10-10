/**
 * The shopper's orders (visitor widget `my_orders`, feature checkout; PLAN 0.8.8 "my orders + tracking + invoices +
 * returns"). Signed in, the shopper sees their orders (newest first, more with Load more) and each order's lines,
 * status history, payment (and the way to pay while it waits), delivery and tracking link, totals, the invoice
 * (`invoices`), downloads and licence keys (`digital_goods`), Cancel while the order allows it, and return or
 * warranty claims (`returns`) with their own list. Signed out, the sign-in hint shows.
 * @module
 */
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
	settingsOf,
	textsOf,
} from './shop-common.js';
import { returnUrlOf } from './shop-checkout.js';
import { renderClaimForm, renderClaims } from './shop-returns.js';

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
			const listBox = h(doc, 'div');
			const detailBox = h(doc, 'div');
			const claimsBox = h(doc, 'section');
			root.append(listBox, detailBox, claimsBox);
			/** @type {string | null} */
			let cursor = null;
			let seq = 0;

			// -------------------------------------------------------------------------------------------- list

			const showList = async () => {
				seq += 1;
				const mine = seq;
				detailBox.replaceChildren();
				detailBox.hidden = true;
				listBox.hidden = false;
				claimsBox.hidden = false;
				if (!shop.signIn()) {
					listBox.replaceChildren(h(doc, 'p', { class: 'hint' }, t('orders.signIn')));
					claimsBox.replaceChildren();
					return;
				}
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
					return h(
						doc,
						'li',
						{},
						h(doc, 'strong', {}, line.variantName ? `${line.name} (${line.variantName})` : line.name),
						line.gradeLabel ? h(doc, 'span', { class: 'meta' }, t('cart.grade', { grade: line.gradeLabel })) : null,
						h(
							doc,
							'span',
							{ class: 'meta' },
							t('orders.lineAmount', {
								quantity: line.quantity,
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
						line.licenceKeys.length > 0
							? h(
									doc,
									'div',
									{},
									h(doc, 'span', { class: 'meta' }, t('orders.licenceKeys')),
									...line.licenceKeys.map((/** @type {string} */ key) => h(doc, 'p', {}, h(doc, 'code', {}, key))),
								)
							: null,
					);
				});

				const payment = order.payment;
				const paymentParts = [
					h(
						doc,
						'p',
						{},
						t('orders.paymentLine', {
							method: t(`checkout.method.${payment.method}`),
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
				if (payment.refunded > 0)
					paymentParts.push(
						h(doc, 'p', { class: 'meta' }, t('orders.refunded', { amount: money(payment.refunded, currency) })),
					);

				const address = order.address;
				const deliveryParts =
					order.delivery.method === 'pickup'
						? [h(doc, 'p', {}, t('orders.pickupAt', { name: order.delivery.locationName }))]
						: address
							? [
									h(
										doc,
										'p',
										{},
										[
											address.name,
											address.line1,
											address.line2,
											address.area,
											address.city,
											address.postalCode,
											address.country,
										]
											.filter(Boolean)
											.join(', '),
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

				const totals = order.totals;
				/** @type {Array<[string, string]>} */
				const rows = [[t('cart.subtotal'), money(totals.subtotal, currency)]];
				if (totals.discount > 0) rows.push([t('orders.discount'), `−${money(totals.discount, currency)}`]);
				if (order.delivery.method === 'delivery') rows.push([t('cart.delivery'), money(totals.delivery, currency)]);
				if (totals.tax > 0) rows.push([t(totals.taxIncluded ? 'cart.taxIncluded' : 'cart.tax'), money(totals.tax, currency)]);
				rows.push([t('cart.total'), money(totals.total, currency)]);

				/** @type {HTMLElement[]} */
				const actions = [];
				if (shop.has('invoices') && typeof fetchDocument === 'function')
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
				if (shop.has('returns') && CLAIMABLE_ROLES.includes(order.role))
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
						h(
							doc,
							'section',
							{ 'aria-label': t('orders.historyTitle') },
							h(doc, 'h2', {}, t('orders.historyTitle')),
							h(
								doc,
								'ul',
								{},
								...order.history.map((/** @type {{ at: string, label: string }} */ entry) =>
									h(doc, 'li', {}, t('orders.historyLine', { status: entry.label, date: dateText(entry.at) })),
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
