// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { SchemaForm } from '../src/SchemaForm.js';
import { setMember } from '../src/PlacementField.js';
import { PLACEMENT_MEMBERS, placementMembersOf, validateValue, widgetOf } from '../src/schema.js';
import { byLabel, byText, cleanup, click, render, type } from '../src/testing.js';

afterEach(cleanup);

/** @type {any} */
const NODE = {
	type: 'object',
	title: 'Placement',
	default: { selectors: [{ selector: 'body', position: 'prepend' }] },
	'x-kind': 'placement',
	'x-placement': {
		members: [
			'paths',
			'selectors',
			'pageTypes',
			'devices',
			'referrers',
			'schedule',
			'consent',
			'triggers',
			'frequency',
			'audience',
		],
	},
	'x-plan': { starter: { members: ['selectors', 'devices', 'frequency'] } },
};

/** @param {{ plan?: string | null, onChange?: (name: string, value: unknown) => void, initial?: unknown }} props */
function Harness({ plan = null, onChange, initial = NODE.default }) {
	const [values, setValues] = useState(/** @type {Record<string, unknown>} */ ({ placement: initial }));
	return (
		<SchemaForm
			schema={{ type: 'object', properties: { placement: NODE } }}
			values={values}
			plan={plan}
			idPrefix="p"
			onChange={(name, value) => {
				onChange?.(name, value);
				setValues((v) => ({ ...v, [name]: value }));
			}}
		/>
	);
}

describe('placement features (F.18)', () => {
	it('helpers: widget, members per plan, client checks', () => {
		expect(widgetOf(NODE)).toBe('placement');
		expect(placementMembersOf(NODE, 'starter')).toEqual(['selectors', 'devices', 'frequency']);
		expect(placementMembersOf({ type: 'object', 'x-kind': 'placement' }, null)).toEqual([...PLACEMENT_MEMBERS]);
		expect(validateValue(NODE, { devices: ['mobile'] }, { plan: 'starter' })).toBeNull();
		expect(validateValue(NODE, { audience: 'x' }, { plan: 'starter' })).toMatch(/plan does not include/);
		expect(validateValue({ ...NODE, 'x-placement': { members: ['paths'] } }, { audience: 'x' })).toMatch(/no audience setting/);
		expect(validateValue(NODE, { nope: 1 })).toMatch(/Unknown placement/);
		expect(validateValue(NODE, [])).toBe('Invalid placement.');
		expect(validateValue(NODE, { frequency: 3 })).toBe('Frequency is invalid.');
		expect(validateValue(NODE, { frequency: { maxPerDay: 0 } })).toMatch(/at least 1/);
		expect(validateValue(NODE, { frequency: { cooldown: 'soon' } })).toMatch(/ISO-8601/);
		expect(validateValue(NODE, { frequency: { cooldown: 'P1D', dismissMemory: 'PT30M' } })).toBeNull();
		expect(validateValue(NODE, { triggers: 'x' })).toBe('Triggers are invalid.');
		expect(validateValue(NODE, { triggers: [{ type: 'teleport' }] })).toMatch(/unknown type/);
		expect(validateValue(NODE, { schedule: {} })).toMatch(/time zone/);
		expect(validateValue(NODE, { audience: ' ' })).toMatch(/audience rule/);
		expect(setMember({ a: 1 }, 'a', [])).toEqual({});
		expect(setMember({}, 'b', { c: 1 })).toEqual({ b: { c: 1 } });
	});

	it('edits every member and only shows what the plan allows', () => {
		const onChange = vi.fn();
		const { container } = render(<Harness onChange={onChange} initial={{}} />);
		const last = () => onChange.mock.calls.at(-1)?.[1];
		type(byLabel(container, 'Paths: include'), '/products/**\n/');
		expect(last()).toEqual({ paths: { include: ['/products/**', '/'] } });
		click(byText(container, 'Add a mount point', 'button'));
		type(byLabel(container, 'CSS selector'), '#buy');
		expect(last().selectors).toEqual([{ selector: '#buy', position: 'append' }]);
		type(byLabel(container, 'Position'), 'after');
		expect(last().selectors).toEqual([{ selector: '#buy', position: 'after' }]);
		type(byLabel(container, 'Page types'), 'product');
		click(byLabel(container, 'mobile'));
		expect(last().devices).toEqual(['mobile']);
		type(byLabel(container, 'Referrers: exclude'), '*.spam.example');
		type(byLabel(container, 'Time zone'), 'Europe/Zurich');
		expect(last().schedule).toEqual({ timezone: 'Europe/Zurich' });
		type(byLabel(container, 'Consent categories'), 'marketing');
		click(byText(container, 'Add a trigger', 'button'));
		type(byLabel(container, 'When'), 'scroll');
		type(byLabel(container, 'Scrolled (%)'), '50');
		expect(last().triggers).toEqual([{ type: 'scroll', percent: 50 }]);
		type(byLabel(container, 'Scrolled (%)'), '');
		type(byLabel(container, 'When'), 'exit');
		expect(last().triggers).toEqual([{ type: 'exit' }]);
		type(byLabel(container, 'Max per day'), '2');
		type(byLabel(container, 'Cooldown'), 'P1D');
		type(byLabel(container, 'Remember a dismissal for'), 'P7D');
		expect(last().frequency).toEqual({ maxPerDay: 2, cooldown: 'P1D', dismissMemory: 'P7D' });
		type(byLabel(container, 'Max per day'), '');
		type(byLabel(container, 'Audience rule'), "device == 'mobile'");
		expect(last().audience).toBe("device == 'mobile'");
		const removes = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Remove');
		for (const button of removes) click(button);
		expect(last().selectors).toBeUndefined();
		// JSON editing
		click(byText(container, 'Edit as JSON', 'button'));
		type(byLabel(container, 'Placement (JSON)'), '{"devices":["tablet"]}');
		expect(last()).toEqual({ devices: ['tablet'] });
		type(byLabel(container, 'Placement (JSON)'), '[1]');
		expect(container.textContent).toContain('Enter a JSON object.');
		click(byText(container, 'Back to the form', 'button'));
		cleanup();
		const starter = render(<Harness plan="starter" />);
		expect(starter.container.textContent).not.toContain('Audience rule');
		expect(starter.container.textContent).toContain('Max per session');
		expect(() => byLabel(starter.container, 'Paths: include')).toThrow();
	});
});
