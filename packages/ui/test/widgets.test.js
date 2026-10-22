// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
	ActionMenu,
	AppShell,
	Badge,
	FieldGrid,
	IconBadge,
	ThemeScript,
	BarChart,
	Button,
	ButtonLink,
	Callout,
	Card,
	Checkbox,
	CheckboxGroup,
	CodeBlock,
	ConfirmDialog,
	Dialog,
	EmptyState,
	ErrorState,
	Form,
	FormError,
	Icon,
	IconButton,
	Input,
	KeyValueList,
	Masonry,
	RadioGroup,
	Section,
	Select,
	STAT_GRID,
	Skeleton,
	SoftBreaks,
	Spinner,
	Stat,
	StatGrid,
	StatusBadge,
	Stepper,
	Switch,
	TextArea,
	ToastProvider,
	copyText,
	cx,
	fieldErrors,
	useToast,
} from '../src/index.js';
import { THEME_SCRIPT, THEME_STORAGE_KEY } from '../src/theme-script.js';
import { ThemeToggle } from '../src/theme.js';
import { act, allByRole, byLabel, byText, cleanup, click, keydown, render, type } from '../src/testing.js';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe('buttons and fields', () => {
	it('Button shows loading as busy and disabled; IconButton has an accessible name', () => {
		const onClick = vi.fn();
		const { container, rerender } = render(<Button onClick={onClick}>Save</Button>);
		const button = /** @type {HTMLButtonElement} */ (container.querySelector('button'));
		expect(button.type).toBe('button');
		click(button);
		expect(onClick).toHaveBeenCalledTimes(1);
		rerender(
			<Button onClick={onClick} loading variant="danger" size="lg" block>
				Save
			</Button>,
		);
		expect(button.disabled).toBe(true);
		expect(button.getAttribute('aria-busy')).toBe('true');
		expect(button.className).toContain('bg-danger');
		rerender(
			<IconButton label="Close">
				<Icon name="close" />
			</IconButton>,
		);
		expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Close');
		rerender(
			<ButtonLink href="/x" variant="primary">
				Go
			</ButtonLink>,
		);
		expect(container.querySelector('a')?.getAttribute('href')).toBe('/x');
		expect(cx('a', false, null, 'b', undefined, 0)).toBe('a b');
	});

	it('Button prevents rapid double clicks while work is in flight', async () => {
		let finish = () => {};
		const onClick = vi.fn(
			() =>
				new Promise((resolve) => {
					finish = () => resolve(undefined);
				}),
		);
		const { container } = render(<Button onClick={onClick}>Send</Button>);
		const button = /** @type {HTMLButtonElement} */ (container.querySelector('button'));
		click(button);
		click(button);
		expect(onClick).toHaveBeenCalledTimes(1);
		await act(async () => finish());
	});

	it('Button and ButtonLink support disabledReason', () => {
		const { container } = render(
			<div>
				<Button disabledReason="Only Owners can do this">Delete</Button>
				<ButtonLink href="/secret" disabledReason="Need higher permissions">
					Secret
				</ButtonLink>
			</div>,
		);
		const button = /** @type {HTMLButtonElement} */ (container.querySelector('button'));
		expect(button.disabled).toBe(true);
		expect(button.title).toBe('Only Owners can do this');
		expect(button.getAttribute('aria-description')).toBe('Only Owners can do this');

		const link = container.querySelector('[aria-disabled="true"]');
		expect(link).not.toBeNull();
		expect(link?.tagName.toLowerCase()).toBe('span');
		expect(link?.getAttribute('title')).toBe('Need higher permissions');
	});

	it('Input, TextArea and Select associate labels, help and errors', () => {
		const { container } = render(
			<div>
				<Input label="Email" help="We never share it" error="Enter an email address." required suffix="@" />
				<TextArea label="Notes" />
				<Select label="Size" placeholder="Pick one" options={[{ value: 'a', label: 'A' }]} defaultValue="" />
			</div>,
		);
		const email = byLabel(container, 'Email');
		expect(email.required).toBe(true);
		expect(email.getAttribute('aria-invalid')).toBe('true');
		const described = String(email.getAttribute('aria-describedby')).split(' ');
		expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual([
			'We never share it',
			'Enter an email address.',
		]);
		expect(container.textContent).toContain('@');
		expect(byLabel(container, 'Notes').tagName).toBe('TEXTAREA');
		expect(byLabel(container, 'Size').querySelectorAll('option')).toHaveLength(2);
	});

	it('Checkbox, Switch, RadioGroup and CheckboxGroup report changes', () => {
		const onSwitch = vi.fn();
		const onRadio = vi.fn();
		const onGroup = vi.fn();
		const { container } = render(
			<div>
				<Checkbox label="Agree" help="Required" />
				<Switch checked={false} onChange={onSwitch} label="Enabled" description="Turns it on" />
				<Switch checked locked label="Locked one" lockedLabel="Set by admin" />
				<RadioGroup
					legend="Size"
					value="s"
					onChange={onRadio}
					options={[
						{ value: 's', label: 'Small' },
						{ value: 'l', label: 'Large' },
					]}
				/>
				<CheckboxGroup
					legend="Days"
					value={['mon']}
					onChange={onGroup}
					options={[
						{ value: 'mon', label: 'Mon' },
						{ value: 'tue', label: 'Tue' },
					]}
				/>
			</div>,
		);
		const agree = byLabel(container, 'Agree');
		click(agree);
		expect(agree.checked).toBe(true);
		const [enabled, locked] = allByRole(container, 'switch');
		click(/** @type {HTMLElement} */ (enabled));
		expect(onSwitch).toHaveBeenCalledWith(true);
		expect(/** @type {HTMLButtonElement} */ (locked).disabled).toBe(true);
		expect(locked?.getAttribute('aria-readonly')).toBe('true');
		expect(container.querySelector('svg[aria-label="Set by admin"]')).not.toBeNull();
		click(byLabel(container, 'Large'));
		expect(onRadio).toHaveBeenCalledWith('l');
		click(byLabel(container, 'Tue'));
		expect(onGroup).toHaveBeenCalledWith(['mon', 'tue']);
		click(byLabel(container, 'Mon'));
		expect(onGroup).toHaveBeenCalledWith([]);
	});
});

describe('display', () => {
	it('renders cards, headers, badges, callouts, states, stats and lists', () => {
		const { container } = render(
			<div>
				<h1>Websites</h1>
				<Card title="Card" subtitle="Sub" actions={<span>act</span>}>
					body
				</Card>
				<StatusBadge status="low_balance" />
				<StatusBadge status="unknown_status" label="Custom" />
				<Callout tone="danger" title="Bad">
					Broken
				</Callout>
				<Callout tone="success" live={false}>
					Fine
				</Callout>
				<EmptyState title="Nothing" description="Add one" action={<Button>Add</Button>} compact />
				<ErrorState message="Failed" />
				<Skeleton lines={3} />
				<Spinner label="Loading" />
				<Stat label="Balance" value="12 credits" hint="low" tone="warning" icon="wallet" />
				<KeyValueList items={[{ label: 'Domain', value: 'shop.com' }]} columns={3} />
			</div>,
		);
		expect(container.querySelector('h1')?.textContent).toContain('Websites');
		expect(container.textContent).toContain('Low balance');
		expect(container.textContent).toContain('Custom');
		expect(allByRole(container, 'alert').length).toBeGreaterThanOrEqual(2);
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(container.querySelector('dl dt')?.textContent).toBe('Domain');
	});

	it('Stat tiles stay neutral and a kind takes the one accent; Section labels its content; a chart with nothing to draw is a line of text', () => {
		const { container } = render(
			<div>
				<Stat label="Websites" value={3} icon="globe" kind="website" />
				<IconBadge icon="users" kind="merchant" size="sm" />
				<IconBadge icon="box" size="xs" className="plain-badge" />
				<Badge kind="admin" dot>
					Owner
				</Badge>
				<EmptyState title="No websites" icon="globe" kind="website" />
				<Section id="s1" title="Websites" description="Your websites">
					<p>body</p>
				</Section>
				<BarChart
					label="Spend"
					data={[
						{ label: '10-01', value: 2 },
						{ label: '10-02', value: 0 },
					]}
				/>
				<BarChart label="None" data={[]} />
				<BarChart
					label="Only zeros"
					data={[
						{ label: 'a', value: 0 },
						{ label: 'b', value: 0 },
					]}
				/>
			</div>,
		);
		// one accent: tiles stay neutral, a kind puts the icon badge, chip and empty-state icon in the indigo tint
		expect(container.querySelector('[data-tone]')).toBeNull();
		const tile = /** @type {HTMLElement} */ (byText(container, 'Websites').closest('.rounded-card'));
		expect(tile.className).toContain('bg-surface');
		expect(tile.querySelector('.bg-primary-soft.size-6')).not.toBeNull();
		expect(container.querySelector('.bg-primary-soft.size-8')).not.toBeNull();
		// without a kind an icon badge stays neutral (README: leaving `kind` out keeps the item neutral)
		expect(container.querySelector('.plain-badge')?.className).toContain('bg-surface-2');
		expect(container.querySelector('.plain-badge')?.className).not.toContain('bg-primary-soft');
		expect(byText(container, 'Owner').className).toContain('bg-primary-soft');
		expect(byText(container, 'No websites').closest('.rounded-card')?.querySelector('.bg-primary-soft')).not.toBeNull();
		expect(container.querySelector('section[aria-labelledby="s1"] h2')?.textContent).toBe('Websites');
		expect(container.querySelector('svg[aria-label^="Spend"]')).not.toBeNull();
		expect(container.textContent).toContain('No data for this period.');
		// only zeros: the empty text, not a row of empty tracks that reads like full bars
		expect(container.querySelector('svg[aria-label^="Only zeros"]')).toBeNull();
		expect(container.textContent.match(/No data for this period\./g)?.length).toBe(2);
	});

	it('Stepper marks the current step', () => {
		const { container } = render(
			<div>
				<Stepper
					current="b"
					steps={[
						{ id: 'a', label: 'A' },
						{ id: 'b', label: 'B', description: 'now' },
						{ id: 'c', label: 'C' },
					]}
				/>
			</div>,
		);
		expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('B');
	});

	it('charts render accessible SVG and data tables', () => {
		const { container } = render(
			<div>
				<BarChart
					label="Spend"
					data={[
						{ label: '01', value: 2 },
						{ label: '02', value: 0 },
					]}
					format={(v) => `${v} c`}
				/>
				<BarChart label="Empty" data={[]} />
				<BarChart label="Zero" data={[{ label: '01', value: 0 }]} emptyText="Nothing earned yet." />
			</div>,
		);
		expect(container.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe('Spend: 2 values, highest 2 c');
		expect(container.querySelector('table.sr-only td')?.textContent).toBe('2 c');
		expect(container.textContent).toContain('No data for this period.');
		expect(container.textContent).toContain('Nothing earned yet.');
		expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(1);
	});
});

describe('ActionMenu', () => {
	it('opens a menu of actions, moves with the arrow keys and closes on Escape, Tab and outside clicks', () => {
		const remove = vi.fn();
		const edit = vi.fn();
		const { container } = render(
			<div>
				<ActionMenu
					label="More actions"
					size="md"
					items={[
						{ label: 'Edit', onSelect: edit },
						{ label: 'Blocked', onSelect: () => undefined, disabled: true, hint: 'Remove the websites first' },
						{ label: 'Delete', onSelect: remove, danger: true },
					]}
				/>
				<p>outside</p>
			</div>,
		);
		const button = /** @type {HTMLElement} */ (container.querySelector('button[aria-haspopup="menu"]'));
		expect(button.getAttribute('aria-label')).toBe('More actions');
		expect(button.className).toContain('w-9');
		expect(button.getAttribute('aria-expanded')).toBe('false');
		click(button);
		const menu = /** @type {HTMLElement} */ (container.querySelector('[role="menu"]'));
		expect(menu.getAttribute('aria-label')).toBe('More actions');
		const items = allByRole(container, 'menuitem');
		expect(items.map((i) => i.textContent)).toEqual(['Edit', 'Blocked', 'Delete']);
		expect(document.activeElement).toBe(items[0]);
		expect(items[2]?.className).toContain('text-danger');
		expect(items[1]?.getAttribute('aria-describedby')).toBeTruthy();
		expect(container.textContent).toContain('Remove the websites first');
		keydown(menu, 'ArrowDown');
		expect(document.activeElement).toBe(items[2]);
		keydown(menu, 'ArrowDown');
		expect(document.activeElement).toBe(items[0]);
		keydown(menu, 'ArrowUp');
		expect(document.activeElement).toBe(items[2]);
		keydown(menu, 'Home');
		expect(document.activeElement).toBe(items[0]);
		keydown(menu, 'End');
		expect(document.activeElement).toBe(items[2]);
		keydown(menu, 'x');
		keydown(menu, 'Escape');
		expect(container.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(button);
		click(button);
		keydown(/** @type {HTMLElement} */ (container.querySelector('[role="menu"]')), 'Tab');
		expect(container.querySelector('[role="menu"]')).toBeNull();
		click(button);
		act(() => {
			byText(container, 'outside').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		});
		expect(container.querySelector('[role="menu"]')).toBeNull();
		click(button);
		click(byText(container, 'Delete', 'button'));
		expect(remove).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[role="menu"]')).toBeNull();
		click(button);
		click(byText(container, 'Edit', 'button'));
		expect(edit).toHaveBeenCalledTimes(1);
	});
	it('a menu whose actions are all disabled ignores the arrow keys; the small button is the default', () => {
		const { container } = render(
			<ActionMenu
				label="Website actions"
				icon="menu"
				items={[{ label: 'Remove', onSelect: () => undefined, disabled: true }]}
			/>,
		);
		const button = /** @type {HTMLElement} */ (container.querySelector('button'));
		expect(button.className).toContain('w-8');
		click(button);
		const menu = /** @type {HTMLElement} */ (container.querySelector('[role="menu"]'));
		keydown(menu, 'ArrowDown');
		expect(document.activeElement).not.toBe(container.querySelector('[role="menuitem"]'));
		click(button);
		expect(container.querySelector('[role="menu"]')).toBeNull();
	});
});

describe('Masonry', () => {
	it('lays cards out in columns that keep each card whole; a list keeps its items', () => {
		const { container } = render(
			<div>
				<Masonry>
					<Card title="A">a</Card>
					<>
						<Card title="B">b</Card>
						<Card title="C">c</Card>
					</>
				</Masonry>
				<Masonry as="ul" columns={2} label="Websites" className="extra">
					<li>one</li>
					<li>two</li>
				</Masonry>
			</div>,
		);
		const [first, second] = /** @type {HTMLElement[]} */ ([...container.querySelectorAll('.\\@container > *')]);
		expect(first?.className).toContain('@6xl:columns-3');
		expect(first?.className).toContain('[&>*]:break-inside-avoid');
		expect(first?.children).toHaveLength(3);
		expect(second?.tagName).toBe('UL');
		expect(second?.getAttribute('aria-label')).toBe('Websites');
		expect(second?.className).not.toContain('columns-3');
		expect(second?.className).toContain('extra');
		expect(first?.className).not.toContain('only-child');
	});

	it('with wideAlone gives a lone card the whole width', () => {
		const { container } = render(
			<Masonry wideAlone>
				<Card title="Only">a</Card>
			</Masonry>,
		);
		const columns = /** @type {HTMLElement} */ (container.querySelector('.\\@container > *'));
		expect(columns.className).toContain('[&:has(>:only-child)]:columns-1');
		expect(columns.className).toContain('@2xl:columns-2');
	});
});

describe('widths follow the container', () => {
	it('StatGrid sizes its tiles by its own width; a Stat never cuts its value', () => {
		const { container } = render(
			<StatGrid label="Numbers">
				<Stat label="Short" value="250 credits" icon="coins" />
				<Stat label="Long" value="12,345.678 credits" />
				<Stat label="Phrase" value={<>Grace ends 12 Oct</>} />
			</StatGrid>,
		);
		const group = /** @type {HTMLElement} */ (container.querySelector('[role="group"]'));
		expect(group.getAttribute('aria-label')).toBe('Numbers');
		expect(group.className).toContain('@container');
		const grid = /** @type {HTMLElement} */ (group.firstElementChild);
		expect(grid.className).toBe(STAT_GRID);
		expect(STAT_GRID).toContain('@md:grid-cols-2');
		expect(STAT_GRID).toContain('@2xl:[&:has(>:nth-child(3):last-child)]:grid-cols-3');
		const values = [...grid.querySelectorAll('.tabular-nums.font-display')].map((el) => el.className);
		expect(values[0]).toContain('whitespace-nowrap');
		expect(values[0]).toContain('@[14rem]:text-figure');
		expect(values[1]).toContain('whitespace-nowrap');
		expect(values[1]).toContain('text-lg');
		expect(values[2]).toContain('text-balance');
		for (const value of values) expect(value).not.toContain('truncate');
		// a small icon sits beside the label at every width
		expect(grid.firstElementChild?.className).toContain('@container');
		expect(grid.querySelector('.size-6 + span')?.textContent).toBe('Short');
		expect(render(<StatGrid />).container.querySelector('[role="group"]')).toBeNull();
	});

	it('SoftBreaks lets a domain or email wrap between its parts without changing the text', () => {
		const { container } = render(
			<p>
				<SoftBreaks text="shop.example.com" />|<SoftBreaks text="a@b.c/d" />|<SoftBreaks text="plain" />
			</p>,
		);
		expect(container.textContent).toBe('shop.example.com|a@b.c/d|plain');
		expect(container.querySelectorAll('wbr')).toHaveLength(5);
		expect(renderToStaticMarkup(<SoftBreaks text="a.b" />)).toBe('a.<wbr/>b');
	});

	it('KeyValueList follows its own width', () => {
		const { container } = render(
			<div>
				<KeyValueList columns={3} items={[{ label: 'A', value: '1' }]} />
				<KeyValueList columns={1} items={[{ label: 'B', value: '2' }]} />
			</div>,
		);
		const [three, one] = [...container.querySelectorAll('dl')];
		expect(three?.parentElement?.className).toContain('@container');
		expect(three?.className).toContain('@2xl:grid-cols-3');
		expect(one?.className).not.toContain('grid-cols-2');
	});
});

describe('overlays', () => {
	/** @param {{ initial?: boolean }} props */
	function Harness({ initial = false }) {
		const [open, setOpen] = useState(initial);
		return (
			<div>
				<button type="button" onClick={() => setOpen(true)}>
					Open
				</button>
				<Dialog
					open={open}
					onClose={() => setOpen(false)}
					title="Edit"
					description="Change it"
					footer={<button type="button">Last</button>}>
					<input aria-label="First field" />
				</Dialog>
			</div>
		);
	}

	it('Dialog is modal, traps focus, closes on Escape and restores focus', () => {
		const { container } = render(<Harness />);
		const opener = byText(container, 'Open', 'button');
		opener.focus();
		click(opener);
		const dialog = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(document.getElementById(String(dialog.getAttribute('aria-labelledby')))?.textContent).toBe('Edit');
		expect(document.getElementById(String(dialog.getAttribute('aria-describedby')))?.textContent).toBe('Change it');
		const close = /** @type {HTMLElement} */ (dialog.querySelector('button[aria-label="Close"]'));
		expect(document.activeElement).toBe(close);
		const last = byText(dialog, 'Last', 'button');
		last.focus();
		keydown(dialog, 'Tab');
		expect(document.activeElement).toBe(close);
		keydown(dialog, 'Tab', { shiftKey: true });
		expect(document.activeElement).toBe(last);
		expect(document.body.style.overflow).toBe('hidden');
		keydown(dialog, 'Escape');
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(opener);
		expect(document.body.style.overflow).toBe('');
	});

	it('Dialog closes on backdrop click; ConfirmDialog confirms', () => {
		render(<Harness initial />);
		const backdrop = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]')?.parentElement);
		act(() => {
			backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		});
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		cleanup();
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		render(
			<ConfirmDialog open onClose={onClose} onConfirm={onConfirm} title="Delete?" danger confirmLabel="Delete" error="Nope">
				Sure?
			</ConfirmDialog>,
		);
		const dialog = /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
		// a destructive confirmation starts on the safe choice
		expect(document.activeElement?.textContent).toBe('Cancel');
		expect(dialog.textContent).toContain('Nope');
		click(byText(dialog, 'Delete', 'button'));
		expect(onConfirm).toHaveBeenCalled();
		click(byText(dialog, 'Cancel', 'button'));
		expect(onClose).toHaveBeenCalled();
		cleanup();
		render(
			<ConfirmDialog open onClose={onClose} onConfirm={onConfirm} title="Publish?" confirmLabel="Publish">
				Sure?
			</ConfirmDialog>,
		);
		expect(document.activeElement?.textContent).toBe('Publish');
	});

	it('nested overlays share scroll lock counter so closing does not leave page locked', () => {
		const Nested = ({ openParent = true, openChild = false }) => (
			<>
				<Dialog open={openParent} onClose={() => {}} title="Parent">
					Parent content
				</Dialog>
				<Dialog open={openChild} onClose={() => {}} title="Child" size="sm">
					Child content
				</Dialog>
			</>
		);
		const { rerender } = render(<Nested openParent openChild={false} />);
		expect(document.body.style.overflow).toBe('hidden');
		// open child
		rerender(<Nested openParent openChild />);
		expect(document.body.style.overflow).toBe('hidden');
		// close parent first, child still open
		rerender(<Nested openParent={false} openChild />);
		expect(document.body.style.overflow).toBe('hidden');
		// close child
		rerender(<Nested openParent={false} openChild={false} />);
		expect(document.body.style.overflow).toBe('');
	});

	it('ConfirmDialog shows Saving... or busyLabel when busy', () => {
		const { rerender } = render(
			<ConfirmDialog open onClose={() => {}} onConfirm={() => {}} title="Save item?" confirmLabel="Save" busy>
				Body
			</ConfirmDialog>,
		);
		const confirmBtn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-busy') === 'true');
		expect(confirmBtn?.textContent).toContain('Saving…');

		rerender(
			<ConfirmDialog
				open
				onClose={() => {}}
				onConfirm={() => {}}
				title="Delete item?"
				confirmLabel="Delete"
				busy
				busyLabel="Deleting…">
				Body
			</ConfirmDialog>,
		);
		const deletingBtn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-busy') === 'true');
		expect(deletingBtn?.textContent).toContain('Deleting…');
	});
});

describe('toasts, code blocks and forms', () => {
	it('shows and dismisses toasts in live regions', () => {
		vi.useFakeTimers();
		function Trigger() {
			const toast = useToast();
			return (
				<>
					<button type="button" onClick={() => toast.show({ title: 'Saved', description: 'All good' })}>
						ok
					</button>
					<button type="button" onClick={() => toast.show({ title: 'Failed', tone: 'danger' })}>
						bad
					</button>
				</>
			);
		}
		const { container } = render(
			<ToastProvider durationMs={1000}>
				<Trigger />
			</ToastProvider>,
		);
		click(byText(container, 'bad', 'button'));
		act(() => {
			vi.advanceTimersByTime(500);
		});
		click(byText(container, 'ok', 'button'));
		expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain('Saved');
		expect(container.querySelector('[aria-live="assertive"]')?.textContent).toContain('Failed');
		act(() => {
			vi.advanceTimersByTime(600);
		});
		expect(container.textContent).not.toContain('Failed');
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Dismiss notification"]')));
		expect(container.textContent).not.toContain('Saved');
	});

	it('copies code once, with the shown-once warning for secrets', async () => {
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const { container } = render(<CodeBlock code="sk_live_x" label="Secret key" secret />);
		expect(container.textContent).toContain('shown only once');
		await act(async () => {
			byText(container, 'Copy', 'button').click();
		});
		expect(writeText).toHaveBeenCalledWith('sk_live_x');
		expect(container.textContent).toContain('Copied');
		expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('Copied to the clipboard.');
		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
		/** @type {any} */ (document).execCommand = () => true;
		expect(await copyText('x')).toBe(true);
	});

	it('point 162: goes back to Copy after 2 seconds, and at once when code changes', async () => {
		vi.useFakeTimers();
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const { container, rerender } = render(<CodeBlock code="sk_live_old" />);
		await act(async () => {
			byText(container, 'Copy', 'button').click();
		});
		expect(container.textContent).toContain('Copied');

		// After 2 seconds, goes back to Copy
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(container.textContent).toContain('Copy');
		expect(container.textContent).not.toContain('Copied');

		// Copy again
		await act(async () => {
			byText(container, 'Copy', 'button').click();
		});
		expect(container.textContent).toContain('Copied');

		// When code changes, at once goes back to Copy
		rerender(<CodeBlock code="sk_live_new" />);
		expect(container.textContent).toContain('Copy');
		expect(container.textContent).not.toContain('Copied');

		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
		vi.useRealTimers();
	});

	it('lays fields out in a grid: short controls are cells, long text and wide ones span the row', () => {
		const { container } = render(
			<div>
				<Form onSubmit={() => undefined} aria-label="Grid">
					<Input label="Name" />
					<Select label="Country" options={[{ value: 'a', label: 'A' }]} />
					<Input label="Address" wide />
					<TextArea label="Notes" />
					<TextArea label="Short note" wide={false} />
					<Checkbox label="Agree" />
					<Switch label="On" checked={false} />
					<RadioGroup legend="Size" options={[{ value: 's', label: 'S' }]} value="s" onChange={() => undefined} />
					<CheckboxGroup legend="Days" options={[{ value: 'mon', label: 'Mon' }]} value={[]} onChange={() => undefined} />
					<button type="submit">Save</button>
				</Form>
				<FieldGrid className="mt-4">
					<Input label="Alone" />
				</FieldGrid>
				<Input label="Accent" type="color" defaultValue="#4f46e5" />
			</div>,
		);
		const grid = /** @type {HTMLElement} */ (container.querySelector('form > div'));
		expect(container.querySelector('form')?.className).toContain('@container');
		expect(grid.className).toContain('@3xl:grid-cols-3');
		const cellOf = (/** @type {string} */ label) => {
			let el = /** @type {HTMLElement | null} */ (byLabel(container, label));
			while (el && el.parentElement !== grid) el = el.parentElement;
			return /** @type {HTMLElement} */ (el);
		};
		expect(cellOf('Name').hasAttribute('data-wide')).toBe(false);
		expect(cellOf('Country').hasAttribute('data-cell')).toBe(true);
		expect(cellOf('Address').hasAttribute('data-wide')).toBe(true);
		expect(cellOf('Notes').hasAttribute('data-wide')).toBe(true);
		expect(cellOf('Short note').hasAttribute('data-wide')).toBe(false);
		expect(cellOf('Agree').hasAttribute('data-cell')).toBe(true);
		expect(grid.querySelector(':scope > fieldset[data-wide]')?.textContent).toContain('Days');
		expect(grid.querySelector(':scope > fieldset:not([data-wide])')?.textContent).toContain('Size');
		expect(grid.querySelector(':scope > button')?.hasAttribute('data-cell')).toBe(false);
		expect(byLabel(container, 'Alone').closest('.\\@container')?.className).toContain('mt-4');
		expect(byLabel(container, 'Accent').className).toContain('cursor-pointer');
		// a lone field cell spans the row
		expect(grid.className).toContain('[&:not(:has(>[data-cell]~[data-cell]))>[data-cell]]:col-span-full');
	});

	it('Form prevents native submission and FormError explains problems', () => {
		const onSubmit = vi.fn();
		/** @type {((problem: import('../src/problems.js').Problem | null) => void) | null} */
		let showProblem = null;
		function Harness() {
			const [email, setEmail] = useState('');
			const [problem, setProblem] = useState(/** @type {import('../src/problems.js').Problem | null} */ (null));
			showProblem = setProblem;
			return (
				<Form onSubmit={onSubmit}>
					<Input
						label="Email"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						error={problem ? fieldErrors(problem).email : undefined}
					/>
					<FormError problem={problem} fields={['email']} />
					<button type="submit">Send</button>
				</Form>
			);
		}
		const { container } = render(<Harness />);
		type(byLabel(container, 'Email'), 'a@b.co');
		act(() => {
			container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		});
		expect(onSubmit).toHaveBeenCalledTimes(1);
		act(() =>
			showProblem?.({
				type: 'https://portal.test/problems/validation_failed',
				status: 422,
				errors: [
					{ path: '/email', message: 'must be an email address' },
					{ path: '/other', message: 'bad' },
				],
			}),
		);
		expect(container.textContent).toContain('Some fields need your attention.');
		expect(container.textContent).toContain('Must be an email address.');
		expect(container.querySelector('li')?.textContent).toContain('other');
	});
});

describe('AppShell', () => {
	it('renders navigation with the current page, a skip link and an off-canvas menu', () => {
		const { container } = render(
			<AppShell
				sections={[
					{
						label: 'Workspace',
						items: [
							{ href: '/websites', label: 'Websites', icon: 'globe', current: true },
							{ href: '/team', label: 'Team' },
							{ href: '/usage', label: 'Usage', icon: 'wallet', kind: 'credit' },
							{ href: '/home', label: 'Home', icon: 'home' },
						],
					},
				]}
				topbar={<span>Shop</span>}
				actions={<button type="button">Sign out</button>}
				banner={<p>Low balance</p>}
				sidebarFooter={<p>me@shop.test</p>}>
				<p>Page body</p>
			</AppShell>,
		);
		expect(container.querySelector('a[href="#main"]')?.textContent).toBe('Skip to content');
		expect(container.querySelector('main#main')?.textContent).toBe('Page body');
		expect(container.querySelector('nav[aria-label="Main"] [aria-current="page"]')?.textContent).toBe('Websites');
		// icons: the accent for the current page, muted for the others; an item without an icon shows none
		const badge = (/** @type {string} */ href) => container.querySelector(`nav a[href="${href}"] > span[aria-hidden="true"]`);
		expect(badge('/websites')?.className).toContain('text-primary');
		expect(badge('/usage')?.className).toContain('text-muted');
		expect(badge('/home')?.className).toContain('text-muted');
		expect(badge('/team')).toBeNull();
		// the group label and the footer are in the sidebar; the header holds the switchers and the actions
		expect(container.querySelector('aside')?.textContent).toContain('Workspace');
		expect(container.querySelector('aside')?.textContent).toContain('me@shop.test');
		expect(container.querySelector('header')?.textContent).toContain('Shop');
		const menu = /** @type {HTMLElement} */ (container.querySelector('button[aria-label="Open navigation"]'));
		expect(menu.getAttribute('aria-expanded')).toBe('false');
		// the menu button shows below 1024 px, where the sidebar is a drawer
		expect(menu.className).toContain('lg:hidden');
		click(menu);
		const panel = /** @type {HTMLElement} */ (container.querySelector('[role="dialog"][aria-label="Navigation"]'));
		expect(panel).not.toBeNull();
		keydown(panel, 'Escape');
		expect(container.querySelector('[role="dialog"][aria-label="Navigation"]')).toBeNull();
		click(menu);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Close navigation"]')));
		expect(container.querySelector('[role="dialog"][aria-label="Navigation"]')).toBeNull();
	});
});

describe('AppShell frame', () => {
	afterEach(() => {
		try {
			window.localStorage.removeItem('ss-nav-rail');
		} catch {
			// no storage
		}
	});

	it('folds the sidebar to an icon rail, remembers it, and hands the slots the state', () => {
		const sections = [
			{ items: [{ href: '/websites', label: 'Websites', icon: /** @type {const} */ ('globe'), current: true }] },
		];
		const slot = (/** @type {string} */ name) => (/** @type {{ rail: boolean }} */ state) => (
			<p>{`${name}:${state.rail ? 'rail' : 'wide'}`}</p>
		);
		const { container, unmount } = render(
			<AppShell
				sections={sections}
				switcher={slot('switcher')}
				sidebarFooter={slot('footer')}
				search={<input aria-label="Search" />}
				topbar={<span>Shop</span>}>
				<p>Body</p>
			</AppShell>,
		);
		const aside = /** @type {HTMLElement} */ (container.querySelector('aside'));
		expect(aside.hasAttribute('data-rail')).toBe(false);
		expect(aside.textContent).toContain('switcher:wide');
		expect(aside.textContent).toContain('footer:wide');
		expect(container.querySelector('header input[aria-label="Search"]')).not.toBeNull();
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Collapse sidebar"]')));
		expect(aside.hasAttribute('data-rail')).toBe(true);
		// the switcher and footer are told of the rail, links keep their name as tooltip and text
		expect(aside.textContent).toContain('switcher:rail');
		expect(aside.textContent).toContain('footer:rail');
		const link = /** @type {HTMLElement} */ (aside.querySelector('nav a[href="/websites"]'));
		expect(link.getAttribute('title')).toBe('Websites');
		expect(link.querySelector('.sr-only')?.textContent).toBe('Websites');
		expect(window.localStorage.getItem('ss-nav-rail')).toBe('1');
		// a new visit starts folded
		unmount();
		const again = render(
			<AppShell sections={sections}>
				<p>Body</p>
			</AppShell>,
		);
		expect(again.container.querySelector('aside')?.hasAttribute('data-rail')).toBe(true);
		click(/** @type {HTMLElement} */ (again.container.querySelector('button[aria-label="Expand sidebar"]')));
		expect(again.container.querySelector('aside')?.hasAttribute('data-rail')).toBe(false);
		expect(window.localStorage.getItem('ss-nav-rail')).toBe('0');
	});

	it('can be fixed wide (collapsible off)', () => {
		const { container } = render(
			<AppShell sections={[{ items: [{ href: '/a', label: 'A' }] }]} collapsible={false}>
				<p>Body</p>
			</AppShell>,
		);
		expect(container.querySelector('button[aria-label="Collapse sidebar"]')).toBeNull();
	});
});

describe('AppShell without the optional parts', () => {
	it('uses the default brand, a router link component and closes the menu on navigation, backdrop and wide screens', () => {
		/** @type {Array<(event: { matches: boolean }) => void>} */
		const listeners = [];
		const media = {
			matches: false,
			addEventListener: (/** @type {string} */ _type, /** @type {any} */ listener) => listeners.push(listener),
			removeEventListener: vi.fn(),
		};
		Object.defineProperty(window, 'matchMedia', { value: () => media, configurable: true });
		/** @param {{ href: string, children?: import('react').ReactNode, onClick?: () => void }} props */
		function RouterLink({ href, children, onClick }) {
			return (
				<a
					href={href}
					data-router="yes"
					onClick={(event) => {
						event.preventDefault();
						onClick?.();
					}}>
					{children}
				</a>
			);
		}
		const { container } = render(
			<AppShell
				sections={[{ items: [{ href: '/home', label: 'Home', badge: { count: 3 } }] }]}
				linkAs={RouterLink}
				themeToggle={false}
				mainId="content">
				<p>Body</p>
			</AppShell>,
		);
		expect(container.textContent).toContain('Single Solution');
		expect(container.textContent).toContain('Console');
		expect(container.querySelector('a[href="#content"]')).not.toBeNull();
		expect(container.querySelector('a[data-router="yes"]')?.textContent).toBe('Home3');
		// the menu button and the title row (no actions, account or theme menu)
		expect(container.querySelector('header')?.children).toHaveLength(2);
		const menu = /** @type {HTMLElement} */ (container.querySelector('button[aria-label="Open navigation"]'));
		const panel = () => container.querySelector('[role="dialog"][aria-label="Navigation"]');
		click(menu);
		click(/** @type {HTMLElement} */ (panel()?.querySelector('a[data-router="yes"]')));
		expect(panel()).toBeNull();
		click(menu);
		const backdrop = /** @type {HTMLElement} */ (panel()?.parentElement);
		act(() => {
			panel()?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		});
		expect(panel()).not.toBeNull();
		act(() => {
			backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		});
		expect(panel()).toBeNull();
		click(menu);
		act(() => listeners.at(-1)?.({ matches: false }));
		expect(panel()).not.toBeNull();
		media.matches = true;
		act(() => listeners.at(-1)?.({ matches: true }));
		expect(panel()).toBeNull();
		expect(media.removeEventListener).toHaveBeenCalled();
		Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true });
		click(menu);
		expect(panel()).not.toBeNull();
	});
});

describe('CodeBlock when copying fails', () => {
	it('announces the failure, without a label or wrapping', async () => {
		Object.defineProperty(navigator, 'clipboard', {
			value: {
				writeText: async () => {
					throw new Error('denied');
				},
			},
			configurable: true,
		});
		/** @type {any} */ (document).execCommand = () => {
			throw new Error('unsupported');
		};
		const { container } = render(<CodeBlock code="npm i" wrap={false} />);
		expect(container.querySelector('pre')?.getAttribute('aria-label')).toBe('Code');
		expect(container.querySelector('pre')?.className).toContain('overflow-x-auto');
		expect(container.textContent).not.toContain('shown only once');
		await act(async () => {
			byText(container, 'Copy', 'button').click();
		});
		expect(container.textContent).toContain('Copy failed. Select the text and copy it manually.');
		/** @type {any} */ (document).execCommand = undefined;
		expect(await copyText('x')).toBe(false);
		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
	});
});

describe('theme', () => {
	afterEach(() => {
		document.documentElement.removeAttribute('data-theme');
		window.localStorage.clear();
		vi.restoreAllMocks();
	});

	it('the console header has one menu with System / Light / Dark that stores the choice and sets data-theme', () => {
		const { container } = render(
			<AppShell sections={[{ items: [{ href: '/a', label: 'A' }] }]}>
				<p>Body</p>
			</AppShell>,
		);
		const trigger = /** @type {HTMLElement} */ (container.querySelector('header button[aria-label="Theme"]'));
		/** @param {string} label */
		const pick = (label) => {
			click(trigger);
			const item = /** @type {HTMLElement} */ (
				[...container.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent === label)
			);
			click(item);
		};
		const checked = () => {
			click(trigger);
			const found = container.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent;
			click(trigger);
			return found;
		};
		expect(checked()).toBe('System');
		pick('Dark');
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
		expect(checked()).toBe('Dark');
		pick('Light');
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
		pick('System');
		expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
		expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
	});

	it('an account menu in the header holds the theme choice above Sign out', () => {
		const out = vi.fn();
		const { container } = render(
			<AppShell
				sections={[{ items: [{ href: '/a', label: 'A', current: true }] }]}
				crumbs={[{ label: 'Acme' }]}
				back={{ href: '/portal', label: 'Back to Portal' }}
				account={{ name: 'Sam Lee', email: 'sam@x.test', items: [{ label: 'Sign out', onSelect: out, danger: true }] }}>
				<p>Body</p>
			</AppShell>,
		);
		const header = /** @type {HTMLElement} */ (container.querySelector('header'));
		// never empty: the breadcrumbs and the page title, Back to Portal and the account menu
		expect(header.querySelector('[aria-current="page"]')?.textContent).toBe('A');
		expect(header.textContent).toContain('Acme');
		expect(header.querySelector('a[href="/portal"]')?.textContent).toBe('Back to Portal');
		click(/** @type {HTMLElement} */ (header.querySelector('button[aria-haspopup="menu"]')));
		const items = [...container.querySelectorAll('[role="menu"] button')].map((b) => b.textContent);
		expect(items).toEqual(['System', 'Light', 'Dark', 'Sign out']);
		// on wide screens the theme is the switch at the bottom of the sidebar, not a second control in the header
		expect(header.querySelector('[role="group"][aria-label="Theme"]')).toBeNull();
		expect(container.querySelector('aside [role="group"][aria-label="Theme"]')).not.toBeNull();
	});

	it('reads the stored choice and survives blocked storage', () => {
		window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
		const first = render(<ThemeToggle />);
		const pressed = () => first.container.querySelector('[aria-pressed="true"]')?.textContent;
		expect(pressed()).toBe('Light');
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		const second = render(<ThemeToggle className="extra" />);
		expect(second.container.querySelector('[aria-pressed="true"]')?.textContent).toBe('System');
		click(/** @type {HTMLElement} */ (second.container.querySelector('button[title="Dark theme"]')));
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
	});

	it('the head script applies a stored choice before paint, with the CSP nonce', () => {
		const html = renderToStaticMarkup(<ThemeScript nonce="abc123" />);
		expect(html).toContain('nonce="abc123"');
		expect(html).toContain('ss-theme');
		expect(renderToStaticMarkup(<ThemeScript />)).not.toContain('nonce');
		window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
		new Function(THEME_SCRIPT)();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		window.localStorage.setItem(THEME_STORAGE_KEY, 'bogus');
		document.documentElement.removeAttribute('data-theme');
		new Function(THEME_SCRIPT)();
		expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
	});
});
