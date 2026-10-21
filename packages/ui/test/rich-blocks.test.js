// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Card } from '../src/display.js';
import { Switch } from '../src/fields.js';
import { cleanup, render } from '../src/testing.js';

afterEach(cleanup);

describe('Card', () => {
	it('draws the lead, the title with its status label, the help, the toggle, the meter and the action', () => {
		const { container } = render(
			<Card
				title="Backups"
				lead={{ icon: 'database', tone: 'success' }}
				status={{ tone: 'success', label: 'Running' }}
				help="Copies the store every night"
				toggle={<Switch checked onChange={() => {}} label="Backups" hideLabel />}
				meter={{ percent: 42, label: '42 of 100 GB used' }}
				action={<a href="/storage">Manage storage</a>}>
				body text
			</Card>,
		);
		const box = /** @type {HTMLElement} */ (container.firstElementChild);
		expect(box.querySelector('header svg')?.parentElement?.className).toContain('bg-success-soft');
		expect(box.querySelector('h2')?.textContent).toBe('Backups');
		const dot = /** @type {HTMLElement} */ (box.querySelector('[title="Running"]'));
		expect(dot.textContent).toBe('Running');
		expect(dot.querySelector('.bg-success-solid')).not.toBeNull();
		expect(box.textContent).toContain('Copies the store every night');
		expect(box.querySelector('header [role="switch"]')).not.toBeNull();
		const meter = /** @type {HTMLElement} */ (box.querySelector('[role="meter"]'));
		expect(meter.getAttribute('aria-valuenow')).toBe('42');
		expect(/** @type {HTMLElement} */ (meter.firstElementChild).style.width).toBe('42%');
		expect(box.textContent).toContain('42 of 100 GB used');
		expect(box.textContent).toContain('body text');
		expect(box.querySelector('a[href="/storage"]')?.textContent).toBe('Manage storage');
		expect(box.className).toContain('ss-lift');
	});

	it('keeps the meter between 0 and 100', () => {
		const { container, rerender } = render(<Card meter={{ percent: 180 }} />);
		const bar = () => /** @type {HTMLElement} */ (container.querySelector('[data-ss-meter]'));
		expect(bar().style.width).toBe('100%');
		rerender(<Card meter={{ percent: -5 }} />);
		expect(bar().style.width).toBe('0%');
	});

	it('draws the body muted while its toggle is off, but not the action', () => {
		const off = <Switch checked={false} onChange={() => {}} label="Backups" hideLabel />;
		const { container, rerender } = render(
			<Card title="Backups" toggle={off} action={<button type="button">Set up</button>}>
				<p>body</p>
			</Card>,
		);
		const muted = /** @type {HTMLElement} */ (container.querySelector('p')?.parentElement);
		expect(muted.className).toContain('opacity-60');
		expect(muted.contains(container.querySelector('button'))).toBe(false);
		rerender(
			<Card title="Backups" toggle={<Switch checked onChange={() => {}} label="Backups" hideLabel />}>
				<p>body</p>
			</Card>,
		);
		expect(container.querySelector('.opacity-60')).toBeNull();
	});

	it('puts the meter and the action in their own padded strip when the body is not padded', () => {
		const { container } = render(
			<Card padded={false} action={<a href="/x">More</a>}>
				<table />
			</Card>,
		);
		const strip = /** @type {HTMLElement} */ (container.querySelector('a')?.parentElement?.parentElement);
		expect(strip.className).toContain('px-5');
	});

	it('still draws the old props exactly as before: no rich look, no extra boxes', () => {
		const { container } = render(
			<Card title="Plan" subtitle="Your plan" actions={<button type="button">Change</button>} flow id="plan">
				<p>body</p>
			</Card>,
		);
		const box = /** @type {HTMLElement} */ (container.firstElementChild);
		expect(box.id).toBe('plan');
		expect(box.getAttribute('data-flow')).toBe('card');
		expect(box.getAttribute('aria-label')).toBe('Plan');
		expect(box.className).not.toContain('ss-lift');
		expect(box.querySelector('h2')?.textContent).toBe('Plan');
		expect(box.querySelector('header p')?.textContent).toBe('Your plan');
		expect(box.querySelector('header button')?.textContent).toBe('Change');
		const body = /** @type {HTMLElement} */ (box.lastElementChild);
		expect(body.firstElementChild?.tagName).toBe('P');
		expect(box.querySelector('[role="meter"]')).toBeNull();
	});
});
