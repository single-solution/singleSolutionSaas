import { describe, expect, it } from 'vitest';
import { validateEvent } from '@ss/contracts';
import * as cli from '../src/index.js';

describe('@ss/cli public API', () => {
	it('exports the command entry points', () => {
		for (const name of [
			'main',
			'initApp',
			'validateProject',
			'createPortal',
			'createEmulatorServer',
			'runCertification',
			'simulateSettlement',
			'lex',
		])
			expect(typeof (/** @type {any} */ (cli)[name])).toBe('function');
		expect(cli.ANATOMY.service).toContain('app/.well-known/ss-connect/route.js');
		expect(cli.IMPORT_POLICY.core?.layers).toEqual(['core']);
	});

	it('ships sample data that forms valid standard events', () => {
		for (const type of Object.keys(cli.SAMPLE_DATA)) {
			const event = cli.buildEnvelope({
				type,
				websiteId: 'web_devwebsite01',
				env: 'test',
				now: Date.parse('2026-10-01T00:00:00Z'),
			});
			const result = validateEvent(event);
			expect(result.ok ? [] : result.problems).toEqual([]);
		}
	});

	it('wraps portal errors with codes', () => {
		expect(cli.portalError('x', 'y', { status: 1 })).toMatchObject({ code: 'x', message: 'y', status: 1 });
	});
});
