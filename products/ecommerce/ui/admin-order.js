/**
 * One order in the orders admin widget (PLAN 0.8.8 Orders, 0.6): a head with the number and status, the next step as
 * a button (Move to …) and Refund or Type serial numbers beside it, and in its More menu the other next statuses, the
 * typed serial numbers (E11), Refund, Edit delivery address (before shipping), Edit staff note, Invoice and Packing
 * slip (opened in a new tab), and a cancelling status last, in danger text behind its typed confirmation. Then the
 * figures in a grid, the lines with their warranty and serial numbers (E12), and cards: customer (blocked, returned
 * parcels), delivery address, shipment, notes, the order's return claims and history (the website's words for who and
 * what the server wrote itself, PLAN 0.4.10). Forms open in dialogs (the packing step asks one serial number per unit;
 * shipping asks a courier and tracking number, or books the courier API).
 * @module
 */
import { EDITABLE_ROLES } from '../core/orders.js';
import { query } from './admin-kit.js';
import { card, detailHead } from './admin-lists.js';
import { serialForm, serialLines, shipForm, typedSerials, warrantyOf } from './admin-order-forms.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Tone} Tone */
/** @typedef {import('./admin-lists.js').Detail} Detail */
/** @typedef {import('./admin-order-forms.js').SerialValues} SerialValues */

/** Address fields staff may change before shipping. */
const ADDRESS_FIELDS = Object.freeze(['name', 'phone', 'line1', 'line2', 'city', 'area', 'postalCode', 'country', 'notes']);

/** The status dot of each role (green, amber and red only for status). @type {Record<string, Tone>} */
export const ROLE_TONES = Object.freeze({
	awaiting_payment: 'warning',
	awaiting_confirmation: 'warning',
	open: 'neutral',
	packed: 'neutral',
	shipped: 'neutral',
	delivered: 'success',
	cancelled: 'danger',
	returned_to_origin: 'danger',
	refunded: 'neutral',
	returned: 'neutral',
});

/** The tone of a claim's status. @type {Record<string, Tone>} */
export const CLAIM_TONES = Object.freeze({
	requested: 'warning',
	approved: 'neutral',
	received: 'neutral',
	refunded: 'success',
	replaced: 'success',
	repaired: 'success',
	closed: 'success',
	rejected: 'danger',
});

/** Who made a history entry when it was not a member of the staff (`ordersAdmin.by.<by>`; staff are named). */
export const HISTORY_ACTORS = Object.freeze(['system', 'shopper', 'guest']);

/**
 * Who made a history entry (of an order or a claim): the website's words for the shop itself, a shopper and a guest,
 * else the staff member's name.
 * @param {Kit} kit @param {{ by?: string }} entry
 */
export const historyBy = (kit, entry) =>
	HISTORY_ACTORS.includes(String(entry.by)) ? kit.t(`ordersAdmin.by.${entry.by}`) : (entry.by ?? '');

/**
 * The note of an order's history entry: the website's words for the entries whose note the server writes itself (a
 * shopper's cancel, an order that ended unpaid or unconfirmed, an edit; `ordersAdmin.historyNote.<reason or kind>`),
 * else the note as staff typed it.
 * @param {Kit} kit @param {{ note?: string, reason?: string, kind?: string }} entry
 */
const historyNote = (kit, entry) => {
	const own = entry.kind === 'edited' ? 'edited' : entry.reason === 'shopper' || entry.reason === 'expired' ? entry.reason : '';
	return own ? kit.t(`ordersAdmin.historyNote.${own}`) : (entry.note ?? '');
};

/**
 * An order detail as a list row (the list's fields).
 * @param {any} order
 */
const summaryOf = (order) => ({
	...order,
	total: order.totals.total,
	currency: order.totals.currency,
	city: order.address?.city ?? '',
});

/**
 * Show one order in the detail pane.
 * @param {Kit} kit @param {string} id @param {Detail} detail
 */
export const orderDetail = async (kit, id, detail) => {
	const line = kit.status();
	kit.put(detail.pane, [detail.back, line]);
	kit.say(line, kit.t('ordersAdmin.loading'));
	const answer = await kit.call('GET', `/v1/admin/orders/${id}`);
	if (!detail.current()) return;
	if (answer.ok) renderOrder(kit, answer.data, detail, '');
	else kit.fail(line, answer);
};

/**
 * The order in the pane, with a message in its status line.
 * @param {Kit} kit @param {any} order @param {Detail} detail @param {string} message
 */
const renderOrder = (kit, order, detail, message) => {
	const { t, h, has } = kit;
	const note = kit.status();
	/** @param {any} next @param {string} text */
	const done = (next, text) => {
		renderOrder(kit, next, detail, text);
		detail.changed(summaryOf(next));
	};
	const currency = order.totals.currency;
	/** @param {number} minor */
	const money = (minor) => kit.money(minor, currency);

	// ---------------------------------------------------------------------------------------------- actions
	/** @type {Array<{ key: string, label: string, role: string }>} */
	const next = order.nextStatuses ?? [];
	const forward = next.filter((status) => status.role !== 'cancelled');
	const cancels = next.filter((status) => status.role === 'cancelled');
	const refundable = Number(order.payment.refundable ?? 0);
	const lines = serialLines(order);
	// typed serials still missing on lines the answer marks serialized make Type serial numbers a main action
	const missing = typedSerials(kit) && lines.some((item) => item.serialized === true && item.serials.length !== item.quantity);
	/** @param {{ key: string, label: string, role: string }} status */
	const moveTo = (status) => () => moveDialog(kit, order, status, done);
	const serials = () => serialsDialog(kit, order, done);
	const refund = () => refundDialog(kit, order, done);
	const second = missing ? 'serials' : refundable > 0 ? 'refund' : '';
	/** @param {string} path @param {string} name */
	const document = (path, name) => async () => {
		const file = await kit.fetchText(`/v1/admin/orders/${order.id}/${path}`);
		if (!file.ok) return kit.fail(note, file);
		kit.openHtml(file.text);
		kit.say(note, t('ordersAdmin.opened', { name }));
		return file;
	};
	const actions = [
		forward[0]
			? kit.button(t('ordersAdmin.moveToStatus', { status: forward[0].label }), moveTo(forward[0]), { primary: true })
			: null,
		second === 'serials' ? kit.button(t('ordersAdmin.typeSerials'), serials) : null,
		second === 'refund' ? kit.button(t('ordersAdmin.refund'), refund) : null,
		kit.moreMenu([
			...forward
				.slice(1)
				.map((status) => ({ label: t('ordersAdmin.moveToStatus', { status: status.label }), onSelect: moveTo(status) })),
			typedSerials(kit) && lines.length > 0 && second !== 'serials'
				? { label: t('ordersAdmin.typeSerials'), onSelect: serials }
				: null,
			refundable > 0 && second !== 'refund' ? { label: t('ordersAdmin.refund'), onSelect: refund } : null,
			order.address && EDITABLE_ROLES.includes(order.role)
				? { label: t('ordersAdmin.editAddress'), onSelect: () => addressDialog(kit, order, done) }
				: null,
			{ label: t('ordersAdmin.editNote'), onSelect: () => noteDialog(kit, order, done) },
			has('invoices') ? { label: t('ordersAdmin.invoice'), onSelect: document('invoice', t('ordersAdmin.invoice')) } : null,
			has('invoices')
				? { label: t('ordersAdmin.packingSlip'), onSelect: document('packing-slip', t('ordersAdmin.packingSlip')) }
				: null,
			...cancels.map((status) => ({
				label: t('ordersAdmin.moveToStatus', { status: status.label }),
				onSelect: moveTo(status),
				danger: true,
			})),
		]),
	];

	// ---------------------------------------------------------------------------------------------- what it is
	const promotions = order.promotions ?? {};
	const figures = kit.fieldGrid([
		[t('ordersAdmin.placedAt'), kit.when(order.placedAt)],
		[t('ordersAdmin.total'), money(order.totals.total)],
		[t('ordersAdmin.paymentState'), t(`ordersAdmin.payment.${order.payment.state}`)],
		[t('ordersAdmin.paymentMethod'), t(`ordersAdmin.method.${order.payment.method}`)],
		[t('ordersAdmin.paid'), money(order.payment.paid)],
		[t('ordersAdmin.advance'), order.payment.advance > 0 ? money(order.payment.advance) : ''],
		[t('ordersAdmin.refundedAmount'), order.payment.refunded > 0 ? money(order.payment.refunded) : ''],
		[t('ordersAdmin.refundableAmount'), refundable > 0 ? money(refundable) : ''],
		// money a cancelled order still holds (paid after its cancel, or recorded by staff): to be refunded (K-13)
		[t('ordersAdmin.refundDue'), order.payment.refundDue > 0 ? money(order.payment.refundDue) : ''],
		[t('ordersAdmin.subtotal'), money(order.totals.subtotal)],
		[t('ordersAdmin.discount'), order.totals.discount > 0 ? money(order.totals.discount) : ''],
		[t('ordersAdmin.deliveryFee'), money(order.totals.delivery)],
		[t('ordersAdmin.tax'), order.totals.tax > 0 ? money(order.totals.tax) : ''],
		[t('ordersAdmin.couponCode'), promotions.couponCode ?? ''],
		[t('ordersAdmin.pointsUsed'), promotions.pointsRedeemed > 0 ? String(promotions.pointsRedeemed) : ''],
		[t('ordersAdmin.pointsEarned'), promotions.pointsEarned > 0 ? String(promotions.pointsEarned) : ''],
	]);
	const table = kit.table(
		[
			t('ordersAdmin.item'),
			t('ordersAdmin.sku'),
			t('ordersAdmin.quantity'),
			t('ordersAdmin.unitPrice'),
			t('ordersAdmin.lineTotal'),
			t('ordersAdmin.warranty'),
			t('ordersAdmin.serials'),
		],
		order.lines.map((/** @type {any} */ item) => [
			[item.name, item.variantName, item.gradeLabel].filter(Boolean).join(' · '),
			item.sku,
			String(item.quantity),
			money(item.unitPrice),
			money(item.total),
			warrantyOf(kit, item),
			item.serials.length > 0
				? item.serials.join(', ')
				: typedSerials(kit) && item.serialized === true
					? kit.badge(t('ordersAdmin.serialsMissing'), 'warning')
					: '',
		]),
	);

	// --------------------------------------------------------------------------------------------------- cards
	const flags = order.customerFlags ?? {};
	const customer = card(kit, t('ordersAdmin.customer'), [
		flags.blocked ? kit.badge(t('ordersAdmin.blocked', { reason: flags.blockedReason ?? '' }), 'danger') : null,
		kit.fieldGrid([
			[t('ordersAdmin.name'), order.customer.name],
			[t('ordersAdmin.email'), order.customer.email],
			[t('ordersAdmin.phone'), order.customer.phone],
			[t('ordersAdmin.ordersCount'), String(flags.orderCount ?? 0)],
			[t('ordersAdmin.rtoCount'), flags.rtoCount > 0 ? String(flags.rtoCount) : ''],
			[t('ordersAdmin.customerNote'), flags.note ?? ''],
		]),
	]);
	const address = order.address
		? card(kit, t('ordersAdmin.addressTitle'), [
				kit.text(
					'p',
					{},
					ADDRESS_FIELDS.map((key) => order.address[key])
						.filter(Boolean)
						.join(', '),
				),
			])
		: null;
	const shipment = order.shipment
		? card(kit, t('ordersAdmin.shipment'), [
				kit.fieldGrid([
					[t('ordersAdmin.courier'), order.shipment.courier],
					[t('ordersAdmin.trackingNumber'), order.shipment.trackingNumber],
					[t('ordersAdmin.trackingStatus'), order.shipment.status],
					[
						t('ordersAdmin.trackingLink'),
						/^https:\/\//.test(order.shipment.trackingUrl ?? '')
							? kit.text(
									'a',
									{ href: order.shipment.trackingUrl, target: '_blank', rel: 'noopener noreferrer' },
									t('ordersAdmin.track'),
								)
							: '',
					],
				]),
			])
		: null;
	const notes =
		order.note || order.staffNote
			? card(kit, t('ordersAdmin.notes'), [
					kit.fieldGrid([
						[t('ordersAdmin.shopperNote'), order.note ?? ''],
						[t('ordersAdmin.staffNote'), order.staffNote ?? ''],
					]),
				])
			: null;
	const history = card(kit, t('ordersAdmin.history'), [
		h(
			'ul',
			{},
			[...order.history]
				.reverse()
				.map((/** @type {any} */ entry) =>
					kit.text(
						'li',
						{},
						[
							kit.when(entry.at),
							entry.fromLabel ? `${entry.fromLabel} → ${entry.toLabel}` : entry.toLabel,
							historyBy(kit, entry),
							historyNote(kit, entry),
						]
							.filter(Boolean)
							.join(' · '),
					),
				),
		),
	]);
	const cards = kit.masonry([customer, address, shipment, notes, history].filter(Boolean));

	kit.put(detail.pane, [
		detail.back,
		detailHead(
			kit,
			[
				t('ordersAdmin.orderHead', { number: order.number }),
				kit.badge(order.statusLabel, ROLE_TONES[order.role] ?? 'neutral'),
			],
			actions,
		),
		note,
		figures,
		table,
		cards,
	]);
	kit.say(note, message);
	if (has('returns')) void claimsCard(kit, order, cards, detail);
};

/**
 * The order's return and warranty claims, as a card added to the masonry when there are any.
 * @param {Kit} kit @param {any} order @param {HTMLElement} cards @param {Detail} detail
 */
const claimsCard = async (kit, order, cards, detail) => {
	const { t } = kit;
	const answer = await kit.call('GET', `/v1/admin/returns${query({ orderId: order.id })}`);
	/** @type {any[]} */
	const claims = answer.ok ? (answer.data.items ?? []) : [];
	if (!detail.current() || claims.length === 0) return;
	cards.append(
		kit.h('div', { class: 'card' }, [
			card(kit, t('ordersAdmin.claims'), [
				kit.h(
					'ul',
					{},
					claims.map((claim) =>
						kit.h('li', {}, [
							`${claim.reference} · ${t(`ordersAdmin.claimKind.${claim.kind}`)} `,
							kit.badge(t(`ordersAdmin.claim.${claim.status}`), CLAIM_TONES[claim.status] ?? 'neutral'),
						]),
					),
				),
			]),
		]),
	);
};

/**
 * Move the order to a status, with what its role needs; a cancelling status asks for the order number first.
 * @param {Kit} kit @param {any} order @param {{ key: string, label: string, role: string }} status
 * @param {(order: any, text: string) => void} done
 */
const moveDialog = (kit, order, status, done) => {
	const { t, has } = kit;
	const reason = kit.input('', { maxlength: '1000' });
	const packing = status.role === 'packed' && has('grades_serials') ? serialForm(kit, order, false) : null;
	const shipping = status.role === 'shipped' ? shipForm(kit) : null;
	const cancelling = status.role === 'cancelled';
	kit.dialog({
		title: t('ordersAdmin.moveToStatus', { status: status.label }),
		body: [
			cancelling ? kit.text('p', {}, t('ordersAdmin.cancelHint', { number: order.number })) : null,
			packing?.node,
			shipping?.node,
			kit.field(t('ordersAdmin.moveNote'), reason),
		],
		submitLabel: t('ordersAdmin.move'),
		danger: cancelling,
		wide: Boolean(packing),
		confirmText: cancelling ? order.number : '',
		onSubmit: async () => {
			const serials = packing ? packing.values() : /** @type {SerialValues} */ ({ ok: true, value: {} });
			if (!serials.ok) return serials.error;
			const answer = await kit.call('POST', `/v1/admin/orders/${order.id}/move`, {
				to: status.key,
				note: reason.value,
				serials: serials.value,
				shipment: shipping ? shipping.value() : null,
				updatedAt: order.updatedAt,
			});
			if (!answer.ok) return kit.reason(answer);
			/** @type {string[]} */
			const warnings = answer.data.warnings ?? [];
			done(answer.data, [t('ordersAdmin.moved', { status: answer.data.statusLabel }), ...warnings].join(' '));
			return null;
		},
	});
};

/**
 * Type the serial numbers of serialized lines at packing or later (typed serials, E11).
 * @param {Kit} kit @param {any} order @param {(order: any, text: string) => void} done
 */
const serialsDialog = (kit, order, done) => {
	const { t } = kit;
	const form = /** @type {NonNullable<ReturnType<typeof serialForm>>} */ (serialForm(kit, order, true));
	kit.dialog({
		title: t('ordersAdmin.serialsTitle'),
		body: [form.node],
		submitLabel: t('admin.save'),
		wide: true,
		onSubmit: async () => {
			const serials = form.values();
			if (!serials.ok) return serials.error;
			if (Object.keys(serials.value).length === 0) return t('ordersAdmin.serialsNothing');
			const answer = await kit.call('PATCH', `/v1/admin/orders/${order.id}`, { serials: serials.value });
			if (!answer.ok) return kit.reason(answer);
			done(answer.data, t('ordersAdmin.serialsSaved'));
			return null;
		},
	});
};

/**
 * Refund part of what was paid (through Payments when paid online, else recorded).
 * @param {Kit} kit @param {any} order @param {(order: any, text: string) => void} done
 */
const refundDialog = (kit, order, done) => {
	const { t } = kit;
	const left = Number(order.payment.refundable ?? 0);
	const amount = kit.input(kit.decimal(left), { inputmode: 'decimal' });
	const reason = kit.input('', { maxlength: '500' });
	kit.dialog({
		title: t('ordersAdmin.refundTitle'),
		body: [
			kit.text('p', { class: 'muted' }, t('ordersAdmin.refundable', { amount: kit.money(left, order.totals.currency) })),
			kit.h('div', { class: 'fields' }, [
				kit.field(t('ordersAdmin.refundAmount', { currency: order.totals.currency }), amount),
				kit.field(t('ordersAdmin.refundReason'), reason),
			]),
		],
		submitLabel: t('ordersAdmin.refund'),
		onSubmit: async () => {
			const minor = kit.amount(amount.value);
			if (minor === null || Number.isNaN(minor) || minor <= 0) return t('admin.checkNumbers');
			const answer = await kit.call('POST', `/v1/admin/orders/${order.id}/refunds`, {
				amount: minor,
				reason: reason.value.trim(),
			});
			if (!answer.ok) return kit.reason(answer);
			done(answer.data.order, t('ordersAdmin.refundDone', { amount: kit.money(minor, order.totals.currency) }));
			return null;
		},
	});
};

/**
 * Change the delivery address (before shipping).
 * @param {Kit} kit @param {any} order @param {(order: any, text: string) => void} done
 */
const addressDialog = (kit, order, done) => {
	const { t } = kit;
	const inputs = new Map(ADDRESS_FIELDS.map((key) => [key, kit.input(order.address[key] ?? '')]));
	kit.dialog({
		title: t('ordersAdmin.addressTitle'),
		body: [
			kit.h(
				'div',
				{ class: 'fields' },
				[...inputs].map(([key, input]) => kit.field(t(`ordersAdmin.address.${key}`), input)),
			),
		],
		submitLabel: t('ordersAdmin.saveAddress'),
		wide: true,
		onSubmit: async () => {
			const answer = await kit.call('PATCH', `/v1/admin/orders/${order.id}`, {
				address: Object.fromEntries([...inputs].map(([key, input]) => [key, input.value])),
			});
			if (!answer.ok) return kit.reason(answer);
			done(answer.data, t('admin.saved'));
			return null;
		},
	});
};

/**
 * Change the staff note.
 * @param {Kit} kit @param {any} order @param {(order: any, text: string) => void} done
 */
const noteDialog = (kit, order, done) => {
	const { t } = kit;
	const text = kit.area(order.staffNote ?? '', { maxlength: '5000', rows: '5' });
	kit.dialog({
		title: t('ordersAdmin.staffNote'),
		body: [kit.field(t('ordersAdmin.staffNoteLabel'), text)],
		submitLabel: t('ordersAdmin.saveNote'),
		onSubmit: async () => {
			const answer = await kit.call('PATCH', `/v1/admin/orders/${order.id}`, { staffNote: text.value });
			if (!answer.ok) return kit.reason(answer);
			done(answer.data, t('admin.saved'));
			return null;
		},
	});
};
