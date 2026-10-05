import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createConfigurator } from '../headless/configurator.js';
import { createPriceDeltas } from '../headless/priceDeltas.js';
import { createResolver } from '../headless/resolver.js';
import { createUrlSync } from '../headless/urlSync.js';
import { priceOf } from '../core/pricing.js';
import { resolve } from '../core/resolve.js';
import { parseSchema } from '../core/schema.js';
import { decodeSelection, mergeSearch, urlOptionsFrom } from '../core/urlSync.js';
import { publicView } from '../core/views.js';
import { PHONE, compiled } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));
const parsed = parseSchema(PHONE);
if (!parsed.ok) throw new Error('fixture');
const record = {
	id: 'cfg_phone',
	key: 'phone-x',
	name: 'Phone X',
	status: /** @type {const} */ ('published'),
	version: 1,
	schema: parsed.schema,
	createdAt: '',
	updatedAt: '',
	publishedAt: '',
};
const view = publicView(record, parsed.schema);
const phone = compiled(PHONE);

/**
 * A Mode C client backed by the real core (what the API does).
 * @param {{ settings?: Record<string, unknown>, fail?: string | null, inStock?: any }} [options]
 */
const coreClient = ({ settings = {}, fail = null, inStock = 'prefer' } = {}) => {
	/** @type {any[]} */
	const calls = [];
	/** @param {Record<string, any>} body */
	const evaluate = (body) => {
		const options = urlOptionsFrom({});
		const selection = { ...decodeSelection(parsed.schema.groups, body.search ?? '', options), ...(body.selection ?? {}) };
		const result = resolve(phone, { selection, changed: body.changed }, { inStock });
		if (!result.ok) return null;
		const price = priceOf(phone, result);
		return {
			...result,
			price: price.ok ? price.price : null,
			url: { search: mergeSearch(body.search ?? '', parsed.schema.groups, result.selection, options), history: 'replace' },
			notify: result.inStock ? null : { configuratorId: 'cfg_phone', combinationId: result.combination?.id ?? null },
		};
	};
	return {
		calls,
		client: /** @type {any} */ ({
			/** @param {string} ref @param {{ search: string }} query */
			widget: async (ref, query) => {
				calls.push(['widget', ref, query]);
				if (fail === 'widget') return { ok: /** @type {const} */ (false), problem: { code: 'not_found' } };
				return {
					ok: /** @type {const} */ (true),
					value: {
						configurator: view,
						settings: {
							layout: 'pills',
							showPrice: true,
							showSummary: true,
							showOutOfStock: true,
							showAdjustments: true,
							urlSync: true,
							history: 'replace',
							inStock,
							...settings,
						},
						evaluation: fail === 'boot' ? null : evaluate({ search: query.search }),
						problem: fail === 'boot' ? { code: 'no_valid_combination' } : null,
					},
				};
			},
			/** @param {Record<string, any>} body */
			evaluate: async (body) => {
				calls.push(['evaluate', body]);
				if (fail === 'evaluate') return { ok: /** @type {const} */ (false), error: { code: 'rate_limited' } };
				return { ok: /** @type {const} */ (true), value: /** @type {any} */ (evaluate(body)) };
			},
		}),
	};
};

const urlPort = (initial = '') => {
	let search = initial;
	/** @type {Array<[string, string]>} */
	const writes = [];
	return {
		writes,
		port: {
			read: () => search,
			/** @param {string} next @param {'replace' | 'push'} mode */
			write: (next, mode) => {
				search = next;
				writes.push([next, mode]);
			},
		},
	};
};

describe('headless widget (createConfigurator)', () => {
	it('loads from the URL, renders groups with states, price and summary, and writes the URL back', async () => {
		const { client, calls } = coreClient();
		const url = urlPort('?ref=x&storage=512');
		/** @type {Array<[string, any]>} */
		const events = [];
		const widget = createConfigurator({
			strings,
			client,
			configurator: 'phone-x',
			url: url.port,
			emit: (name, data) => events.push([name, data]),
		});
		expect(widget.state()).toMatchObject({ status: 'idle', title: 'Configure' });
		/** @type {string[]} */
		const statuses = [];
		const unsubscribe = widget.subscribe((state) => statuses.push(state.status));
		await widget.actions.load();
		const state = widget.state();
		expect(calls[0]).toEqual(['widget', 'phone-x', { search: '?ref=x&storage=512' }]);
		expect(state).toMatchObject({
			status: 'ready',
			configuratorId: 'cfg_phone',
			title: 'Phone X',
			selection: { storage: '512', color: 'black' },
			inStock: true,
		});
		expect(state.groups.map((group) => [group.key, group.display])).toEqual([
			['storage', 'pills'],
			['color', 'swatches'],
			['addons', 'pills'],
		]);
		expect(state.groups[1]?.options[0]).toMatchObject({
			key: 'black',
			label: 'Black',
			swatch: '#000000',
			selected: true,
			state: 'selected',
			disabled: false,
			stateText: null,
		});
		expect(state.priceText).toBe('€1,000.00');
		expect(state.summary).toEqual([
			{ label: 'Storage', value: '512' },
			{ label: 'Colour', value: 'Black' },
			{ label: 'Add-ons', value: 'None' },
		]);
		expect(url.writes).toEqual([['?ref=x&storage=512&color=black', 'replace']]);
		expect(statuses).toContain('loading');
		unsubscribe();
		await widget.actions.pick('color', 'pink');
		expect(widget.state().selection).toEqual({ storage: '256', color: 'pink' });
		expect(widget.state().notice).toBe('We changed Storage to 256 to match your choice.');
		expect(events.at(-1)).toEqual(['widget.changed', { group: 'color', complete: true, inStock: true }]);
		await widget.actions.toggle('addons', 'charger');
		await widget.actions.toggle('addons', 'case');
		expect(widget.state().selection.addons).toEqual(['case', 'charger']);
		expect(widget.state().summary[2]).toEqual({ label: 'Add-ons', value: 'Case, Charger' });
		await widget.actions.toggle('addons', 'case');
		expect(widget.state().selection.addons).toEqual(['charger']);
		await widget.actions.reset();
		expect(widget.state().selection).toEqual({ storage: '128', color: 'black' });
		expect(url.writes.at(-1)).toEqual(['?ref=x&storage=128&color=black', 'replace']);
	});

	it('explains out-of-stock results, hands them to notify-me, and hides or disables options', async () => {
		const { client } = coreClient();
		/** @type {Array<[string, any]>} */
		const events = [];
		const widget = createConfigurator({
			strings,
			client,
			configurator: 'phone-x',
			emit: (name, data) => events.push([name, data]),
		});
		expect(await widget.actions.requestNotify()).toMatchObject({ ok: false });
		await widget.actions.load();
		await widget.actions.pick('storage', '256');
		await widget.actions.pick('color', 'black');
		expect(widget.state()).toMatchObject({ inStock: false, outOfStockText: 'This combination is out of stock.' });
		expect(await widget.actions.requestNotify()).toEqual({
			ok: true,
			value: { configuratorId: 'cfg_phone', combinationId: 'v2' },
		});
		expect(events.at(-1)).toEqual(['widget.notify_requested', { configuratorId: 'cfg_phone', combinationId: 'v2' }]);
		const hidden = createConfigurator({
			strings,
			client: coreClient({ settings: { showOutOfStock: false, layout: 'dropdowns', showAdjustments: false } }).client,
			configurator: 'phone-x',
		});
		await hidden.actions.load();
		expect(hidden.state().groups[0]?.options.map((option) => option.key)).toEqual(['128', '512']);
		expect(hidden.state().groups.map((group) => group.display)).toEqual(['dropdown', 'swatches', 'dropdown']);
		const required = createConfigurator({
			strings,
			client: coreClient({ inStock: 'require' }).client,
			configurator: 'phone-x',
		});
		await required.actions.load();
		expect(required.state().groups[0]?.options[1]).toMatchObject({
			key: '256',
			state: 'out_of_stock',
			disabled: true,
			stateText: 'out of stock',
		});
		expect(required.state().requireStock).toBe(true);
		const conflict = required.state().groups[1]?.options.find((option) => option.key === 'pink');
		expect(conflict).toMatchObject({ state: 'conflict', stateText: 'changes other choices' });
	});

	it('reports load and evaluation failures as user-facing text', async () => {
		const missing = createConfigurator({ strings, client: coreClient({ fail: 'widget' }).client, configurator: 'nope' });
		await missing.actions.load();
		expect(missing.state()).toMatchObject({ status: 'error', error: 'This configurator is not available.' });
		const broken = createConfigurator({ strings, client: coreClient({ fail: 'boot' }).client, configurator: 'phone-x' });
		await broken.actions.load();
		expect(broken.state().error).toBe('These options cannot be combined.');
		const limited = createConfigurator({ strings, client: coreClient({ fail: 'evaluate' }).client, configurator: 'phone-x' });
		expect(await limited.actions.pick('color', 'pink')).toMatchObject({ ok: false, problem: { code: 'not_loaded' } });
		await limited.actions.load();
		await limited.actions.pick('color', 'pink');
		expect(limited.state()).toMatchObject({ busy: false, error: 'Something went wrong. Please try again.' });
	});

	it('ignores stale responses and stops after destroy', async () => {
		const { client } = coreClient();
		/** @type {Array<() => void>} */
		const gates = [];
		const slow = {
			...client,
			/** @param {Record<string, any>} body */
			evaluate: async (body) => {
				await new Promise((resolveGate) => gates.push(() => resolveGate(undefined)));
				return client.evaluate(body);
			},
		};
		const widget = createConfigurator({ strings, client: slow, configurator: 'phone-x' });
		await widget.actions.load();
		const first = widget.actions.pick('color', 'pink');
		const second = widget.actions.pick('color', 'black');
		gates[1]?.();
		await second;
		gates[0]?.();
		await first;
		expect(widget.state().selection.color).toBe('black');
		widget.destroy();
		const before = widget.state();
		const third = widget.actions.pick('color', 'gold');
		gates[2]?.();
		await third;
		expect(widget.state()).toBe(before);
	});

	it('validates picks before they are sent', async () => {
		const widget = createConfigurator({ strings, client: coreClient().client, configurator: 'phone-x' });
		await widget.actions.load();
		expect(widget.validate({ group: 'storage', value: '128' })).toEqual([]);
		expect(widget.validate({ group: 'storage', value: null })).toEqual([]);
		expect(widget.validate({ group: 'addons', value: ['case'] })).toEqual([]);
		expect(widget.validate({ group: 'nope', value: 'x' })[0]).toMatchObject({ path: '/group', code: 'unknown_group' });
		expect(widget.validate({ group: 'storage', value: '64' })[0]).toMatchObject({ path: '/value', code: 'invalid' });
		expect(widget.validate({ group: 'addons', value: 'case' })[0]?.code).toBe('invalid');
		expect(widget.validate(null)[0]?.code).toBe('unknown_group');
		expect(widget.t('widget.title')).toBe('Configure');
	});

	it('formats quantities and range / text values', async () => {
		const schema = parseSchema({
			name: 'Plan',
			groups: [
				{ key: 'seats', label: 'Seats', type: 'range', min: 1, max: 9, required: true, unitPrice: 100 },
				{ key: 'company', label: 'Company', type: 'text', required: true },
			],
			pricing: { currency: 'USD' },
		});
		if (!schema.ok) throw new Error('fixture');
		const plan = compiled(schema.schema);
		const client = {
			widget: async () => ({
				ok: /** @type {const} */ (true),
				value: /** @type {any} */ ({
					configurator: publicView({ ...record, schema: schema.schema }, schema.schema),
					settings: {
						layout: 'pills',
						showPrice: true,
						showSummary: true,
						showOutOfStock: true,
						showAdjustments: true,
						urlSync: false,
						history: 'replace',
						inStock: 'prefer',
					},
					evaluation: (() => {
						const result = /** @type {any} */ (resolve(plan, { selection: { seats: 3 }, quantity: 2 }));
						const price = priceOf(plan, result);
						return { ...result, price: price.ok ? price.price : null, url: null, notify: null };
					})(),
					problem: null,
				}),
			}),
			evaluate: async () => ({ ok: /** @type {const} */ (false), problem: { code: 'x' } }),
		};
		const widget = createConfigurator({ strings, client, configurator: 'plan' });
		await widget.actions.load();
		expect(widget.state()).toMatchObject({
			priceText: '2 × $3.00 = $6.00',
			missingText: 'Choose Company to continue.',
			complete: false,
		});
		expect(widget.state().summary).toEqual([
			{ label: 'Seats', value: '3' },
			{ label: 'Company', value: 'None' },
		]);
		expect(widget.validate({ group: 'seats', value: 4 })).toEqual([]);
		expect(widget.validate({ group: 'seats', value: 40 })).toHaveLength(1);
		expect(widget.validate({ group: 'company', value: 'Acme' })).toEqual([]);
	});
});

describe('headless resolver (local, Mode B)', () => {
	it('runs the same resolver in the page on the public view', async () => {
		/** @type {Array<[string, any]>} */
		const events = [];
		const resolver = createResolver({
			config: { in_stock: 'require', max_steps: 1000 },
			strings,
			configurator: view,
			now: () => 0,
			emit: (name, data) => events.push([name, data]),
		});
		await Promise.resolve();
		expect(resolver.state()).toMatchObject({ status: 'ready', configuratorId: 'cfg_phone' });
		const result = await resolver.actions.resolve({ selection: { storage: '256', color: 'black' }, changed: 'storage' });
		expect(result.ok && result.value.selection).toEqual({ storage: '256', color: 'pink' });
		expect(events).toEqual([['resolver.resolved', { exact: false, inStock: true }]]);
		const checked = await resolver.actions.check({ selection: { storage: '128', color: 'black' } });
		expect(checked.ok && checked.value.valid).toBe(true);
		/** @type {any[]} */
		const states = [];
		const off = resolver.subscribe((state) => states.push(state));
		await resolver.actions.resolve({});
		off();
		expect(states).toHaveLength(1);
		expect(resolver.validate({ selection: [], quantity: 0 }).map((p) => p.path)).toEqual(['/selection', '/quantity']);
		expect(resolver.validate({})).toEqual([]);
		resolver.destroy();
	});

	it('reports unloaded, invalid and unresolvable configurators', async () => {
		const resolver = createResolver({ strings });
		expect(await resolver.actions.resolve({})).toMatchObject({ ok: false, problem: { code: 'not_loaded' } });
		expect(await resolver.actions.check({})).toMatchObject({ ok: false });
		expect(await resolver.actions.load({ id: 'x', schema: { name: '' } })).toMatchObject({ ok: false });
		expect(resolver.state()).toMatchObject({
			status: 'error',
			problem: { code: 'invalid_configurator', detail: 'The configurator could not be loaded.' },
		});
		await resolver.actions.load({
			id: 'never',
			schema: { name: 'x', groups: [{ key: 'a', options: [{ key: '1' }] }], rules: [{ id: 'r', when: 'true' }] },
		});
		const result = await resolver.actions.resolve({});
		expect(result).toMatchObject({ ok: false, problem: { code: 'no_valid_combination' } });
		expect(resolver.state().problem?.code).toBe('no_valid_combination');
	});
});

describe('headless price deltas (Mode B)', () => {
	it('prices locally with the element rounding, or through the quote client', async () => {
		const pricer = createPriceDeltas({
			config: { rounding_mode: 'up', rounding_increment: 1000 },
			strings,
			configurator: view,
			currency: 'USD',
		});
		const local = await pricer.actions.price({ selection: { storage: '256', color: 'pink' }, combination: { id: 'v3' } });
		expect(local.ok).toBe(true);
		expect(pricer.state()).toMatchObject({ status: 'ready', unitText: '€700.00', totalText: '€700.00' });
		expect(pricer.format(1999, 'GBP')).toBe('£19.99');
		const quotes = /** @type {any[]} */ ([]);
		const remote = createPriceDeltas({
			strings,
			configurator: view,
			client: {
				quote: async (body) => {
					quotes.push(body);
					return { ok: true, value: { price: { currency: 'EUR', unit: 500, total: 1000, quantity: 2 } } };
				},
			},
		});
		const seen = /** @type {any[]} */ ([]);
		const off = remote.subscribe((state) => seen.push(state.status));
		await remote.actions.price({ selection: { storage: '128' }, quantity: 2 });
		off();
		expect(quotes).toEqual([{ configurator: 'cfg_phone', selection: { storage: '128' }, quantity: 2 }]);
		expect(remote.state()).toMatchObject({ unitText: '€5.00', totalText: '€10.00' });
		expect(seen).toEqual(['ready']);
		expect(remote.validate({ selection: {} })).toEqual([]);
		expect(remote.validate({})).toHaveLength(1);
		remote.destroy();
	});

	it('reports failures', async () => {
		const failing = createPriceDeltas({
			strings,
			configurator: view,
			client: { quote: async () => ({ ok: false, problem: { code: 'selection_invalid' } }) },
		});
		expect(await failing.actions.price({ selection: {} })).toMatchObject({ ok: false });
		expect(failing.state().error).toBe('Something went wrong. Please try again.');
		const empty = createPriceDeltas({ strings });
		expect(await empty.actions.price({ selection: {} })).toMatchObject({ ok: false, problem: { code: 'not_loaded' } });
		const huge = createPriceDeltas({
			strings,
			configurator: {
				id: 'x',
				schema: { name: 'x', groups: [{ key: 'n', type: 'range', min: 0, max: 1_000_000_000, unitPrice: 10_000_000_000 }] },
			},
		});
		expect(await huge.actions.price({ selection: { n: 1_000_000_000 } })).toMatchObject({
			ok: false,
			problem: { code: 'price_out_of_range' },
		});
		const unpriced = createPriceDeltas({
			strings,
			configurator: { id: 'x', schema: { name: 'x', groups: [{ key: 'a', options: [{ key: '1' }] }] } },
		});
		await unpriced.actions.price({ selection: { a: '1' } });
		expect(unpriced.state()).toMatchObject({ price: null, unitText: null });
	});
});

describe('headless URL sync (Mode B)', () => {
	it('reads and writes the selection through the URL port', async () => {
		const url = urlPort('?storage=256&utm=1');
		/** @type {Array<[string, any]>} */
		const events = [];
		const sync = createUrlSync({
			config: { history: 'push', canonical: 'selection' },
			strings,
			groups: parsed.schema.groups,
			url: url.port,
			emit: (name, data) => events.push([name, data]),
		});
		expect(sync.state().selection).toEqual({ storage: '256' });
		const written = await sync.actions.write({ storage: '512', color: 'gold' });
		expect(written).toEqual({ ok: true, value: '?utm=1&storage=512&color=gold' });
		expect(url.writes).toEqual([['?utm=1&storage=512&color=gold', 'push']]);
		expect(sync.state()).toMatchObject({ canonical: '?storage=512&color=gold' });
		expect(events).toEqual([['url_sync.written', { params: true }]]);
		const seen = /** @type {any[]} */ ([]);
		const off = sync.subscribe((state) => seen.push(state.selection));
		expect(await sync.actions.read()).toEqual({ ok: true, value: { storage: '512', color: 'gold' } });
		off();
		expect(seen).toHaveLength(1);
		expect(sync.validate({ storage: '1', zz: 1 })).toEqual([
			{ path: '/zz', code: 'unknown_group', message: 'This choice is not valid.' },
		]);
		expect(sync.validate('x')).toHaveLength(1);
		sync.destroy();
		await sync.actions.read();
		expect(sync.state().selection).toEqual({ storage: '512', color: 'gold' });
	});
});
