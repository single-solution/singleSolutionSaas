import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { render, styles, update } from '../ui/configurator.js';
import { createFakeDom, findAll } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));

/** @param {string} key @param {Partial<import('../headless/configurator.js').OptionView>} [extra] */
const option = (key, extra = {}) => ({
	key,
	label: key.toUpperCase(),
	description: null,
	swatch: null,
	image: null,
	state: /** @type {const} */ ('available'),
	selected: false,
	disabled: false,
	stateText: null,
	...extra,
});

/** @param {Partial<import('../headless/configurator.js').ConfiguratorState>} [extra] */
const stateOf = (extra = {}) =>
	/** @type {import('../headless/configurator.js').ConfiguratorState} */ ({
		status: 'ready',
		busy: false,
		configuratorId: 'cfg_1',
		title: 'Phone X',
		groups: [
			{
				key: 'storage',
				label: 'Storage',
				description: 'How much space',
				type: 'single',
				display: 'pills',
				required: true,
				value: '256',
				options: [
					option('128'),
					option('256', { selected: true, state: 'selected' }),
					option('512', { state: 'out_of_stock', disabled: true, stateText: 'out of stock' }),
					option('1tb', { state: 'conflict', stateText: 'changes other choices' }),
				],
				min: null,
				max: null,
				step: null,
				maxLength: null,
			},
			{
				key: 'color',
				label: 'Colour',
				description: null,
				type: 'single',
				display: 'swatches',
				required: true,
				value: 'black',
				options: [
					option('black', { swatch: '#000000', selected: true, state: 'selected' }),
					option('photo', { image: 'https://cdn.example.com/p.png' }),
				],
				min: null,
				max: null,
				step: null,
				maxLength: null,
			},
			{
				key: 'addons',
				label: 'Add-ons',
				description: null,
				type: 'multi',
				display: 'pills',
				required: false,
				value: ['case'],
				options: [option('case', { selected: true, state: 'selected' }), option('charger')],
				min: null,
				max: null,
				step: null,
				maxLength: null,
			},
			{
				key: 'model',
				label: 'Model',
				description: 'Pick one',
				type: 'single',
				display: 'dropdown',
				required: false,
				value: null,
				options: [option('a'), option('b', { stateText: 'out of stock', disabled: true })],
				min: null,
				max: null,
				step: null,
				maxLength: null,
			},
			{
				key: 'seats',
				label: 'Seats',
				description: null,
				type: 'range',
				display: 'pills',
				required: true,
				value: 3,
				options: [],
				min: 1,
				max: 9,
				step: 1,
				maxLength: null,
			},
			{
				key: 'note',
				label: 'Engraving',
				description: 'Up to 20 letters',
				type: 'text',
				display: 'pills',
				required: false,
				value: null,
				options: [],
				min: null,
				max: null,
				step: null,
				maxLength: 20,
			},
		],
		selection: { storage: '256', color: 'black', addons: ['case'], seats: 3 },
		complete: true,
		missingText: null,
		inStock: true,
		outOfStockText: null,
		notify: null,
		priceText: '€600.00',
		price: null,
		summary: [{ label: 'Storage', value: '256' }],
		notice: 'We changed Storage to 256 to match your choice.',
		error: null,
		showPrice: true,
		showSummary: true,
		requireStock: true,
		...extra,
	});

const recorder = () => {
	/** @type {Array<[string, ...unknown[]]>} */
	const calls = [];
	return {
		calls,
		actions: {
			/** @param {string} group @param {unknown} value */
			pick: async (group, value) => {
				calls.push(['pick', group, value]);
			},
			/** @param {string} group @param {string} key */
			toggle: async (group, key) => {
				calls.push(['toggle', group, key]);
			},
			requestNotify: async () => {
				calls.push(['notify']);
			},
		},
	};
};

const byFocus = (/** @type {any} */ root, /** @type {string} */ key) =>
	findAll(root, (node) => node.attributes?.['data-ss-focus'] === key)[0];

describe('ui/configurator renderer', () => {
	it('renders accessible radio groups, checkbox groups, selects and inputs with labels', () => {
		const { actions } = recorder();
		const root = render({ state: stateOf(), actions, strings, dom: createFakeDom() });
		expect(root.attributes).toMatchObject({
			role: 'region',
			'aria-label': 'Phone X',
			'aria-busy': 'false',
			class: 'ss-configurator ss-configurator--pills',
		});
		const [radiogroup] = findAll(root, (node) => node.attributes?.role === 'radiogroup');
		const label = findAll(root, (node) => node.attributes?.id === radiogroup.attributes['aria-labelledby'])[0];
		expect(label.textContent).toBe('Storage');
		expect(radiogroup.attributes['aria-describedby']).toBe('ss-cfg-cfg_1-storage-hint');
		const radios = findAll(radiogroup, (node) => node.attributes?.role === 'radio');
		expect(
			radios.map((node) => [node.attributes['aria-checked'], node.attributes.tabindex, node.attributes['data-state']]),
		).toEqual([
			['false', '-1', 'available'],
			['true', '0', 'selected'],
			['false', '-1', 'out_of_stock'],
			['false', '-1', 'conflict'],
		]);
		expect(radios[2].attributes['aria-disabled']).toBe('true');
		expect(radios[2].textContent).toBe('512 (out of stock)');
		const swatches = findAll(root, (node) => node.attributes?.class?.includes('ss-configurator__option--swatch'));
		expect(swatches[0].attributes.title).toBe('BLACK');
		expect(findAll(swatches[0], (node) => node.attributes?.class === 'ss-configurator__swatch')[0].styles).toEqual({
			'--ss-swatch': '#000000',
		});
		expect(findAll(swatches[1], (node) => node.tag === 'img')[0].attributes).toMatchObject({
			src: 'https://cdn.example.com/p.png',
			alt: '',
		});
		const checkboxes = findAll(root, (node) => node.attributes?.role === 'checkbox');
		expect(checkboxes.map((node) => node.attributes['aria-checked'])).toEqual(['true', 'false']);
		expect(findAll(root, (node) => node.attributes?.role === 'group')).toHaveLength(1);
		const [select] = findAll(root, (node) => node.tag === 'select');
		expect(select.attributes).toMatchObject({
			id: 'ss-cfg-cfg_1-model-control',
			'aria-describedby': 'ss-cfg-cfg_1-model-hint',
		});
		expect(findAll(root, (node) => node.tag === 'label' && node.attributes.for === 'ss-cfg-cfg_1-model-control')).toHaveLength(
			1,
		);
		expect(select.children.map((/** @type {any} */ node) => node.textContent)).toEqual(['None', 'A', 'B (out of stock)']);
		expect(select.children[0].attributes.selected).toBe('');
		expect(select.children[2].attributes.disabled).toBe('');
		const inputs = findAll(root, (node) => node.tag === 'input');
		expect(inputs.map((node) => node.attributes.type)).toEqual(['number', 'text']);
		expect(inputs[0].attributes).toMatchObject({ min: '1', max: '9', step: '1', value: '3', required: '' });
		expect(inputs[1].attributes).toMatchObject({ maxlength: '20', value: '', 'aria-describedby': 'ss-cfg-cfg_1-note-hint' });
		expect(findAll(root, (node) => node.attributes?.role === 'status')[0].textContent).toBe(
			'We changed Storage to 256 to match your choice.',
		);
		expect(findAll(root, (node) => node.attributes?.class === 'ss-configurator__price')[0].textContent).toBe('€600.00');
		expect(findAll(root, (node) => node.tag === 'dl')[0].textContent).toBe('Storage256');
	});

	it('chooses with clicks, Space / Enter and arrow keys (radio pattern), skipping disabled options', () => {
		const { calls, actions } = recorder();
		const dom = createFakeDom();
		const root = render({ state: stateOf(), actions, strings, dom });
		const radios = findAll(root, (node) => node.attributes?.role === 'radio');
		radios[0].dispatch('click');
		radios[1].dispatch('click');
		radios[2].dispatch('click');
		let prevented = 0;
		const key = (/** @type {any} */ node, /** @type {string} */ name) =>
			node.dispatch('keydown', { key: name, preventDefault: () => (prevented += 1) });
		key(radios[1], 'ArrowRight');
		expect(dom.activeElement).toBe(radios[3]);
		key(radios[1], 'ArrowLeft');
		key(radios[1], 'ArrowUp');
		key(radios[3], 'ArrowDown');
		key(radios[1], 'Home');
		key(radios[1], 'End');
		key(radios[0], ' ');
		key(radios[3], 'Enter');
		key(radios[2], 'ArrowRight');
		key(radios[0], 'Tab');
		expect(calls).toEqual([
			['pick', 'storage', '128'],
			['pick', 'storage', '1tb'],
			['pick', 'storage', '128'],
			['pick', 'storage', '128'],
			['pick', 'storage', '128'],
			['pick', 'storage', '128'],
			['pick', 'storage', '1tb'],
			['pick', 'storage', '128'],
			['pick', 'storage', '1tb'],
		]);
		expect(prevented).toBe(9);
		const checkboxes = findAll(root, (node) => node.attributes?.role === 'checkbox');
		checkboxes[1].dispatch('click');
		const [select] = findAll(root, (node) => node.tag === 'select');
		select.dispatch('change', { target: { value: 'a' } });
		select.dispatch('change', { target: { value: '' } });
		const inputs = findAll(root, (node) => node.tag === 'input');
		inputs[0].dispatch('change', { target: { value: '7' } });
		inputs[0].dispatch('change', { target: { value: '' } });
		inputs[1].dispatch('change', { target: { value: 'Ada' } });
		inputs[1].dispatch('change', {});
		expect(calls.slice(9)).toEqual([
			['toggle', 'addons', 'charger'],
			['pick', 'model', 'a'],
			['pick', 'model', null],
			['pick', 'seats', 7],
			['pick', 'seats', null],
			['pick', 'note', 'Ada'],
			['pick', 'note', null],
		]);
	});

	it('keeps keyboard focus on the same control across updates', () => {
		const { actions } = recorder();
		const dom = createFakeDom();
		const parent = dom.createElement('div');
		const first = render({ state: stateOf(), actions, strings, dom });
		parent.append(first);
		byFocus(first, 'storage::128').focus();
		const next = update(first, { state: stateOf({ busy: true }), actions, strings, dom });
		expect(parent.children[0]).toBe(next);
		expect(next.attributes['aria-busy']).toBe('true');
		expect(dom.activeElement).toBe(byFocus(next, 'storage::128'));
		dom.activeElement = null;
		const third = update(next, { state: stateOf(), actions, strings, dom });
		expect(dom.activeElement).toBeNull();
		expect(update(null, { state: stateOf(), actions, strings, dom })).toBeTruthy();
		expect(third).not.toBe(next);
	});

	it('renders loading, out-of-stock with notify-me, missing, error, slots and the dropdowns variant', () => {
		const { calls, actions } = recorder();
		const dom = createFakeDom();
		const loading = render({ state: stateOf({ status: 'loading', groups: [], configuratorId: null }), actions, strings, dom });
		expect(loading.attributes['aria-busy']).toBe('true');
		expect(loading.textContent).toContain('Loading options…');
		const sold = render({
			state: stateOf({
				outOfStockText: 'Sold out',
				notify: { configuratorId: 'cfg_1' },
				notice: null,
				missingText: 'Choose Colour to continue.',
				error: 'Oops',
				showPrice: false,
				showSummary: false,
			}),
			actions,
			strings,
			theme: { variant: 'dropdowns', idPrefix: 'my widget' },
			slots: { before: dom.createTextNode('B'), after: dom.createTextNode('A'), summary: dom.createTextNode('S') },
			dom,
		});
		expect(sold.attributes.class).toBe('ss-configurator ss-configurator--dropdowns');
		expect(findAll(sold, (node) => node.attributes?.role === 'note')[0].textContent).toBe('Sold out');
		expect(findAll(sold, (node) => node.attributes?.role === 'alert')[0].textContent).toBe('Oops');
		expect(findAll(sold, (node) => node.attributes?.role === 'status')[0].textContent).toBe('Choose Colour to continue.');
		expect(findAll(sold, (node) => node.attributes?.class === 'ss-configurator__price')[0].children).toEqual([]);
		expect(sold.children[0].text).toBe('B');
		expect(sold.children.at(-1).text).toBe('A');
		expect(findAll(sold, (node) => node.tag === 'dl')).toHaveLength(0);
		expect(findAll(sold, (node) => node.tag === 'select').map((node) => node.attributes.id)).toEqual([
			'my_widget-storage-control',
			'my_widget-model-control',
		]);
		expect(findAll(sold, (node) => node.attributes?.role === 'radiogroup')).toHaveLength(1);
		findAll(sold, (node) => node.attributes?.class === 'ss-configurator__notify')[0].dispatch('click');
		expect(calls).toEqual([['notify']]);
		const noNotify = render({ state: stateOf({ outOfStockText: 'Sold out', notify: null }), actions, strings, dom });
		expect(findAll(noNotify, (node) => node.attributes?.class === 'ss-configurator__notify')).toHaveLength(0);
		const summary = render({ state: stateOf({ groups: [], notice: null }), actions, strings, dom });
		expect(findAll(summary, (node) => node.tag === 'dl')).toHaveLength(0);
	});

	it('uses design tokens only and stays inside its budget', () => {
		expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
		expect(styles).toMatch(/var\(--ss-color-focus\)/);
		expect(styles).toMatch(/:focus-visible/);
		expect(styles).toMatch(/prefers-reduced-motion/);
		const source = ['../ui/configurator.js', '../headless/strings.js', '../core/strings.js'].map((file) =>
			readFileSync(new URL(file, import.meta.url)),
		);
		expect(gzipSync(Buffer.concat(source)).length).toBeLessThan(16 * 1024);
	});
});
