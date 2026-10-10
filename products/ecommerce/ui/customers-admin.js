/**
 * Customers, reviews, reports and CSV (admin widget `customers_admin`; PLAN 0.8.8 Admin widgets, 0.6): a section for
 * each switched-on feature — customers (Cart and checkout, `customers.manage`) as a list-and-detail screen: the count
 * of matching customers as a badge, search, Blocked / Not blocked chips with their counts, and one customer with their
 * figures, staff note, latest orders and return claims, Block (with a reason) or Unblock and Edit note as buttons, and
 * Reset returned parcels in the More menu; reviews moderation (Reviews, `./admin-reviews.js`); reports (Reports,
 * `reports.read`) and CSV (CSV, `csv.run`) from `./admin-reports.js`.
 * @module
 */
import { mountAdmin, query } from './admin-kit.js';
import { card, chipFilter, detailHead, listScreen } from './admin-lists.js';
import { CLAIM_TONES } from './admin-order.js';
import { csvTab, reportsTab } from './admin-reports.js';
import { reviewsTab } from './admin-reviews.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-lists.js').Detail} Detail */

/**
 * @param {import('./widget.js').AdminMount} input
 * @returns {Promise<void>}
 */
export const mountCustomersAdmin = async (input) => {
	mountAdmin(input, 'customers-admin', 'customersAdmin.title', (kit, box) => {
		const { t, has } = kit;
		/** @type {Array<{ key: string, label: string, feature: string, render: (panel: HTMLElement) => void }>} */
		const entries = [
			{
				key: 'customers',
				label: t('customersAdmin.customers'),
				feature: 'checkout',
				render: (panel) => customersTab(kit, panel),
			},
			{ key: 'reviews', label: t('customersAdmin.reviews'), feature: 'reviews', render: (panel) => reviewsTab(kit, panel) },
			{ key: 'reports', label: t('customersAdmin.reports'), feature: 'reports', render: (panel) => reportsTab(kit, panel) },
			{ key: 'csv', label: t('customersAdmin.csv'), feature: 'csv', render: (panel) => csvTab(kit, panel) },
		];
		box.append(kit.sections(entries.filter((entry) => has(entry.feature))));
	});
};

/**
 * A customer's name for people: the name, else the e-mail, else the user id.
 * @param {any} customer
 */
const nameOf = (customer) => customer.name || customer.email || customer.userId;

/**
 * The customers section.
 * @param {Kit} kit @param {HTMLElement} panel
 */
const customersTab = (kit, panel) => {
	const { t, h } = kit;
	const reload = () => void screen.reload();
	const search = kit.input('', { type: 'search', placeholder: t('customersAdmin.searchCustomers') });
	const chips = chipFilter(kit, {
		label: t('customersAdmin.blockedFilter'),
		choices: [
			{ value: '', label: t('admin.all') },
			{ value: 'true', label: t('customersAdmin.blockedOnly') },
			{ value: 'false', label: t('customersAdmin.notBlocked') },
		],
		onChange: reload,
	});
	const counts = async () => {
		const q = search.value.trim();
		const [total, byBlocked] = await Promise.all([
			kit.call('GET', `/v1/admin/customers/count${query({ q, blocked: chips.value() })}`),
			kit.call('GET', `/v1/admin/customers/counts${query({ q, by: 'blocked' })}`),
		]);
		screen.count(total);
		// customers without the flag count as not blocked
		chips.counts(
			byBlocked.ok
				? {
						...byBlocked,
						data: {
							total: byBlocked.data.total,
							groups: {
								true: byBlocked.data.groups?.true ?? 0,
								false: (byBlocked.data.groups?.false ?? 0) + (byBlocked.data.groups?.none ?? 0),
							},
						},
					}
				: byBlocked,
		);
	};
	const form = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.text('button', { type: 'submit', class: 'secondary' }, t('admin.searchButton')),
	]);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		reload();
	});
	const screen = listScreen(kit, panel, {
		title: t('customersAdmin.customers'),
		path: (cursor) => `/v1/admin/customers${query({ q: search.value.trim(), blocked: chips.value(), cursor })}`,
		row: (customer) => ({
			name: nameOf(customer),
			figure: kit.money(customer.totalSpent),
			meta: [
				customer.email,
				customer.phone,
				t('customersAdmin.ordersCount', { count: customer.ordersPlaced }),
				customer.rtoCount > 0 ? t('customersAdmin.rtoCount', { count: customer.rtoCount }) : '',
			]
				.filter(Boolean)
				.join(' · '),
			tone: customer.blocked ? 'danger' : customer.rtoCount > 0 ? 'warning' : 'neutral',
			toneLabel: customer.blocked
				? t('customersAdmin.blocked')
				: customer.rtoCount > 0
					? t('customersAdmin.rtoCount', { count: customer.rtoCount })
					: t('customersAdmin.canOrder'),
		}),
		key: (customer) => customer.userId,
		open: (customer, detail) => customerDetail(kit, customer.userId, detail),
		empty: t('customersAdmin.noCustomers'),
		nothing: t('customersAdmin.nothing'),
		filters: [form, chips.node],
		counts,
	});
	void screen.reload();
};

/**
 * Show one customer in the detail pane.
 * @param {Kit} kit @param {string} userId @param {Detail} detail
 */
const customerDetail = async (kit, userId, detail) => {
	const line = kit.status();
	kit.put(detail.pane, [detail.back, line]);
	kit.say(line, kit.t('customersAdmin.loading'));
	const answer = await kit.call('GET', `/v1/admin/customers/${encodeURIComponent(userId)}`);
	if (!detail.current()) return;
	if (answer.ok) renderCustomer(kit, answer.data, detail, '');
	else kit.fail(line, answer);
};

/**
 * @param {Kit} kit @param {any} customer @param {Detail} detail @param {string} message
 */
const renderCustomer = (kit, customer, detail, message) => {
	const { t, has } = kit;
	const path = `/v1/admin/customers/${encodeURIComponent(customer.userId)}`;
	const note = kit.status();
	/** @param {Record<string, unknown>} body @param {string} text @returns {Promise<string | null>} */
	const change = async (body, text) => {
		const answer = await kit.call('PATCH', path, body);
		if (!answer.ok) return kit.reason(answer);
		renderCustomer(kit, answer.data, detail, text);
		detail.changed(answer.data);
		return null;
	};
	const block = () => {
		const reason = kit.input('', { maxlength: '500' });
		kit.dialog({
			title: t('customersAdmin.block'),
			body: [kit.text('p', {}, t('customersAdmin.blockHint')), kit.field(t('customersAdmin.blockReason'), reason)],
			submitLabel: t('customersAdmin.block'),
			danger: true,
			onSubmit: () => change({ blocked: true, blockedReason: reason.value }, t('customersAdmin.blockedDone')),
		});
	};
	const unblock = () =>
		change({ blocked: false }, t('customersAdmin.unblocked')).then((error) => error && kit.say(note, error, true));
	const editNote = () => {
		const text = kit.area(customer.note ?? '', { maxlength: '5000', rows: '5' });
		kit.dialog({
			title: t('customersAdmin.staffNote'),
			body: [kit.field(t('customersAdmin.noteLabel'), text)],
			submitLabel: t('admin.save'),
			onSubmit: () => change({ note: text.value }, t('admin.saved')),
		});
	};
	const resetRto = () =>
		kit.dialog({
			title: t('customersAdmin.resetRto'),
			body: [kit.text('p', {}, t('customersAdmin.resetRtoHint', { count: customer.rtoCount }))],
			submitLabel: t('customersAdmin.resetRto'),
			onSubmit: () => change({ resetRto: true }, t('customersAdmin.rtoReset')),
		});
	/** @type {any[]} */
	const recent = customer.recentOrders ?? [];
	const cards = kit.masonry([
		card(kit, t('customersAdmin.staffNote'), [
			kit.text('p', { class: customer.note ? '' : 'muted' }, customer.note || t('customersAdmin.noNote')),
		]),
		card(kit, t('customersAdmin.recentOrders'), [
			recent.length === 0
				? kit.text('p', { class: 'muted' }, t('customersAdmin.noOrders'))
				: kit.table(
						[t('customersAdmin.orderNumber'), t('admin.status'), t('customersAdmin.total'), t('customersAdmin.placed')],
						recent.map((order) => [
							order.number,
							order.statusLabel,
							kit.money(order.total, order.currency),
							kit.when(order.placedAt),
						]),
					),
		]),
	]);
	kit.put(detail.pane, [
		detail.back,
		detailHead(
			kit,
			[nameOf(customer), customer.blocked ? kit.badge(t('customersAdmin.blocked'), 'danger') : null],
			[
				customer.blocked
					? kit.button(t('customersAdmin.unblock'), unblock, { primary: true })
					: kit.button(t('customersAdmin.block'), block),
				kit.button(t('customersAdmin.editNote'), editNote),
				kit.moreMenu([customer.rtoCount > 0 ? { label: t('customersAdmin.resetRto'), onSelect: resetRto } : null]),
			],
		),
		note,
		kit.fieldGrid([
			[t('customersAdmin.email'), customer.email],
			[t('customersAdmin.phone'), customer.phone],
			[t('customersAdmin.userId'), customer.userId],
			[t('customersAdmin.ordersPlaced'), String(customer.ordersPlaced)],
			[t('customersAdmin.totalSpent'), kit.money(customer.totalSpent)],
			[t('customersAdmin.rto'), String(customer.rtoCount)],
			[t('customersAdmin.blockedReason'), customer.blocked ? customer.blockedReason : ''],
			[t('customersAdmin.since'), customer.createdAt ? kit.when(customer.createdAt) : ''],
		]),
		cards,
	]);
	kit.say(note, message);
	if (has('returns')) void claimsCard(kit, customer, cards, detail);
};

/**
 * The customer's return and warranty claims, as a card added when there are any (and the ticket may read them).
 * @param {Kit} kit @param {any} customer @param {HTMLElement} cards @param {Detail} detail
 */
const claimsCard = async (kit, customer, cards, detail) => {
	const { t } = kit;
	const answer = await kit.call('GET', `/v1/admin/returns${query({ userId: customer.userId })}`);
	/** @type {any[]} */
	const claims = answer.ok ? (answer.data.items ?? []) : [];
	if (!detail.current() || claims.length === 0) return;
	cards.append(
		kit.h('div', { class: 'card' }, [
			card(kit, t('customersAdmin.claims'), [
				kit.h(
					'ul',
					{},
					claims.map((claim) =>
						kit.h('li', {}, [
							`${claim.reference} · ${t('ordersAdmin.orderHead', { number: claim.orderNumber })} · ${t(`ordersAdmin.claimKind.${claim.kind}`)} `,
							kit.badge(t(`ordersAdmin.claim.${claim.status}`), CLAIM_TONES[claim.status]),
						]),
					),
				),
			]),
		]),
	);
};
