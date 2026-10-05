import { describe, expect, it } from 'vitest';
import { isValidFeatureValue, normaliseProduct, withinPlanMax } from '../src/catalog.js';
import { resolveEntitlement } from '../src/resolve.js';
import { HEALTHY, NOW, couponsInput } from './fixtures.js';

const PLACEMENT = {
	type: 'object',
	title: 'Placement',
	default: { selectors: [{ selector: 'body' }] },
	'x-kind': 'placement',
	'x-placement': { members: ['selectors', 'devices', 'audience', 'frequency'] },
	'x-plan': { starter: { members: ['selectors', 'devices'] } },
};

/** Coupons with a placement feature on the apply box and an optional storage resource on reports. */
const productInput = () => {
	const input = couponsInput();
	const applyBox = /** @type {any} */ (input.elements[1]);
	applyBox.features.properties.placement = PLACEMENT;
	const reports = /** @type {any} */ (input.elements[2]);
	reports.requires = { resources: ['database'], optionalResources: ['storage', 'database'] };
	return input;
};

/** @param {string} plan @param {Record<string, unknown>} value */
const resolveWith = (plan, value) =>
	resolveEntitlement({
		product: normaliseProduct(productInput()),
		subscription: { id: 'sub_1', plan, priceBookVersion: '2026-06-01', status: 'active', websiteId: 'w1', merchantId: 'm1' },
		now: NOW,
		layers: { website: { features: { 'apply_box.placement': { value } } } },
		runtime: { resources: HEALTHY },
	});

describe('placement features (F.18)', () => {
	it('normalises the kind with its members and plan members', () => {
		const product = normaliseProduct(productInput());
		const feature = product.features['apply_box.placement'];
		expect(feature?.kind).toBe('placement');
		expect(feature?.members).toEqual(['selectors', 'devices', 'audience', 'frequency']);
		expect(product.plans.starter?.max['apply_box.placement']).toEqual(['selectors', 'devices']);
		expect(product.features['codes.maxActive']?.members).toBeNull();
	});

	it('validates values with the placement v1 schema and the element members', () => {
		const feature = /** @type {any} */ (normaliseProduct(productInput()).features['apply_box.placement']);
		expect(isValidFeatureValue(feature, { devices: ['mobile'] })).toBe(true);
		expect(isValidFeatureValue(feature, { devices: ['watch'] })).toBe(false);
		expect(isValidFeatureValue(feature, { paths: { include: ['/'] } })).toBe(false);
		expect(isValidFeatureValue(feature, 'x')).toBe(false);
		expect(isValidFeatureValue({ ...feature, members: null }, { paths: { include: ['/'] } })).toBe(true);
		expect(withinPlanMax(feature, { audience: 'x' }, ['selectors'])).toBe(false);
		expect(withinPlanMax(feature, { selectors: [] }, ['selectors'])).toBe(true);
		expect(withinPlanMax(feature, 'not an object', ['selectors'])).toBe(true);
	});

	it('applies the plan bound: members outside the plan fall back to the default', () => {
		const starter = resolveWith('starter', { devices: ['mobile'], audience: "page.path == '/'" });
		expect(starter.features['apply_box.placement']).toMatchObject({ value: PLACEMENT.default });
		const pro = resolveWith('pro', { devices: ['mobile'], audience: "page.path == '/'" });
		expect(pro.features['apply_box.placement']?.value).toEqual({ devices: ['mobile'], audience: "page.path == '/'" });
	});

	it('refuses malformed placement features', () => {
		/** @param {Record<string, unknown>} node @param {string} code */
		const refuses = (node, code) => {
			const input = couponsInput();
			/** @type {any} */ (input.elements[1]).features.properties.placement = { ...PLACEMENT, ...node };
			expect(() => normaliseProduct(input)).toThrow(expect.objectContaining({ code: `catalog/${code}` }));
		};
		refuses({ type: 'string', default: '' }, 'invalid_feature_kind');
		refuses({ 'x-placement': { members: ['nope'] } }, 'invalid_feature_kind');
		refuses({ 'x-plan': { starter: { max: 3 } } }, 'invalid_plan');
		refuses({ 'x-plan': { starter: { members: ['schedule'] } } }, 'invalid_plan');
		refuses({ 'x-plan': { starter: { members: ['selectors'], default: { devices: ['mobile'] } } } }, 'invalid_plan');
		const input = couponsInput();
		/** @type {any} */ (input.elements[0]).features.properties.maxActive['x-plan'].starter.members = ['paths'];
		expect(() => normaliseProduct(input)).toThrow(expect.objectContaining({ code: 'catalog/invalid_plan' }));
	});
});

describe('optional resources (F.18)', () => {
	it('never disables the element and are listed apart from requires', () => {
		const product = normaliseProduct(productInput());
		expect(product.elements.reports?.requires).toEqual(['database']);
		expect(product.elements.reports?.optionalResources).toEqual(['storage']);
		expect(product.elements.codes?.optionalResources).toEqual([]);
		const doc = resolveWith('pro', {});
		expect(doc.elements.reports?.enabled).toBe(true);
	});
});
