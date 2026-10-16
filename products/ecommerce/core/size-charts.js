/**
 * Measurement tables (PLAN 0.8.10 E5, dynamic model §6; stored as size charts): a named table of sizes with columns,
 * rows of values, advice and notes. Its values are in any unit of `core/units.js`, an own label (`EU`, `years`) or none
 * (no default), and each column may name its own; `convertTo` lets shoppers see the columns of one dimension in another
 * unit of it (exact factors, never between dimensions). A product shows the table named on it, else its brand's, else
 * its first category's (or the nearest ancestor's), unless it hides the size guide. No I/O.
 * @module
 */
import { isObject } from '@ss/contracts/util';
import { cleanText } from './catalog.js';
import { sameDimension, unitOf } from './units.js';

/** @typedef {import('./model.js').SizeChartRecord} SizeChartRecord */
/** @typedef {import('./catalog.js').FieldError} FieldError */

/** Limits of a chart. */
const CHART_LIMITS = Object.freeze({ name: 120, columns: 12, rows: 40, label: 60, value: 60, text: 2000, unit: 20 });

/** Column keys: lowercase letters, digits, `_` and `-` (keys made from labels with dashes, CA-16). */
const COLUMN_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * The editable fields of a chart.
 * @typedef {Omit<SizeChartRecord, 'id'>} SizeChartFields
 */

/**
 * Check a new chart or changes to one.
 * @param {unknown} body
 * @param {SizeChartRecord | null} existing
 * @returns {{ ok: true, value: SizeChartFields } | { ok: false, errors: FieldError[] }}
 */
export const checkSizeChart = (body, existing) => {
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'Send the size chart as an object.' }] };
	/** @type {FieldError[]} */
	const errors = [];
	/** @param {string} path @param {string} message */
	const fail = (path, message) => errors.push({ path, message });

	const name = body.name === undefined ? (existing?.name ?? '') : cleanText(body.name, CHART_LIMITS.name);
	if (!name) fail('/name', `Give a name of 1 to ${CHART_LIMITS.name} characters.`);
	/**
	 * A unit: a known one, an own label or '' (none).
	 * @param {unknown} value @param {string} path @param {string} kept
	 */
	const unitText = (value, path, kept) => {
		if (value === undefined) return kept;
		const text = value === null ? '' : cleanText(value, CHART_LIMITS.unit);
		if (text === null) fail(path, `A unit is a unit such as cm or kg, or a label of at most ${CHART_LIMITS.unit} characters.`);
		return text ?? kept;
	};
	const unit = unitText(body.unit, '/unit', existing?.unit ?? '');

	/** @type {SizeChartRecord['columns']} */
	let columns = existing?.columns ?? [];
	if (body.columns !== undefined) {
		if (!Array.isArray(body.columns) || body.columns.length === 0 || body.columns.length > CHART_LIMITS.columns)
			fail('/columns', `Give 1 to ${CHART_LIMITS.columns} columns.`);
		else {
			columns = [];
			body.columns.forEach((column, index) => {
				const key = isObject(column) && typeof column.key === 'string' ? column.key.trim() : '';
				const label = isObject(column) ? cleanText(column.label, CHART_LIMITS.label) : null;
				const own = unitText(isObject(column) ? column.unit : undefined, `/columns/${index}/unit`, '');
				if (!COLUMN_KEY.test(key) || columns.some((other) => other.key === key))
					fail(`/columns/${index}/key`, 'Each column has its own key (lowercase letters, digits, _ and -).');
				else if (!label) fail(`/columns/${index}/label`, `A column label has 1 to ${CHART_LIMITS.label} characters.`);
				else columns.push({ key, label, unit: own });
			});
		}
	}
	if (!existing && body.columns === undefined) fail('/columns', 'Give the chart its columns.');

	/** @type {SizeChartRecord['rows']} */
	let rows = existing?.rows ?? [];
	if (body.rows !== undefined) {
		if (!Array.isArray(body.rows) || body.rows.length > CHART_LIMITS.rows)
			fail('/rows', `Give at most ${CHART_LIMITS.rows} rows.`);
		else {
			rows = [];
			body.rows.forEach((row, index) => {
				const size = isObject(row) ? cleanText(row.size, CHART_LIMITS.label) : null;
				if (!size || rows.some((other) => other.size === size))
					return void fail(`/rows/${index}/size`, 'Each row has its own size (1 to 60 characters).');
				const label = row.label === undefined ? size : cleanText(row.label, CHART_LIMITS.label);
				/** @type {Record<string, string>} */
				const values = {};
				for (const [key, value] of Object.entries(isObject(row.values) ? row.values : {})) {
					const text = cleanText(typeof value === 'number' ? String(value) : value, CHART_LIMITS.value);
					if (!columns.some((column) => column.key === key) || text === null)
						fail(`/rows/${index}/values/${key}`, 'Give values of the chart columns, up to 60 characters each.');
					else if (text) values[key] = text;
				}
				if (row.values !== undefined && !isObject(row.values))
					fail(`/rows/${index}/values`, 'Give the values by column key.');
				rows.push({ size, label: label || size, values });
			});
		}
	}
	// shoppers switch to another unit only of a dimension the table's values are in (exact, never between dimensions)
	const convertTo = unitText(body.convertTo, '/convertTo', existing?.convertTo ?? '');
	if (
		convertTo &&
		!columns.some((column) => {
			const from = column.unit || unit;
			return from !== convertTo && sameDimension(from, convertTo);
		})
	)
		fail(
			'/convertTo',
			unitOf(convertTo)
				? 'Switch only to another unit of the length, weight or volume the table is in.'
				: 'Switch to a unit such as cm, in, kg or lb.',
		);
	/** @param {'advice' | 'notes'} field */
	const longText = (field) => {
		if (body[field] === undefined) return existing?.[field] ?? '';
		const text = cleanText(body[field], CHART_LIMITS.text, { multiline: true });
		if (text === null) fail(`/${field}`, `This text has at most ${CHART_LIMITS.text} characters.`);
		return text ?? existing?.[field] ?? '';
	};
	const advice = longText('advice');
	const notes = longText('notes');
	const active = body.active === undefined ? (existing?.active ?? true) : body.active;
	if (typeof active !== 'boolean') fail('/active', 'Active is true or false.');
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			name: /** @type {string} */ (name),
			unit,
			convertTo,
			columns,
			rows,
			advice,
			notes,
			active: active !== false,
		},
	};
};

/**
 * The chart a product shows: its own, else its brand's, else its first category's (or the nearest ancestor's that has
 * one), else the website's default chart (the `size_charts` setting `defaultChartId`, SF-3); null when it hides the
 * size guide or none is found or active.
 * @param {{ sizeChartId?: string | null, hideSizeGuide?: boolean, categoryIds: string[] }} product
 * @param {{ sizeChartId?: string | null } | null} brand
 * @param {ReadonlyMap<string, { path: string[], sizeChartId?: string | null }>} categories by id
 * @param {ReadonlyMap<string, SizeChartRecord>} charts active charts by id
 * @param {string | null} [defaultId] the default chart's id
 * @returns {SizeChartRecord | null}
 */
export const resolveSizeChart = (product, brand, categories, charts, defaultId = null) => {
	if (product.hideSizeGuide) return null;
	/** @param {string | null | undefined} id */
	const found = (id) => (id ? (charts.get(id) ?? null) : null);
	const own = found(product.sizeChartId) ?? found(brand?.sizeChartId);
	if (own) return own;
	const first = categories.get(product.categoryIds[0] ?? '');
	const trail = first ? [product.categoryIds[0] ?? '', ...[...first.path].reverse()] : [];
	for (const id of trail) {
		const chart = found(categories.get(id)?.sizeChartId);
		if (chart) return chart;
	}
	return found(defaultId);
};

/**
 * A table as shoppers see it (everything but `active` is public).
 * @param {SizeChartRecord} chart
 */
export const chartView = (chart) => ({
	id: chart.id,
	name: chart.name,
	unit: chart.unit,
	convertTo: chart.convertTo,
	columns: chart.columns,
	rows: chart.rows,
	advice: chart.advice,
	notes: chart.notes,
});
