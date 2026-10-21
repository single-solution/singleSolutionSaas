// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Row } from '../src/Row.js';
import { cleanup, click, keydown, render } from '../src/testing.js';

afterEach(cleanup);

/** @param {HTMLElement} root */
const row = (root) => /** @type {HTMLElement} */ (root.querySelector('[data-ss-row]'));

describe('Row', () => {
	it('draws the lead, the title, the status label, the facts, the value and the time', () => {
		const { container } = render(
			<Row
				lead={{ avatar: 'Acme Shop' }}
				title="Acme Shop"
				status={{ tone: 'success', label: 'Live' }}
				meta="3 websites"
				value="$120"
				time="2 min ago"
			/>,
		);
		const box = row(container);
		expect(box.textContent).toContain('AS');
		expect(box.querySelector('.truncate')?.textContent).toBe('Acme Shop');
		const dot = /** @type {HTMLElement} */ (box.querySelector('[title="Live"]'));
		expect(dot.textContent).toBe('Live');
		expect(dot.querySelector('.sr-only')).not.toBeNull();
		expect(box.textContent).toContain('3 websites');
		expect(box.textContent).toContain('$120');
		expect(box.textContent).toContain('2 min ago');
		expect(box.className).toContain('h-14');
	});

	it('draws an icon chip, or any node, as the lead', () => {
		const { container, rerender } = render(<Row lead={{ icon: 'bell', tone: 'warning' }} title="Alerts" />);
		const chip = /** @type {HTMLElement} */ (row(container).querySelector('svg')?.parentElement);
		expect(chip.className).toContain('bg-warning-soft');
		rerender(<Row lead={<b data-testid="mine">x</b>} title="Alerts" />);
		expect(row(container).querySelector('b[data-testid="mine"]')).not.toBeNull();
	});

	it('joins the facts of an array with a dot on one line', () => {
		const { container } = render(<Row title="Acme" meta={['3 websites', '4 products', '']} />);
		const line = /** @type {HTMLElement} */ (row(container).querySelector('p'));
		expect(line.textContent).toBe('3 websites · 4 products');
		expect(line.className).toContain('truncate');
	});

	it('shows the warning in place of the facts, in its color', () => {
		const { container } = render(<Row title="Acme" meta="3 websites" warning={{ tone: 'danger', text: 'Card expired' }} />);
		const line = /** @type {HTMLElement} */ (row(container).querySelector('p'));
		expect(line.textContent).toBe('Card expired');
		expect(line.className).toContain('text-danger');
		expect(row(container).textContent).not.toContain('3 websites');
	});

	it('selects with a click, Enter and Space, and shows the picked look', () => {
		const onSelect = vi.fn();
		const { container, rerender } = render(<Row title="Acme" onSelect={onSelect} />);
		const box = row(container);
		expect(box.getAttribute('role')).toBe('button');
		expect(box.tabIndex).toBe(0);
		click(box);
		keydown(box, 'Enter');
		keydown(box, ' ');
		expect(onSelect).toHaveBeenCalledTimes(3);
		expect(box.hasAttribute('data-selected')).toBe(false);
		rerender(<Row title="Acme" onSelect={onSelect} selected />);
		expect(box.hasAttribute('data-selected')).toBe(true);
		expect(box.className).toContain('bg-primary-soft');
	});

	it('does not select when a click or a key happens inside the trailing control', () => {
		const onSelect = vi.fn();
		const onToggle = vi.fn();
		const { container } = render(
			<Row
				title="Email"
				onSelect={onSelect}
				trailing={
					<button type="button" onClick={onToggle}>
						Switch
					</button>
				}
			/>,
		);
		const control = /** @type {HTMLElement} */ (container.querySelector('[data-ss-row-trailing] button'));
		click(control);
		keydown(control, 'Enter');
		expect(onToggle).toHaveBeenCalledTimes(1);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('is a link through linkAs with href, and does nothing when disabled', () => {
		/** @param {{ href: string, children?: import('react').ReactNode, className?: string }} props */
		const RouterLink = ({ href, children, className }) => (
			<a href={href} data-router="yes" className={className}>
				{children}
			</a>
		);
		const { container, rerender } = render(<Row title="Acme" href="/m/acme" linkAs={RouterLink} />);
		const link = /** @type {HTMLElement} */ (container.querySelector('a[data-router="yes"]'));
		expect(link.getAttribute('href')).toBe('/m/acme');
		expect(link.className).toContain('after:absolute');
		const onSelect = vi.fn();
		rerender(<Row title="Acme" onSelect={onSelect} disabled />);
		const box = row(container);
		click(box);
		keydown(box, 'Enter');
		expect(onSelect).not.toHaveBeenCalled();
		expect(box.getAttribute('aria-disabled')).toBe('true');
		expect(box.tabIndex).toBe(-1);
	});
});
