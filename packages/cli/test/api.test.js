import { describe, expect, it } from 'vitest';
import { PRODUCT_UNAVAILABLE_REASONS } from '@ss/contracts';
import { KIT_ROUTES, checkApiRoutes, kitImportRoutesOf } from '../src/api.js';
import { renderOpenapi } from '../src/openapi.js';

const IMPORTING = { features: [{ key: 'notes' }, { key: 'import' }] };
const IMPORT_KEYS = [
	'POST /v1/import/:collection',
	'POST /v1/import/:collection/prune',
	'POST /v1/import/finish',
	'GET /v1/import/status',
];
/** @param {string} summary */
const described = (summary) => Object.fromEntries(IMPORT_KEYS.map((key) => [key, { summary }]));

describe('the kit routes', () => {
	it('carry the auth the kit serves them with', () => {
		const auth = Object.fromEntries(KIT_ROUTES.map((route) => [`${route.method} ${route.path}`, route.auth]));
		expect(auth['GET /v1/widget/config']).toBe('browser');
		expect(auth['GET /v1/widget/admin/config']).toBe('ticket');
		expect(auth['GET /v1/lists/:list']).toBe('server');
		const doc = /** @type {any} */ (renderOpenapi({ manifest: null, routes: [] }));
		expect(doc.paths['/v1/widget/config'].get).toMatchObject({
			'x-ss-auth': 'browser',
			security: [{ browserToken: [] }, { serverToken: [] }],
			summary: 'Widget config (visitor widgets)',
		});
		expect(doc.paths['/v1/widget/admin/config'].get).toMatchObject({ 'x-ss-auth': 'ticket', security: [{ ticket: [] }] });
		expect(doc.components.schemas.WidgetConfig.required).toContain('widgets');
		expect(doc.components.schemas.Problem.properties.reason.enum).toEqual([...PRODUCT_UNAVAILABLE_REASONS]);
	});

	it('include the import routes for a manifest with the feature import, described by the product', () => {
		expect(kitImportRoutesOf(null)).toEqual([]);
		expect(kitImportRoutesOf({ features: 'x' })).toEqual([]);
		expect(kitImportRoutesOf({ features: [null, { key: 'notes' }] })).toEqual([]);
		expect(kitImportRoutesOf(IMPORTING).map((route) => `${route.method} ${route.path}`)).toEqual(IMPORT_KEYS);
		const doc = /** @type {any} */ (renderOpenapi({ manifest: IMPORTING, routes: [], api: described('Import') }));
		expect(doc.paths['/v1/import/{collection}'].post).toMatchObject({
			summary: 'Import',
			'x-ss-auth': 'server',
			'x-ss-feature': 'import',
		});
		expect(doc.paths['/v1/import/status'].get['x-ss-feature']).toBe('import');
		expect(/** @type {any} */ (renderOpenapi({ manifest: null, routes: [] })).paths['/v1/import/status']).toBeUndefined();
	});

	it("keep a product's own route of the same method and path", () => {
		const own = { file: 'server/imports.js', line: 3, method: 'GET', path: '/v1/import/status', auth: 'server' };
		const doc = /** @type {any} */ (
			renderOpenapi({ manifest: IMPORTING, routes: [{ ...own, feature: 'notes', idempotent: false }] })
		);
		expect(doc.paths['/v1/import/status'].get['x-ss-feature']).toBe('notes');
		expect(
			checkApiRoutes({}, [{ ...own, idempotent: false }], IMPORTING).filter((p) =>
				p.message.startsWith('GET /v1/import/status'),
			),
		).toEqual([expect.objectContaining({ rule: 'api.missing', file: 'server/imports.js', line: 3 })]);
	});
});

describe('the API description against the routes', () => {
	it('takes the import routes the kit serves as the product’s own', () => {
		expect(checkApiRoutes(described('Import'), [], IMPORTING)).toEqual([]);
		expect(checkApiRoutes({}, [], IMPORTING).map((p) => [p.rule, p.file, p.message])).toEqual(
			IMPORT_KEYS.map((key) => [
				'api.missing',
				'schemas/api.json',
				`${key} has no entry in schemas/api.json: describe what it takes and answers (the kit serves it for the feature import)`,
			]),
		);
		// without the feature (or the manifest), an import entry names no route
		expect(checkApiRoutes(described('Import'), [], { features: [] }).map((p) => p.rule)).toEqual(
			IMPORT_KEYS.map(() => 'api.unknown'),
		);
		expect(checkApiRoutes(described('Import'), []).map((p) => p.rule)).toHaveLength(4);
		expect(checkApiRoutes({ 'GET /v1/widget/config': {} }, [])[0]?.message).toBe(
			'GET /v1/widget/config is a route of the kit, which describes it itself',
		);
	});
});
