/**
 * One order in the orders admin widget (PLAN 0.8.8 Orders, 0.6): a head with the number and status, the next step as
 * a button (Move to …) and Type serial numbers, Record a payment (an order awaiting payment) or Refund beside it, and
 * in its More menu the other next statuses, the typed serial numbers (E11), Record a payment (E26: a bank transfer,
 * cash or another way, up to the balance due, confirming a waiting order with it), Refund, Edit items and payment (a
 * waiting order with nothing paid, priced again, E29), Edit delivery address (before shipping), Edit staff note,
 * Invoice and Packing slip (opened in a new tab), a canceling status in danger text behind its typed confirmation, and
 * Delete order last (E31, behind the order number typed). Then the figures in a grid, the lines with their warranty and
 * serial numbers (E12), and cards: customer (blocked, returned packages), delivery address, shipment, notes, the
 * order's return claims and history (the website's words for who and what the server wrote itself, PLAN 0.4.10).
 * Forms open in dialogs (the packing step asks one serial number per unit; shipping asks a courier and tracking
 * number, or books the courier API); the warnings a move, a refund or a payment answers show in the website's words
 * too. Opening an order marks it opened by the staff member (the list's "not opened by me" filter).
 * @module
 */
import { ADDRESS_FIELDS, ADDRESS_LIMITS } from '../core/address.js';
import { WAITING_ROLES } from '../core/flow.js';
import { EDITABLE_ROLES, PAYMENT_METHODS, RECORDED_METHODS } from '../core/orders.js';
import { query } from './admin-kit.js';
import { fieldsCard, fieldsDialog } from './admin-field-values.js';
import { card, detailHead } from './admin-lists.js';
import { serialForm, serialLines, shipForm, typedLine, unitsMissing, warrantyOf } from './admin-order-forms.js';
import { codeOf } from './admin-problems.js';
import { variantLabel } from './admin-taxonomy.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Tone} Tone */
/** @typedef {import('./admin-lists.js').Detail} Detail */
/** @typedef {import('./admin-order-forms.js').SerialValues} SerialValues */
/** A code the server wrote, with the values its words take. @typedef {{ code: string, values?: Record<string, string | number> }} Coded */

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
/** The kind of actor the server token is when a call names no member of the staff (`ordersAdmin.by.server`). */
export const SERVER_KIND = 'server';

/**
 * Who made a history entry (of an order or a claim): the website's words for the server token, the shop itself, a
 * shopper and a guest, else the staff member's name. Entries keep the kind of actor (`byKind`), so a member of the
 * staff named like one of these keeps their name; imported entries have only the name.
 * @param {Kit} kit @param {{ by?: string, byKind?: string }} entry
 */
export const historyBy = (kit, entry) => {
	if (entry.byKind === SERVER_KIND) return kit.t(`ordersAdmin.by.${SERVER_KIND}`);
	if (entry.byKind) return entry.by ?? '';
	return HISTORY_ACTORS.includes(String(entry.by)) ? kit.t(`ordersAdmin.by.${entry.by}`) : (entry.by ?? '');
};

/**
 * The website's words for what the server wrote as a code (PLAN 0.4.10): the text `<prefix><code>` filled with its
 * values, an `amount` (minor units) as money of the order's currency by the website's Format.
 * @param {Kit} kit @param {string} prefix @param {Coded} coded @param {(minor: number) => string} money
 */
const codedText = (kit, prefix, { code, values = {} }, money) =>
	kit.t(
		`${prefix}${code}`,
		Object.fromEntries(
			Object.entries(values).map(([name, value]) => [
				name,
				name === 'amount' && typeof value === 'number' ? money(value) : value,
			]),
		),
	);

/**
 * What the refunds through Payments a transition asked for add up to in a state (`effects`).
 * @param {any} order @param {'pending' | 'failed'} state
 */
const effectsSum = (order, state) =>
	(Array.isArray(order.effects) ? order.effects : [])
		.filter((/** @type {any} */ effect) => effect.kind === 'refund' && effect.state === state)
		.reduce((/** @type {number} */ sum, /** @type {any} */ effect) => sum + Number(effect.amount ?? 0), 0);

/**
 * The warnings of an answer (a move, a refund, a payment) in the website's words (`ordersAdmin.warning.<code>`).
 * @param {Kit} kit @param {{ warningCodes: Coded[] }} data @param {(minor: number) => string} money
 * @returns {string[]}
 */
export const warningsText = (kit, data, money) =>
	data.warningCodes.map((warning) => codedText(kit, 'ordersAdmin.warning.', warning, money));

/**
 * The note of an order's history entry: the website's words for the entries whose note the server writes itself
 * (`ordersAdmin.historyNote.<code>` with its values; imported entries by their reason or kind: a shopper's cancel, an
 * order that ended unpaid or unconfirmed, an edit), else the note as staff typed it.
 * @param {Kit} kit @param {{ note?: string, reason?: string, kind?: string } & Partial<Coded>} entry
 * @param {(minor: number) => string} money
 */
const historyNote = (kit, entry, money) => {
	if (entry.code) return codedText(kit, 'ordersAdmin.historyNote.', { code: entry.code, values: entry.values }, money);
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
	if (!answer.ok) return void kit.fail(line, answer);
	renderOrder(kit, answer.data, detail, '');
	// opened by this staff member (E31): a marker only, so a refusal changes nothing shown
	await kit.call('POST', `/v1/admin/orders/${id}/seen`);
};

/**
 * The shopper's transfer proof (E24): when it came, its reference and a link to open it; '' without one.
 * @param {Kit} kit @param {any} proof
 */
const proofOf = (kit, proof) => {
	if (!proof) return '';
	const { t, h } = kit;
	const sent = proof.reference
		? t('ordersAdmin.proofSentRef', { date: kit.when(proof.at), reference: proof.reference })
		: t('ordersAdmin.proofSent', { date: kit.when(proof.at) });
	return h('span', {}, [
		sent,
		...(typeof proof.url === 'string' && /^https:\/\//.test(proof.url)
			? [' ', kit.text('a', { href: proof.url, target: '_blank', rel: 'noopener noreferrer' }, t('ordersAdmin.openProof'))]
			: []),
	]);
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
	/** @type {NextStatus[]} */
	const next = order.nextStatuses ?? [];
	const forward = next.filter((status) => status.role !== 'cancelled');
	const cancels = next.filter((status) => status.role === 'cancelled');
	const refundable = Number(order.payment.refundable ?? 0);
	const balanceDue = Number(order.payment.balanceDue ?? 0);
	// lines whose units are typed (their item type), and typed numbers still missing make Type serial numbers a main action
	const typed = serialLines(order).filter(typedLine);
	const missing = typed.some(unitsMissing);
	// a waiting order with nothing paid and only physical lines is edited and priced again (E29)
	const editable =
		WAITING_ROLES.includes(order.role) &&
		Number(order.payment.paid ?? 0) === 0 &&
		order.lines.every((/** @type {any} */ item) => item.kind === 'physical');
	/** @param {NextStatus} status */
	const moveTo = (status) => () => moveDialog(kit, order, status, done);
	const serials = () => serialsDialog(kit, order, done);
	const refund = () => refundDialog(kit, order, done);
	const pay = () => paymentDialog(kit, order, done);
	const second = missing
		? 'serials'
		: order.role === 'awaiting_payment' && balanceDue > 0
			? 'payment'
			: refundable > 0
				? 'refund'
				: '';
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
		second === 'payment' ? kit.button(t('ordersAdmin.recordPayment'), pay) : null,
		second === 'refund' ? kit.button(t('ordersAdmin.refund'), refund) : null,
		kit.moreMenu([
			...forward
				.slice(1)
				.map((status) => ({ label: t('ordersAdmin.moveToStatus', { status: status.label }), onSelect: moveTo(status) })),
			typed.length > 0 && second !== 'serials' ? { label: t('ordersAdmin.typeSerials'), onSelect: serials } : null,
			balanceDue > 0 && second !== 'payment' ? { label: t('ordersAdmin.recordPayment'), onSelect: pay } : null,
			refundable > 0 && second !== 'refund' ? { label: t('ordersAdmin.refund'), onSelect: refund } : null,
			editable ? { label: t('ordersAdmin.editItems'), onSelect: () => editDialog(kit, order, done) } : null,
			order.address && EDITABLE_ROLES.includes(order.role)
				? { label: t('ordersAdmin.editAddress'), onSelect: () => addressDialog(kit, order, done) }
				: null,
			// the dispatch video is replaced once the order is packed
			VIDEO_ROLES.includes(order.role)
				? { label: t('ordersAdmin.replaceVideo'), onSelect: () => videoDialog(kit, order, done) }
				: null,
			{ label: t('ordersAdmin.editNote'), onSelect: () => noteDialog(kit, order, done) },
			// the order fields staff fill (dynamic model §2)
			(order.orderFields ?? []).some((/** @type {any} */ field) => field.active)
				? {
						label: t('admin.editFields'),
						onSelect: () =>
							fieldsDialog(kit, {
								fields: order.orderFields,
								values: order.fields ?? {},
								save: async (body) => {
									const answer = await kit.call('PATCH', `/v1/admin/orders/${order.id}`, body);
									if (!answer.ok) return kit.reason(answer);
									done(answer.data, t('admin.saved'));
									return null;
								},
							}),
					}
				: null,
			has('invoices') ? { label: t('ordersAdmin.invoice'), onSelect: document('invoice', t('ordersAdmin.invoice')) } : null,
			has('invoices')
				? { label: t('ordersAdmin.packingSlip'), onSelect: document('packing-slip', t('ordersAdmin.packingSlip')) }
				: null,
			...cancels.map((status) => ({
				label: t('ordersAdmin.moveToStatus', { status: status.label }),
				onSelect: moveTo(status),
				danger: true,
			})),
			{ label: t('ordersAdmin.deleteOrder'), onSelect: () => deleteDialog(kit, order, detail), danger: true },
		]),
	];

	// ---------------------------------------------------------------------------------------------- what it is
	const promotions = order.promotions ?? {};
	const figures = kit.fieldGrid([
		[t('ordersAdmin.placedAt'), kit.when(order.placedAt)],
		[t('ordersAdmin.total'), money(order.totals.total)],
		[t('ordersAdmin.paymentState'), t(`ordersAdmin.payment.${order.payment.state}`)],
		[t('ordersAdmin.paymentMethod'), t(`ordersAdmin.method.${order.payment.method}`)],
		// the shopper's transfer proof: when it came, its reference and a link to open it (E24)
		[t('ordersAdmin.proof'), proofOf(kit, order.payment.proof)],
		[t('ordersAdmin.paid'), money(order.payment.paid)],
		[t('ordersAdmin.balanceDue'), balanceDue > 0 ? money(balanceDue) : ''],
		[t('ordersAdmin.advance'), order.payment.advance > 0 ? money(order.payment.advance) : ''],
		[t('ordersAdmin.refundedAmount'), order.payment.refunded > 0 ? money(order.payment.refunded) : ''],
		[t('ordersAdmin.refundableAmount'), refundable > 0 ? money(refundable) : ''],
		// money a canceled order still holds (paid after its cancel, or recorded by staff): to be refunded (K-13)
		[t('ordersAdmin.refundDue'), order.payment.refundDue > 0 ? money(order.payment.refundDue) : ''],
		// a refund its cancel asked of Payments: tried again while pending; failed ones staff refund from the order
		[t('ordersAdmin.refundPending'), effectsSum(order, 'pending') > 0 ? money(effectsSum(order, 'pending')) : ''],
		[t('ordersAdmin.refundFailed'), effectsSum(order, 'failed') > 0 ? money(effectsSum(order, 'failed')) : ''],
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
			item.serials.length > 0 ? unitsText(item) : typedLine(item) ? kit.badge(t('ordersAdmin.serialsMissing'), 'warning') : '',
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
							historyNote(kit, entry, money),
						]
							.filter(Boolean)
							.join(' · '),
					),
				),
		),
	]);
	const fields = fieldsCard(kit, order.orderFields ?? [], order.fields ?? {});
	const cards = kit.masonry([customer, address, shipment, notes, fields, history].filter(Boolean));

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
 * A status staff may move the order to, with what the move needs and its options (the order's `nextStatuses`).
 * @typedef {{ key: string, label: string, role: string, needs?: string[],
 *   options?: { video?: string, restock?: string } }} NextStatus
 */

/** Roles of an order whose dispatch video staff may replace. */
const VIDEO_ROLES = Object.freeze(['packed', 'shipped']);

/**
 * Move the order to a status, with what its role and the move need: the units' numbers (packing: every line whose item
 * type numbers its units; shipping or delivering: those still missing some) and the dispatch video when packing, the
 * shipment, a staff note and a note for the shopper (required when the move needs them), and whether the items go back
 * in stock when the move asks; a canceling status asks for the order number first.
 * @param {Kit} kit @param {any} order @param {NextStatus} status
 * @param {(order: any, text: string) => void} done
 */
const moveDialog = (kit, order, status, done) => {
	const { t, has } = kit;
	const needs = status.needs ?? [];
	const options = status.options ?? {};
	const reason = kit.input('', { maxlength: '1000' });
	const forShopper = kit.input('', { maxlength: '1000' });
	const numbered = has('grades_serials') ? serialLines(order) : [];
	const packing =
		status.role === 'packed'
			? serialForm(kit, numbered, false)
			: status.role === 'shipped' || status.role === 'delivered'
				? serialForm(kit, numbered.filter(unitsMissing), false)
				: null;
	const shipping = status.role === 'shipped' ? shipForm(kit) : null;
	const video =
		status.role === 'packed' && options.video && options.video !== 'off'
			? kit.input('', { maxlength: '2000', inputmode: 'url' })
			: null;
	const restock = options.restock === 'ask' ? kit.check(t('ordersAdmin.restockAsk')) : null;
	const cancelling = status.role === 'cancelled';
	kit.dialog({
		title: t('ordersAdmin.moveToStatus', { status: status.label }),
		body: [
			cancelling ? kit.text('p', {}, t('ordersAdmin.cancelHint', { number: order.number })) : null,
			packing?.node,
			video
				? kit.field(t(options.video === 'required' ? 'ordersAdmin.videoRequired' : 'ordersAdmin.videoOptional'), video)
				: null,
			shipping?.node,
			restock?.node,
			kit.field(t(needs.includes('note') ? 'ordersAdmin.moveNoteRequired' : 'ordersAdmin.moveNote'), reason),
			kit.field(t(needs.includes('reason') ? 'ordersAdmin.shopperNoteRequired' : 'ordersAdmin.shopperNoteField'), forShopper),
		],
		submitLabel: t('ordersAdmin.move'),
		danger: cancelling,
		wide: Boolean(packing),
		confirmText: cancelling ? order.number : '',
		onSubmit: async () => {
			const serials = packing ? packing.values() : /** @type {SerialValues} */ ({ ok: true, value: {} });
			if (!serials.ok) return serials.error;
			if (needs.includes('note') && !reason.value.trim()) return t('ordersAdmin.needsNote');
			if (needs.includes('reason') && !forShopper.value.trim()) return t('ordersAdmin.needsShopperNote');
			const answer = await kit.call('POST', `/v1/admin/orders/${order.id}/move`, {
				to: status.key,
				note: reason.value,
				...(forShopper.value.trim() ? { shopperNote: forShopper.value.trim() } : {}),
				...(restock ? { restock: restock.box.checked } : {}),
				...(video && video.value.trim() ? { video: video.value.trim() } : {}),
				serials: serials.value,
				shipment: shipping ? shipping.value() : null,
				updatedAt: order.updatedAt,
			});
			if (!answer.ok) return kit.reason(answer);
			/** @param {number} minor */
			const money = (minor) => kit.money(minor, order.totals.currency);
			done(
				answer.data,
				[t('ordersAdmin.moved', { status: answer.data.statusLabel }), ...warningsText(kit, answer.data, money)].join(' '),
			);
			return null;
		},
	});
};

/**
 * Replace the dispatch video once the order is packed (a YouTube or https address).
 * @param {Kit} kit @param {any} order @param {(order: any, text: string) => void} done
 */
const videoDialog = (kit, order, done) => {
	const { t } = kit;
	const video = kit.input('', { maxlength: '2000', inputmode: 'url' });
	kit.dialog({
		title: t('ordersAdmin.replaceVideo'),
		body: [kit.field(t('ordersAdmin.videoAddress'), video)],
		submitLabel: t('admin.save'),
		onSubmit: async () => {
			if (!video.value.trim()) return t('ordersAdmin.videoAddress');
			const answer = await kit.call('PATCH', `/v1/admin/orders/${order.id}`, { video: video.value.trim() });
			if (!answer.ok) return kit.reason(answer);
			done(answer.data, t('ordersAdmin.videoReplaced'));
			return null;
		},
	});
};

/**
 * A line's units for staff: each unit's values by unit field (`<field>: <value> / <value>`), else its serial number.
 * @param {any} item
 */
const unitsText = (item) =>
	(item.units ?? item.serials.map((/** @type {string} */ serial) => ({ serial, values: {} })))
		.map((/** @type {any} */ unit) => {
			const parts = (item.unitFields ?? []).flatMap((/** @type {any} */ field) =>
				unit.values?.[field.id]?.length > 0 ? [`${field.name}: ${unit.values[field.id].join(' / ')}`] : [],
			);
			return parts.length > 0 ? parts.join(', ') : unit.serial;
		})
		.join('; ');

/**
 * Type the numbers of the units of lines whose item type has them typed, at packing or later.
 * @param {Kit} kit @param {any} order @param {(order: any, text: string) => void} done
 */
const serialsDialog = (kit, order, done) => {
	const { t } = kit;
	const form = /** @type {NonNullable<ReturnType<typeof serialForm>>} */ (
		serialForm(kit, serialLines(order).filter(typedLine), true)
	);
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
			/** @param {number} value */
			const money = (value) => kit.money(value, order.totals.currency);
			done(
				answer.data.order,
				[t('ordersAdmin.refundDone', { amount: money(minor) }), ...warningsText(kit, answer.data, money)].join(' '),
			);
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
	// the address fields staff may change before shipping, each at most its length in the one address table
	const inputs = new Map(
		ADDRESS_FIELDS.map((key) => [key, kit.input(order.address[key] ?? '', { maxlength: String(ADDRESS_LIMITS[key]) })]),
	);
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

/**
 * Record a payment staff took (E26): a bank transfer, cash or another way, up to the balance due; a waiting order is
 * confirmed with it unless staff untick that.
 * @param {Kit} kit @param {any} order @param {(order: any, text: string) => void} done
 */
const paymentDialog = (kit, order, done) => {
	const { t } = kit;
	const currency = order.totals.currency;
	/** @param {number} minor */
	const money = (minor) => kit.money(minor, currency);
	const due = Number(order.payment.balanceDue ?? 0);
	const method = kit.select(
		RECORDED_METHODS.map((value) => ({ value, label: t(`ordersAdmin.paidWith.${value}`) })),
		order.payment.method === 'bank_transfer' ? 'bank_transfer' : 'cash',
	);
	const amount = kit.input(kit.decimal(due), { inputmode: 'decimal' });
	const reference = kit.input('', { maxlength: '120' });
	const note = kit.input('', { maxlength: '1000' });
	const confirm = WAITING_ROLES.includes(order.role) ? kit.check(t('ordersAdmin.paymentConfirm'), true) : null;
	kit.dialog({
		title: t('ordersAdmin.recordPayment'),
		body: [
			kit.text('p', { class: 'muted' }, t('ordersAdmin.paymentDue', { amount: money(due) })),
			kit.h('div', { class: 'fields' }, [
				kit.field(t('ordersAdmin.paymentHow'), method),
				kit.field(t('ordersAdmin.refundAmount', { currency }), amount),
				kit.field(t('ordersAdmin.paymentReference'), reference),
				kit.field(t('ordersAdmin.paymentNote'), note),
			]),
			confirm?.node,
		],
		submitLabel: t('ordersAdmin.recordPayment'),
		onSubmit: async () => {
			const minor = kit.amount(amount.value);
			if (minor === null || Number.isNaN(minor) || minor <= 0) return t('admin.checkNumbers');
			const answer = await kit.call('POST', `/v1/admin/orders/${order.id}/payments`, {
				method: method.value,
				amount: minor,
				...(reference.value.trim() ? { reference: reference.value.trim() } : {}),
				...(note.value.trim() ? { note: note.value.trim() } : {}),
				...(confirm ? { confirm: confirm.box.checked } : {}),
			});
			if (!answer.ok) return kit.reason(answer);
			done(
				answer.data.order,
				[t('ordersAdmin.paymentRecorded', { amount: money(minor) }), ...warningsText(kit, answer.data, money)].join(' '),
			);
			return null;
		},
	});
};

/**
 * One line of a waiting order being edited: its variant, its name, and the quantity and unit price staff give.
 * @typedef {{ variantId: string, name: string, quantity: HTMLInputElement, price: HTMLInputElement, placedPrice: string,
 *   placedQuantity: number }} EditLine
 */

/**
 * Edit a waiting order (E29: awaiting payment or confirmation, nothing paid, physical lines only): its items (a
 * quantity of 0 takes a line out; another unit price only where staff change it; more items by searching the
 * products), how it is paid and how it is delivered. The server prices it again with the offers it was placed with.
 * @param {Kit} kit @param {any} order @param {(order: any, text: string) => void} done
 */
const editDialog = (kit, order, done) => {
	const { t, h } = kit;
	const currency = order.totals.currency;
	/** @type {EditLine[]} */
	const lines = [];
	const table = h('div');
	const draw = () =>
		kit.put(table, [
			kit.table(
				[t('ordersAdmin.item'), t('ordersAdmin.quantity'), t('ordersAdmin.unitPriceIn', { currency })],
				lines.map((line) => [line.name, line.quantity, line.price]),
			),
		]);
	/** @param {string} variantId @param {string} name @param {number} quantity @param {number | null} unitPrice */
	const addLine = (variantId, name, quantity, unitPrice) => {
		const found = lines.find((line) => line.variantId === variantId);
		if (found) {
			found.quantity.value = String(Number(found.quantity.value || 0) + 1);
			return;
		}
		const price = unitPrice === null ? '' : kit.decimal(unitPrice);
		lines.push({
			variantId,
			name,
			quantity: kit.input(String(quantity), {
				type: 'number',
				min: '0',
				max: '99',
				step: '1',
				'aria-label': t('ordersAdmin.quantityOf', { item: name }),
			}),
			price: kit.input(price, { inputmode: 'decimal', 'aria-label': t('ordersAdmin.unitPriceOf', { item: name }) }),
			placedPrice: price,
			placedQuantity: unitPrice === null ? 0 : quantity,
		});
		draw();
	};
	for (const item of order.lines)
		addLine(item.variantId, [item.name, item.variantName].filter(Boolean).join(' · '), item.quantity, item.unitPrice);

	// more items: a product found by name or SKU, then one of its variants
	const find = kit.input('', { type: 'search', placeholder: t('ordersAdmin.findItem') });
	// what a search found (or why it found nothing), as chips to pick
	const found = h('ul', { class: 'chips' });
	/** @param {{ status: number, data: any }} answer */
	const failed = (answer) => {
		kit.put(found, [kit.text('li', { class: 'error' }, kit.reason(answer))]);
		return answer;
	};
	const search = kit.button(t('admin.find'), async () => {
		const answer = await kit.call('GET', `/v1/admin/products${query({ q: find.value.trim(), limit: 10 })}`);
		if (!answer.ok) return failed(answer);
		/** @type {any[]} */
		const items = answer.data.items ?? [];
		kit.put(
			found,
			items.length === 0
				? [kit.text('li', { class: 'muted' }, t('admin.noMatches'))]
				: items.map((product) => h('li', {}, [kit.button(product.name, () => variantsOf(product.id))])),
		);
		return answer;
	});
	/** @param {string} productId */
	const variantsOf = async (productId) => {
		const answer = await kit.call('GET', `/v1/admin/products/${productId}`);
		if (!answer.ok) return failed(answer);
		const product = answer.data;
		/** @type {any[]} */
		const variants = (product.variants ?? []).filter((/** @type {any} */ variant) => variant.active !== false);
		kit.put(
			found,
			variants.map((variant) => {
				const name = [product.name, variantLabel(kit, variant)].join(' · ');
				return h('li', {}, [kit.button(name, () => addLine(variant.id, name, 1, null))]);
			}),
		);
		return answer;
	};

	const deliveryOn = order.delivery.method !== 'none';
	const payment = kit.select(
		PAYMENT_METHODS.map((value) => ({ value, label: t(`ordersAdmin.method.${value}`) })),
		order.payment.method,
	);
	const delivery = kit.select(
		['delivery', 'pickup'].map((value) => ({ value, label: t(`ordersAdmin.deliveryMethod.${value}`) })),
		order.delivery.method,
	);
	// pickup locations (multi_location): the one the order has, else the first
	const location = kit.select([]);
	const locationField = kit.field(t('ordersAdmin.pickupLocation'), location);
	const showLocation = () => {
		locationField.hidden = delivery.value !== 'pickup' || location.options.length === 0;
	};
	delivery.addEventListener('change', showLocation);
	if (deliveryOn && kit.has('multi_location'))
		void kit.call('GET', '/v1/admin/locations').then((answer) => {
			/** @type {any[]} */
			const places = answer.ok ? (answer.data.items ?? []).filter((/** @type {any} */ place) => place.pickup) : [];
			location.replaceChildren(...places.map((place) => kit.text('option', { value: place.id }, place.name)));
			if (places.some((place) => place.id === order.delivery.locationId)) location.value = order.delivery.locationId;
			showLocation();
		});
	showLocation();

	kit.dialog({
		title: t('ordersAdmin.editItems'),
		body: [
			kit.text('p', { class: 'muted' }, t('ordersAdmin.editItemsHint')),
			table,
			h('div', { class: 'row inline' }, [kit.field(t('ordersAdmin.addItem'), find), search]),
			found,
			h('div', { class: 'fields' }, [
				kit.field(t('ordersAdmin.paymentMethod'), payment),
				deliveryOn ? kit.field(t('ordersAdmin.deliveryHow'), delivery) : null,
				deliveryOn ? locationField : null,
			]),
		],
		submitLabel: t('admin.save'),
		wide: true,
		onSubmit: async () => {
			/** @type {Array<{ variantId: string, quantity: number, unitPrice?: number }>} */
			const wanted = [];
			let changed = false;
			for (const line of lines) {
				const quantity = Number(line.quantity.value || 0);
				if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) return t('admin.checkNumbers');
				const priced = line.price.value.trim() !== line.placedPrice;
				const unitPrice = priced ? kit.amount(line.price.value) : null;
				if (priced && (unitPrice === null || Number.isNaN(unitPrice))) return t('admin.checkNumbers');
				if (quantity !== line.placedQuantity || priced) changed = true;
				if (quantity > 0)
					wanted.push({ variantId: line.variantId, quantity, ...(priced ? { unitPrice: Number(unitPrice) } : {}) });
			}
			if (wanted.length === 0) return t('ordersAdmin.editNoItems');
			const placedLocation = order.delivery.locationId ?? '';
			const moved =
				deliveryOn &&
				(delivery.value !== order.delivery.method || (delivery.value === 'pickup' && location.value !== placedLocation));
			const body = {
				...(changed ? { lines: wanted } : {}),
				...(payment.value !== order.payment.method ? { paymentMethod: payment.value } : {}),
				...(moved
					? {
							delivery: {
								method: delivery.value,
								// where it goes, for the zone and taxes (dynamic model §5)
								city: order.address?.city ?? '',
								area: order.address?.area ?? '',
								region: order.address?.region ?? '',
								postalCode: order.address?.postalCode ?? '',
								country: order.address?.country ?? '',
								locationId: delivery.value === 'pickup' && location.value ? location.value : null,
							},
						}
					: {}),
			};
			if (Object.keys(body).length === 0) return t('ordersAdmin.editNothing');
			const answer = await kit.call('PATCH', `/v1/admin/orders/${order.id}`, body);
			if (!answer.ok) return kit.reason(answer);
			done(answer.data, t('ordersAdmin.itemsSaved'));
			return null;
		},
	});
};

/**
 * Delete the order (E31), behind its number typed. What it holds is given back as a cancel does; the server refuses
 * (409) while it holds the shopper's money, a refund through Payments is pending or it is with the courier.
 * @param {Kit} kit @param {any} order @param {Detail} detail
 */
const deleteDialog = (kit, order, detail) => {
	const { t } = kit;
	kit.dialog({
		title: t('ordersAdmin.deleteOrder'),
		body: [kit.text('p', {}, t('ordersAdmin.deleteHint', { number: order.number }))],
		submitLabel: t('ordersAdmin.deleteOrder'),
		danger: true,
		confirmText: order.number,
		onSubmit: async () => {
			const answer = await kit.call('DELETE', `/v1/admin/orders/${order.id}`);
			if (!answer.ok) return codeOf(answer) === 'conflict' ? t('ordersAdmin.deleteRefused') : kit.reason(answer);
			await detail.reload();
			return null;
		},
	});
};
