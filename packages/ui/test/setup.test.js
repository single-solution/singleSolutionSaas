// @vitest-environment jsdom
/**
 * The setup steps of a product dashboard's Overview: a product's requirements (settings, lists, "one of these features
 * on") become steps from the real state, each with the section of its button; a link names a section with no more than
 * the feature's name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardProvider, settingSectionOf, useSetupSteps, wantsSettings } from '../src/dashboard.js';
import { SectionLayout } from '../src/index.js';
import { act, cleanup, render } from '../src/testing.js';

const MANIFEST = {
	features: [
		{ key: 'catalog', name: 'Catalog', dependsOn: [] },
		{ key: 'checkout', name: 'Checkout', dependsOn: ['catalog'] },
		{ key: 'shipping', name: 'Shipping', dependsOn: ['checkout'] },
	],
};

/** @param {string} group @param {boolean} [advanced] */
const field = (group, advanced = false) => ({
	type: 'string',
	title: 'x',
	default: '',
	'x-ui': { group, ...(advanced ? { advanced: true } : {}) },
});

/** A schema with four groups and an Advanced block, and one with a single group. */
const SCHEMAS = {
	catalog: {
		properties: {
			currency: field('Basics'),
			productUrl: field('Page addresses'),
			unit: field('Units and uploads'),
			cache: field('Basics', true),
		},
	},
	checkout: { properties: { guests: field('Guests') } },
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	window.history.replaceState(null, '', '/');
});

describe('settingSectionOf', () => {
	it('names the feature’s view of the setting’s group when the feature shows its groups as views, else the feature', () => {
		const feature = (/** @type {keyof typeof SCHEMAS} */ key) => ({ key, name: key, schema: SCHEMAS[key], values: {} });
		expect(settingSectionOf(feature('catalog'), 'productUrl', 'Advanced')).toBe('catalog.page-addresses');
		expect(settingSectionOf(feature('catalog'), 'unit', 'Advanced')).toBe('catalog.units-and-uploads');
		expect(settingSectionOf(feature('catalog'), 'cache', 'Advanced')).toBe('catalog.advanced');
		// one group: the feature itself (its first view)
		expect(settingSectionOf(feature('checkout'), 'guests', 'Advanced')).toBe('checkout');
		expect(settingSectionOf(feature('catalog'), 'missing', 'Advanced')).toBe('catalog');
	});
});

describe('a link names a section with the name of the feature', () => {
	it('opens the first view of a feature that has several', () => {
		window.history.replaceState(null, '', '/#catalog');
		const sections = [
			{ id: 'seo', label: 'Search', content: <p>Search cards</p> },
			{
				id: 'catalog',
				label: 'Catalog',
				content: null,
				children: [
					{ id: 'catalog.basics', label: 'Basics', content: <p>Basics cards</p> },
					{ id: 'catalog.page-addresses', label: 'Page addresses', content: <p>Address cards</p> },
				],
			},
		];
		const { container } = render(<SectionLayout sections={sections} />);
		expect(/** @type {HTMLElement} */ (container.querySelector('[id="section-catalog.basics"]')).hidden).toBe(false);
		expect(/** @type {HTMLElement} */ (container.querySelector('[id="section-seo"]')).hidden).toBe(true);
	});
});

/** @type {import('../src/dashboard-setup.js').SetupRequirement[]} */
const REQUIREMENTS = [
	{ key: 'pay', oneOf: ['checkout', 'shipping'], label: 'Switch on a way to sell', why: 'Why one.', action: 'See features' },
	{
		key: 'url',
		when: ['catalog'],
		setting: 'catalog.productUrl',
		confirm: true,
		label: 'Set the address',
		why: 'Why two.',
		action: 'Set address',
		detail: (value) => `Now ${String(value)}`,
	},
	{
		key: 'guests',
		when: ['checkout'],
		setting: 'checkout.guests',
		optional: true,
		label: 'Guests',
		why: 'Why three.',
		action: 'Choose',
	},
	{
		key: 'zone',
		when: ['shipping'],
		list: 'zones',
		done: (value) => Array.isArray(value) && value.some((zone) => zone.rates.length > 0),
		label: 'Add a zone',
		why: 'Why four.',
		action: 'Open zones',
		section: 'shipping.zones',
	},
	{
		key: 'later',
		when: ['shipping'],
		after: 'storage',
		setting: 'catalog.currency',
		label: 'After storage',
		why: 'Why five.',
		action: 'Go',
	},
];

/** The steps as the hook makes them, printed. @param {{ overview: any, websiteId: string, open: (tab: string, section?: string) => void, settings?: any }} props */
function Steps(props) {
	const steps = useSetupSteps(props, REQUIREMENTS);
	return (
		<ul>
			{steps.map((step) => (
				<li key={step.key} data-done={String(step.done)} data-optional={String(Boolean(step.optional))}>
					<button type="button" onClick={step.onSelect}>
						{step.actionLabel}
					</button>
					{step.detail}
				</li>
			))}
		</ul>
	);
}

/** @param {{ on: string[], connections?: Array<{ name: string, status: string }>, zones?: unknown[] }} state */
const serve = ({ on, connections = [], zones = [] }) => {
	const answers = /** @type {Record<string, unknown>} */ ({
		'/v1/dashboard/websites/w1/settings': {
			features: [
				{
					key: 'catalog',
					on: true,
					schema: SCHEMAS.catalog,
					values: {
						productUrl: { value: '/products/{slug}', source: 'built-in' },
						currency: { value: '', source: 'built-in' },
					},
				},
				{ key: 'checkout', on: true, schema: SCHEMAS.checkout, values: { guests: { value: 'off', source: 'website' } } },
			],
		},
		'/v1/dashboard/websites/w1/lists/zones': { value: zones },
	});
	const fetch = vi.fn(async (/** @type {string} */ path) =>
		path in answers ? new Response(JSON.stringify(answers[path]), { status: 200 }) : new Response('{}', { status: 404 }),
	);
	vi.stubGlobal('fetch', fetch);
	return {
		overview: { ok: /** @type {const} */ (true), data: { featuresOn: on, checklist: { connections } } },
		calls: () => fetch.mock.calls.map(([path]) => String(path)),
	};
};

const settle = async () => {
	for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

/** @param {HTMLElement} container */
const rows = (container) =>
	Object.fromEntries(
		[...container.querySelectorAll('li')].map((li) => [li.textContent, [li.dataset.done, li.dataset.optional]]),
	);

describe('useSetupSteps', () => {
	it('ticks each step from the saved state, shows only what the switched-on features need, and opens the exact section', async () => {
		const { overview, calls } = serve({
			on: ['catalog', 'checkout', 'shipping'],
			zones: [{ rates: [] }],
		});
		const open = vi.fn();
		const { container } = render(
			<DashboardProvider manifest={MANIFEST} texts={{ title: 'Shop' }}>
				<Steps overview={overview} websiteId="w1" open={open} />
			</DashboardProvider>,
		);
		await settle();
		// the built-in address is only a start: it is to do; a choice made (guests) is done; a zone without a rate is to do
		expect(rows(container)).toEqual({
			'See features': ['true', 'false'],
			'Set addressNow /products/{slug}': ['false', 'false'],
			Choose: ['true', 'true'],
			'Open zones': ['false', 'false'],
		});
		// the settings are read once and the list once
		expect(calls().sort()).toEqual(['/v1/dashboard/websites/w1/lists/zones', '/v1/dashboard/websites/w1/settings']);
		const press = async (/** @type {string} */ label) =>
			act(async () =>
				/** @type {HTMLButtonElement} */ (
					[...container.querySelectorAll('button')].find((b) => b.textContent === label)
				).click(),
			);
		await press('Set address');
		await press('Open zones');
		await press('See features');
		await press('Choose');
		expect(open.mock.calls).toEqual([
			['settings', 'catalog.page-addresses'],
			['settings', 'shipping.zones'],
			['features'],
			['settings', 'checkout'],
		]);
	});

	it('leaves out a step whose feature is off or whose connection is not connected yet, and reads nothing it does not need', async () => {
		const { overview, calls } = serve({ on: ['checkout'] });
		render(
			<DashboardProvider manifest={MANIFEST} texts={{ title: 'Shop' }}>
				<Steps overview={overview} websiteId="w1" open={() => undefined} />
			</DashboardProvider>,
		);
		await settle();
		// Catalog and Shipping are off: no address step, no zone step, no list read
		expect(calls()).toEqual(['/v1/dashboard/websites/w1/settings']);
		cleanup();
		const ready = serve({
			on: ['shipping'],
			connections: [{ name: 'storage', status: 'connected' }],
			zones: [{ rates: [{}] }],
		});
		const second = render(
			<DashboardProvider manifest={MANIFEST} texts={{ title: 'Shop' }}>
				<Steps overview={ready.overview} websiteId="w1" open={() => undefined} />
			</DashboardProvider>,
		);
		await settle();
		// the zone has a rate; "After storage" shows now that storage is connected
		expect(rows(second.container)).toMatchObject({ 'Open zones': ['true', 'false'], Go: ['false', 'false'] });
	});

	it('knows when a product needs the settings read', () => {
		const answer = { ok: /** @type {const} */ (true), data: { featuresOn: ['shipping'] } };
		expect(wantsSettings(answer, REQUIREMENTS)).toBe(true);
		expect(wantsSettings({ ok: true, data: { featuresOn: [] } }, REQUIREMENTS)).toBe(false);
		expect(wantsSettings(null, REQUIREMENTS)).toBe(false);
	});
});

describe('a setting only the merchant can settle', () => {
	it('is ticked when saved on this website, not when the Owner’s Defaults or the built-in value stand', async () => {
		/** @param {string} source */
		const run = async (source) => {
			vi.stubGlobal(
				'fetch',
				vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								features: [{ key: 'catalog', on: true, schema: {}, values: { currency: { value: 'EUR', source } } }],
							}),
							{ status: 200 },
						),
				),
			);
			/** @param {{ overview: any, websiteId: string, open: () => void }} props */
			const Own = (props) => {
				const steps = useSetupSteps(props, [
					{
						key: 'currency',
						when: ['catalog'],
						setting: 'catalog.currency',
						own: true,
						label: 'Currency',
						why: 'Why.',
						action: 'Set',
					},
				]);
				return <p>{steps.map((step) => `${step.key}:${step.done}`).join(',')}</p>;
			};
			const view = render(
				<DashboardProvider manifest={MANIFEST} texts={{ title: 'Shop' }}>
					<Own
						overview={{ ok: true, data: { featuresOn: ['catalog'], checklist: { connections: [] } } }}
						websiteId="w1"
						open={() => undefined}
					/>
				</DashboardProvider>,
			);
			await settle();
			const text = view.container.textContent;
			cleanup();
			return text;
		};
		expect(await run('default')).toBe('currency:false');
		expect(await run('built-in')).toBe('currency:false');
		expect(await run('website')).toBe('currency:true');
	});
});
