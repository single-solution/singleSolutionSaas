/**
 * Size charts (PLAN 0.8.10 E5): a named table of sizes in inches or centimetres, with columns, rows of values, fit
 * advice and notes. A product shows the chart named on it, else its brand's, else its first category's (or the nearest
 * ancestor's), unless it hides the size guide. No I/O.
 * @module
 */
import { cleanText, isObject } from './catalog.js';

/** @typedef {import('./model.js').SizeChartRecord} SizeChartRecord */
/** @typedef {import('./catalog.js').FieldError} FieldError */

/** Limits of a chart. */
export const CHART_LIMITS = Object.freeze({ name: 120, columns: 12, rows: 40, label: 60, value: 60, text: 2000 });

/** Column keys. */
const COLUMN_KEY = /^[a-z][a-z0-9_]{0,39}$/;

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
	const unit = body.unit === undefined ? (existing?.unit ?? 'in') : body.unit;
	if (unit !== 'in' && unit !== 'cm') fail('/unit', 'The unit is in or cm.');

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
				if (!COLUMN_KEY.test(key) || columns.some((other) => other.key === key))
					fail(`/columns/${index}/key`, 'Each column has its own key (lowercase letters, digits and _).');
				else if (!label) fail(`/columns/${index}/label`, `A column label has 1 to ${CHART_LIMITS.label} characters.`);
				else columns.push({ key, label });
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
	/** @param {'fitAdvice' | 'notes'} field */
	const longText = (field) => {
		if (body[field] === undefined) return existing?.[field] ?? '';
		const text = cleanText(body[field], CHART_LIMITS.text, { multiline: true });
		if (text === null) fail(`/${field}`, `This text has at most ${CHART_LIMITS.text} characters.`);
		return text ?? existing?.[field] ?? '';
	};
	const fitAdvice = longText('fitAdvice');
	const notes = longText('notes');
	const active = body.active === undefined ? (existing?.active ?? true) : body.active;
	if (typeof active !== 'boolean') fail('/active', 'Active is true or false.');
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			name: /** @type {string} */ (name),
			unit: /** @type {'in' | 'cm'} */ (unit),
			columns,
			rows,
			fitAdvice,
			notes,
			active: active !== false,
		},
	};
};

/**
 * The chart a product shows: its own, else its brand's, else its first category's (or the nearest ancestor's that has
 * one); null when it hides the size guide or none is found or active.
 * @param {{ sizeChartId?: string | null, hideSizeGuide?: boolean, categoryIds: string[] }} product
 * @param {{ sizeChartId?: string | null } | null} brand
 * @param {ReadonlyMap<string, { path: string[], sizeChartId?: string | null }>} categories by id
 * @param {ReadonlyMap<string, SizeChartRecord>} charts active charts by id
 * @returns {SizeChartRecord | null}
 */
export const resolveSizeChart = (product, brand, categories, charts) => {
	if (product.hideSizeGuide) return null;
	/** @param {string | null | undefined} id */
	const found = (id) => (id ? (charts.get(id) ?? null) : null);
	const own = found(product.sizeChartId) ?? found(brand?.sizeChartId);
	if (own) return own;
	const first = categories.get(product.categoryIds[0] ?? '');
	if (!first) return null;
	const trail = [product.categoryIds[0] ?? '', ...[...first.path].reverse()];
	for (const id of trail) {
		const chart = found(categories.get(id)?.sizeChartId);
		if (chart) return chart;
	}
	return null;
};

/**
 * A chart as shoppers see it (without its notes for staff only: there are none; everything is public).
 * @param {SizeChartRecord} chart
 */
export const chartView = (chart) => ({
	id: chart.id,
	name: chart.name,
	unit: chart.unit,
	columns: chart.columns,
	rows: chart.rows,
	fitAdvice: chart.fitAdvice,
	notes: chart.notes,
});
