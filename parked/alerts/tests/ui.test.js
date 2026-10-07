import { describe, expect, it } from 'vitest';
import { createNotifyMe } from '../headless/notifyMe.js';
import { render, styles } from '../ui/notifyMe.js';
import en from '../strings/en.json' with { type: 'json' };
import { createFakeDom, createNotifyMeClient, findAll } from './helpers.js';

/** @param {Partial<import('../headless/notifyMe.js').NotifyMeState>} [patch] */
const stateWith = async (patch = {}) => {
	const element = createNotifyMe({ config: { itemId: 'itm_1' }, strings: en, client: createNotifyMeClient() });
	await element.actions.load();
	return { element, state: { ...element.state(), ...patch } };
};

describe('render (Mode A)', () => {
	it('renders an accessible inline form wired to the headless actions', async () => {
		const { element, state } = await stateWith({ type: 'price_drop', errors: { '/email': 'bad' }, message: 'hello' });
		const dom = createFakeDom();
		const root = render({
			state,
			actions: element.actions,
			strings: en,
			dom,
			slots: { before: dom.createTextNode('B'), after: dom.createTextNode('A') },
		});
		expect(root.tag).toBe('section');
		expect(root.attributes).toMatchObject({
			role: 'region',
			'aria-label': en['capture.title'],
			class: 'ss-notify ss-notify--inline',
		});
		const radios = findAll(root, (node) => node.attributes?.type === 'radio');
		expect(radios.map((node) => node.attributes.value)).toEqual(['back_in_stock', 'price_drop', 'email', 'sms']);
		const input = findAll(root, (node) => node.attributes?.name === 'email')[0];
		expect(input.attributes).toMatchObject({ type: 'email', 'aria-invalid': 'true', required: '' });
		expect(findAll(root, (node) => node.attributes?.name === 'target')).toHaveLength(1);
		const status = findAll(root, (node) => node.attributes?.role === 'status')[0];
		expect(status.textContent).toBe('hello');
		input.dispatch('input', { target: { value: 'jane@example.com' } });
		findAll(root, (node) => node.attributes?.name === 'consent')[0].dispatch('change', { target: { checked: true } });
		findAll(root, (node) => node.attributes?.name === 'target')[0].dispatch('input', { target: { value: '500' } });
		radios[0].dispatch('change');
		radios[3].dispatch('change');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(element.state()).toMatchObject({
			email: 'jane@example.com',
			consent: true,
			targetAmount: '500',
			type: 'back_in_stock',
			channel: 'sms',
		});
		const form = findAll(root, (node) => node.tag === 'form')[0];
		let prevented = false;
		form.dispatch('submit', { preventDefault: () => (prevented = true) });
		expect(prevented).toBe(true);
	});

	it('renders the button variant, phones, single types and the done states', async () => {
		const dom = createFakeDom();
		const { element, state } = await stateWith({
			types: ['custom:vip'],
			type: 'custom:vip',
			channels: ['sms'],
			channel: 'sms',
			requireConsent: false,
			status: 'submitting',
			consent: true,
		});
		const button = render({ state, actions: element.actions, strings: en, theme: { variant: 'button' }, dom });
		expect(findAll(button, (node) => node.tag === 'details')).toHaveLength(1);
		expect(findAll(button, (node) => node.attributes?.name === 'phone')[0].attributes.type).toBe('tel');
		findAll(button, (node) => node.attributes?.name === 'phone')[0].dispatch('input', { target: { value: '+1' } });
		expect(findAll(button, (node) => node.tag === 'button')[0].attributes.disabled).toBe('');
		expect(button.textContent).toContain(en['capture.type.custom']);

		const done = render({
			state: { ...state, status: 'subscribed', identified: true, subscription: { id: 'als_1' }, message: 'ok' },
			actions: element.actions,
			strings: en,
			dom,
		});
		const stop = findAll(done, (node) => node.tag === 'button')[0];
		expect(stop.textContent).toBe(en['capture.unsubscribe']);
		stop.dispatch('click');
		const guest = render({
			state: { ...state, status: 'subscribed', identified: false },
			actions: element.actions,
			strings: en,
			dom,
		});
		expect(findAll(guest, (node) => node.tag === 'button')).toHaveLength(0);
		const empty = render({
			state: { ...state, types: [], status: 'error', message: 'x' },
			actions: element.actions,
			strings: en,
			dom,
		});
		expect(findAll(empty, (node) => node.tag === 'form')).toHaveLength(0);
		expect(findAll(empty, (node) => node.attributes?.class === 'ss-notify__error')).toHaveLength(1);
		const signedIn = render({
			state: {
				...state,
				status: 'ready',
				identified: true,
				allowEntry: false,
				requireConsent: true,
				consent: true,
				errors: { '/consent': 'tick' },
			},
			actions: element.actions,
			strings: en,
			dom,
		});
		expect(findAll(signedIn, (node) => node.tag === 'input' && node.attributes.type === 'tel')).toHaveLength(0);
		expect(findAll(signedIn, (node) => node.attributes?.name === 'consent')[0].attributes.checked).toBe('');
		const typeless = render({
			state: { ...state, status: 'ready', type: null, types: ['back_in_stock'] },
			actions: element.actions,
			strings: en,
			dom,
		});
		expect(typeless.textContent).toContain(en['capture.type.custom']);
	});

	it('uses design tokens only', () => {
		expect(styles).toContain('var(--ss-color-primary)');
		expect(styles).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
	});
});
