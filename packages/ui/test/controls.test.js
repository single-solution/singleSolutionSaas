// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
	AccountMenu,
	Avatar,
	CARD_FLOW,
	Checkbox,
	CheckboxInput,
	CardFlow,
	Col,
	Disclosure,
	Grid,
	Input,
	Masonry,
	RadioGroup,
	SaveBar,
	SegmentedControl,
	Select,
	SettingList,
	SettingRow,
	SettingsCard,
	Switch,
	TextArea,
} from '../src/index.js';
import { Form } from '../src/Form.js';
import { allByRole, byLabel, cleanup, click, keydown, render, type } from '../src/testing.js';

afterEach(cleanup);

/** @param {ParentNode} root @param {string} label */
const button = (root, label) => [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

describe('Switch', () => {
	it('is a native button with the switch role, a name, a description and the state', () => {
		const onChange = vi.fn();
		const { container } = render(
			<Switch label="Allow stacking" description="Codes can be combined" checked={false} onChange={onChange} />,
		);
		const toggle = /** @type {HTMLButtonElement} */ (allByRole(container, 'switch')[0]);
		// a native button: Space and Enter activate it, Tab reaches it
		expect(toggle.tagName).toBe('BUTTON');
		expect(toggle.type).toBe('button');
		expect(toggle.tabIndex).toBe(0);
		expect(byLabel(container, 'Allow stacking')).toBe(toggle);
		expect(toggle.getAttribute('aria-checked')).toBe('false');
		const help = container.querySelector(`#${toggle.getAttribute('aria-describedby')}`);
		expect(help?.textContent).toBe('Codes can be combined');
		click(toggle);
		expect(onChange).toHaveBeenCalledWith(true);
	});

	it('does not toggle when disabled or locked, and a locked one says so', () => {
		const onChange = vi.fn();
		const { container } = render(
			<>
				<Switch label="Off" checked disabled onChange={onChange} />
				<Switch label="Locked" checked locked lockedLabel="Set by your plan" onChange={onChange} />
			</>,
		);
		const [disabled, locked] = /** @type {HTMLButtonElement[]} */ (allByRole(container, 'switch'));
		expect(disabled?.disabled).toBe(true);
		expect(locked?.disabled).toBe(true);
		expect(locked?.getAttribute('aria-readonly')).toBe('true');
		expect(container.querySelector('svg[aria-label="Set by your plan"]')).not.toBeNull();
		click(/** @type {HTMLElement} */ (locked));
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe('RadioGroup', () => {
	const options = [
		{ value: 'a', label: 'Alpha', description: 'The first one' },
		{ value: 'b', label: 'Beta', disabled: true },
		{ value: 'c', label: 'Gamma' },
	];

	/** @param {{ cards?: boolean, onChange?: (value: string) => void }} props */
	function Group({ cards, onChange }) {
		const [value, setValue] = useState('a');
		return (
			<RadioGroup
				legend="Letter"
				options={options}
				value={value}
				cards={cards}
				onChange={(next) => {
					onChange?.(next);
					setValue(next);
				}}
			/>
		);
	}

	it('is a labelled group of native radios; the arrows move the choice and the focus, skipping disabled ones', () => {
		const onChange = vi.fn();
		const { container } = render(<Group onChange={onChange} />);
		expect(container.querySelector('fieldset legend')?.textContent).toBe('Letter');
		// the legend is a floated block, so a hairline on the fieldset (a row list's divider) is not drawn through it
		expect(container.querySelector('fieldset legend')?.className).toContain('float-left');
		expect(container.querySelector('fieldset')?.className).toContain('[&>legend+*]:clear-both');
		const radios = /** @type {HTMLInputElement[]} */ ([...container.querySelectorAll('input[type="radio"]')]);
		expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
		expect(radios[1]?.disabled).toBe(true);
		radios[0]?.focus();
		keydown(/** @type {HTMLElement} */ (radios[0]), 'ArrowDown');
		expect(onChange).toHaveBeenLastCalledWith('c');
		expect(document.activeElement).toBe(radios[2]);
		keydown(/** @type {HTMLElement} */ (radios[2]), 'ArrowRight');
		expect(onChange).toHaveBeenLastCalledWith('a');
		expect(document.activeElement).toBe(radios[0]);
		keydown(/** @type {HTMLElement} */ (radios[0]), 'ArrowUp');
		expect(document.activeElement).toBe(radios[2]);
		keydown(/** @type {HTMLElement} */ (radios[2]), 'Home');
		expect(document.activeElement).toBe(radios[0]);
		keydown(/** @type {HTMLElement} */ (radios[0]), 'End');
		expect(document.activeElement).toBe(radios[2]);
		// keys that are not arrows are left alone
		onChange.mockClear();
		keydown(/** @type {HTMLElement} */ (radios[2]), 'a');
		expect(onChange).not.toHaveBeenCalled();
		click(/** @type {HTMLElement} */ (radios[0]));
		expect(onChange).toHaveBeenLastCalledWith('a');
	});

	it('as radio cards shows each title with its description, linked to the radio', () => {
		const { container } = render(<Group cards />);
		const first = /** @type {HTMLInputElement} */ (container.querySelector('input[type="radio"]'));
		expect(byLabel(container, 'Alpha')).toBe(first);
		const description = container.querySelector(`#${first.getAttribute('aria-describedby')}`);
		expect(description?.textContent).toBe('The first one');
		// the whole card is the click target (a stretched label)
		expect(container.querySelector('label')?.className).toContain('after:absolute');
	});
});

describe('SegmentedControl', () => {
	/** @param {{ onChange?: (value: string) => void, block?: boolean }} props */
	function Segments({ onChange, block }) {
		const [value, setValue] = useState('day');
		return (
			<SegmentedControl
				legend="Range"
				block={block}
				options={[
					{ value: 'day', label: 'Day' },
					{ value: 'week', label: 'Week' },
					{ value: 'month', label: 'Month' },
				]}
				value={value}
				onChange={(next) => {
					onChange?.(next);
					setValue(next);
				}}
			/>
		);
	}

	it('is a labelled group of native radios that moves with the arrows', () => {
		const onChange = vi.fn();
		const { container } = render(<Segments onChange={onChange} />);
		const group = container.querySelector('fieldset');
		expect(group?.querySelector('legend')?.textContent).toBe('Range');
		const radios = /** @type {HTMLInputElement[]} */ ([...container.querySelectorAll('input[type="radio"]')]);
		expect(radios).toHaveLength(3);
		expect(byLabel(container, 'Week')).toBe(radios[1]);
		radios[0]?.focus();
		keydown(/** @type {HTMLElement} */ (radios[0]), 'ArrowRight');
		expect(onChange).toHaveBeenLastCalledWith('week');
		expect(radios[1]?.checked).toBe(true);
		expect(document.activeElement).toBe(radios[1]);
		click(/** @type {HTMLElement} */ (radios[2]));
		expect(onChange).toHaveBeenLastCalledWith('month');
	});

	it('block shares the width between the segments', () => {
		const { container } = render(<Segments block />);
		expect(container.querySelector('label')?.className).toContain('flex-1');
	});
});

describe('Checkbox', () => {
	it('shows the mixed state and leaves it on the next click', () => {
		const onChange = vi.fn();
		const { container, rerender } = render(<Checkbox label="Select all" indeterminate checked={false} onChange={onChange} />);
		const box = byLabel(container, 'Select all');
		expect(box.type).toBe('checkbox');
		expect(box.indeterminate).toBe(true);
		click(box);
		expect(onChange).toHaveBeenCalledTimes(1);
		rerender(<Checkbox label="Select all" checked onChange={onChange} />);
		expect(byLabel(container, 'Select all').indeterminate).toBe(false);
	});

	it('passes the ref of a bare checkbox through', () => {
		/** @type {{ current: HTMLInputElement | null }} */
		const ref = { current: null };
		render(<CheckboxInput aria-label="Row" checked={false} onChange={() => undefined} ref={ref} />);
		expect(ref.current?.getAttribute('aria-label')).toBe('Row');
	});
});

describe('Input adornments', () => {
	it('shows a prefix and a suffix inside the frame and keeps the input labelled', () => {
		const onChange = vi.fn();
		const { container } = render(
			<Input label="Price" prefix="$" suffix="USD" value="12" onChange={onChange} help="Before tax" />,
		);
		const input = byLabel(container, 'Price');
		expect(input.parentElement?.textContent).toBe('$USD');
		expect(input.parentElement?.className).toContain('rounded-control');
		expect(input.getAttribute('aria-describedby')).toContain('-help');
		type(input, '15');
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('marks an invalid adorned input and a plain one', () => {
		const { container } = render(
			<>
				<Input label="Rate" suffix="%" error="Too high" value="" onChange={() => undefined} />
				<Input label="Plain" value="" onChange={() => undefined} />
			</>,
		);
		const rate = byLabel(container, 'Rate');
		expect(rate.getAttribute('aria-invalid')).toBe('true');
		expect(rate.parentElement?.className).toContain('border-danger');
		expect(container.querySelector('[role="alert"]')?.textContent).toBe('Too high');
		expect(byLabel(container, 'Plain').parentElement?.tagName).toBe('DIV');
		expect(byLabel(container, 'Plain').className).toContain('h-9');
	});
});

describe('SettingsCard rows', () => {
	it('lays labelled controls out as rows: label and help left, control and error right, hairlines between', () => {
		const { container } = render(
			<SettingsCard title="Sending" description="How email goes out">
				<SettingList>
					<Input label="Host" help="The SMTP server" error="Required" value="" onChange={() => undefined} />
					<Select label="Mode" options={[{ value: 'a', label: 'A' }]} value="a" onChange={() => undefined} />
					<Switch label="Secure" description="Use TLS" checked={false} />
					<TextArea label="Signature" value="" onChange={() => undefined} />
				</SettingList>
			</SettingsCard>,
		);
		expect(container.querySelector('section h2')?.textContent).toBe('Sending');
		const host = byLabel(container, 'Host');
		const row = /** @type {HTMLElement} */ (host.closest('[data-cell]'));
		// Stripe-like rows: a ~280 px label column, the control at most 560 px wide; they stack in a narrow card
		expect(row.className).toContain('@2xl:grid-cols-[minmax(0,17.5rem)_minmax(0,1fr)]');
		// the label and the help share the left column, the control and its error the right one
		const [left, right] = /** @type {HTMLElement[]} */ ([...row.children]);
		expect(left?.textContent).toContain('Host');
		expect(left?.textContent).toContain('The SMTP server');
		expect(right?.contains(host)).toBe(true);
		expect(right?.querySelector('[role="alert"]')?.textContent).toBe('Required');
		expect(right?.className).toContain('max-w-[35rem]');
		// long text is a row too, its control column a little wider (640 px); no control spans the whole card
		const signature = /** @type {HTMLElement} */ (byLabel(container, 'Signature').closest('[data-cell]'));
		expect(signature.className).toContain('grid-cols-[minmax(0,17.5rem)_minmax(0,1fr)]');
		expect(signature.children[1]?.className).toContain('max-w-[40rem]');
		expect(container.querySelector('[data-cell]')?.parentElement?.className).toContain('[&>[data-cell]+[data-cell]]:border-t');
	});

	it('a Form inside a card is a list of rows with its buttons below', () => {
		const { container } = render(
			<SettingsCard title="Branding">
				<Form onSubmit={() => undefined} aria-label="Branding">
					<Input label="Name" value="" onChange={() => undefined} />
					<button type="submit">Save</button>
				</Form>
			</SettingsCard>,
		);
		const grid = container.querySelector('form > div');
		expect(grid?.className).toContain('flex-col');
		expect(grid?.className).not.toContain('grid-cols-1');
		// outside a card the same form keeps the field grid
		cleanup();
		const plain = render(
			<Form onSubmit={() => undefined} aria-label="Plain">
				<Input label="Name" value="" onChange={() => undefined} />
			</Form>,
		);
		expect(plain.container.querySelector('form > div')?.className).toContain('grid-cols-1');
	});

	it('SettingRow names a custom control by its label or as a group', () => {
		const { container } = render(
			<SettingsCard title="Look">
				<SettingList>
					<SettingRow label="Accent" description="The brand color" htmlFor="accent">
						<input id="accent" type="color" />
					</SettingRow>
					<SettingRow label="Logo" stacked>
						<input type="file" aria-label="Logo file" />
					</SettingRow>
				</SettingList>
			</SettingsCard>,
		);
		expect(byLabel(container, 'Accent').id).toBe('accent');
		const group = /** @type {HTMLElement} */ (container.querySelector('[role="group"]'));
		expect(container.querySelector(`#${group.getAttribute('aria-labelledby')}`)?.textContent).toBe('Logo');
		expect(group.className).not.toContain('grid-cols');
	});
});

describe('SaveBar', () => {
	it('is on screen only when something changed, and reports Save and Discard', () => {
		const onSave = vi.fn();
		const onDiscard = vi.fn();
		const { container, rerender } = render(<SaveBar show={false} onSave={onSave} onDiscard={onDiscard} />);
		expect(container.innerHTML).toBe('');
		rerender(<SaveBar show onSave={onSave} onDiscard={onDiscard} />);
		expect(container.querySelector('[role="status"]')?.textContent).toBe('You have unsaved changes');
		click(/** @type {HTMLElement} */ (button(container, 'Save changes')));
		expect(onSave).toHaveBeenCalledTimes(1);
		click(/** @type {HTMLElement} */ (button(container, 'Discard')));
		expect(onDiscard).toHaveBeenCalledTimes(1);
		rerender(<SaveBar show saving onSave={onSave} onDiscard={onDiscard} />);
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Discard')).disabled).toBe(true);
		expect(/** @type {HTMLButtonElement} */ (button(container, 'Save changes')).getAttribute('aria-busy')).toBe('true');
	});
});

describe('cards keep their own height', () => {
	it('aligns the cells of the grid and masonry to the start so no card stretches', () => {
		const grid = render(
			<Grid>
				<Col span={8}>a</Col>
				<Col span={4}>b</Col>
			</Grid>,
		);
		expect(grid.container.firstElementChild?.className).toContain('items-start');
		expect(grid.container.firstElementChild?.className).not.toContain('items-stretch');
		const masonry = render(
			<Masonry>
				<div>one</div>
			</Masonry>,
		);
		expect(masonry.container.querySelector('.break-inside-avoid, [class*="break-inside-avoid"]')).not.toBeNull();
	});
});

describe('Grid', () => {
	it('spans the 12 columns: a phone gets the whole row', () => {
		const { container } = render(
			<Grid>
				<Col span={8} xl={9}>
					A
				</Col>
				<Col span={4}>B</Col>
			</Grid>,
		);
		const [a, b] = /** @type {HTMLElement[]} */ ([...(container.firstElementChild?.children ?? [])]);
		expect(container.firstElementChild?.className).toContain('grid-cols-12');
		expect(a?.className).toContain('col-span-12');
		expect(a?.className).toContain('md:col-span-8');
		expect(a?.className).toContain('xl:col-span-9');
		expect(b?.className).toContain('md:col-span-4');
	});
});

describe('Disclosure', () => {
	it('is collapsed by default, opens and closes with its bar, and can start open or be forced open', () => {
		const { container } = render(
			<Disclosure title="Advanced" description="Rarely changed">
				<p>Hidden until opened</p>
			</Disclosure>,
		);
		const bar = /** @type {HTMLButtonElement} */ (container.querySelector('button'));
		expect(bar.getAttribute('aria-expanded')).toBe('false');
		expect(container.textContent).not.toContain('Hidden until opened');
		click(bar);
		expect(bar.getAttribute('aria-expanded')).toBe('true');
		expect(container.textContent).toContain('Hidden until opened');
		expect(bar.getAttribute('aria-controls')).toBe(container.querySelector('p')?.parentElement?.id);
		click(bar);
		expect(container.textContent).not.toContain('Hidden until opened');
		const started = render(
			<Disclosure title="More" defaultOpen>
				<p>Open at start</p>
			</Disclosure>,
		);
		expect(started.container.textContent).toContain('Open at start');
		const forced = render(
			<Disclosure title="Errors" forceOpen>
				<p>Forced open</p>
			</Disclosure>,
		);
		expect(forced.container.textContent).toContain('Forced open');
	});
});

describe('AccountMenu', () => {
	it('shows the person as an avatar with name and email, and opens a menu headed by them', () => {
		const onSignOut = vi.fn();
		const { container } = render(
			<AccountMenu
				name="Sara Khan"
				email="sara@shop.test"
				items={[{ label: 'Sign out', onSelect: onSignOut, danger: true }]}
			/>,
		);
		const trigger = /** @type {HTMLButtonElement} */ (container.querySelector('button[aria-haspopup="menu"]'));
		expect(trigger.getAttribute('aria-label')).toBe('Account');
		expect(trigger.textContent).toContain('SK');
		expect(trigger.textContent).toContain('Sara Khan');
		expect(trigger.textContent).toContain('sara@shop.test');
		click(trigger);
		const menu = /** @type {HTMLElement} */ (container.querySelector('[role="menu"]'));
		expect(menu.textContent).toContain('sara@shop.test');
		click(/** @type {HTMLElement} */ (menu.querySelector('[role="menuitem"]')));
		expect(onSignOut).toHaveBeenCalledTimes(1);
	});

	it('compact shows the avatar alone; placement up opens the menu above; initials fall back to the email', () => {
		const { container } = render(
			<>
				<AccountMenu name="mo@shop.test" items={[{ label: 'Sign out', onSelect: () => undefined }]} compact placement="up" />
				<Avatar name="Single" />
				<Avatar name="" size="sm" />
			</>,
		);
		const trigger = /** @type {HTMLButtonElement} */ (container.querySelector('button[aria-haspopup="menu"]'));
		expect(trigger.textContent).toBe('MO');
		click(trigger);
		expect(container.querySelector('[role="menu"]')?.className).toContain('bottom-full');
		const avatars = [...container.querySelectorAll('span[aria-hidden="true"].rounded-full')].map((el) => el.textContent);
		expect(avatars).toEqual(['MO', 'SI', '?']);
	});
});

describe('card flow', () => {
	it('places small cards side by side while there is room: auto-fill columns, natural heights, wide content on its own row', () => {
		expect(CARD_FLOW).toContain('repeat(auto-fill,minmax(min(100%,52rem),1fr))');
		expect(CARD_FLOW).toContain('items-start');
		expect(CARD_FLOW).not.toContain('items-stretch');
		// anything that is not a card takes the whole row; a flagged card takes one column
		expect(CARD_FLOW).toContain('*:col-span-full');
		expect(CARD_FLOW).toContain('[&>[data-flow=card]]:col-auto');
		const { container } = render(
			<CardFlow>
				<SettingsCard title="One">a</SettingsCard>
				<SettingsCard title="Table" wide>
					b
				</SettingsCard>
				<p>Callout</p>
			</CardFlow>,
		);
		expect(container.firstElementChild?.className).toContain('auto-fill');
		const [small, wide, other] = /** @type {HTMLElement[]} */ ([...(container.firstElementChild?.children ?? [])]);
		expect(small?.getAttribute('data-flow')).toBe('card');
		expect(wide?.getAttribute('data-flow')).toBeNull();
		expect(other?.getAttribute('data-flow')).toBeNull();
	});
});
