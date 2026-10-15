/**
 * Customers, reviews, reports and CSV (admin widget `customers_admin`; PLAN 0.8.8 Admin widgets, 0.6): a section for
 * each switched-on feature — customers (Cart and checkout, `customers.manage`) as a list-and-detail screen: the count
 * of matching customers as a badge, search, Blocked / Not blocked chips with their counts, A to Z or newest first, only
 * the customers this staff member has not opened, Add customer (a customer without an account by phone, with opening
 * points, E46), and one customer (marked opened by the staff member) with their figures, staff note, addresses, latest
 * orders and return claims, Block (with a reason) or Unblock and Edit note as buttons, and in the More menu Reset
 * returned packages, Edit fields, Add address, Mark (or unmark) as a loyalty member (E47) and Delete customer (without
 * orders); reviews moderation (Reviews, `./admin-reviews.js`); reports (Reports,
 * `reports.read`) and CSV (CSV, `csv.run`) from `./admin-reports.js`.
 * @module
 */
import { ADDRESS_FIELDS, ADDRESS_LIMITS } from '../core/address.js';
import { mountAdmin, query } from './admin-kit.js';
import { fieldsCard, fieldsDialog } from './admin-field-values.js';
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
 * A customer's name for people: the name, else the email, else the user id or customer id.
 * @param {any} customer
 */
const nameOf = (customer) => customer.name || customer.email || customer.userId || customer.id;

/**
 * How the staff routes name a customer (K-6): their customer id (members and guests alike), else their user id.
 * @param {any} customer
 */
const refOf = (customer) => customer.id || customer.userId;

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
	const unseen = kit.check(t('customersAdmin.unseenOnly'));
	unseen.box.addEventListener('change', reload);
	const counts = async () => {
		const q = search.value.trim();
		const mine = unseen.box.checked;
		const [total, byBlocked] = await Promise.all([
			kit.call('GET', `/v1/admin/customers/count${query({ q, blocked: chips.value(), unseen: mine })}`),
			kit.call('GET', `/v1/admin/customers/counts${query({ q, unseen: mine, by: 'blocked' })}`),
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
	const sort = kit.select(
		[
			{ value: 'name', label: t('customersAdmin.sortName') },
			{ value: 'newest', label: t('customersAdmin.sortNewest') },
		],
		'name',
	);
	sort.addEventListener('change', reload);
	const form = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.field(t('customersAdmin.sort'), sort),
		kit.text('button', { type: 'submit', class: 'secondary' }, t('admin.searchButton')),
	]);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		reload();
	});
	/** Add a customer without an account (E46). */
	const add = () => {
		const name = kit.input('', { maxlength: '120', required: '' });
		const phone = kit.input('', { type: 'tel', maxlength: '40', required: '' });
		const email = kit.input('', { type: 'email', maxlength: '254' });
		const city = kit.input('', { maxlength: '80' });
		const points = kit.input('0', { type: 'number', min: '0', step: '1' });
		const member = kit.check(t('customersAdmin.loyaltyMember'));
		kit.dialog({
			title: t('customersAdmin.add'),
			body: [
				kit.text('p', {}, t('customersAdmin.addHint')),
				kit.field(t('checkout.field.name'), name),
				kit.field(t('customersAdmin.phone'), phone),
				kit.field(t('customersAdmin.email'), email),
				kit.field(t('checkout.field.city'), city),
				...(kit.has('loyalty') ? [kit.field(t('customersAdmin.openingPoints'), points), member.node] : []),
			],
			submitLabel: t('customersAdmin.add'),
			onSubmit: async () => {
				const answer = await kit.call('POST', '/v1/admin/customers', {
					name: name.value,
					phone: phone.value,
					...(email.value.trim() ? { email: email.value } : {}),
					...(city.value.trim() ? { city: city.value } : {}),
					...(kit.has('loyalty') ? { points: Number(points.value) || 0, loyaltyMember: member.box.checked } : {}),
				});
				if (!answer.ok) return kit.reason(answer);
				await screen.reload();
				return null;
			},
		});
	};
	const screen = listScreen(kit, panel, {
		title: t('customersAdmin.customers'),
		path: (cursor) =>
			`/v1/admin/customers${query({ q: search.value.trim(), blocked: chips.value(), unseen: unseen.box.checked, sort: sort.value === 'name' ? '' : sort.value, cursor })}`,
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
		key: (customer) => refOf(customer),
		open: (customer, detail) => customerDetail(kit, refOf(customer), detail),
		empty: t('customersAdmin.noCustomers'),
		nothing: t('customersAdmin.nothing'),
		actions: [kit.button(t('customersAdmin.add'), add, { primary: true })],
		filters: [form, chips.node, unseen.node],
		counts,
	});
	void screen.reload();
};

/**
 * Show one customer in the detail pane.
 * @param {Kit} kit @param {string} ref the customer id or user id @param {Detail} detail
 */
const customerDetail = async (kit, ref, detail) => {
	const line = kit.status();
	kit.put(detail.pane, [detail.back, line]);
	kit.say(line, kit.t('customersAdmin.loading'));
	const answer = await kit.call('GET', `/v1/admin/customers/${encodeURIComponent(ref)}`);
	if (!detail.current()) return;
	if (!answer.ok) return void kit.fail(line, answer);
	renderCustomer(kit, answer.data, detail, '');
	// opened by this staff member (E31): a marker only, so a refusal changes nothing shown
	await kit.call('POST', `/v1/admin/customers/${encodeURIComponent(ref)}/seen`);
};

/**
 * @param {Kit} kit @param {any} customer @param {Detail} detail @param {string} message
 */
const renderCustomer = (kit, customer, detail, message) => {
	const { t, has } = kit;
	const path = `/v1/admin/customers/${encodeURIComponent(refOf(customer))}`;
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
	/** @type {any[]} the addresses kept for the customer (E46) */
	const addresses = customer.addresses ?? [];
	/** @param {any[]} list @param {string} text */
	const saveAddresses = async (list, text) => {
		const answer = await kit.call('PUT', `${path}/addresses`, { addresses: list });
		if (!answer.ok) return kit.reason(answer);
		renderCustomer(kit, answer.data, detail, text);
		return null;
	};
	const addAddress = () => {
		// the address fields, each at most its length in the one address table (core/address.js)
		const inputs = ADDRESS_FIELDS.map((field) => ({
			field,
			control: kit.input(field === 'name' ? customer.name : field === 'phone' ? customer.phone : '', {
				maxlength: String(ADDRESS_LIMITS[field]),
				...(field === 'phone' ? { type: 'tel' } : {}),
			}),
		}));
		kit.dialog({
			title: t('customersAdmin.addAddress'),
			body: inputs.map(({ field, control }) => kit.field(t(`checkout.field.${field}`), control)),
			submitLabel: t('admin.save'),
			onSubmit: () =>
				saveAddresses(
					[Object.fromEntries(inputs.map(({ field, control }) => [field, control.value])), ...addresses],
					t('customersAdmin.addressSaved'),
				),
		});
	};
	/** @param {any} address */
	const addressText = (address) =>
		ADDRESS_FIELDS.filter((field) => field !== 'notes')
			.map((field) => address[field])
			.filter(Boolean)
			.join(', ');
	const loyaltyOn = has('loyalty');
	const remove = () =>
		kit.dialog({
			title: t('customersAdmin.delete'),
			body: [kit.text('p', {}, t('customersAdmin.deleteHint', { name: nameOf(customer) }))],
			submitLabel: t('customersAdmin.delete'),
			danger: true,
			onSubmit: async () => {
				const answer = await kit.call('DELETE', path);
				if (!answer.ok) return kit.reason(answer);
				await detail.reload();
				return null;
			},
		});
	/** @type {any[]} */
	const recent = customer.recentOrders ?? [];
	const cards = kit.masonry(
		[
			card(kit, t('customersAdmin.staffNote'), [
				kit.text('p', { class: customer.note ? '' : 'muted' }, customer.note || t('customersAdmin.noNote')),
			]),
			// the customer fields staff keep (dynamic model §2)
			fieldsCard(kit, customer.customerFields ?? [], customer.fields ?? {}),
			card(kit, t('customersAdmin.addresses'), [
				addresses.length === 0
					? kit.text('p', { class: 'muted' }, t('customersAdmin.noAddresses'))
					: kit.h(
							'ul',
							{ class: 'rows' },
							addresses.map((address, index) =>
								kit.h('li', {}, [
									addressText(address),
									' ',
									kit.confirmButton(t('admin.remove'), t('admin.confirmRemove'), () =>
										saveAddresses(
											addresses.filter((_, other) => other !== index),
											t('customersAdmin.addressRemoved'),
										),
									),
								]),
							),
						),
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
		].filter((entry) => entry !== null),
	);
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
				kit.moreMenu([
					customer.rtoCount > 0 ? { label: t('customersAdmin.resetRto'), onSelect: resetRto } : null,
					{ label: t('customersAdmin.addAddress'), onSelect: addAddress },
					loyaltyOn
						? {
								label: t(customer.loyaltyMember ? 'customersAdmin.unmarkMember' : 'customersAdmin.markMember'),
								onSelect: () =>
									void change(
										{ loyaltyMember: !customer.loyaltyMember },
										t(customer.loyaltyMember ? 'customersAdmin.unmarkedMember' : 'customersAdmin.markedMember'),
									).then((error) => error && kit.say(note, error, true)),
							}
						: null,
					customer.ordersPlaced === 0 && customer.orderCount === 0
						? { label: t('customersAdmin.delete'), onSelect: remove }
						: null,
					(customer.customerFields ?? []).some((/** @type {any} */ field) => field.active)
						? {
								label: t('admin.editFields'),
								onSelect: () =>
									fieldsDialog(kit, {
										fields: customer.customerFields,
										values: customer.fields ?? {},
										save: (body) => change(body, t('admin.saved')),
									}),
							}
						: null,
				]),
			],
		),
		note,
		kit.fieldGrid([
			[t('customersAdmin.email'), customer.email],
			[t('customersAdmin.phone'), customer.phone],
			[t('checkout.field.city'), customer.city ?? ''],
			[t('customersAdmin.userId'), customer.userId || t('customersAdmin.guest')],
			...(loyaltyOn
				? [
						/** @type {[string, string]} */ ([
							t('customersAdmin.loyaltyMember'),
							t(customer.loyaltyMember ? 'admin.yes' : 'admin.no'),
						]),
					]
				: []),
			[t('customersAdmin.ordersPlaced'), String(customer.ordersPlaced)],
			[t('customersAdmin.totalSpent'), kit.money(customer.totalSpent)],
			[t('customersAdmin.rto'), String(customer.rtoCount)],
			[t('customersAdmin.blockedReason'), customer.blocked ? customer.blockedReason : ''],
			[t('customersAdmin.since'), customer.createdAt ? kit.when(customer.createdAt) : ''],
		]),
		cards,
	]);
	kit.say(note, message);
	// claims are listed by Accounts user id: a guest's are on their orders
	if (has('returns') && customer.userId) void claimsCard(kit, customer, cards, detail);
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
