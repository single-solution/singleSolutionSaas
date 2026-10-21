// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '../src/testing.js';
import { DisplayLocale, LocalTime } from '../src/time.js';

afterEach(cleanup);

describe('LocalTime (point 290: checks the date first, never throws on bad dates)', () => {
	it('renders valid ISO strings, timestamps and Date instances', () => {
		const { container, rerender } = render(<LocalTime value="2026-10-04T14:30:00Z" />);
		const time = container.querySelector('time');
		expect(time).not.toBeNull();
		expect(time?.getAttribute('dateTime')).toBe('2026-10-04T14:30:00.000Z');

		rerender(<LocalTime value={new Date('2026-10-04T14:30:00Z')} />);
		expect(container.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-04T14:30:00.000Z');

		rerender(<LocalTime value={1791124200000} />);
		expect(container.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-04T14:30:00.000Z');
	});

	it('returns a dash for empty, null, and undefined values without throwing', () => {
		const { container, rerender } = render(<LocalTime value={null} />);
		expect(container.textContent).toBe('—');

		rerender(<LocalTime value={undefined} />);
		expect(container.textContent).toBe('—');

		rerender(<LocalTime value="" />);
		expect(container.textContent).toBe('—');
	});

	it('returns a dash for invalid dates (point 290) and never throws', () => {
		const bad = ['soon', 'invalid', {}, [], Number.NaN, 'not-a-date'];
		for (const val of bad) {
			const { container } = render(<LocalTime value={/** @type {any} */ (val)} />);
			expect(container.textContent).toBe('—');
			cleanup();
		}
	});

	it('respects DisplayLocale', () => {
		const { container } = render(
			<DisplayLocale locale="en-GB">
				<LocalTime value="2026-10-04T14:30:00Z" />
			</DisplayLocale>,
		);
		const time = container.querySelector('time');
		expect(time?.getAttribute('title')).toContain('4 Oct 2026');
	});
});
