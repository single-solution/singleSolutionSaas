import { describe, expect, it } from 'vitest';
import * as testing from '@ss/platform/testing';
import { modules } from '../src/modules/index.js';

describe('@ss/platform/testing', () => {
	it('exposes the composition root, the module list and the module factories for system tests', () => {
		expect(Object.keys(testing).sort()).toEqual([
			'closeMongoClients',
			'commerceModule',
			'configModule',
			'createCatalogModule',
			'createConnectorsModule',
			'createDeliveryModule',
			'createIdentityModule',
			'createIntegrationModule',
			'createPortal',
			'createSystemStore',
			'loadConfig',
			'loadEnv',
			'modules',
			'systemModule',
			'testSystemState',
			'totpCode',
		]);
		expect(testing.modules).toBe(modules);
		for (const factory of [
			testing.createIntegrationModule,
			testing.createCatalogModule,
			testing.createIdentityModule,
			testing.createConnectorsModule,
			testing.createDeliveryModule,
		]) {
			expect(factory().name).toBeTypeOf('string');
		}
	});
});
