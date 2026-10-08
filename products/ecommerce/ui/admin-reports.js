/**
 * Reports and CSV in the customers admin widget (PLAN 0.8.8 Admin tools): reports (feature `reports`, `reports.read`)
 * — sales by product, category, brand or city, stock age, return rate and margin over a date range, shown as tables
 * and downloadable as CSV; and CSV (feature `csv`, `csv.run`) — export products, import products (a dry run lists
 * every problem per row before anything is written), export orders by date range.
 * @module
 */
import { toCsv } from '../core/csv.js';
import { dayEnd, dayStart, query } from './admin-kit.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {{ label: string, value: (row: any) => string | number | null, money?: boolean }} Column */

/** The reports: their address and, for sales, the grouping. */
const REPORTS = Object.freeze({
	sales_product: { path: '/v1/admin/reports/sales', by: 'product' },
	sales_category: { path: '/v1/admin/reports/sales', by: 'category' },
	sales_brand: { path: '/v1/admin/reports/sales', by: 'brand' },
	sales_city: { path: '/v1/admin/reports/sales', by: 'city' },
	stock_age: { path: '/v1/admin/reports/stock-age', by: '' },
	return_rate: { path: '/v1/admin/reports/returns', by: '' },
	margin: { path: '/v1/admin/reports/margin', by: '' },
});

/** @typedef {keyof typeof REPORTS} ReportKey */

/**
 * The columns of a report.
 * @param {Kit} kit @param {ReportKey} key
 * @returns {Column[]}
 */
const columnsOf = (kit, key) => {
	const { t } = kit;
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
			{
				label: t('customersAdmin.returnRate'),
				value: (row) => (row.rate === null ? '' : `${Math.round(row.rate * 1000) / 10} %`),
			},
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
		{ label: t(`customersAdmin.by.${REPORTS[key].by}`), value: (row) => row.name || row.key || t('customersAdmin.none') },
		{ label: t('customersAdmin.units'), value: (row) => row.units },
		{ label: t('customersAdmin.revenue'), value: (row) => row.revenue, money: true },
		{ label: t('customersAdmin.discount'), value: (row) => row.discount, money: true },
	];
};

/**
 * The reports tab.
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
	report.addEventListener('change', () => {
		dates.hidden = report.value === 'stock_age';
	});
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
			const { path, by } = REPORTS[key];
			const answer = await kit.call(
				'GET',
				`${path}${query({ by, ...(key === 'stock_age' ? {} : { from: from.value, to: to.value }) })}`,
			);
			result.replaceChildren();
			download.hidden = true;
			if (!answer.ok) {
				kit.fail(line, answer);
				return answer;
			}
			const columns = columnsOf(kit, key);
			/** @type {any[]} */
			const rows = answer.data.rows ?? [];
			const totals = answer.data.totals;
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
					? kit.text(
							'p',
							{ class: 'amount' },
							key === 'margin'
								? t('customersAdmin.marginTotals', {
										revenue: kit.money(totals.revenue),
										cost: kit.money(totals.cost),
										margin: kit.money(totals.margin),
									})
								: t('customersAdmin.salesTotals', {
										orders: totals.orders,
										units: totals.units,
										revenue: kit.money(totals.revenue),
									}),
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
		h('div', { class: 'row inline' }, [kit.field(t('customersAdmin.reportLabel'), report), dates, run, download]),
		line,
		result,
	);
};

/**
 * The CSV tab: export products, import products (dry run first), export orders by date range.
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
		/** @type {Array<{ line: number, path: string, message: string }>} */
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
					errors.map((error) => [String(error.line), error.path, error.message]),
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
	panel.append(
		kit.group(t('customersAdmin.products'), [
			kit.button(t('customersAdmin.exportProducts'), exporter('/v1/admin/csv/products', 'products.csv')),
		]),
		kit.group(t('customersAdmin.importProducts'), [
			kit.text('p', { class: 'muted' }, t('customersAdmin.importHint')),
			kit.field(t('customersAdmin.csvFile'), file),
			h('div', { class: 'actions' }, [check, importButton]),
			note,
			problems,
		]),
		kit.group(t('customersAdmin.orders'), [
			h('div', { class: 'row' }, [kit.field(t('admin.from'), from), kit.field(t('admin.to'), to)]),
			kit.button(t('customersAdmin.exportOrders'), () =>
				exporter(`/v1/admin/csv/orders${query({ from: dayStart(from.value), to: dayEnd(to.value) })}`, 'orders.csv')(),
			),
		]),
		line,
	);
};
