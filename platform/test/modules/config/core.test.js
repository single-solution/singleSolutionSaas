import { describe, expect, it } from 'vitest';
import { validateFeatureConfig, validateManifest } from '@ss/contracts';
import { diffStates, lockedTouches, touchedKeys } from '../../../src/modules/config/core/diff.js';
import { parseReason } from '../../../src/modules/config/service.js';
import {
	applyOps,
	decodeState,
	emptyState,
	encodeState,
	normaliseState,
	toLayerInput,
} from '../../../src/modules/config/core/state.js';
import { actorMayLock, actorMayWrite, parseTarget, targetKey } from '../../../src/modules/config/core/targets.js';
import {
	featureNode,
	featureValueProblem,
	indexManifest,
	splitFeatureKey,
	validateEntries,
} from '../../../src/modules/config/core/validate.js';
import { MER_A, SUB_A1, manifest } from './fixtures.js';

const index = indexManifest(manifest());

/** @param {any} result */
const errorsOf = (result) => (result.ok ? [] : result.errors);

describe('fixture', () => {
	it('is a valid SSPS manifest', () => {
		expect(validateManifest(manifest()).ok).toBe(true);
	});
});

describe('targets', () => {
	it('parses every level and derives stable keys', () => {
		const platform = parseTarget({ appId: 'app_coupons' }, 'platform');
		expect(platform).toEqual({ ok: true, value: { level: 'platform', appId: 'app_coupons' } });
		expect(parseTarget('app_coupons', 'platform')).toEqual(platform);
		expect(parseTarget({ level: 'merchant', merchantId: MER_A, appId: 'app_coupons' }).ok).toBe(false);
		const website = parseTarget(SUB_A1, 'website');
		expect(website.ok && targetKey(website.value)).toBe(`website:${SUB_A1}`);
		const admin = parseTarget({ subscriptionId: SUB_A1 }, 'admin');
		expect(admin.ok && targetKey(admin.value)).toBe(`admin:${SUB_A1}`);
		expect(platform.ok && targetKey(platform.value)).toBe('platform:app_coupons');
	});

	it('rejects bad targets', () => {
		expect(errorsOf(parseTarget(42, 'website'))[0].path).toBe('/target');
		expect(errorsOf(parseTarget({}, 'nope'))[0].path).toBe('/level');
		expect(errorsOf(parseTarget({ subscriptionId: 'x' }, 'website'))[0].path).toBe('/target/subscriptionId');
		expect(errorsOf(parseTarget({ appId: '' }, 'platform'))[0].path).toBe('/target/appId');
	});

	it('knows who may write and lock', () => {
		expect(actorMayWrite('merchant_user', 'website')).toBe(true);
		expect(actorMayWrite('merchant_user', 'admin')).toBe(false);
		expect(actorMayWrite('merchant_user', 'platform')).toBe(false);
		expect(actorMayWrite('staff', 'platform')).toBe(true);
		expect(actorMayWrite('system', 'admin')).toBe(true);
		expect(actorMayWrite('product', 'website')).toBe(false);
		expect(actorMayWrite(undefined, 'website')).toBe(false);
		expect(actorMayLock('staff')).toBe(true);
		expect(actorMayLock('system')).toBe(true);
		expect(actorMayLock('merchant_user')).toBe(false);
	});
});

describe('state', () => {
	it('normalises, encodes and decodes', () => {
		const state = normaliseState({
			elements: { codes: { enabled: true, locked: true }, banner: { enabled: false, locked: false }, bad: { enabled: 'x' } },
			features: { 'codes.maxActive': { value: 5 }, 'codes.window': { value: { days: 3 }, locked: true }, broken: {} },
		});
		expect(state).toEqual({
			elements: { codes: { enabled: true, locked: true }, banner: { enabled: false } },
			features: { 'codes.maxActive': { value: 5 }, 'codes.window': { value: { days: 3 }, locked: true } },
		});
		const stored = encodeState(state);
		expect(stored.features.map((f) => f.key)).toEqual(['codes.maxActive', 'codes.window']);
		expect(decodeState(stored)).toEqual(state);
		expect(decodeState(null)).toEqual(emptyState());
		expect(decodeState({ elements: 'x', features: [null, { key: 1 }] })).toEqual(emptyState());
		expect(normaliseState('x')).toEqual(emptyState());
		expect(normaliseState({ elements: [], features: null })).toEqual(emptyState());
		expect(toLayerInput(state)).toEqual(state);
	});

	it('applies element, feature, config and lock operations', () => {
		const start = normaliseState({
			elements: { codes: { enabled: true, locked: true } },
			features: { 'codes.prefix': { value: 'A', locked: true } },
		});
		const result = applyOps(start, {
			elements: { codes: false, banner: { enabled: true, locked: true } },
			features: { 'codes.prefix': { value: 'B' }, 'codes.maxActive': { value: 7, locked: false } },
			config: { banner: { text: 'Hi' } },
			locks: { elements: { banner: false }, features: { 'codes.maxActive': true } },
		});
		expect(result).toEqual({
			ok: true,
			next: {
				elements: { codes: { enabled: false, locked: true }, banner: { enabled: true } },
				features: {
					'codes.prefix': { value: 'B', locked: true },
					'codes.maxActive': { value: 7, locked: true },
					'banner.text': { value: 'Hi' },
				},
			},
		});
		expect(start.elements.codes).toEqual({ enabled: true, locked: true }); // not mutated
		const removed = applyOps(start, { elements: { codes: null }, features: { 'codes.prefix': null } });
		expect(removed.ok && removed.next).toEqual(emptyState());
		const unlocked = applyOps(start, { elements: { codes: { enabled: true, locked: false } } });
		expect(unlocked.ok && unlocked.next.elements.codes).toEqual({ enabled: true });
	});

	it('reports structural errors', () => {
		expect(errorsOf(applyOps(emptyState(), 'x'))[0].code).toBe('invalid_change');
		const paths = errorsOf(
			applyOps(emptyState(), {
				extra: 1,
				elements: { 'bad key!': true, a: 'yes', b: { enabled: 'no' }, c: { enabled: true, foo: 1, locked: 'x' } },
				features: { f: 3, 'g.h': { value: 1, other: 2 }, 'i.j': { value: undefined } },
				config: { 'x.y': {}, z: 3, w: { 'bad key!': 1, v: undefined } },
				locks: { elements: { nope: true, codes: 'x' }, features: 'x', other: {} },
			}),
		).map((/** @type {any} */ e) => e.path);
		expect(paths).toEqual(
			expect.arrayContaining([
				'/extra',
				'/elements/bad key!',
				'/elements/a',
				'/elements/b/enabled',
				'/elements/c/foo',
				'/elements/c/locked',
				'/features/f',
				'/features/g.h/other',
				'/features/i.j/value',
				'/config/x.y',
				'/config/z',
				'/config/w/bad key!',
				'/config/w/v',
				'/locks/other',
				'/locks/features',
				'/locks/elements/nope',
				'/locks/elements/codes',
			]),
		);
		expect(errorsOf(applyOps(emptyState(), { elements: [] }))[0].path).toBe('/elements');
		expect(errorsOf(applyOps(emptyState(), { features: [] }))[0].path).toBe('/features');
		expect(errorsOf(applyOps(emptyState(), { config: [] }))[0].path).toBe('/config');
		expect(errorsOf(applyOps(emptyState(), { locks: [] }))[0].path).toBe('/locks');
		expect(errorsOf(applyOps(emptyState(), { locks: { features: { 'codes.prefix': true } } }))[0].code).toBe(
			'lock_without_value',
		);
		const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`e${i}`, true]));
		expect(errorsOf(applyOps(emptyState(), { elements: many })).at(-1).message).toContain('at most 500');
	});
});

describe('diff', () => {
	it('lists added, removed and changed entries in order', () => {
		const a = normaliseState({
			elements: { codes: { enabled: true } },
			features: { 'codes.prefix': { value: 'A' }, 'codes.note': { value: 'x' } },
		});
		const b = normaliseState({
			elements: { banner: { enabled: true, locked: true } },
			features: { 'codes.prefix': { value: 'B' }, 'codes.note': { value: 'x' } },
		});
		const diff = diffStates(a, b);
		expect(diff).toEqual([
			{ kind: 'elements', key: 'banner', op: 'added', after: { enabled: true, locked: true } },
			{ kind: 'elements', key: 'codes', op: 'removed', before: { enabled: true } },
			{ kind: 'features', key: 'codes.prefix', op: 'changed', before: { value: 'A' }, after: { value: 'B' } },
		]);
		expect(diffStates(a, a)).toEqual([]);
		expect(touchedKeys(diff)).toEqual({ elements: ['banner'], features: ['codes.prefix'] });
		expect(lockedTouches(diff).map((d) => d.key)).toEqual(['banner']);
	});
});

describe('validate', () => {
	it('splits feature keys and finds nodes', () => {
		expect(splitFeatureKey('codes.window')).toEqual({ element: 'codes', name: 'window' });
		expect(splitFeatureKey('codes')).toBeNull();
		expect(splitFeatureKey('.x')).toBeNull();
		expect(splitFeatureKey('x.')).toBeNull();
		expect(featureNode(index, 'codes')).toMatchObject({ ok: false, code: 'unknown_feature' });
		expect(featureNode(index, 'ghost.x')).toMatchObject({ ok: false, code: 'unknown_element' });
		expect(featureNode(index, 'codes.ghost')).toMatchObject({ ok: false, code: 'unknown_feature' });
		expect(featureNode(index, 'codes.maxActive')).toMatchObject({ ok: true, element: 'codes', name: 'maxActive' });
		const noFeatures = indexManifest({
			...manifest(),
			elements: [{ key: 'bare', name: 'Bare', modes: ['C'], price: { hourly: 0 } }],
		});
		expect(featureNode(noFeatures, 'bare.x')).toMatchObject({ ok: false, code: 'unknown_feature' });
	});

	it('validates values against absolute bounds and schema types', () => {
		/** @param {string} key @param {unknown} value */
		const check = (key, value) => {
			const found = /** @type {any} */ (featureNode(index, key));
			return featureValueProblem(found, value, validateFeatureConfig);
		};
		expect(check('codes.maxActive', 500)).toBeNull();
		expect(check('codes.maxActive', 500_000)).toMatch(/<=/); // absolute bound, not the plan max
		expect(check('codes.maxActive', 0)).toMatch(/>=/);
		expect(check('codes.maxActive', 'ten')).toMatch(/integer/);
		expect(check('codes.maxActive', null)).toBeNull(); // limit: null = unlimited
		expect(check('codes.prefix', null)).toMatch(/string/);
		expect(check('codes.prefix', 'lower')).toMatch(/pattern/);
		expect(check('codes.window', { days: 0 })).toMatch(/days/);
		expect(check('codes.window', {})).toMatch(/days/);
		expect(check('codes.window', { days: 2, extra: 1 })).toMatch(/not allowed/);
		expect(check('codes.allowStacking', 1)).toMatch(/boolean/);
		const fallback = featureValueProblem(
			/** @type {any} */ ({ schema: { type: 'object', properties: {} }, node: {}, name: 'x' }),
			1,
			() => ({ ok: false, problems: [] }),
		);
		expect(fallback).toBe('invalid value');
		const other = featureValueProblem(
			/** @type {any} */ ({ schema: { type: 'object', properties: {} }, node: {}, name: 'x' }),
			1,
			() => ({ ok: false, problems: [{ path: '/y', message: 'broken' }] }),
		);
		expect(other).toBe('broken');
	});

	it('rejects unknown keys and locks on non-lockable features', () => {
		const state = normaliseState({
			elements: { codes: { enabled: true }, ghost: { enabled: true } },
			features: {
				'codes.maxActive': { value: 3, locked: true },
				'codes.note': { value: 'n', locked: true },
				'codes.ghost': { value: 1 },
				'codes.prefix': { value: 'bad!' },
			},
		});
		const errors = validateEntries({
			index,
			state,
			keys: { elements: ['codes', 'ghost', 'absent'], features: Object.keys(state.features).concat('absent.key') },
			validateFeatureConfig,
		});
		expect(errors.map((e) => [e.path, e.code])).toEqual([
			['/elements/ghost', 'unknown_element'],
			['/features/codes.note/locked', 'not_lockable'],
			['/features/codes.ghost', 'unknown_feature'],
			['/features/codes.prefix', 'invalid_value'],
		]);
	});
});

describe('reasons', () => {
	it('parses reasons and names', () => {
		expect(parseReason(undefined, false)).toEqual({ ok: true, value: null });
		expect(parseReason('', true).ok).toBe(false);
		expect(parseReason('  why  ', true)).toEqual({ ok: true, value: 'why' });
		expect(parseReason('   ', false).ok).toBe(false);
		expect(parseReason(3, false).ok).toBe(false);
	});
});
