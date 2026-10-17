import { describe, expect, it } from 'vitest';
import * as testing from '@ss/platform/testing';

describe('@ss/platform/testing', () => {
	it('exposes the composition root, the module factories and the API driver for system tests', () => {
		expect(Object.keys(testing).sort()).toEqual([
			'closeMongoClients',
			'commerceModule',
			'createCatalogModule',
			'createIdentityModule',
			'createPortal',
			'createPortalClient',
			'createSystemStore',
			'loadConfig',
			'systemModule',
			'testSystemState',
			'websiteModule',
		]);
		for (const factory of [testing.createCatalogModule, testing.createIdentityModule]) {
			expect(factory().name).toBeTypeOf('string');
		}
	});
});
