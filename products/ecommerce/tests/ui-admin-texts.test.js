/**
 * The widget texts named after a code (PLAN 0.4.10: every word a widget shows is a text the merchant can edit): each
 * value of the code's lists has its text, so a new status, kind or type without one fails here instead of showing its
 * text key; and a refusal picks the website's words for its field or code, never the server's English.
 */
import { describe, expect, it } from 'vitest';
import strings from '../strings/en.json' with { type: 'json' };
import { SORTS } from '../core/catalog-query.js';
import { CSV_PROBLEMS } from '../core/catalog-csv.js';
import { BRAND_STATUSES, CATEGORY_STATUSES } from '../core/catalog-taxonomy.js';
import { PAYMENT_METHODS as CHECKOUT_METHODS } from '../core/checkout.js';
import { DEAL_TYPES } from '../core/deals.js';
import { HEALTH_CHECKS } from '../core/health.js';
import { STATUS_ROLES } from '../core/model.js';
import {
	ADDRESS_FIELDS,
	HISTORY_NOTES,
	MOVE_WARNINGS,
	PAYMENT_METHODS,
	PAYMENT_STATES,
	RECORDED_METHODS,
} from '../core/orders.js';
import { POLICY_SETTINGS } from '../core/policies.js';
import { CLAIM_ACTIONS, CLAIM_KINDS, CLAIM_NOTES, CLAIM_STATUSES } from '../core/returns.js';
import { REVIEW_STATUSES } from '../core/reviews.js';
import { CLAIM_TONES, HISTORY_ACTORS, ROLE_TONES, SERVER_KIND } from '../ui/admin-order.js';
import { codeOf, problemKey } from '../ui/admin-problems.js';
import { GRID_SORTS } from '../ui/product-grid.js';

const TEXTS = /** @type {Record<string, string>} */ (strings);

/**
 * The text keys `<prefix><value>` of the values.
 * @param {string} prefix @param {Iterable<string>} values
 */
const keysOf = (prefix, values) => [...values].map((value) => `${prefix}${value}`);

describe('widget texts named after a code (PLAN 0.4.10)', () => {
	it('every value of the codes the widgets show has its text, so no text key ever shows', () => {
		// lists core keeps to itself, as the code names them
		const productKinds = ['physical', 'digital', 'service'];
		const productStatuses = ['draft', 'active', 'archived'];
		const serialStatuses = ['in_stock', 'sold', 'faulty'];
		const couponTypes = ['percent', 'fixed', 'free_delivery'];
		const bundleTypes = ['bundle', 'buy_x_get_y'];
		const pointKinds = ['earn', 'redeem', 'refund', 'expire', 'adjust', 'reverse'];
		const offerStates = ['live', 'off', 'ended', 'scheduled', 'usedUp'];
		// refund and restock have their own words (ordersAdmin.refund, ordersAdmin.restock)
		const claimMoves = Object.keys(CLAIM_ACTIONS).filter((action) => action !== 'refund' && action !== 'restock');
		const keys = [
			...keysOf('ordersAdmin.role.', STATUS_ROLES),
			...keysOf('ordersAdmin.method.', PAYMENT_METHODS),
			...keysOf('ordersAdmin.payment.', PAYMENT_STATES),
			...keysOf('ordersAdmin.paidWith.', RECORDED_METHODS),
			...keysOf('ordersAdmin.deliveryMethod.', ['delivery', 'pickup']),
			...keysOf('orders.payment.', PAYMENT_STATES),
			...keysOf('checkout.method.', [...PAYMENT_METHODS, ...CHECKOUT_METHODS]),
			...keysOf('ordersAdmin.claimKind.', CLAIM_KINDS),
			...keysOf('returns.kind.', CLAIM_KINDS),
			...keysOf('ordersAdmin.claim.', CLAIM_STATUSES),
			...keysOf('returns.status.', CLAIM_STATUSES),
			...keysOf('ordersAdmin.claimAction.', claimMoves),
			...keysOf('ordersAdmin.claimDone.', claimMoves),
			...keysOf('ordersAdmin.address.', Object.keys(ADDRESS_FIELDS)),
			...keysOf('checkout.field.', Object.keys(ADDRESS_FIELDS)),
			...keysOf('ordersAdmin.by.', [...HISTORY_ACTORS, SERVER_KIND]),
			// what the server writes itself, and `expired` of entries written before the codes
			...keysOf('ordersAdmin.historyNote.', [...HISTORY_NOTES, ...CLAIM_NOTES, 'expired']),
			...keysOf('ordersAdmin.warning.', MOVE_WARNINGS),
			// a product check's refusal (`invalid`) shows the text of the field it names
			...keysOf(
				'customersAdmin.csvProblem.',
				CSV_PROBLEMS.filter((code) => code !== 'invalid'),
			),
			...keysOf('promotionsAdmin.dealType.', DEAL_TYPES),
			...keysOf('promotionsAdmin.couponType.', couponTypes),
			...keysOf('promotionsAdmin.bundleType.', bundleTypes),
			...keysOf('promotionsAdmin.pointsKind.', pointKinds),
			...keysOf('orders.points.kind.', pointKinds),
			...keysOf('promotionsAdmin.state.', offerStates),
			...keysOf('customersAdmin.review.', REVIEW_STATUSES),
			...keysOf('customersAdmin.health.', HEALTH_CHECKS),
			...keysOf('customersAdmin.healthStatus.', ['ok', 'attention', 'skipped']),
			...keysOf('catalogAdmin.categoryStatus.', CATEGORY_STATUSES),
			...keysOf('catalogAdmin.brandStatus.', BRAND_STATUSES),
			...keysOf('catalogAdmin.kind.', productKinds),
			...keysOf('catalogAdmin.status.', productStatuses),
			...keysOf('catalogAdmin.serial.', serialStatuses),
			...keysOf('grid.sort.', [...Object.keys(SORTS), ...GRID_SORTS]),
			...keysOf('checkout.policy.', Object.keys(POLICY_SETTINGS)),
			// the codes the admin routes refuse with most (the rest show the general text)
			...keysOf('problem.', [
				'not_found',
				'conflict',
				'move_not_allowed',
				'validation_failed',
				'feature_off',
				'rate_limited',
				'count_timeout',
				'storage_not_connected',
				'ai_not_connected',
				'payments_unavailable',
				'nothing_paid',
				'slug_taken',
				'coupon_code_taken',
			]),
		];
		expect(keys.filter((key) => !Object.hasOwn(TEXTS, key))).toEqual([]);
		// the words of a server's code take only the values it gives
		/** @param {string} prefix @param {string[]} names */
		const strayValues = (prefix, names) =>
			Object.entries(TEXTS)
				.filter(([key]) => key.startsWith(prefix))
				.flatMap(([key, text]) =>
					[...text.matchAll(/\{(\w+)\}/g)]
						.map((match) => match[1])
						.filter((name) => !names.includes(String(name)))
						.map(() => key),
				);
		expect(strayValues('ordersAdmin.historyNote.', ['amount', 'reason', 'reference'])).toEqual([]);
		expect(strayValues('ordersAdmin.warning.', ['amount'])).toEqual([]);
		expect(strayValues('customersAdmin.csvProblem.', ['currency', 'category', 'brand', 'sku'])).toEqual([]);
		// every status has its tone
		expect(STATUS_ROLES.filter((role) => !Object.hasOwn(ROLE_TONES, role))).toEqual([]);
		expect(CLAIM_STATUSES.filter((status) => !Object.hasOwn(CLAIM_TONES, status))).toEqual([]);
	});

	it('a refusal names the text for its field (the deepest part with one first), else for its code, else none', () => {
		const texts = {
			'problem.field.price': 'Price',
			'problem.field.variants': 'Variants',
			'problem.validation_failed': 'Check',
			'problem.conflict': 'Conflict',
		};
		expect(problemKey(texts, 'validation_failed', [{ path: '/variants/0/price' }])).toBe('problem.field.price');
		expect(problemKey(texts, 'validation_failed', [{ path: '/variants/0/sku' }])).toBe('problem.field.variants');
		expect(problemKey(texts, 'validation_failed', [{ path: '/other' }])).toBe('problem.validation_failed');
		expect(problemKey(texts, 'validation_failed')).toBe('problem.validation_failed');
		// only a validation names a field
		expect(problemKey(texts, 'conflict', [{ path: '/price' }])).toBe('problem.conflict');
		expect(problemKey(texts, 'teapot')).toBeNull();
		expect(problemKey(texts, '')).toBeNull();
		expect(problemKey({}, 'validation_failed', [{ path: 7 }])).toBeNull();
		expect(codeOf({ data: { type: 'https://shop.example/problems/not_found' } })).toBe('not_found');
		expect(codeOf({ data: null })).toBe('');
	});
});
