/**
 * Sample configurators for the dashboard editor ("Start from") and the docs — deliberately unrelated to each other (apparel, a
 * computer, a SaaS plan) to show that the schema is generic. Amounts are integer minor units; the samples carry no
 * currency, so the website's (or none) applies.
 */

/** @type {ReadonlyArray<Record<string, any>>} */
export const SAMPLES = Object.freeze([
	{
		key: 'classic-tee',
		name: 'Classic tee',
		description: 'Size × colour with a variant matrix and stock.',
		groups: [
			{
				key: 'color',
				label: 'Colour',
				display: 'swatches',
				default: 'navy',
				options: [
					{ key: 'navy', label: 'Navy', swatch: '#1f2a44' },
					{ key: 'sand', label: 'Sand', swatch: '#d8c8a8' },
					{ key: 'forest', label: 'Forest', swatch: '#2f5d3a' },
				],
			},
			{
				key: 'size',
				label: 'Size',
				options: [{ key: 'S' }, { key: 'M' }, { key: 'L' }, { key: 'XL', priceDelta: 200 }],
			},
		],
		combinations: [
			{ id: 'tee-navy-s', sku: 'TEE-NV-S', options: { color: 'navy', size: 'S' }, stock: 4 },
			{ id: 'tee-navy-m', sku: 'TEE-NV-M', options: { color: 'navy', size: 'M' }, stock: 0 },
			{ id: 'tee-navy-l', sku: 'TEE-NV-L', options: { color: 'navy', size: 'L' }, stock: 7 },
			{ id: 'tee-sand-m', sku: 'TEE-SD-M', options: { color: 'sand', size: 'M' }, stock: 3 },
			{ id: 'tee-sand-xl', sku: 'TEE-SD-XL', options: { color: 'sand', size: 'XL' }, stock: 2 },
			{ id: 'tee-forest-l', sku: 'TEE-FR-L', options: { color: 'forest', size: ['L', 'XL'] }, stock: 5 },
		],
		pricing: { base: 1900 },
	},
	{
		key: 'workstation',
		name: 'Workstation',
		description: 'Memory and storage with an exclusion rule, optional add-ons and rounding.',
		groups: [
			{
				key: 'memory',
				label: 'Memory',
				options: [
					{ key: '16gb', label: '16 GB' },
					{ key: '32gb', label: '32 GB', priceDelta: 15000 },
					{ key: '64gb', label: '64 GB', priceDelta: 40000 },
				],
			},
			{
				key: 'storage',
				label: 'Storage',
				options: [
					{ key: '512gb', label: '512 GB' },
					{ key: '1tb', label: '1 TB', priceDelta: 10000 },
					{ key: '4tb', label: '4 TB', priceDelta: 45000 },
				],
			},
			{
				key: 'extras',
				label: 'Extras',
				type: 'multi',
				required: false,
				maxSelect: 2,
				options: [
					{ key: 'warranty', label: 'Extended warranty', priceDelta: 9900 },
					{ key: 'gpu', label: 'Graphics card', priceDelta: 60000, when: "selection.memory != '16gb'" },
					{ key: 'setup', label: 'Setup service', priceDelta: 4900 },
				],
			},
			{ key: 'engraving', label: 'Engraving', type: 'text', required: false, maxLength: 30 },
		],
		rules: [
			{
				id: 'no-4tb-on-16gb',
				when: "selection.memory == '16gb' and selection.storage == '4tb'",
				message: '4 TB needs at least 32 GB.',
			},
		],
		pricing: {
			base: 89900,
			rules: [{ id: 'bundle', when: 'len(selection.extras) == 2', percent: -500 }],
			rounding: { mode: 'nearest', increment: 100, ending: 99 },
		},
	},
	{
		key: 'team-plan',
		name: 'Team plan',
		description: 'A SaaS plan builder: plan, seats (range with a unit price) and add-ons that depend on the plan.',
		groups: [
			{
				key: 'plan',
				label: 'Plan',
				default: 'team',
				options: [
					{ key: 'team', label: 'Team' },
					{ key: 'business', label: 'Business', priceDelta: 5000 },
				],
			},
			{ key: 'seats', label: 'Seats', type: 'range', min: 1, max: 50, step: 1, default: 5, unitPrice: 800 },
			{
				key: 'addons',
				label: 'Add-ons',
				type: 'multi',
				required: false,
				options: [
					{ key: 'sso', label: 'Single sign-on', priceDelta: 3000, when: "selection.plan == 'business'" },
					{ key: 'audit', label: 'Audit log', priceDelta: 1500 },
				],
			},
		],
		rules: [
			{ id: 'team-max-20', when: "selection.plan == 'team' and selection.seats > 20", message: 'Team covers up to 20 seats.' },
		],
		pricing: { base: 0, rules: [{ id: 'volume', when: 'selection.seats >= 25', percent: -1000 }] },
	},
]);
