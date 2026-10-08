/**
 * One order in the orders admin widget (PLAN 0.8.8 Orders): lines with serial numbers, totals, payment, the customer's
 * flags (blocked, returned parcels), history, the staff note, the delivery address (editable before shipping), moves
 * to the statuses the flow allows next with what each role needs (serial numbers per unit when packing serialized
 * lines; a courier and tracking number, or booking through the courier API, when shipping), refunds, and the invoice
 * and packing slip (opened in a new tab).
 * @module
 */
import { formatMoney } from '../core/money.js';
import { EDITABLE_ROLES } from '../core/orders.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */

/** Address fields staff may change before shipping. */
const ADDRESS_FIELDS = Object.freeze(['name', 'phone', 'line1', 'line2', 'city', 'area', 'postalCode', 'country', 'notes']);

/**
 * Couriers of the website, when the widget settings carry them (`settings.orders.couriers: [{ key, name }]`).
 * @param {Kit} kit
 * @returns {Array<{ key: string, name: string }>}
 */
const couriersOf = (kit) => {
	const list = kit.settings.orders?.couriers;
	return Array.isArray(list) ? list : [];
};

/**
 * Pairs of a definition list.
 * @param {Kit} kit @param {Array<[string, string | Node | null | undefined]>} pairs empty values are left out
 */
const facts = (kit, pairs) =>
	kit.h(
		'dl',
		{},
		pairs
			.filter(([, value]) => value !== '' && value !== null && value !== undefined)
			.flatMap(([label, value]) => [kit.text('dt', {}, label), kit.h('dd', {}, [value])]),
	);

/**
 * The order detail. `done()` goes back to the list.
 * @param {Kit} kit
 * @param {{ id: string, done: (changed: boolean) => void }} options
 * @returns {HTMLElement}
 */
export const orderDetail = (kit, { id, done }) => {
	const { t, h, has } = kit;
	const box = h('div');
	const line = kit.status();
	box.append(line);
	let changed = false;

	/** @param {any} order @param {string} [message] */
	const render = (order, message = '') => {
		const note = kit.status();
		/** @param {{ ok: boolean, data: any }} answer @param {string} text */
		const after = (answer, text) => {
			changed = true;
			render(answer.data, text);
			return answer;
		};
		const currency = order.totals.currency;
		/** @param {number} minor */
		const money = (minor) => formatMoney(minor, currency);
		const flags = order.customerFlags ?? {};

		// ---------------------------------------------------------------------------------------- what it is
		const lines = kit.table(
			[
				t('ordersAdmin.item'),
				t('ordersAdmin.sku'),
				t('ordersAdmin.quantity'),
				t('ordersAdmin.unitPrice'),
				t('ordersAdmin.lineTotal'),
				t('ordersAdmin.serials'),
			],
			order.lines.map((/** @type {any} */ item) => [
				[item.name, item.variantName, item.gradeLabel].filter(Boolean).join(' · '),
				item.sku,
				String(item.quantity),
				money(item.unitPrice),
				money(item.total),
				item.serials.join(', '),
			]),
		);
		const totals = facts(kit, [
			[t('ordersAdmin.subtotal'), money(order.totals.subtotal)],
			[t('ordersAdmin.discount'), order.totals.discount > 0 ? money(order.totals.discount) : ''],
			[t('ordersAdmin.deliveryFee'), money(order.totals.delivery)],
			[t('ordersAdmin.tax'), order.totals.tax > 0 ? money(order.totals.tax) : ''],
			[t('ordersAdmin.total'), order.totalText],
			[t('ordersAdmin.paymentMethod'), t(`ordersAdmin.method.${order.payment.method}`)],
			[t('ordersAdmin.paymentState'), t(`ordersAdmin.payment.${order.payment.state}`)],
			[t('ordersAdmin.paid'), money(order.payment.paid)],
			[t('ordersAdmin.refundedAmount'), order.payment.refunded > 0 ? money(order.payment.refunded) : ''],
			[t('ordersAdmin.couponCode'), order.promotions?.couponCode ?? ''],
		]);
		const customer = kit.group(t('ordersAdmin.customer'), [
			facts(kit, [
				[t('ordersAdmin.name'), order.customer.name],
				[t('ordersAdmin.email'), order.customer.email],
				[t('ordersAdmin.phone'), order.customer.phone],
				[t('ordersAdmin.ordersCount'), String(flags.orderCount ?? 0)],
				[t('ordersAdmin.rtoCount'), flags.rtoCount > 0 ? String(flags.rtoCount) : ''],
				[t('ordersAdmin.customerNote'), flags.note ?? ''],
				[t('ordersAdmin.shopperNote'), order.note ?? ''],
			]),
			flags.blocked
				? kit.text('p', { class: 'pill warn' }, t('ordersAdmin.blocked', { reason: flags.blockedReason ?? '' }))
				: null,
		]);
		const shipment = order.shipment
			? kit.group(t('ordersAdmin.shipment'), [
					facts(kit, [
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
		const history = kit.group(t('ordersAdmin.history'), [
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
								entry.by,
								entry.note,
							]
								.filter(Boolean)
								.join(' · '),
						),
					),
			),
		]);

		// ------------------------------------------------------------------------------------------ changes
		const staffNote = kit.area(order.staffNote ?? '', { maxlength: '5000' });
		const saveNote = kit.button(t('ordersAdmin.saveNote'), async () => {
			const answer = await kit.call('PATCH', `/v1/admin/orders/${order.id}`, { staffNote: staffNote.value });
			return answer.ok ? after(answer, t('admin.saved')) : (kit.fail(note, answer), answer);
		});
		const editable = order.address && EDITABLE_ROLES.includes(order.role);
		const address = new Map(ADDRESS_FIELDS.map((key) => [key, kit.input(order.address?.[key] ?? '')]));
		const addressPart = order.address
			? kit.group(t('ordersAdmin.addressTitle'), [
					editable
						? h(
								'div',
								{ class: 'fields' },
								[...address].map(([key, input]) => kit.field(t(`ordersAdmin.address.${key}`), input)),
							)
						: kit.text(
								'p',
								{},
								ADDRESS_FIELDS.map((key) => order.address[key])
									.filter(Boolean)
									.join(', '),
							),
					editable
						? kit.button(t('ordersAdmin.saveAddress'), async () => {
								const answer = await kit.call('PATCH', `/v1/admin/orders/${order.id}`, {
									address: Object.fromEntries([...address].map(([key, input]) => [key, input.value])),
								});
								return answer.ok ? after(answer, t('admin.saved')) : (kit.fail(note, answer), answer);
							})
						: null,
				])
			: null;

		box.replaceChildren(
			h('div', { class: 'head' }, [
				kit.text('h3', {}, t('ordersAdmin.orderTitle', { number: order.number, status: order.statusLabel })),
				kit.button(t('admin.back'), () => done(changed)),
			]),
			kit.text('p', { class: 'meta' }, t('ordersAdmin.placedOn', { when: kit.when(order.placedAt) })),
			note,
			moveOf(kit, order, note, after),
			refundOf(kit, order, note, after),
			has('invoices') ? documentsOf(kit, order, note) : '',
			lines,
			totals,
			customer,
			shipment ?? '',
			addressPart ?? '',
			kit.group(t('ordersAdmin.staffNote'), [kit.field(t('ordersAdmin.staffNoteLabel'), staffNote), saveNote]),
			history,
		);
		kit.say(note, message);
	};

	void kit.call('GET', `/v1/admin/orders/${id}`).then((answer) => {
		if (answer.ok) render(answer.data);
		else {
			kit.fail(line, answer);
			box.append(kit.button(t('admin.back'), () => done(false)));
		}
	});
	return box;
};

/**
 * Move the order to one of the statuses its flow allows next, with what that status's role needs.
 * @param {Kit} kit @param {any} order @param {HTMLElement} note
 * @param {(answer: any, text: string) => any} after
 */
const moveOf = (kit, order, note, after) => {
	const { t, h, has } = kit;
	/** @type {Array<{ key: string, label: string, role: string }>} */
	const next = order.nextStatuses ?? [];
	if (next.length === 0) return '';
	const to = kit.select(next.map((status) => ({ value: status.key, label: status.label })));
	const reason = kit.input('', { maxlength: '1000' });
	const extra = h('div');

	// packing: one serial number per unit of each physical line (only serialized lines need them)
	const physical = order.lines.filter((/** @type {any} */ item) => item.kind === 'physical');
	/** @type {Map<string, HTMLInputElement[]>} */
	const serialInputs = new Map(
		physical.map((/** @type {any} */ item) => [
			item.id,
			Array.from({ length: item.quantity }, (_, index) =>
				kit.input(item.serials[index] ?? '', {
					maxlength: '80',
					'aria-label': t('ordersAdmin.serialOf', { item: item.name, unit: index + 1 }),
				}),
			),
		]),
	);
	const serialsPart = kit.group(t('ordersAdmin.serialsTitle'), [
		kit.text('p', { class: 'muted' }, t('ordersAdmin.serialsHint')),
		...physical.map((/** @type {any} */ item) =>
			h('div', {}, [
				kit.text('strong', {}, `${item.name} ${item.variantName ?? ''}`.trim()),
				h('div', { class: 'row' }, serialInputs.get(item.id) ?? []),
			]),
		),
	]);

	// shipping: a courier of the list and a tracking number, or a booking through the courier API
	const couriers = couriersOf(kit);
	const courier =
		couriers.length > 0
			? kit.select([
					{ value: '', label: t('ordersAdmin.pickCourier') },
					...couriers.map((item) => ({ value: item.key, label: item.name })),
				])
			: kit.input('', { maxlength: '40' });
	const tracking = kit.input('', { maxlength: '80' });
	const book = kit.check(t('ordersAdmin.bookCourier'));
	const trackingField = kit.field(t('ordersAdmin.trackingNumber'), tracking);
	book.box.addEventListener('change', () => {
		trackingField.hidden = book.box.checked;
	});
	const shipPart = kit.group(t('ordersAdmin.shipment'), [
		h('div', { class: 'fields' }, [kit.field(t('ordersAdmin.courier'), courier), trackingField]),
		has('courier_apis') ? book.node : null,
	]);

	const roleOf = () => next.find((status) => status.key === to.value)?.role ?? '';
	const show = () => {
		const role = roleOf();
		kit.put(extra, [
			role === 'packed' && has('grades_serials') && physical.length > 0 ? serialsPart : null,
			role === 'shipped' ? shipPart : null,
		]);
	};
	to.addEventListener('change', show);
	show();

	const move = kit.button(
		t('ordersAdmin.move'),
		async () => {
			const role = roleOf();
			/** @type {Record<string, string[]>} */
			const serials = {};
			if (role === 'packed')
				for (const [lineId, inputs] of serialInputs) {
					const values = inputs.map((input) => input.value.trim());
					if (values.every(Boolean)) serials[lineId] = values;
				}
			/** @type {Record<string, unknown> | null} */
			let shipment = null;
			if (role === 'shipped') {
				if (has('courier_apis') && book.box.checked)
					shipment = { book: true, ...(courier.value ? { courier: courier.value } : {}) };
				else if (courier.value || tracking.value.trim())
					shipment = { courier: courier.value, trackingNumber: tracking.value.trim() };
			}
			const answer = await kit.call('POST', `/v1/admin/orders/${order.id}/move`, {
				to: to.value,
				note: reason.value,
				serials,
				shipment,
				updatedAt: order.updatedAt,
			});
			if (!answer.ok) {
				kit.fail(note, answer);
				return answer;
			}
			/** @type {string[]} */
			const warnings = answer.data.warnings ?? [];
			return after(answer, [t('ordersAdmin.moved', { status: answer.data.statusLabel }), ...warnings].join(' '));
		},
		{ primary: true },
	);
	return kit.group(t('ordersAdmin.moveTitle'), [
		h('div', { class: 'fields' }, [kit.field(t('ordersAdmin.moveTo'), to), kit.field(t('ordersAdmin.moveNote'), reason)]),
		extra,
		move,
	]);
};

/**
 * Refund part of what was paid (through Payments when paid online, else recorded).
 * @param {Kit} kit @param {any} order @param {HTMLElement} note
 * @param {(answer: any, text: string) => any} after
 */
const refundOf = (kit, order, note, after) => {
	const { t, h } = kit;
	const left = Number(order.payment.refundable ?? 0);
	if (left <= 0) return '';
	const amount = kit.input(kit.decimal(left), { inputmode: 'decimal' });
	const reason = kit.input('', { maxlength: '500' });
	const refund = kit.button(t('ordersAdmin.refund'), async () => {
		const minor = kit.amount(amount.value);
		if (minor === null || Number.isNaN(minor) || minor <= 0) return kit.say(note, t('admin.checkNumbers'), true);
		const answer = await kit.call('POST', `/v1/admin/orders/${order.id}/refunds`, {
			amount: minor,
			reason: reason.value.trim(),
		});
		if (!answer.ok) {
			kit.fail(note, answer);
			return answer;
		}
		return after({ ok: true, data: answer.data.order }, t('ordersAdmin.refundDone', { amount: kit.money(minor) }));
	});
	return kit.group(t('ordersAdmin.refundTitle'), [
		kit.text('p', { class: 'muted' }, t('ordersAdmin.refundable', { amount: kit.money(left) })),
		h('div', { class: 'fields' }, [
			kit.field(t('ordersAdmin.refundAmount', { currency: kit.currency }), amount),
			kit.field(t('ordersAdmin.refundReason'), reason),
		]),
		refund,
	]);
};

/**
 * The invoice and the packing slip, fetched with the ticket and opened in a new tab.
 * @param {Kit} kit @param {any} order @param {HTMLElement} note
 */
const documentsOf = (kit, order, note) => {
	const { t, h } = kit;
	/** @param {string} label @param {string} path */
	const opener = (label, path) =>
		kit.button(label, async () => {
			const answer = await kit.fetchText(`/v1/admin/orders/${order.id}/${path}`);
			if (!answer.ok) return kit.fail(note, answer);
			kit.openHtml(answer.text);
			return answer;
		});
	return h('div', { class: 'actions' }, [
		opener(t('ordersAdmin.invoice'), 'invoice'),
		opener(t('ordersAdmin.packingSlip'), 'packing-slip'),
	]);
};
