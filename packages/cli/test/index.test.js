import { describe, expect, it } from 'vitest';
import * as cli from '../src/index.js';

describe('@ss/cli public API', () => {
	it('exports the commands and validateProject', () => {
		for (const name of ['main', 'initApp', 'validateProject', 'writeAssets', 'renderOpenapi', 'scanRoutes', 'lex'])
			expect(typeof (/** @type {any} */ (cli)[name])).toBe('function');
		for (const name of ['buildPack', 'writePack', 'renderAssets', 'checkModules', 'checkEventSchemas', 'INIT_KINDS'])
			expect(/** @type {any} */ (cli)[name]).toBeUndefined();
		expect(cli.ANATOMY).toEqual(
			expect.arrayContaining(['core/', 'api/', 'adapters/', 'ui/', 'app/', 'strings/', 'schemas/', 'tests/', 'docs/']),
		);
		expect(cli.ENV_NAMES).toEqual(['MONGODB_URI', 'CONNECT_SECRET', 'ENCRYPTION_KEY']);
		expect(cli.MAX_SERVER_ENTRIES).toBe(2);
		expect(cli.IMPORT_POLICY.core?.layers).toEqual(['core']);
		expect(cli.KIT_API_ROUTES.map((route) => route.path)).toContain('/v1/tickets');
	});
});
