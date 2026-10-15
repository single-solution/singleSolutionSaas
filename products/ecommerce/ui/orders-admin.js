/**
 * Orders and returns (admin widget `orders_admin`, tickets with `orders.read`, `orders.manage`, `orders.refund`,
 * `orders.delete`, `bulk.run`, `csv.run` and `returns.manage`; PLAN 0.8.8 Orders, 0.6): the orders as a
 * list-and-detail screen — the count of matching orders as a badge, search, status chips with their counts, more
 * filters (stage, payment state and method with their counts, placed between two days, only the orders this staff
 * member has not opened, only canceled orders with money to refund), a checkbox on each row with Move selected (Bulk actions) and the packing slips and pick list
 * of the selected orders (Invoices), and in the list's More menu Export these orders as CSV (CSV) and Move all orders
 * of a status (to another status of the same kind, before a status is removed or renamed in the order flow) — beside
 * one order (`./admin-order.js`); and the return and warranty claims (Returns, `./admin-returns.js`). What the ticket
 * does not allow answers 403 and is shown as not allowed.
 * @module
 */
import { STATUS_ROLES } from '../core/model.js';
import { PAYMENT_METHODS, PAYMENT_STATES } from '../core/orders.js';
import { dayEnd, dayStart, mountAdmin, query } from './admin-kit.js';
import { chipFilter, countedSelect, listScreen } from './admin-lists.js';
import { ROLE_TONES, orderDetail } from './admin-order.js';
import { returnsTab } from './admin-returns.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */

/**
 * @param {import('./widget.js').AdminMount} input
 * @returns {Promise<void>}
 */
export const mountOrdersAdmin = async (input) => {
	mountAdmin(input, 'orders-admin', 'ordersAdmin.title', (kit, box) => {
		const { t, has } = kit;
		box.append(
			kit.sections([
				{ key: 'orders', label: t('ordersAdmin.orders'), render: (panel) => ordersTab(kit, panel) },
				...(has('returns')
					? [
							{
								key: 'returns',
								label: t('ordersAdmin.returns'),
								render: (/** @type {HTMLElement} */ panel) => returnsTab(kit, panel),
							},
						]
					: []),
			]),
		);
	});
};

/**
 * The statuses of the website's order flow (the admin widget config's `settings.orders.statuses: [{ key, label, role }]`).
 * @param {Kit} kit
 * @returns {Array<{ key: string, label: string, role: string }>}
 */
const statusesOf = (kit) => kit.settings.orders.statuses;

/**
 * The orders section.
 * @param {Kit} kit @param {HTMLElement} panel
 */
const ordersTab = (kit, panel) => {
	const { t, h, has } = kit;
	const flow = statusesOf(kit);
	const all = { value: '', label: t('admin.all') };
	const roles = STATUS_ROLES.map((role) => ({ value: role, label: t(`ordersAdmin.role.${role}`) }));
	/** @param {string} label @param {number} count */
	const withCount = (label, count) => t('ordersAdmin.withCount', { label, count });
	const reload = () => void screen.reload();

	const search = kit.input('', { type: 'search', placeholder: t('ordersAdmin.searchOrders') });
	const chips = chipFilter(kit, {
		label: t('admin.status'),
		choices: [all, ...flow.map((status) => ({ value: status.key, label: status.label }))],
		onChange: reload,
	});
	const stage = countedSelect(kit, [all, ...roles], withCount);
	const paymentState = countedSelect(
		kit,
		[all, ...PAYMENT_STATES.map((state) => ({ value: state, label: t(`ordersAdmin.payment.${state}`) }))],
		withCount,
	);
	const paymentMethod = countedSelect(
		kit,
		[all, ...PAYMENT_METHODS.map((method) => ({ value: method, label: t(`ordersAdmin.method.${method}`) }))],
		withCount,
	);
	const from = kit.input('', { type: 'date' });
	const to = kit.input('', { type: 'date' });
	const unseen = kit.check(t('ordersAdmin.unseenOnly'));
	// canceled orders that still hold the shopper's money: the refunds to make (late money, K-13)
	const refundDue = kit.check(t('ordersAdmin.refundDueOnly'));

	/**
	 * The list's filters; a count by a field leaves out that field's own filter.
	 * @param {string} [without]
	 */
	const filters = (without = '') => ({
		q: search.value.trim(),
		status: without === 'status' ? '' : chips.value(),
		role: without === 'role' ? '' : stage.node.value,
		paymentState: without === 'paymentState' ? '' : paymentState.node.value,
		paymentMethod: without === 'paymentMethod' ? '' : paymentMethod.node.value,
		from: dayStart(from.value, kit.timeZone),
		to: dayEnd(to.value, kit.timeZone),
		unseen: unseen.box.checked,
		refundDue: refundDue.box.checked,
	});
	/** @param {string} by */
	const countsBy = (by) => kit.call('GET', `/v1/admin/orders/counts${query({ ...filters(by), by })}`);
	const counts = async () => {
		const [total, chipCounts, roleCounts, states, methods] = await Promise.all([
			kit.call('GET', `/v1/admin/orders/count${query(filters())}`),
			countsBy('status'),
			countsBy('role'),
			countsBy('paymentState'),
			countsBy('paymentMethod'),
		]);
		screen.count(total);
		chips.counts(chipCounts);
		// statuses with orders that the flow no longer has (imported orders), for Move all orders of a status
		if (chipCounts.ok) for (const key of Object.keys(chipCounts.data.groups ?? {})) if (!known.has(key)) others.add(key);
		stage.counts(roleCounts);
		paymentState.counts(states);
		paymentMethod.counts(methods);
	};

	const form = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.text('button', { type: 'submit', class: 'secondary' }, t('admin.searchButton')),
	]);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		reload();
	});
	const more = h('details', { class: 'filters' }, [
		kit.text('summary', {}, t('ordersAdmin.moreFilters')),
		h('div', { class: 'fields' }, [
			kit.field(t('ordersAdmin.stage'), stage.node),
			kit.field(t('ordersAdmin.paymentState'), paymentState.node),
			kit.field(t('ordersAdmin.paymentMethod'), paymentMethod.node),
			kit.field(t('admin.from'), from),
			kit.field(t('admin.to'), to),
			unseen.node,
			refundDue.node,
		]),
	]);
	for (const control of [stage.node, paymentState.node, paymentMethod.node, from, to, unseen.box, refundDue.box])
		control.addEventListener('change', reload);

	// bulk moves: the selected orders to one status (each move follows the flow; refusals are listed per order)
	const failures = h('ul');
	const moveSelected = kit.button(t('ordersAdmin.moveSelected'), () => {
		failures.replaceChildren();
		if (screen.selected.size === 0) return kit.say(screen.line, t('admin.selectFirst'), true);
		const target = kit.select(flow.map((status) => ({ value: status.key, label: status.label })));
		const note = kit.input('', { maxlength: '1000' });
		const ids = [...screen.selected];
		return kit.dialog({
			title: t('ordersAdmin.bulkTitle'),
			body: [
				kit.text('p', { class: 'muted' }, t('ordersAdmin.bulkHint', { count: ids.length })),
				h('div', { class: 'fields' }, [
					kit.field(t('ordersAdmin.moveTo'), target),
					kit.field(t('ordersAdmin.moveNote'), note),
				]),
			],
			submitLabel: t('ordersAdmin.moveSelected'),
			onSubmit: async () => {
				const answer = await kit.call('POST', '/v1/admin/orders/bulk-move', { ids, to: target.value, note: note.value });
				if (!answer.ok) return kit.reason(answer);
				/** @type {any[]} */
				const results = answer.data.results ?? [];
				await screen.reload();
				kit.say(screen.line, t('ordersAdmin.bulkDone', { moved: answer.data.moved, count: results.length }));
				failures.append(
					...results
						.filter((result) => !result.ok)
						.map((result) =>
							kit.text(
								'li',
								{ class: 'error' },
								t('ordersAdmin.bulkFailed', { order: result.id, reason: kit.refusal(result.code) }),
							),
						),
				);
				return null;
			},
		});
	});

	// the packing slips or the pick list of the selected orders, as one printable page (Invoices)
	/** @param {string} path @param {string} name */
	const printSelected = (path, name) =>
		kit.button(name, async () => {
			failures.replaceChildren();
			if (screen.selected.size === 0) return kit.say(screen.line, t('admin.selectFirst'), true);
			const file = await kit.fetchText(`/v1/admin/orders/${path}${query({ ids: [...screen.selected].join(',') })}`);
			if (!file.ok) return kit.fail(screen.line, file);
			kit.openHtml(file.text);
			kit.say(screen.line, t('ordersAdmin.opened', { name }));
			return file;
		});

	// every order of a status to another status of the same kind (role), so the flow can drop or rename the status
	const known = new Set(flow.map((status) => status.key));
	/** Statuses with orders the flow no longer has. @type {Set<string>} */
	const others = new Set();
	const restatus = () => {
		const source = kit.select([
			...flow.map((status) => ({ value: status.key, label: status.label })),
			...[...others].map((key) => ({ value: key, label: t('ordersAdmin.retiredStatus', { status: key }) })),
		]);
		const target = kit.select(flow.map((status) => ({ value: status.key, label: status.label })));
		// only statuses of the same kind of step (any status of the flow for one it no longer has)
		const sameKind = () => {
			const role = flow.find((status) => status.key === source.value)?.role;
			for (const option of target.options) {
				const status = flow.find((item) => item.key === option.value);
				option.disabled = option.value === source.value || (role !== undefined && status?.role !== role);
				option.hidden = option.disabled;
			}
			const first = [...target.options].find((option) => !option.disabled);
			target.value = first ? first.value : '';
		};
		source.addEventListener('change', sameKind);
		sameKind();
		kit.dialog({
			title: t('ordersAdmin.restatus'),
			body: [
				kit.text('p', { class: 'muted' }, t('ordersAdmin.restatusHint')),
				h('div', { class: 'fields' }, [
					kit.field(t('ordersAdmin.restatusFrom'), source),
					kit.field(t('ordersAdmin.moveTo'), target),
				]),
			],
			submitLabel: t('ordersAdmin.restatusButton'),
			onSubmit: async () => {
				if (!target.value) return t('ordersAdmin.restatusNoTarget');
				const answer = await kit.call('POST', '/v1/admin/orders/restatus', { from: source.value, to: target.value });
				if (!answer.ok) return kit.reason(answer);
				const label = (/** @type {string} */ key) => flow.find((status) => status.key === key)?.label ?? key;
				await screen.reload();
				kit.say(
					screen.line,
					t('ordersAdmin.restatusDone', {
						count: answer.data.moved,
						from: label(answer.data.from),
						to: label(answer.data.to),
					}),
				);
				return null;
			},
		});
	};

	// CSV: the orders the list's filters match (the CSV has no "not opened by me")
	const exportCsv = async () => {
		const answer = await kit.fetchText(`/v1/admin/csv/orders${query({ ...filters(), unseen: false })}`);
		if (!answer.ok) return kit.fail(screen.line, answer);
		kit.save('orders.csv', answer.text);
		kit.say(screen.line, t('ordersAdmin.exported', { name: 'orders.csv' }));
		return answer;
	};

	const screen = listScreen(kit, panel, {
		title: t('ordersAdmin.orders'),
		path: (cursor) => `/v1/admin/orders${query({ ...filters(), cursor })}`,
		row: (order) => ({
			name: order.number,
			figure: kit.money(order.total, order.currency),
			meta: [
				order.statusLabel,
				order.customer?.name,
				order.city,
				kit.when(order.placedAt),
				t(`ordersAdmin.method.${order.payment.method}`),
				t(`ordersAdmin.payment.${order.payment.state}`),
			]
				.filter(Boolean)
				.join(' · '),
			tone: ROLE_TONES[order.role] ?? 'neutral',
			toneLabel: order.statusLabel,
		}),
		open: (order, detail) => orderDetail(kit, order.id, detail),
		empty: t('ordersAdmin.noOrders'),
		nothing: t('ordersAdmin.nothing'),
		actions: [
			kit.moreMenu([
				has('csv') ? { label: t('ordersAdmin.exportCsv'), onSelect: exportCsv } : null,
				{ label: t('ordersAdmin.restatus'), onSelect: restatus },
			]),
		],
		filters: [form, chips.node, more],
		after: [failures],
		counts,
		...(has('bulk_actions') || has('invoices')
			? {
					bulk: {
						label: (/** @type {any} */ order) => order.number,
						all: t('ordersAdmin.selectAll'),
						actions: [
							has('bulk_actions') ? moveSelected : null,
							has('invoices') ? printSelected('packing-slips', t('ordersAdmin.packingSlips')) : null,
							has('invoices') ? printSelected('pick-list', t('ordersAdmin.pickList')) : null,
						],
					},
				}
			: {}),
	});
	void screen.reload();
};
