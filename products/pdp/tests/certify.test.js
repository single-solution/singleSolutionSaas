/**
 * `ss certify` against this pack (static certification: validation plus a headless/renderer smoke test of every
 * element) and `ss app validate` with no errors and no warnings.
 */
import { describe, expect, it } from 'vitest';
import { formatReport, runCertification, validateProject } from '@ss/cli';
import { ROOT } from '../pack.js';

describe('ss certify', () => {
	it('ss app validate passes without errors or warnings', async () => {
		const report = await validateProject(ROOT);
		expect(report.problems).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it('certifies every element of the pack', async () => {
		const report = await runCertification({ dir: ROOT });
		expect(report.ok, formatReport(report)).toBe(true);
		expect(report.kind).toBe('pack');
		expect(report.summary.failed).toBe(0);
		expect(report.summary.skipped).toBe(0);
		// project validation + headless and renderer checks for each of the 13 elements
		expect(report.summary.passed).toBe(1 + 13 * 2);
	}, 60_000);
});
