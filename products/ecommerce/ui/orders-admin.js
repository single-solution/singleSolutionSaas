/**
 * Orders and returns (admin widget `orders_admin`, tickets with `orders.read`, `orders.manage`, `orders.refund`,
 * `bulk.run` and `returns.manage`; PLAN 0.8.8 Orders): the orders list with filters (status, payment state and method,
 * dates, search) and Load more, bulk moves of the selected orders (Bulk actions), one order (`./admin-order.js`), and
 * the returns section (Returns, `./admin-returns.js`). What the ticket does not allow answers 403 and is shown as not
 * allowed.
 * @module
 */
import { STATUS_ROLES } from '../core/model.js';
import { PAYMENT_METHODS, PAYMENT_STATES } from '../core/orders.js';
import { dayEnd, dayStart, mountAdmin, query } from './admin-kit.js';
import { orderDetail } from './admin-order.js';
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
 * Statuses of the website's order flow, when the widget settings carry them (`settings.orders.statuses: [{ key, label }]`).
 * @param {Kit} kit
 * @returns {Array<{ key: string, label: string }>}
 */
const statusesOf = (kit) => {
	const list = kit.settings.orders?.statuses;
	return Array.isArray(list) ? list : [];
};

/**
 * The orders section: filters, the list, bulk moves and the order detail.
 * @param {Kit} kit @param {HTMLElement} panel
 */
const ordersTab = (kit, panel) => {
	const { t, h, has } = kit;
	const line = kit.status();
	const listView = h('div');
	const detailView = h('div');
	/** @type {Set<string>} */
	const selected = new Set();
	/** Statuses seen in the list (bulk moves offer them when the settings do not list the flow). @type {Map<string, string>} */
	const seen = new Map(statusesOf(kit).map((status) => [status.key, status.label]));

	const search = kit.input('', { type: 'search', placeholder: t('ordersAdmin.searchOrders') });
	const flow = statusesOf(kit);
	const status =
		flow.length > 0
			? kit.select([{ value: '', label: t('admin.all') }, ...flow.map((item) => ({ value: item.key, label: item.label }))])
			: kit.select([
					{ value: '', label: t('admin.all') },
					...STATUS_ROLES.map((role) => ({ value: role, label: t(`ordersAdmin.role.${role}`) })),
				]);
	const paymentState = kit.select([
		{ value: '', label: t('admin.all') },
		...PAYMENT_STATES.map((state) => ({ value: state, label: t(`ordersAdmin.payment.${state}`) })),
	]);
	const paymentMethod = kit.select([
		{ value: '', label: t('admin.all') },
		...PAYMENT_METHODS.map((method) => ({ value: method, label: t(`ordersAdmin.method.${method}`) })),
	]);
	const from = kit.input('', { type: 'date' });
	const to = kit.input('', { type: 'date' });

	/** @param {any} order */
	const rowOf = (order) => {
		seen.set(order.status, order.statusLabel);
		const pick = kit.check('', false);
		pick.box.setAttribute('aria-label', t('admin.select', { name: order.number }));
		pick.box.addEventListener('change', () => {
			if (pick.box.checked) selected.add(order.id);
			else selected.delete(order.id);
		});
		return h('li', {}, [
			has('bulk_actions') ? pick.node : null,
			h('div', { class: 'what' }, [
				h('strong', {}, [t('ordersAdmin.orderTitle', { number: order.number, status: order.statusLabel })]),
				kit.text(
					'span',
					{ class: 'meta' },
					[
						kit.when(order.placedAt),
						order.customer?.name,
						order.city,
						kit.money(order.total, order.currency),
						t(`ordersAdmin.method.${order.payment.method}`),
						t(`ordersAdmin.payment.${order.payment.state}`),
					]
						.filter(Boolean)
						.join(' · '),
				),
			]),
			kit.button(t('admin.open'), () => open(order.id)),
		]);
	};
	const pages = kit.pager({
		path: (cursor) =>
			`/v1/admin/orders${query({
				q: search.value.trim(),
				[flow.length > 0 ? 'status' : 'role']: status.value,
				paymentState: paymentState.value,
				paymentMethod: paymentMethod.value,
				from: dayStart(from.value, kit.timeZone),
				to: dayEnd(to.value, kit.timeZone),
				cursor,
			})}`,
		row: rowOf,
		line,
		empty: t('ordersAdmin.noOrders'),
	});
	const bulk = has('bulk_actions') ? bulkOf(kit, selected, seen, () => reload()) : null;
	const reload = async () => {
		selected.clear();
		const answer = await pages.load(true);
		bulk?.refresh();
		return answer;
	};

	/** @param {string} id */
	const open = (id) => {
		listView.hidden = true;
		detailView.replaceChildren(
			orderDetail(kit, {
				id,
				done: (changed) => {
					detailView.replaceChildren();
					listView.hidden = false;
					if (changed) void reload();
				},
			}),
		);
	};

	const filters = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.field(t('admin.status'), status),
		kit.field(t('ordersAdmin.paymentState'), paymentState),
		kit.field(t('ordersAdmin.paymentMethod'), paymentMethod),
		kit.field(t('admin.from'), from),
		kit.field(t('admin.to'), to),
		kit.text('button', { type: 'submit', class: 'secondary' }, t('admin.searchButton')),
	]);
	filters.addEventListener('submit', (event) => {
		event.preventDefault();
		void reload();
	});
	for (const control of [status, paymentState, paymentMethod, from, to]) control.addEventListener('change', () => void reload());

	kit.put(listView, [filters, bulk?.node, line, pages.node]);
	panel.append(listView, detailView);
	void reload();
};

/**
 * Move the selected orders to one status (each move follows the flow; refusals are listed per order). `refresh` updates
 * the statuses offered.
 * @param {Kit} kit @param {Set<string>} selected @param {Map<string, string>} seen statuses to offer
 * @param {() => Promise<unknown>} reload
 */
const bulkOf = (kit, selected, seen, reload) => {
	const { t, h } = kit;
	const note = kit.status();
	const failures = h('ul');
	const to = kit.select([]);
	const reason = kit.input('', { maxlength: '1000' });
	const fillStatuses = () => {
		const current = to.value;
		to.replaceChildren(...[...seen].map(([key, label]) => kit.text('option', { value: key }, label)));
		if (seen.has(current)) to.value = current;
	};
	to.addEventListener('focus', fillStatuses);
	fillStatuses();
	const apply = kit.button(t('ordersAdmin.moveSelected'), async () => {
		failures.replaceChildren();
		if (selected.size === 0 || !to.value) return kit.say(note, t('admin.selectFirst'), true);
		const answer = await kit.call('POST', '/v1/admin/orders/bulk-move', {
			ids: [...selected],
			to: to.value,
			note: reason.value,
		});
		if (!answer.ok) return kit.fail(note, answer);
		/** @type {any[]} */
		const results = answer.data.results ?? [];
		kit.say(note, t('ordersAdmin.bulkDone', { moved: answer.data.moved, count: results.length }));
		failures.append(
			...results
				.filter((result) => !result.ok)
				.map((result) =>
					kit.text('li', { class: 'error' }, t('ordersAdmin.bulkFailed', { order: result.id, reason: result.detail })),
				),
		);
		await reload();
		return answer;
	});
	return {
		node: kit.group(t('ordersAdmin.bulkTitle'), [
			h('div', { class: 'row inline' }, [
				kit.field(t('ordersAdmin.moveTo'), to),
				kit.field(t('ordersAdmin.moveNote'), reason),
				apply,
			]),
			note,
			failures,
		]),
		refresh: fillStatuses,
	};
};
