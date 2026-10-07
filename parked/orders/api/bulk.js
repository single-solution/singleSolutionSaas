/**
 * Bulk service: status changes for many orders (each validated and claimed like a single change; one failure never
 * stops the rest), CSV export with the merchant's columns and CSV import of status and tracking updates with a dry
 * run. Results are reported per order.
 */
import { exportCell, importRows } from '../core/bulk.js';
import { parseCsv, recordsOf, toCsv } from '../core/csv.js';
import { applyFulfilment } from '../core/fulfilment.js';
import { checkMove, isRevenue } from '../core/lifecycle.js';
import { missingSerials } from '../core/serials.js';
import { idList } from '../core/text.js';
import { fail, invalid } from './context.js';

/** Longest CSV accepted (characters). */
export const MAX_CSV_CHARS = 3_500_000;

/**
 * @param {import('./lifecycle.js').Lifecycle} lifecycle
 */
export const createBulk = (lifecycle) => {
	/**
	 * Move many orders to one status.
	 * @param {import('./context.js').Site} site
	 * @param {unknown} body `{ ids, status, reason?, note? }`
	 * @param {import('./context.js').Actor} actor
	 */
	const batch = async (site, body, actor) => {
		const input = /** @type {any} */ (body ?? {});
		const ids = idList(input.ids, site.settings.bulk.max_orders);
		if (!ids) return invalid([{ path: '/ids', code: 'ids_invalid' }]);
		if (typeof input.status !== 'string') return invalid([{ path: '/status', code: 'required' }]);
		/** @type {Array<{ id: string, number: string | null, outcome: 'updated' | 'skipped' | 'failed', code?: string, status?: string }>} */
		const results = [];
		for (const id of ids) {
			const order = await site.repos.orders.get(id);
			if (!order) {
				results.push({ id, number: null, outcome: 'failed', code: 'not_found' });
				continue;
			}
			const moved = await lifecycle.move(site, order, input.status, { actor, reason: input.reason, note: input.note });
			if (moved.ok) results.push({ id, number: order.number, outcome: 'updated', status: moved.order.status });
			else
				results.push({
					id,
					number: order.number,
					outcome: moved.reason === 'status_unchanged' ? 'skipped' : 'failed',
					code: /** @type {any} */ (moved).reason,
					status: order.status,
				});
		}
		return {
			ok: true,
			report: {
				status: input.status,
				updated: results.filter((r) => r.outcome === 'updated').length,
				skipped: results.filter((r) => r.outcome === 'skipped').length,
				failed: results.filter((r) => r.outcome === 'failed').length,
				results,
			},
		};
	};

	/**
	 * Import status and tracking updates from CSV (`dryRun` checks everything and changes nothing).
	 * @param {import('./context.js').Site} site
	 * @param {unknown} body `{ csv, dryRun? }`
	 * @param {import('./context.js').Actor} actor
	 */
	const importCsv = async (site, body, actor) => {
		const input = /** @type {any} */ (body ?? {});
		if (typeof input.csv !== 'string' || input.csv.length === 0 || input.csv.length > MAX_CSV_CHARS)
			return invalid([{ path: '/csv', code: 'csv_required' }]);
		const parsed = parseCsv(input.csv, {
			delimiter: site.settings.bulk.csv_delimiter,
			maxRows: site.settings.bulk.max_import_rows,
		});
		if (!parsed.ok) return fail('csv_invalid', parsed.code);
		const { rows, problems } = importRows(recordsOf(parsed.rows).records);
		const dryRun = input.dryRun === true;
		/** @type {Array<{ line: number, outcome: 'updated' | 'valid' | 'failed', code?: string, number?: string }>} */
		const results = problems.map((p) => ({ line: p.line, outcome: /** @type {const} */ ('failed'), code: p.code }));
		const { settings } = site;
		for (const row of rows) {
			const order =
				'id' in row.ref ? await site.repos.orders.get(row.ref.id) : await site.repos.orders.byNumber(row.ref.number);
			if (!order) {
				results.push({ line: row.line, outcome: 'failed', code: 'not_found' });
				continue;
			}
			const hasFulfilment = Object.keys(row.fulfilment).length > 0;
			const preview = hasFulfilment
				? applyFulfilment(order.fulfilment, row.fulfilment, {
						carriers: settings.carriers,
						allowOther: settings.fulfilment.allow_other_carrier,
						dispatchVideo: settings.fulfilment.dispatch_video,
						maxNote: settings.fulfilment.max_note_length,
					})
				: null;
			if (preview && !preview.ok) {
				results.push({ line: row.line, outcome: 'failed', code: preview.errors[0]?.code ?? 'invalid', number: order.number });
				continue;
			}
			const projected = preview?.ok ? { ...order, fulfilment: preview.value } : order;
			if (row.status && row.status !== order.status) {
				const check = checkMove(settings.matrix, projected, row.status, actor.type, {
					missingSerials: settings.enabled('serials') ? missingSerials(order.lines, settings.serials) : [],
					hasTracking: Boolean(projected.fulfilment?.trackingNumber),
					hasDispatchVideo: Boolean(projected.fulfilment?.dispatchVideoUrl),
					money: { total: order.amounts.total, paid: order.paid ?? 0, refunded: order.refunded ?? 0 },
					reason: row.reason,
				});
				if (!check.ok) {
					results.push({ line: row.line, outcome: 'failed', code: check.code, number: order.number });
					continue;
				}
			}
			if (dryRun) {
				results.push({ line: row.line, outcome: 'valid', number: order.number });
				continue;
			}
			if (hasFulfilment) {
				const updated = await lifecycle.fulfil(site, order.id, row.fulfilment, actor);
				if (!updated.ok) {
					results.push({
						line: row.line,
						outcome: 'failed',
						code: /** @type {any} */ (updated).reason,
						number: order.number,
					});
					continue;
				}
			}
			if (row.status && row.status !== order.status) {
				const moved = await lifecycle.move(site, order.id, row.status, { actor, reason: row.reason });
				if (!moved.ok) {
					results.push({ line: row.line, outcome: 'failed', code: moved.reason, number: order.number });
					continue;
				}
			}
			results.push({ line: row.line, outcome: 'updated', number: order.number });
		}
		results.sort((a, b) => a.line - b.line);
		return {
			ok: true,
			report: {
				dryRun,
				rows: results.length,
				updated: results.filter((r) => r.outcome === 'updated').length,
				valid: results.filter((r) => r.outcome === 'valid').length,
				failed: results.filter((r) => r.outcome === 'failed').length,
				results,
			},
		};
	};

	/**
	 * Export orders as CSV (`status`, `from`, `to` filters; newest first; capped by `max_export_rows`).
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, string | undefined>} query
	 */
	const exportCsv = async (site, query) => {
		const filter = filterOf(query);
		if (!filter) return invalid([{ path: '/query', code: 'filter_invalid' }]);
		const { settings } = site;
		const columns = settings.bulk.export_columns;
		const max = settings.bulk.max_export_rows;
		/** @type {Array<Array<string | number | boolean | null>>} */
		const rows = [];
		/** @type {unknown} */
		let after = null;
		while (rows.length < max) {
			const limit = Math.min(500, max - rows.length);
			const page = await site.repos.orders.page(filter, { after, limit });
			for (const order of page)
				rows.push(
					columns.map((/** @type {string} */ column) =>
						exportCell(order, column, { revenue: isRevenue(settings.matrix, order.status) }),
					),
				);
			if (page.length < limit) break;
			const last = page[page.length - 1];
			after = [new Date(last.placedAt).toISOString(), last.id];
		}
		return { ok: true, csv: toCsv(columns, rows, { delimiter: settings.bulk.csv_delimiter, bom: true }), count: rows.length };
	};

	return Object.freeze({ batch, importCsv, exportCsv });
};

/**
 * The order filter of list and export queries: `status` (one key), `from` / `to` (ISO placement dates), `source`,
 * `payment`, `delivery`, `review` (A39: more than status and customer).
 * @param {Record<string, string | undefined>} query
 * @returns {Record<string, unknown> | null}
 */
export const filterOf = (query) => {
	/** @type {Record<string, unknown>} */
	const filter = {};
	const key = /^[a-z][a-z0-9_]{0,39}$/;
	if (query.status !== undefined) {
		if (!key.test(query.status)) return null;
		filter.status = query.status;
	}
	for (const [param, field] of /** @type {const} */ ([
		['source', 'source'],
		['payment', 'payment.method'],
		['delivery', 'delivery.method'],
		['review', 'risk.review'],
	])) {
		const value = query[param];
		if (value === undefined) continue;
		if (!key.test(value)) return null;
		filter[field] = value;
	}
	/** @type {Record<string, Date>} */
	const range = {};
	for (const [param, op] of /** @type {const} */ ([
		['from', '$gte'],
		['to', '$lt'],
	])) {
		const value = query[param];
		if (value === undefined) continue;
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return null;
		range[op] = date;
	}
	if (Object.keys(range).length > 0) filter.placedAt = range;
	if (query.customerId !== undefined) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(query.customerId)) return null;
		filter.customerId = query.customerId;
	}
	return filter;
};
