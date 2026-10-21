// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Card, Stat } from '../src/display.js';
import { Switch } from '../src/fields.js';
import { act, cleanup, render } from '../src/testing.js';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** Take over requestAnimationFrame: the callbacks wait until `flush(time)` runs them. */
const frames = () => {
	/** @type {Map<number, (time: number) => void>} */
	const queue = new Map();
	let next = 1;
	vi.stubGlobal('requestAnimationFrame', (/** @type {(time: number) => void} */ callback) => {
		queue.set(next, callback);
		return next++;
	});
	vi.stubGlobal('cancelAnimationFrame', (/** @type {number} */ id) => queue.delete(id));
	return {
		waiting: () => queue.size,
		/** @param {number} time */
		flush: (time) =>
			act(() => {
				const run = [...queue.values()];
				queue.clear();
				for (const callback of run) callback(time);
			}),
	};
};

/** @param {HTMLElement} root */
const figure = (root) => /** @type {HTMLElement} */ (root.querySelector('.tabular-nums.font-display')).textContent;

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

describe('Stat', () => {
	it('shows the change beside the figure, in the color of its tone', () => {
		const { container } = render(<Stat label="Orders" value="1,284" change={{ value: '+8%', tone: 'success' }} />);
		const change = /** @type {HTMLElement} */ ([...container.querySelectorAll('span')].find((el) => el.textContent === '+8%'));
		expect(change.className).toContain('text-success');
		expect(change.previousElementSibling?.textContent).toBe('1,284');
	});

	it('still draws the old props as before: label, figure, hint in its tone, no change', () => {
		const { container } = render(<Stat label="Orders" value={12} hint="3 waiting" tone="danger" />);
		expect(container.textContent).toBe('Orders123 waiting');
		expect(container.querySelector('.text-danger')?.textContent).toBe('3 waiting');
		expect(container.querySelector('.flex-wrap')).toBeNull();
	});

	it('does not count on the first draw, and counts up to the new number after a change', () => {
		const loop = frames();
		const { container, rerender } = render(<Stat label="Orders" value="1,284" />);
		expect(loop.waiting()).toBe(0);
		expect(figure(container)).toBe('1,284');
		rerender(<Stat label="Orders" value="1,500" />);
		expect(figure(container)).toBe('1,284');
		loop.flush(1000);
		expect(figure(container)).toBe('1,284');
		loop.flush(1200);
		const middle = Number(figure(container).replace(',', ''));
		expect(middle).toBeGreaterThan(1284);
		expect(middle).toBeLessThan(1500);
		expect(figure(container)).toContain(',');
		loop.flush(1400);
		expect(figure(container)).toBe('1,500');
		expect(loop.waiting()).toBe(0);
	});

	it('counts a plain number and a number in a text with its text around it', () => {
		const loop = frames();
		const { container, rerender } = render(<Stat label="Revenue" value="$82" />);
		rerender(<Stat label="Revenue" value="$182" />);
		loop.flush(0);
		loop.flush(100);
		const text = figure(container);
		expect(text.startsWith('$')).toBe(true);
		expect(Number(text.slice(1))).toBeGreaterThan(82);
		expect(Number(text.slice(1))).toBeLessThan(182);
		loop.flush(400);
		expect(figure(container)).toBe('$182');
		rerender(<Stat label="Revenue" value={5} />);
		expect(loop.waiting()).toBe(0);
		expect(figure(container)).toBe('5');
		rerender(<Stat label="Revenue" value={25} />);
		loop.flush(0);
		loop.flush(200);
		expect(Number(figure(container))).toBeGreaterThan(5);
		expect(Number(figure(container))).toBeLessThan(25);
	});

	it('starts a new count from the number on the screen when the value changes in the middle of one', () => {
		const loop = frames();
		const { container, rerender } = render(<Stat label="Orders" value={0} />);
		rerender(<Stat label="Orders" value={1000} />);
		loop.flush(0);
		loop.flush(200);
		const middle = Number(figure(container));
		expect(middle).toBeGreaterThan(0);
		rerender(<Stat label="Orders" value={2000} />);
		expect(Number(figure(container))).toBe(middle);
	});

	it('just swaps anything that is not one number, and swaps with reduced motion', () => {
		const loop = frames();
		const { container, rerender } = render(<Stat label="State" value="Active" />);
		rerender(<Stat label="State" value="Paused" />);
		expect(figure(container)).toBe('Paused');
		rerender(<Stat label="State" value="3 of 12" />);
		rerender(<Stat label="State" value="4 of 12" />);
		expect(figure(container)).toBe('4 of 12');
		rerender(<Stat label="State" value="12 users" />);
		rerender(<Stat label="State" value="5 files" />);
		expect(figure(container)).toBe('5 files');
		expect(loop.waiting()).toBe(0);
		vi.stubGlobal('matchMedia', () => ({ matches: true }));
		rerender(<Stat label="State" value={10} />);
		rerender(<Stat label="State" value={20} />);
		expect(figure(container)).toBe('20');
		expect(loop.waiting()).toBe(0);
	});
});
