// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
	AppShell,
	THEME_SCRIPT,
	THEME_STORAGE_KEY,
	ThemeScript,
	ThemeToggle,
	BarChart,
	Breadcrumbs,
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
	Meter,
	PageHeader,
	RadioGroup,
	Select,
	ShareBars,
	Skeleton,
	Spinner,
	Stat,
	StatusBadge,
	Stepper,
	Switch,
	TabNav,
	Table,
	Tabs,
	TextArea,
	ToastProvider,
	copyText,
	cx,
	useFormState,
	useToast,
} from '../src/index.js';
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

	it('Input, TextArea and Select associate labels, help and errors', () => {
		const { container } = render(
			<div>
				<Input label="E-mail" help="We never share it" error="Enter an e-mail address." required suffix="@" />
				<TextArea label="Notes" />
				<Select label="Plan" placeholder="Pick one" options={[{ value: 'a', label: 'A' }]} defaultValue="" />
			</div>,
		);
		const email = byLabel(container, 'E-mail');
		expect(email.required).toBe(true);
		expect(email.getAttribute('aria-invalid')).toBe('true');
		const described = String(email.getAttribute('aria-describedby')).split(' ');
		expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual([
			'We never share it',
			'Enter an e-mail address.',
		]);
		expect(container.textContent).toContain('@');
		expect(byLabel(container, 'Notes').tagName).toBe('TEXTAREA');
		expect(byLabel(container, 'Plan').querySelectorAll('option')).toHaveLength(2);
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
					max={1}
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
		expect(byLabel(container, 'Tue').disabled).toBe(true);
		click(byLabel(container, 'Mon'));
		expect(onGroup).toHaveBeenCalledWith([]);
	});
});

describe('display', () => {
	it('renders cards, headers, badges, callouts, states, stats and lists', () => {
		const { container } = render(
			<div>
				<PageHeader
					title="Websites"
					subtitle="All of them"
					actions={<Button>Add</Button>}
					badge={<StatusBadge status="active" />}
				/>
				<Card title="Card" subtitle="Sub" actions={<span>act</span>}>
					body
				</Card>
				<StatusBadge status="spend_cap" />
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
				<KeyValueList items={[{ label: 'Plan', value: 'basic' }]} columns={3} />
				<Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Here' }]} />
			</div>,
		);
		expect(container.querySelector('h1')?.textContent).toContain('Websites');
		expect(container.textContent).toContain('Spend cap');
		expect(container.textContent).toContain('Custom');
		expect(allByRole(container, 'alert').length).toBeGreaterThanOrEqual(2);
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(container.querySelector('nav[aria-label="Breadcrumb"] [aria-current="page"]')?.textContent).toBe('Here');
		expect(container.querySelector('dl dt')?.textContent).toBe('Plan');
	});

	it('Meter exposes its value; Stepper marks the current step', () => {
		const { container } = render(
			<div>
				<Meter label="Spend" value={90} max={100} />
				<Meter label="Other" value={10} max={0} tone="success" valueText="none" hint="hint" />
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
		const [meter, other] = allByRole(container, 'meter');
		expect(meter?.getAttribute('aria-valuenow')).toBe('90');
		expect(meter?.getAttribute('aria-valuetext')).toBe('90 %');
		expect(meter?.querySelector('rect')?.getAttribute('class')).toContain('fill-warning');
		expect(meter?.querySelector('rect')?.getAttribute('width')).toBe('90');
		expect(other?.getAttribute('aria-valuetext')).toBe('none');
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
				<ShareBars
					label="Share"
					data={[
						{ label: 'A', value: 3, hint: 'x' },
						{ label: 'B', value: 1 },
					]}
				/>
				<ShareBars label="None" data={[]} />
			</div>,
		);
		expect(container.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe('Spend: 2 values, highest 2 c');
		expect(container.querySelector('table.sr-only td')?.textContent).toBe('2 c');
		expect(container.textContent).toContain('No data for this period.');
		expect(container.querySelector('ul[aria-label="Share"]')?.children).toHaveLength(2);
	});
});

describe('Table', () => {
	const rows = [
		{ id: 'a', name: 'Beta', n: 2 },
		{ id: 'b', name: 'Alpha', n: 10 },
		{ id: 'c', name: 'Gamma', n: null },
	];
	it('sorts by column with aria-sort and loads more by cursor', () => {
		const onLoadMore = vi.fn();
		const { container } = render(
			<Table
				caption="Things"
				rows={rows}
				rowKey={(r) => r.id}
				hasMore
				onLoadMore={onLoadMore}
				columns={[
					{ key: 'name', header: 'Name', sortable: true, rowHeader: true },
					{ key: 'n', header: 'N', sortable: true, align: 'right', render: (r) => String(r.n ?? '—') },
				]}
			/>,
		);
		const names = () => [...container.querySelectorAll('tbody th')].map((th) => th.textContent);
		expect(names()).toEqual(['Beta', 'Alpha', 'Gamma']);
		const [nameHeader, nHeader] = [...container.querySelectorAll('thead th')];
		expect(nameHeader?.getAttribute('aria-sort')).toBe('none');
		click(/** @type {HTMLElement} */ (nameHeader?.querySelector('button')));
		expect(nameHeader?.getAttribute('aria-sort')).toBe('ascending');
		expect(names()).toEqual(['Alpha', 'Beta', 'Gamma']);
		click(/** @type {HTMLElement} */ (nameHeader?.querySelector('button')));
		expect(nameHeader?.getAttribute('aria-sort')).toBe('descending');
		expect(names()).toEqual(['Gamma', 'Beta', 'Alpha']);
		click(/** @type {HTMLElement} */ (nHeader?.querySelector('button')));
		expect(names()).toEqual(['Beta', 'Alpha', 'Gamma']);
		expect(container.querySelector('caption')?.textContent).toBe('Things');
		click(byText(container, 'Load more', 'button'));
		expect(onLoadMore).toHaveBeenCalled();
	});
	it('shows the empty message', () => {
		const { container } = render(
			<Table
				caption="None"
				rows={[]}
				rowKey={() => 'x'}
				columns={[{ key: 'a', header: 'A' }]}
				empty="Nothing here"
				captionHidden={false}
			/>,
		);
		expect(container.textContent).toContain('Nothing here');
	});
});

describe('Tabs', () => {
	it('moves selection and focus with arrow keys, Home and End', () => {
		const onChange = vi.fn();
		const { container } = render(
			<Tabs
				label="Sections"
				onChange={onChange}
				tabs={[
					{ id: 'a', label: 'A', content: 'Panel A' },
					{ id: 'b', label: 'B', content: 'Panel B' },
					{ id: 'c', label: 'C', content: 'Panel C' },
				]}
			/>,
		);
		const list = /** @type {HTMLElement} */ (container.querySelector('[role="tablist"]'));
		const tabs = allByRole(container, 'tab');
		expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
		expect(container.querySelector('[role="tabpanel"]')?.textContent).toBe('Panel A');
		keydown(list, 'ArrowRight');
		expect(onChange).toHaveBeenLastCalledWith('b');
		expect(document.activeElement).toBe(tabs[1]);
		expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(tabs[1]?.id);
		keydown(list, 'End');
		expect(onChange).toHaveBeenLastCalledWith('c');
		keydown(list, 'ArrowRight');
		expect(onChange).toHaveBeenLastCalledWith('a');
		keydown(list, 'ArrowLeft');
		expect(onChange).toHaveBeenLastCalledWith('c');
		keydown(list, 'Home');
		expect(onChange).toHaveBeenLastCalledWith('a');
		keydown(list, 'x');
		click(/** @type {HTMLElement} */ (tabs[2]));
		expect(tabs[2]?.getAttribute('aria-selected')).toBe('true');
	});
	it('TabNav marks the current link', () => {
		const { container } = render(
			<TabNav
				label="Nav"
				current="/b"
				items={[
					{ href: '/a', label: 'A' },
					{ href: '/b', label: 'B' },
				]}
			/>,
		);
		expect(container.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/b');
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
		expect(document.activeElement?.textContent).toBe('Delete');
		expect(dialog.textContent).toContain('Nope');
		click(byText(dialog, 'Delete', 'button'));
		expect(onConfirm).toHaveBeenCalled();
		click(byText(dialog, 'Cancel', 'button'));
		expect(onClose).toHaveBeenCalled();
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
					<button type="button" onClick={() => toast.show({ title: 'Failed', tone: 'danger', durationMs: 100 })}>
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
		click(byText(container, 'ok', 'button'));
		click(byText(container, 'bad', 'button'));
		expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain('Saved');
		expect(container.querySelector('[aria-live="assertive"]')?.textContent).toContain('Failed');
		act(() => {
			vi.advanceTimersByTime(150);
		});
		expect(container.textContent).not.toContain('Failed');
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Dismiss notification"]')));
		expect(container.textContent).not.toContain('Saved');
	});

	it('copies code once, with the shown-once warning for secrets', async () => {
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const onCopy = vi.fn();
		const { container } = render(<CodeBlock code="sk_live_x" label="Secret key" secret onCopy={onCopy} />);
		expect(container.textContent).toContain('shown only once');
		await act(async () => {
			byText(container, 'Copy', 'button').click();
		});
		expect(writeText).toHaveBeenCalledWith('sk_live_x');
		expect(onCopy).toHaveBeenCalledWith(true);
		expect(container.textContent).toContain('Copied');
		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
		/** @type {any} */ (document).execCommand = () => true;
		expect(await copyText('x')).toBe(true);
	});

	it('Form prevents native submission and FormError explains problems', () => {
		const onSubmit = vi.fn();
		/** @type {ReturnType<typeof useFormState<{ email: string }>> | null} */
		let state = null;
		function Harness() {
			state = useFormState({ email: '' });
			return (
				<Form onSubmit={onSubmit}>
					<Input
						label="E-mail"
						value={state.values.email}
						onChange={(e) => state?.set('email', e.currentTarget.value)}
						error={state.errors.email}
					/>
					<FormError problem={state.problem} fields={['email']} />
					<button type="submit">Send</button>
				</Form>
			);
		}
		const { container } = render(<Harness />);
		type(byLabel(container, 'E-mail'), 'a@b.co');
		act(() => {
			container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		});
		expect(onSubmit).toHaveBeenCalledTimes(1);
		act(() =>
			state?.setProblem({
				type: 'https://portal.test/problems/validation_failed',
				status: 422,
				errors: [
					{ path: '/email', message: 'must be an e-mail address' },
					{ path: '/other', message: 'bad' },
				],
			}),
		);
		expect(container.textContent).toContain('Some fields need your attention.');
		expect(container.textContent).toContain('Must be an e-mail address.');
		expect(container.querySelector('li')?.textContent).toContain('other');
		type(byLabel(container, 'E-mail'), 'x@y.co');
		expect(container.textContent).not.toContain('Must be an e-mail address.');
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
		const menu = /** @type {HTMLElement} */ (container.querySelector('button[aria-label="Open navigation"]'));
		expect(menu.getAttribute('aria-expanded')).toBe('false');
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
				sections={[{ items: [{ href: '/home', label: 'Home', badge: <b>3</b> }] }]}
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
		expect(container.querySelector('header')?.children).toHaveLength(1);
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

	it('the console header has a System / Light / Dark switch that stores the choice and sets data-theme', () => {
		const { container } = render(
			<AppShell sections={[{ items: [{ href: '/a', label: 'A' }] }]}>
				<p>Body</p>
			</AppShell>,
		);
		const group = /** @type {HTMLElement} */ (container.querySelector('header [role="group"][aria-label="Theme"]'));
		const button = (/** @type {string} */ label) =>
			/** @type {HTMLElement} */ ([...group.querySelectorAll('button')].find((b) => b.textContent === label));
		expect(button('System').getAttribute('aria-pressed')).toBe('true');
		click(button('Dark'));
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
		expect(button('Dark').getAttribute('aria-pressed')).toBe('true');
		click(button('Light'));
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
		click(button('System'));
		expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
		expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
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
