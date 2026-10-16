/**
 * Reports and CSV in the customers admin widget (PLAN 0.8.8 Admin tools, 0.6: plain pages of cards and tables): reports
 * (feature `reports`, `reports.read`) — the shop health card (E41: each check with its count and state, read when the
 * section opens and again on request), then the sales summary (its totals and the orders per day, week or month), sales
 * by any grouping the server lists (E12: product, category, brand, tags, place, zone, courier, payment method, period
 * or any field), sell-through, stock age, oldest stock (now), return rate and margin over a date range, with
 * their totals as figures and their rows as a table, downloadable as CSV; and CSV (feature `csv`, `csv.run`) as cards —
 * export products, import products (a dry run lists every problem per row, in the website's words, before anything is
 * written), export orders by date range and status, export customers.
 * @module
 */
import { toCsv } from '@ss/app-kit/widget';
import { dayEnd, dayStart, query } from './admin-kit.js';
import { card } from './admin-lists.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {{ label: string, value: (row: any) => string | number | null, money?: boolean }} Column */

/** The reports: their address and whether they cover a date range (else they are now). */
const REPORTS = Object.freeze({
	summary: { path: '/v1/admin/reports/summary', range: true },
	sales: { path: '/v1/admin/reports/sales', range: true },
	sell_through: { path: '/v1/admin/reports/sell-through', range: true },
	stock_age: { path: '/v1/admin/reports/stock-age', range: false },
	oldest_stock: { path: '/v1/admin/reports/oldest-stock', range: false },
	return_rate: { path: '/v1/admin/reports/returns', range: true },
	margin: { path: '/v1/admin/reports/margin', range: true },
});
/** The summary's series (E12). */
const SERIES = Object.freeze(['day', 'week', 'month']);

/** @typedef {keyof typeof REPORTS} ReportKey */

/**
 * A problem of a row of a CSV file in the website's words (PLAN 0.4.10): its code's text
 * (`customersAdmin.csvProblem.<code>` with its values); a product check's refusal (`invalid`) by the field it names.
 * @param {Kit} kit @param {{ path: string, code?: string, values?: Record<string, string> }} problem
 */
const rowProblem = (kit, problem) =>
	problem.code && problem.code !== 'invalid'
		? kit.t(`customersAdmin.csvProblem.${problem.code}`, problem.values ?? {})
		: kit.refusal('validation_failed', [{ path: problem.path }]);

/**
 * The columns of a report (sales: the grouping's name heads its first column).
 * @param {Kit} kit @param {ReportKey} key @param {string} grouping
 * @returns {Column[]}
 */
const columnsOf = (kit, key, grouping) => {
	const { t } = kit;
	/** @param {number | null} rate */
	const percent = (rate) => (rate === null ? '' : `${Math.round(rate * 1000) / 10} %`);
	if (key === 'summary')
		return [
			{ label: t('customersAdmin.periodColumn'), value: (row) => row.period },
			{ label: t('customersAdmin.orders'), value: (row) => row.orders },
			{ label: t('customersAdmin.revenue'), value: (row) => row.total, money: true },
		];
	if (key === 'sell_through')
		return [
			{ label: t('customersAdmin.product'), value: (row) => row.name },
			{ label: t('customersAdmin.sold'), value: (row) => row.sold },
			{ label: t('customersAdmin.stock'), value: (row) => row.stock },
			{ label: t('customersAdmin.sellThrough'), value: (row) => percent(row.rate) },
		];
	if (key === 'oldest_stock')
		return [
			{ label: t('customersAdmin.product'), value: (row) => row.name },
			{ label: t('customersAdmin.variant'), value: (row) => row.variantName },
			{ label: t('customersAdmin.sku'), value: (row) => row.sku },
			{ label: t('customersAdmin.stock'), value: (row) => row.stock },
			{ label: t('customersAdmin.waitingSince'), value: (row) => row.since.slice(0, 10) },
			{ label: t('customersAdmin.daysWaiting'), value: (row) => row.days },
		];
	if (key === 'stock_age')
		return [
			{ label: t('customersAdmin.product'), value: (row) => row.name },
			{ label: t('customersAdmin.stock'), value: (row) => row.stock },
			{ label: t('customersAdmin.listedOn'), value: (row) => row.publishedAt.slice(0, 10) },
			{ label: t('customersAdmin.lastSold'), value: (row) => (row.lastSoldAt ? row.lastSoldAt.slice(0, 10) : '') },
			{ label: t('customersAdmin.daysListed'), value: (row) => row.daysListed },
			{ label: t('customersAdmin.daysSinceSale'), value: (row) => row.daysSinceSale },
		];
	if (key === 'return_rate')
		return [
			{ label: t('customersAdmin.product'), value: (row) => row.name },
			{ label: t('customersAdmin.sold'), value: (row) => row.sold },
			{ label: t('customersAdmin.claimed'), value: (row) => row.claimed },
			{ label: t('customersAdmin.returnRate'), value: (row) => percent(row.rate) },
		];
	if (key === 'margin')
		return [
			{ label: t('customersAdmin.product'), value: (row) => row.name },
			{ label: t('customersAdmin.units'), value: (row) => row.units },
			{ label: t('customersAdmin.revenue'), value: (row) => row.revenue, money: true },
			{ label: t('customersAdmin.cost'), value: (row) => row.cost, money: true },
			{ label: t('customersAdmin.margin'), value: (row) => row.margin, money: true },
		];
	return [
		{ label: grouping, value: (row) => row.name || row.key || t('customersAdmin.none') },
		{ label: t('customersAdmin.units'), value: (row) => row.units },
		{ label: t('customersAdmin.revenue'), value: (row) => row.revenue, money: true },
		{ label: t('customersAdmin.discount'), value: (row) => row.discount, money: true },
	];
};

/** The tone of a shop health check's state (E41). */
const HEALTH_TONES = Object.freeze(/** @type {const} */ ({ ok: 'success', attention: 'warning', skipped: 'neutral' }));

/**
 * The shop health card (E41): every check with its count and state, read now and on Check again.
 * @param {Kit} kit
 */
const healthCard = (kit) => {
	const { t, h } = kit;
	const line = kit.status();
	const result = h('div');
	const read = async () => {
		const answer = await kit.call('GET', '/v1/admin/reports/health');
		if (!answer.ok) {
			result.replaceChildren();
			kit.fail(line, answer);
			return answer;
		}
		/** @type {Array<{ key: string, status: 'ok' | 'attention' | 'skipped', count: number }>} */
		const checks = answer.data.checks ?? [];
		kit.say(line, answer.data.attention === 0 ? t('customersAdmin.healthClear') : '');
		kit.put(result, [
			kit.table(
				[t('customersAdmin.healthCheck'), t('customersAdmin.healthCount'), t('customersAdmin.healthState')],
				checks.map((check) => [
					t(`customersAdmin.health.${check.key}`),
					check.status === 'skipped' ? '' : String(check.count),
					kit.badge(t(`customersAdmin.healthStatus.${check.status}`), HEALTH_TONES[check.status] ?? 'neutral'),
				]),
			),
		]);
		return answer;
	};
	void read();
	return card(kit, t('customersAdmin.healthTitle'), [line, result, kit.button(t('customersAdmin.healthAgain'), read)]);
};

/**
 * The reports section.
 * @param {Kit} kit @param {HTMLElement} panel
 */
export const reportsTab = (kit, panel) => {
	const { t, h } = kit;
	const line = kit.status();
	const result = h('div');
	const report = kit.select(
		/** @type {ReportKey[]} */ (Object.keys(REPORTS)).map((key) => ({ value: key, label: t(`customersAdmin.report.${key}`) })),
	);
	const from = kit.input('', { type: 'date' });
	const to = kit.input('', { type: 'date' });
	const dates = h('div', { class: 'row' }, [kit.field(t('admin.from'), from), kit.field(t('admin.to'), to)]);
	// what sales group by, read from the server (E12): the built-in groupings in the widget's words, fields by name
	const grouping = kit.select([{ value: 'product', label: t('customersAdmin.by.product') }], 'product');
	void kit.call('GET', '/v1/admin/reports/groupings').then((answer) => {
		if (!answer.ok) return;
		/** @type {Array<{ key: string, label: string, kind: string }>} */
		const items = answer.data.items ?? [];
		grouping.replaceChildren(
			...items.map((item) =>
				kit.h('option', { value: item.key }, [
					item.kind === 'built_in' && kit.t(`customersAdmin.by.${item.key}`) !== `customersAdmin.by.${item.key}`
						? kit.t(`customersAdmin.by.${item.key}`)
						: item.label,
				]),
			),
		);
		grouping.value = 'product';
	});
	const series = kit.select(SERIES.map((key) => ({ value: key, label: t(`customersAdmin.series.${key}`) })));
	const groupingField = kit.field(t('customersAdmin.groupBy'), grouping);
	const seriesField = kit.field(t('customersAdmin.seriesLabel'), series);
	const sync = () => {
		const key = /** @type {ReportKey} */ (report.value);
		dates.hidden = !REPORTS[key].range;
		groupingField.hidden = key !== 'sales';
		seriesField.hidden = key !== 'summary';
	};
	report.addEventListener('change', sync);
	sync();
	/** @type {{ key: string, header: string[], rows: Array<Array<string | number>> } | null} */
	let last = null;
	const download = kit.button(t('customersAdmin.downloadCsv'), () => {
		if (last) kit.save(`report-${last.key}.csv`, toCsv(last.header, last.rows));
	});
	download.hidden = true;
	const run = kit.button(
		t('customersAdmin.run'),
		async () => {
			const key = /** @type {ReportKey} */ (report.value);
			const { path, range } = REPORTS[key];
			const answer = await kit.call(
				'GET',
				`${path}${query({
					...(key === 'sales' ? { by: grouping.value } : {}),
					...(key === 'summary' && series.value !== 'day' ? { series: series.value } : {}),
					...(range ? { from: from.value, to: to.value } : {}),
				})}`,
			);
			result.replaceChildren();
			download.hidden = true;
			if (!answer.ok) {
				kit.fail(line, answer);
				return answer;
			}
			const columns = columnsOf(kit, key, grouping.selectedOptions[0]?.textContent ?? '');
			// the summary's rows are its periods, its totals the answer itself
			/** @type {any[]} */
			const rows = (key === 'summary' ? answer.data.periods : answer.data.rows) ?? [];
			const totals = key === 'summary' ? answer.data : answer.data.totals;
			kit.say(line, rows.length === 0 ? t('customersAdmin.noRows') : '');
			kit.put(result, [
				answer.data.from
					? kit.text(
							'p',
							{ class: 'muted' },
							t('customersAdmin.period', { from: kit.when(answer.data.from), to: kit.when(answer.data.to) }),
						)
					: null,
				totals
					? kit.fieldGrid(
							key === 'summary'
								? [
										[t('customersAdmin.orders'), String(totals.orders)],
										[t('customersAdmin.units'), String(totals.units)],
										[t('customersAdmin.revenue'), kit.money(totals.total)],
										[t('customersAdmin.goods'), kit.money(totals.goods)],
										[t('customersAdmin.deliveryFees'), kit.money(totals.delivery)],
										[t('customersAdmin.fees'), kit.money(totals.fees)],
										[t('customersAdmin.discount'), kit.money(totals.discount)],
										[t('customersAdmin.refunded'), kit.money(totals.refunded)],
									]
								: key === 'margin'
									? [
											[t('customersAdmin.revenue'), kit.money(totals.revenue)],
											[t('customersAdmin.cost'), kit.money(totals.cost)],
											[t('customersAdmin.margin'), kit.money(totals.margin)],
										]
									: [
											[t('customersAdmin.orders'), String(totals.orders)],
											[t('customersAdmin.units'), String(totals.units)],
											[t('customersAdmin.revenue'), kit.money(totals.revenue)],
											[t('customersAdmin.discount'), kit.money(totals.discount)],
										],
						)
					: null,
				kit.table(
					columns.map((column) => column.label),
					rows.map((row) =>
						columns.map((column) => {
							const value = column.value(row);
							return column.money && typeof value === 'number' ? kit.money(value) : String(value ?? '');
						}),
					),
				),
			]);
			last = {
				key,
				header: columns.map((column) => column.label),
				rows: rows.map((row) =>
					columns.map((column) => {
						const value = column.value(row);
						return column.money && typeof value === 'number' ? kit.decimal(value) : (value ?? '');
					}),
				),
			};
			download.hidden = rows.length === 0;
			return answer;
		},
		{ primary: true },
	);
	panel.append(
		healthCard(kit),
		h('div', { class: 'row inline' }, [
			kit.field(t('customersAdmin.reportLabel'), report),
			groupingField,
			seriesField,
			dates,
			run,
			download,
		]),
		line,
		result,
	);
};

/**
 * The CSV section, as cards: export products, export orders by date range and status, export customers, import
 * products (dry run first).
 * @param {Kit} kit @param {HTMLElement} panel
 */
export const csvTab = (kit, panel) => {
	const { t, h } = kit;
	const line = kit.status();
	/** @param {string} path @param {string} name */
	const exporter = (path, name) => async () => {
		kit.say(line, t('customersAdmin.preparing'));
		const answer = await kit.fetchText(path);
		if (!answer.ok) {
			kit.fail(line, answer);
			return answer;
		}
		kit.save(name, answer.text);
		kit.say(line, t('customersAdmin.downloaded', { name }));
		return answer;
	};

	// import: read the file, check it (dry run), then import
	const note = kit.status();
	const problems = h('div');
	const file = kit.input('', { type: 'file', accept: '.csv,text/csv' });
	let text = '';
	const importButton = kit.button(
		t('customersAdmin.importNow'),
		async () => {
			const answer = await kit.call('POST', '/v1/admin/csv/products', { csv: text, dryRun: false });
			if (!answer.ok) {
				kit.fail(note, answer);
				return answer;
			}
			importButton.hidden = true;
			kit.say(note, t('customersAdmin.imported', { created: answer.data.created, updated: answer.data.updated }));
			return answer;
		},
		{ primary: true },
	);
	importButton.hidden = true;
	const check = kit.button(t('customersAdmin.checkFile'), async () => {
		problems.replaceChildren();
		importButton.hidden = true;
		const picked = file.files?.[0];
		if (!picked) return kit.say(note, t('customersAdmin.pickFile'), true);
		text = await picked.text();
		const answer = await kit.call('POST', '/v1/admin/csv/products', { csv: text, dryRun: true });
		if (!answer.ok) {
			kit.fail(note, answer);
			return answer;
		}
		/** @type {Array<{ line: number, path: string, code?: string, values?: Record<string, string> }>} */
		const errors = answer.data.errors ?? [];
		kit.say(
			note,
			t(errors.length > 0 ? 'customersAdmin.checkFailed' : 'customersAdmin.checkPassed', {
				rows: answer.data.rows,
				created: answer.data.created,
				updated: answer.data.updated,
				problems: errors.length,
			}),
			errors.length > 0,
		);
		if (errors.length > 0)
			problems.append(
				kit.table(
					[t('customersAdmin.line'), t('customersAdmin.field'), t('customersAdmin.problem')],
					errors.map((error) => [String(error.line), error.path, rowProblem(kit, error)]),
				),
			);
		importButton.hidden = errors.length > 0;
		return answer;
	});
	file.addEventListener('change', () => {
		problems.replaceChildren();
		importButton.hidden = true;
		kit.say(note, '');
	});

	const from = kit.input('', { type: 'date' });
	const to = kit.input('', { type: 'date' });
	/** @type {Array<{ key: string, label: string }>} */
	const flow = Array.isArray(kit.settings.orders?.statuses) ? kit.settings.orders.statuses : [];
	const status = kit.select([
		{ value: '', label: t('admin.all') },
		...flow.map((item) => ({ value: item.key, label: item.label })),
	]);
	panel.append(
		line,
		kit.masonry([
			card(kit, t('customersAdmin.products'), [
				kit.text('p', { class: 'muted' }, t('customersAdmin.exportHint')),
				kit.button(t('customersAdmin.exportProducts'), exporter('/v1/admin/csv/products', 'products.csv')),
			]),
			card(kit, t('customersAdmin.orders'), [
				h('div', { class: 'fields' }, [
					kit.field(t('admin.from'), from),
					kit.field(t('admin.to'), to),
					flow.length > 0 ? kit.field(t('admin.status'), status) : null,
				]),
				kit.button(t('customersAdmin.exportOrders'), () =>
					exporter(
						`/v1/admin/csv/orders${query({
							from: dayStart(from.value, kit.timeZone),
							to: dayEnd(to.value, kit.timeZone),
							status: status.value,
						})}`,
						'orders.csv',
					)(),
				),
			]),
			// customers come with orders (Cart and checkout)
			kit.has('checkout')
				? card(kit, t('customersAdmin.customers'), [
						kit.text('p', { class: 'muted' }, t('customersAdmin.exportCustomersHint')),
						kit.button(t('customersAdmin.exportCustomers'), exporter('/v1/admin/csv/customers', 'customers.csv')),
					])
				: null,
			card(kit, t('customersAdmin.importProducts'), [
				kit.text('p', { class: 'muted' }, t('customersAdmin.importHint')),
				kit.field(t('customersAdmin.csvFile'), file),
				h('div', { class: 'actions' }, [check, importButton]),
				note,
				problems,
			]),
		]),
	);
};
