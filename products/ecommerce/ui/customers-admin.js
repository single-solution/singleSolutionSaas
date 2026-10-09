/**
 * Customers, reviews, reports and CSV (admin widget `customers_admin`; PLAN 0.8.8 Admin widgets): a section for each
 * switched-on feature — customers (Cart and checkout, `customers.manage`: search, blocked filter, one customer with
 * their latest orders, block or unblock with a reason, the staff note, reset the returned-parcel count), reviews
 * moderation (Reviews, `reviews.moderate`: pending, approved or rejected; approve, reject, reply, delete), reports
 * (Reports, `reports.read`) and CSV (CSV, `csv.run`) from `./admin-reports.js`.
 * @module
 */
import { mountAdmin, query } from './admin-kit.js';
import { csvTab, reportsTab } from './admin-reports.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */

/**
 * @param {import('./widget.js').AdminMount} input
 * @returns {Promise<void>}
 */
export const mountCustomersAdmin = async (input) => {
	mountAdmin(input, 'customers-admin', 'customersAdmin.title', (kit, box) => {
		const { t, has } = kit;
		/** @type {Array<{ key: string, label: string, render: (panel: HTMLElement) => void }>} */
		const entries = [
			...(has('checkout')
				? [
						{
							key: 'customers',
							label: t('customersAdmin.customers'),
							render: (/** @type {HTMLElement} */ panel) => customersTab(kit, panel),
						},
					]
				: []),
			...(has('reviews')
				? [
						{
							key: 'reviews',
							label: t('customersAdmin.reviews'),
							render: (/** @type {HTMLElement} */ panel) => reviewsTab(kit, panel),
						},
					]
				: []),
			...(has('reports')
				? [
						{
							key: 'reports',
							label: t('customersAdmin.reports'),
							render: (/** @type {HTMLElement} */ panel) => reportsTab(kit, panel),
						},
					]
				: []),
			...(has('csv')
				? [{ key: 'csv', label: t('customersAdmin.csv'), render: (/** @type {HTMLElement} */ panel) => csvTab(kit, panel) }]
				: []),
		];
		box.append(kit.sections(entries));
	});
};

/**
 * The customers section: search, the blocked filter, the list and one customer.
 * @param {Kit} kit @param {HTMLElement} panel
 */
const customersTab = (kit, panel) => {
	const { t, h } = kit;
	const line = kit.status();
	const listView = h('div');
	const detailView = h('div');
	const search = kit.input('', { type: 'search', placeholder: t('customersAdmin.searchCustomers') });
	const blocked = kit.select([
		{ value: '', label: t('admin.all') },
		{ value: 'true', label: t('customersAdmin.blockedOnly') },
		{ value: 'false', label: t('customersAdmin.notBlocked') },
	]);
	/** @param {any} customer */
	const rowOf = (customer) =>
		h('li', {}, [
			h('div', { class: 'what' }, [
				h('strong', {}, [customer.name || customer.email || customer.userId]),
				kit.text(
					'span',
					{ class: 'meta' },
					[
						customer.email,
						customer.phone,
						t('customersAdmin.ordersSpent', { orders: customer.ordersPlaced, spent: customer.totalSpentText }),
						customer.rtoCount > 0 ? t('customersAdmin.rtoCount', { count: customer.rtoCount }) : '',
					]
						.filter(Boolean)
						.join(' · '),
				),
				customer.blocked ? kit.text('span', { class: 'pill warn' }, t('customersAdmin.blocked')) : null,
			]),
			kit.button(t('admin.open'), () => open(customer.userId)),
		]);
	const pages = kit.pager({
		path: (cursor) => `/v1/admin/customers${query({ q: search.value.trim(), blocked: blocked.value, cursor })}`,
		row: rowOf,
		line,
		empty: t('customersAdmin.noCustomers'),
	});
	/** @param {string} userId */
	const open = (userId) => {
		listView.hidden = true;
		detailView.replaceChildren(
			customerDetail(kit, {
				userId,
				done: (changed) => {
					detailView.replaceChildren();
					listView.hidden = false;
					if (changed) void pages.load(true);
				},
			}),
		);
	};
	const filters = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.field(t('customersAdmin.blockedFilter'), blocked),
		kit.text('button', { type: 'submit', class: 'secondary' }, t('admin.searchButton')),
	]);
	filters.addEventListener('submit', (event) => {
		event.preventDefault();
		void pages.load(true);
	});
	blocked.addEventListener('change', () => void pages.load(true));
	listView.append(filters, line, pages.node);
	panel.append(listView, detailView);
	void pages.load(true);
};

/**
 * One customer: details, latest orders, block or unblock, note, reset the returned-parcel count.
 * @param {Kit} kit @param {{ userId: string, done: (changed: boolean) => void }} options
 */
const customerDetail = (kit, { userId, done }) => {
	const { t, h } = kit;
	const box = h('div');
	const line = kit.status();
	box.append(line);
	const path = `/v1/admin/customers/${encodeURIComponent(userId)}`;
	let changed = false;

	/** @param {any} customer @param {string} [message] */
	const render = (customer, message = '') => {
		const note = kit.status();
		/** @param {Record<string, unknown>} body @param {string} text */
		const change = async (body, text) => {
			const answer = await kit.call('PATCH', path, body);
			if (!answer.ok) {
				kit.fail(note, answer);
				return answer;
			}
			changed = true;
			render(answer.data, text);
			return answer;
		};
		const reason = kit.input('', { maxlength: '500' });
		const staffNote = kit.area(customer.note ?? '', { maxlength: '5000' });
		kit.put(box, [
			h('div', { class: 'head' }, [
				kit.text('h3', {}, customer.name || customer.email || customer.userId),
				kit.button(t('admin.back'), () => done(changed)),
			]),
			h(
				'dl',
				{},
				[
					[t('customersAdmin.email'), customer.email],
					[t('customersAdmin.phone'), customer.phone],
					[t('customersAdmin.userId'), customer.userId],
					[t('customersAdmin.ordersPlaced'), String(customer.ordersPlaced)],
					[t('customersAdmin.totalSpent'), customer.totalSpentText],
					[t('customersAdmin.rto'), String(customer.rtoCount)],
					[t('customersAdmin.blockedReason'), customer.blocked ? customer.blockedReason : ''],
				]
					.filter(([, value]) => value)
					.flatMap(([label, value]) => [kit.text('dt', {}, String(label)), kit.text('dd', {}, String(value))]),
			),
			customer.blocked ? kit.text('p', { class: 'pill warn' }, t('customersAdmin.blocked')) : null,
			kit.group(t('customersAdmin.blocklist'), [
				customer.blocked
					? kit.button(t('customersAdmin.unblock'), () => change({ blocked: false }, t('customersAdmin.unblocked')))
					: h('div', { class: 'row inline' }, [
							kit.field(t('customersAdmin.blockReason'), reason),
							kit.button(t('customersAdmin.block'), () =>
								change({ blocked: true, blockedReason: reason.value }, t('customersAdmin.blockedDone')),
							),
						]),
				customer.rtoCount > 0
					? kit.button(t('customersAdmin.resetRto'), () => change({ resetRto: true }, t('customersAdmin.rtoReset')))
					: null,
			]),
			kit.group(t('customersAdmin.staffNote'), [
				kit.field(t('customersAdmin.noteLabel'), staffNote),
				kit.button(t('admin.save'), () => change({ note: staffNote.value }, t('admin.saved'))),
			]),
			note,
			kit.group(t('customersAdmin.recentOrders'), [
				(customer.recentOrders ?? []).length === 0
					? kit.text('p', { class: 'muted' }, t('customersAdmin.noOrders'))
					: kit.table(
							[t('customersAdmin.orderNumber'), t('admin.status'), t('customersAdmin.total'), t('customersAdmin.placed')],
							customer.recentOrders.map((/** @type {any} */ order) => [
								order.number,
								order.statusLabel,
								order.totalText,
								kit.when(order.placedAt),
							]),
						),
			]),
		]);
		kit.say(note, message);
	};

	void kit.call('GET', path).then((answer) => {
		if (answer.ok) render(answer.data);
		else {
			kit.fail(line, answer);
			box.append(kit.button(t('admin.back'), () => done(false)));
		}
	});
	return box;
};

/** Review statuses. */
const REVIEW_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);

/**
 * The reviews section: reviews by status, newest first, with approve, reject, reply and delete.
 * @param {Kit} kit @param {HTMLElement} panel
 */
const reviewsTab = (kit, panel) => {
	const { t, h } = kit;
	const line = kit.status();
	const status = kit.select(
		[
			...REVIEW_STATUSES.map((key) => ({ value: key, label: t(`customersAdmin.review.${key}`) })),
			{ value: '', label: t('admin.all') },
		],
		'pending',
	);
	/** @param {any} review */
	const rowOf = (review) => {
		const item = h('li');
		/** @param {any} current */
		const draw = (current) => {
			const note = kit.status();
			const reply = kit.area(current.reply ?? '', { maxlength: '2000' });
			/** @param {string} method @param {string} suffix @param {unknown} [body] */
			const act = async (method, suffix, body) => {
				const answer = await kit.call(method, `/v1/admin/reviews/${current.id}${suffix}`, body);
				if (!answer.ok) {
					kit.fail(note, answer);
					return answer;
				}
				if (method === 'DELETE') item.remove();
				else {
					draw(answer.data);
					kit.say(/** @type {HTMLElement} */ (item.querySelector('[role="status"]')), t('admin.saved'));
				}
				return answer;
			};
			kit.put(item, [
				h('div', { class: 'what' }, [
					h('strong', {}, [`${'★'.repeat(current.rating)}${'☆'.repeat(Math.max(0, 5 - current.rating))} ${current.title}`]),
					kit.text(
						'span',
						{ class: 'meta' },
						[
							t(`customersAdmin.review.${current.status}`),
							current.name,
							current.productId,
							kit.when(current.createdAt),
						].join(' · '),
					),
					kit.text('p', {}, current.body),
					kit.field(t('customersAdmin.reply'), reply),
					h('div', { class: 'actions' }, [
						current.status === 'approved'
							? null
							: kit.button(t('customersAdmin.approve'), () => act('POST', '/approve'), { primary: true }),
						current.status === 'rejected' ? null : kit.button(t('customersAdmin.reject'), () => act('POST', '/reject')),
						kit.button(t('customersAdmin.saveReply'), () => act('POST', '/reply', { reply: reply.value })),
						kit.confirmButton(t('admin.delete'), t('admin.confirmDelete'), () => act('DELETE', '')),
					]),
					note,
				]),
			]);
		};
		draw(review);
		return item;
	};
	const pages = kit.pager({
		path: (cursor) => `/v1/admin/reviews${query({ status: status.value, cursor })}`,
		row: rowOf,
		line,
		empty: t('customersAdmin.noReviews'),
	});
	status.addEventListener('change', () => void pages.load(true));
	panel.append(h('div', { class: 'row inline' }, [kit.field(t('admin.status'), status)]), line, pages.node);
	void pages.load(true);
};
