import { describe, expect, it } from 'vitest';
import * as testing from '@ss/platform/testing';
import { modules } from '../src/modules/index.js';

describe('@ss/platform/testing', () => {
	it('exposes the composition root, the module list, the module factories and the API driver for system tests', () => {
		expect(Object.keys(testing).sort()).toEqual([
			'SESSIONS',
			'closeMongoClients',
			'commerceModule',
			'createCatalogModule',
			'createIdentityModule',
			'createPortal',
			'createPortalClient',
			'createSystemStore',
			'loadConfig',
			'loadEnv',
			'modules',
			'systemModule',
			'testSystemState',
			'totpCode',
		]);
		expect(testing.modules).toBe(modules);
		expect(modules.map((m) => m.name)).toEqual(['system', 'catalog', 'identity', 'commerce']);
		for (const factory of [testing.createCatalogModule, testing.createIdentityModule]) {
			expect(factory().name).toBeTypeOf('string');
		}
	});
});
