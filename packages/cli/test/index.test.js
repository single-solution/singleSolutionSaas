import { describe, expect, it } from 'vitest';
import * as cli from '../src/index.js';

describe('@ss/cli public API', () => {
	it('exports the command entry points', () => {
		for (const name of ['main', 'initApp', 'validateProject', 'writeAssets', 'buildPack', 'writePack', 'lex'])
			expect(typeof (/** @type {any} */ (cli)[name])).toBe('function');
		for (const name of ['createPortal', 'runCertification', 'publishPack', 'measurePack', 'checkBudgets'])
			expect(/** @type {any} */ (cli)[name]).toBeUndefined();
		expect(cli.ANATOMY.service).toContain('app/api/[...path]/route.js');
		expect(cli.ANATOMY.service).not.toContain('jobs/');
		expect(cli.MAX_SERVER_ENTRIES).toBe(2);
		expect(cli.IMPORT_POLICY.core?.layers).toEqual(['core']);
	});
});
