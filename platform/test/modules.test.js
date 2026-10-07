import { describe, expect, it } from 'vitest';
import { defineCollection } from '../src/infra/db.js';
import { composeModules, defineModule, moduleProblems } from '../src/infra/modules.js';
import { modules } from '../src/modules/index.js';
import { createTestLogger } from './helpers.js';

const shared = () => /** @type {any} */ ({ logger: createTestLogger().logger, now: () => 0 });

describe('defineModule', () => {
	it('validates names, collections, migrations and factories', () => {
		expect(() => defineModule({ name: 'Bad' })).toThrow(/name/);
		expect(() => defineModule({ name: 'platform' })).toThrow(/name/);
		expect(() => defineModule({ name: 'a', collections: [defineCollection({ module: 'b', name: 'b_x' })] })).toThrow(
			/collection/,
		);
		expect(() => defineModule({ name: 'a', migrations: [{ id: '202610010000-b-x', up: async () => {} }] })).toThrow(
			/migration/,
		);
		expect(() => defineModule(/** @type {any} */ ({ name: 'a', routes: [] }))).toThrow(/factory/);
		expect(Object.isFrozen(defineModule({ name: 'a' }))).toBe(true);
	});
});

describe('composeModules', () => {
	it('builds lazy services across modules, collects jobs and ports', () => {
		/** @type {string[]} */
		const built = [];
		const a = defineModule({
			name: 'alpha',
			service: (ctx) => {
				built.push('alpha');
				return { hello: () => `alpha+${ctx.service('beta').name()}` };
			},
			routes: (ctx) => [{ method: 'GET', path: '/v1/alpha', auth: 'public', handler: () => ctx.service('alpha').hello() }],
			jobs: () => ({ 'alpha.work': async () => {} }),
			ports: () => ({ appKeys: () => null }),
		});
		const b = defineModule({ name: 'beta', service: (ctx) => (built.push('beta'), { name: () => ctx.module }) });
		const composed = composeModules([a, b], { shared: shared(), collection: (m, n) => `${m}:${n}` });
		expect(composed.names()).toEqual(['alpha', 'beta']);
		expect(built).toEqual([]); // lazy
		expect(/** @type {any} */ (composed.service('alpha')).hello()).toBe('alpha+beta');
		expect(built).toEqual(['alpha', 'beta']);
		expect(composed.service('alpha')).toBe(composed.service('alpha'));
		expect(composed.routes).toHaveLength(1);
		expect(Object.keys(composed.jobs)).toEqual(['alpha.work']);
		expect(typeof composed.ports.appKeys).toBe('function');
		const ctx = composed.context('beta');
		expect(ctx.collection('beta_x')).toBe('beta:beta_x');
		expect(ctx.moduleNames()).toEqual(['alpha', 'beta']);
		expect(composed.context('beta')).toBe(ctx);
		expect(composed.migrations()).toEqual([]);
	});

	it('refuses collisions and bad wiring', () => {
		const opts = { shared: shared(), collection: () => null };
		expect(() => composeModules([defineModule({ name: 'a' }), defineModule({ name: 'a' })], opts)).toThrow(/twice/);
		expect(() => composeModules([defineModule({ name: 'a', jobs: () => ({ 'b.x': async () => {} }) })], opts)).toThrow(
			/must be named/,
		);
		expect(() =>
			composeModules(
				[
					defineModule({ name: 'a', ports: () => ({ appKeys: () => null }) }),
					defineModule({ name: 'b', ports: () => ({ appKeys: () => null }) }),
				],
				opts,
			),
		).toThrow(/port appKeys/);
		const cyclic = composeModules(
			[
				defineModule({ name: 'a', service: (ctx) => ctx.service('b') }),
				defineModule({ name: 'b', service: (ctx) => ctx.service('a') }),
				defineModule({ name: 'c' }),
			],
			opts,
		);
		expect(() => cyclic.service('a')).toThrow(/cycle/);
		expect(() => cyclic.service('zzz')).toThrow(/not registered/);
		expect(() => cyclic.service('c')).toThrow(/no service/);
	});

	it('merges module problem codes', () => {
		expect(moduleProblems([defineModule({ name: 'a', problems: { a_x: { status: 400, title: 'X' } } })])).toEqual({
			a_x: { status: 400, title: 'X' },
		});
		expect(() =>
			moduleProblems([
				defineModule({ name: 'a', problems: { dup: { status: 400, title: 'X' } } }),
				defineModule({ name: 'b', problems: { dup: { status: 400, title: 'Y' } } }),
			]),
		).toThrow(/twice/);
	});

	it('the registry lists the system module', () => {
		expect(modules.map((m) => m.name)).toContain('system');
	});
});
