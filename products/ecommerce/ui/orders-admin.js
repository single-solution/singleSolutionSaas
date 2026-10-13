/**
 * Orders and returns (admin widget `orders_admin`, tickets with `orders.read`, `orders.manage`, `orders.refund`,
 * `bulk.run`, `csv.run` and `returns.manage`; PLAN 0.8.8 Orders, 0.6): the orders as a list-and-detail screen — the
 * count of matching orders as a badge, search, status chips with their counts, more filters (stage, payment state and
 * method with their counts, placed between two days), a checkbox on each row with Move selected (Bulk actions), and
 * Export these orders as CSV in the list's More menu (CSV) — beside one order (`./admin-order.js`); and the return and
 * warranty claims (Returns, `./admin-returns.js`). What the ticket does not allow answers 403 and is shown as not
 * allowed.
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
 * Statuses of the website's order flow, when the widget settings carry them (`settings.orders.statuses: [{ key, label }]`).
 * @param {Kit} kit
 * @returns {Array<{ key: string, label: string }>}
 */
const statusesOf = (kit) => {
	const list = kit.settings.orders?.statuses;
	return Array.isArray(list) ? list : [];
};

/**
 * The orders section.
 * @param {Kit} kit @param {HTMLElement} panel
 */
const ordersTab = (kit, panel) => {
	const { t, h, has } = kit;
	const flow = statusesOf(kit);
	// with the flow known the chips are its statuses and the stage (role) is a select; else the chips are the roles
	const byStatus = flow.length > 0;
	/** Statuses seen in the list (bulk moves offer them when the settings do not list the flow). @type {Map<string, string>} */
	const seen = new Map(flow.map((status) => [status.key, status.label]));
	const all = { value: '', label: t('admin.all') };
	const roles = STATUS_ROLES.map((role) => ({ value: role, label: t(`ordersAdmin.role.${role}`) }));
	/** @param {string} label @param {number} count */
	const withCount = (label, count) => t('ordersAdmin.withCount', { label, count });
	const reload = () => void screen.reload();

	const search = kit.input('', { type: 'search', placeholder: t('ordersAdmin.searchOrders') });
	const chips = chipFilter(kit, {
		label: t('admin.status'),
		choices: [all, ...(byStatus ? flow.map((status) => ({ value: status.key, label: status.label })) : roles)],
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

	/**
	 * The list's filters; a count by a field leaves out that field's own filter.
	 * @param {string} [without]
	 */
	const filters = (without = '') => {
		const status = byStatus ? chips.value() : '';
		const role = byStatus ? stage.node.value : chips.value();
		return {
			q: search.value.trim(),
			status: without === 'status' ? '' : status,
			role: without === 'role' ? '' : role,
			paymentState: without === 'paymentState' ? '' : paymentState.node.value,
			paymentMethod: without === 'paymentMethod' ? '' : paymentMethod.node.value,
			from: dayStart(from.value, kit.timeZone),
			to: dayEnd(to.value, kit.timeZone),
		};
	};
	/** @param {string} by */
	const countsBy = (by) => kit.call('GET', `/v1/admin/orders/counts${query({ ...filters(by), by })}`);
	const counts = async () => {
		const [total, chipCounts, roleCounts, states, methods] = await Promise.all([
			kit.call('GET', `/v1/admin/orders/count${query(filters())}`),
			countsBy(byStatus ? 'status' : 'role'),
			byStatus ? countsBy('role') : null,
			countsBy('paymentState'),
			countsBy('paymentMethod'),
		]);
		screen.count(total);
		chips.counts(chipCounts);
		if (roleCounts) stage.counts(roleCounts);
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
			byStatus ? kit.field(t('ordersAdmin.stage'), stage.node) : null,
			kit.field(t('ordersAdmin.paymentState'), paymentState.node),
			kit.field(t('ordersAdmin.paymentMethod'), paymentMethod.node),
			kit.field(t('admin.from'), from),
			kit.field(t('admin.to'), to),
		]),
	]);
	for (const control of [stage.node, paymentState.node, paymentMethod.node, from, to])
		control.addEventListener('change', reload);

	// bulk moves: the selected orders to one status (each move follows the flow; refusals are listed per order)
	const failures = h('ul');
	const moveSelected = kit.button(t('ordersAdmin.moveSelected'), () => {
		failures.replaceChildren();
		if (screen.selected.size === 0) return kit.say(screen.line, t('admin.selectFirst'), true);
		const target = kit.select([...seen].map(([value, label]) => ({ value, label })));
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

	// CSV: the orders the filters match (by status and days; the CSV takes no other filter)
	const exportCsv = async () => {
		const answer = await kit.fetchText(
			`/v1/admin/csv/orders${query({ status: byStatus ? chips.value() : '', from: filters().from, to: filters().to })}`,
		);
		if (!answer.ok) return kit.fail(screen.line, answer);
		kit.save('orders.csv', answer.text);
		kit.say(screen.line, t('ordersAdmin.exported', { name: 'orders.csv' }));
		return answer;
	};

	const screen = listScreen(kit, panel, {
		title: t('ordersAdmin.orders'),
		path: (cursor) => `/v1/admin/orders${query({ ...filters(), cursor })}`,
		row: (order) => {
			seen.set(order.status, order.statusLabel);
			return {
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
			};
		},
		open: (order, detail) => orderDetail(kit, order.id, detail),
		empty: t('ordersAdmin.noOrders'),
		nothing: t('ordersAdmin.nothing'),
		actions: [has('csv') ? kit.moreMenu([{ label: t('ordersAdmin.exportCsv'), onSelect: exportCsv }]) : null],
		filters: [form, chips.node, more],
		after: [failures],
		counts,
		...(has('bulk_actions')
			? {
					bulk: {
						label: (/** @type {any} */ order) => order.number,
						all: t('ordersAdmin.selectAll'),
						actions: [moveSelected],
					},
				}
			: {}),
	});
	void screen.reload();
};
