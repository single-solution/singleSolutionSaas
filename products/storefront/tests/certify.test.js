/**
 * `ss certify` for element packs is static: `ss app validate` plus, for every element, the headless core's standard
 * shape and an accessible renderer root. Every check must pass (CERTIFIABLE), with no validation warnings.
 */
import { describe, expect, it } from 'vitest';
import { formatValidation, runCertification, validateProject } from '@ss/cli';
import { ROOT } from './helpers.js';

describe('ss certify', () => {
	it('ss app validate passes without errors or warnings', async () => {
		const report = await validateProject(ROOT);
		expect(report.problems, formatValidation(report)).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it('certifies every element', async () => {
		const report = await runCertification({ dir: ROOT });
		const failed = report.checks.filter((check) => check.status !== 'pass');
		expect(failed).toEqual([]);
		expect(report).toMatchObject({ ok: true, kind: 'pack', product: 'storefront' });
		expect(report.summary.passed).toBe(1 + 2 * 13);
	});
});
