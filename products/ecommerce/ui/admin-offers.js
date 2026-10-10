/**
 * Coupons, deals and bundles in the promotions admin widget (PLAN 0.8.8 Promotions, 0.6): each a list-and-detail
 * screen — search, Active / Off chips, the main Add action (New coupon, deal or bundle) and, for coupons, Generate codes
 * in the list's More menu (a batch of random codes, downloadable as CSV); each row with its state (active, off,
 * scheduled, ended or used up), the discount and its uses — beside one offer read fresh: its figures and what it
 * applies to, with Edit and Turn on / Turn off as buttons, and Duplicate and Delete (last, in danger text, behind its
 * typed confirmation) in the More menu. Editors open in dialogs (`./admin-offer-fields.js`).
 * @module
 */
import { toCsv } from '../core/csv.js';
import { query } from './admin-kit.js';
import { card, chipFilter, detailHead, listScreen } from './admin-lists.js';
import { bundleFields, couponFields, dealFields } from './admin-offer-fields.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Tone} Tone */
/** @typedef {import('./admin-lists.js').Detail} Detail */
/** @typedef {import('./admin-offer-fields.js').Searches} Searches */
/** @typedef {import('./admin-offer-fields.js').Part} Part */
/** @typedef {'coupons' | 'deals' | 'bundles'} Kind */

/**
 * An offer's state now, with its tone: off, ended, scheduled, used up or active.
 * @param {any} item
 * @param {number} now
 * @returns {{ key: string, tone: Tone }}
 */
const stateOf = (item, now) => {
	if (!item.active) return { key: 'off', tone: 'neutral' };
	if (item.endsAt && Date.parse(item.endsAt) <= now) return { key: 'ended', tone: 'neutral' };
	if (item.startsAt && Date.parse(item.startsAt) > now) return { key: 'scheduled', tone: 'warning' };
	if (typeof item.limit === 'number' && item.used >= item.limit) return { key: 'usedUp', tone: 'warning' };
	return { key: 'live', tone: 'success' };
};

/**
 * What an offer takes off, for people.
 * @param {Kit} kit @param {any} item
 */
const valueOf = (kit, item) => {
	if (item.type === 'percent') return kit.t('promotionsAdmin.percentText', { value: item.value });
	if (item.type === 'fixed') return kit.money(item.value);
	if (item.type === 'free_delivery') return kit.t('promotionsAdmin.couponType.free_delivery');
	if (item.type === 'buy_x_get_y')
		return kit.t('promotionsAdmin.buyGetText', { buy: item.buy, get: item.get, percent: item.value });
	return item.price ? kit.money(item.price) : kit.t('promotionsAdmin.percentText', { value: item.value });
};

/**
 * How each kind of offer is named and edited.
 * @type {Record<Kind, { label: (item: any) => string, fields: (kit: Kit, searches: Searches, names: Map<string, string>,
 *   item: any) => Part, copy: (item: any) => any }>}
 */
const KINDS = {
	coupons: {
		label: (item) => item.code,
		fields: (kit, searches, names, item) => couponFields(kit, searches, names, item, true),
		copy: (item) => ({ ...item, code: '' }),
	},
	deals: { label: (item) => item.name, fields: dealFields, copy: (item) => item },
	bundles: { label: (item) => item.name, fields: bundleFields, copy: (item) => item },
};

/**
 * A section of offers.
 * @param {Kit} kit @param {HTMLElement} panel @param {Searches} searches @param {Kind} kind
 */
export const offersTab = (kit, panel, searches, kind) => {
	const { t, h } = kit;
	const spec = KINDS[kind];
	const path = `/v1/admin/${kind}`;
	/** @type {Map<string, string>} */
	const names = new Map();
	const known = searches.names().then((found) => {
		for (const [id, name] of found) names.set(id, name);
	});
	const reload = () => void screen.reload();
	const search = kit.input('', { type: 'search' });
	const chips = chipFilter(kit, {
		label: t('promotionsAdmin.activeFilter'),
		choices: [
			{ value: '', label: t('admin.all') },
			{ value: 'true', label: t('promotionsAdmin.active') },
			{ value: 'false', label: t('promotionsAdmin.inactive') },
		],
		onChange: reload,
	});
	const form = h('form', { class: 'row inline' }, [
		kit.field(t('admin.search'), search),
		kit.text('button', { type: 'submit', class: 'secondary' }, t('admin.searchButton')),
	]);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		reload();
	});

	/**
	 * The editor in a dialog: a new offer (null), a copy, or a change of one.
	 * @param {any} item @param {boolean} create
	 * @param {(saved: any) => void} done
	 */
	const editor = async (item, create, done) => {
		await known;
		const part = spec.fields(kit, searches, names, item ?? {});
		kit.dialog({
			title: create ? t(`promotionsAdmin.new.${kind}`) : t('admin.editing', { name: spec.label(item) }),
			body: part.nodes,
			submitLabel: t('admin.save'),
			wide: true,
			onSubmit: async () => {
				const body = part.values();
				if (!body) return t('admin.checkNumbers');
				const answer = await kit.call(create ? 'POST' : 'PATCH', create ? path : `${path}/${item.id}`, body);
				if (!answer.ok) return kit.reason(answer);
				done(answer.data);
				return null;
			},
		});
	};
	/** @param {any} saved */
	const created = async (saved) => {
		await screen.reload(String(saved.id));
		kit.say(screen.line, t('admin.saved'));
	};

	const screen = listScreen(kit, panel, {
		title: t(`promotionsAdmin.${kind}`),
		path: (cursor) => `${path}${query({ q: search.value.trim(), active: chips.value(), cursor })}`,
		row: (item) => {
			const state = stateOf(item, Date.now());
			return {
				name: spec.label(item),
				figure: valueOf(kit, item),
				meta: [
					t(`promotionsAdmin.state.${state.key}`),
					t('promotionsAdmin.usedText', { used: item.used, limit: item.limit ?? '∞' }),
					item.endsAt ? t('promotionsAdmin.endsOn', { when: kit.when(item.endsAt) }) : '',
				]
					.filter(Boolean)
					.join(' · '),
				tone: state.tone,
				toneLabel: t(`promotionsAdmin.state.${state.key}`),
			};
		},
		open: (item, detail) => offerDetail(kit, { path, kind, item, detail, names, known, editor, created }),
		empty: t(`promotionsAdmin.empty.${kind}`),
		nothing: t(`promotionsAdmin.nothing.${kind}`),
		actions: [
			kit.button(t(`promotionsAdmin.new.${kind}`), () => editor(null, true, created), { primary: true }),
			kind === 'coupons' ? kit.moreMenu([{ label: t('promotionsAdmin.batch'), onSelect: () => batch() }]) : null,
		],
		filters: [form, chips.node],
	});

	/** Generate many coupons with random codes; the codes are shown with Download codes. */
	const batch = async () => {
		await known;
		const prefix = kit.input('', { maxlength: '30' });
		const count = kit.input('10', { type: 'number', min: '1', max: '500', step: '1' });
		const part = couponFields(kit, searches, names, {}, false);
		kit.dialog({
			title: t('promotionsAdmin.batch'),
			body: [
				h('div', { class: 'fields' }, [
					kit.field(t('promotionsAdmin.prefix'), prefix),
					kit.field(t('promotionsAdmin.count'), count),
				]),
				...part.nodes,
			],
			submitLabel: t('promotionsAdmin.generate'),
			wide: true,
			onSubmit: async () => {
				const coupon = part.values();
				if (!coupon) return t('admin.checkNumbers');
				const answer = await kit.call('POST', `${path}/batch`, {
					prefix: prefix.value.trim(),
					count: Number(count.value),
					coupon,
				});
				if (!answer.ok) return kit.reason(answer);
				/** @type {string[]} */
				const codes = answer.data.codes ?? [];
				void screen.reload();
				kit.dialog({
					title: t('promotionsAdmin.generated', { count: answer.data.created }),
					body: [kit.text('p', {}, codes.join(', '))],
					submitLabel: t('promotionsAdmin.downloadCodes'),
					onSubmit: () => {
						kit.save(
							'coupon-codes.csv',
							toCsv(
								[t('promotionsAdmin.code')],
								codes.map((code) => [code]),
							),
						);
					},
				});
				return null;
			},
		});
	};

	void screen.reload();
};

/**
 * @typedef {object} OfferContext
 * @property {string} path the kind's address
 * @property {Kind} kind
 * @property {any} item the list's row
 * @property {Detail} detail
 * @property {Map<string, string>} names names of products, categories and brands
 * @property {Promise<void>} known the names of categories and brands, once read
 * @property {(item: any, create: boolean, done: (saved: any) => void) => Promise<void>} editor
 * @property {(saved: any) => Promise<void>} created after a copy is saved
 */

/**
 * Show one offer in the detail pane, read fresh.
 * @param {Kit} kit @param {OfferContext} context
 */
const offerDetail = async (kit, context) => {
	const { detail } = context;
	const line = kit.status();
	kit.put(detail.pane, [detail.back, line]);
	const [answer] = await Promise.all([kit.call('GET', `${context.path}/${context.item.id}`), context.known]);
	if (answer.ok) await productNames(kit, context.names, answer.data);
	if (!detail.current()) return;
	if (answer.ok) renderOffer(kit, context, answer.data, '');
	else kit.fail(line, answer);
};

/**
 * Read the names of the products an offer names (its scopes and bundle items) that are not known yet, 20 at a time
 * (`GET /v1/admin/products?ids=`); when the ticket cannot read the catalog the ids stay.
 * @param {Kit} kit @param {Map<string, string>} names @param {any} item
 */
const productNames = async (kit, names, item) => {
	/** @type {string[]} */
	const wanted = [
		...(item.scope?.productIds ?? []),
		...(item.getScope?.productIds ?? []),
		...(item.items ?? []).map((/** @type {any} */ entry) => entry.productId),
	];
	const ids = [...new Set(wanted)].filter((id) => !names.has(id));
	for (let start = 0; start < ids.length; start += 20) {
		const answer = await kit.call(
			'GET',
			`/v1/admin/products${query({ ids: ids.slice(start, start + 20).join(','), limit: 20 })}`,
		);
		if (!answer.ok) return;
		for (const found of answer.data.items ?? []) names.set(found.id, found.name);
	}
};

/**
 * @param {Kit} kit @param {OfferContext} context @param {any} item @param {string} message
 */
const renderOffer = (kit, context, item, message) => {
	const { t, h } = kit;
	const { kind, path, detail, names } = context;
	const spec = KINDS[kind];
	const note = kit.status();
	const state = stateOf(item, Date.now());
	/** @param {any} saved @param {string} text */
	const done = (saved, text) => {
		renderOffer(kit, context, saved, text);
		detail.changed(saved);
	};
	const toggle = async () => {
		const answer = await kit.call('PATCH', `${path}/${item.id}`, { active: !item.active });
		if (!answer.ok) return kit.fail(note, answer);
		done(answer.data, t(item.active ? 'promotionsAdmin.turnedOff' : 'promotionsAdmin.turnedOn'));
		return answer;
	};
	const remove = () =>
		kit.dialog({
			title: t('promotionsAdmin.deleteTitle', { name: spec.label(item) }),
			body: [kit.text('p', {}, t('promotionsAdmin.deleteHint'))],
			submitLabel: t('admin.delete'),
			danger: true,
			confirmText: spec.label(item),
			onSubmit: async () => {
				const answer = await kit.call('DELETE', `${path}/${item.id}`);
				if (!answer.ok) return kit.reason(answer);
				await detail.reload();
				return null;
			},
		});
	/** @param {string[]} ids */
	const named = (ids) => ids.map((id) => names.get(id) ?? id).join(', ');
	/** @param {string} title @param {any} scope */
	const scopeCard = (title, scope) =>
		card(kit, title, [
			scope && scope.productIds.length + scope.categoryIds.length + scope.brandIds.length > 0
				? kit.fieldGrid([
						[t('promotionsAdmin.products'), named(scope.productIds)],
						[t('promotionsAdmin.categories'), named(scope.categoryIds)],
						[t('promotionsAdmin.brands'), named(scope.brandIds)],
					])
				: kit.text('p', { class: 'muted' }, t('promotionsAdmin.everything')),
		]);
	/** @param {string | null} at */
	const time = (at) => (at ? kit.when(at) : '');
	const common = [
		[t('promotionsAdmin.startsAt'), time(item.startsAt)],
		[t('promotionsAdmin.endsAt'), time(item.endsAt)],
		[
			t('promotionsAdmin.limitShort'),
			item.limit === null || item.limit === undefined ? t('promotionsAdmin.noLimit') : String(item.limit),
		],
		[t('promotionsAdmin.used'), String(item.used ?? 0)],
	];
	/** @type {Array<[string, string]>} */
	const facts =
		kind === 'coupons'
			? [
					[t('promotionsAdmin.type'), t(`promotionsAdmin.couponType.${item.type}`)],
					[t('promotionsAdmin.discountShort'), valueOf(kit, item)],
					[
						t('promotionsAdmin.maxDiscountShort'),
						item.type === 'percent' && item.maxDiscount ? kit.money(item.maxDiscount) : '',
					],
					[t('promotionsAdmin.minSubtotalShort'), item.minSubtotal ? kit.money(item.minSubtotal) : ''],
					[t('promotionsAdmin.perCustomerShort'), item.perCustomer ? String(item.perCustomer) : ''],
					[t('promotionsAdmin.firstOrderOnly'), item.firstOrderOnly ? t('admin.yes') : ''],
				]
			: kind === 'deals'
				? [
						[t('promotionsAdmin.type'), t(`promotionsAdmin.dealType.${item.type}`)],
						[t('promotionsAdmin.discountShort'), valueOf(kit, item)],
						[t('promotionsAdmin.priority'), String(item.priority ?? 0)],
						[t('promotionsAdmin.description'), item.description ?? ''],
					]
				: [
						[t('promotionsAdmin.type'), t(`promotionsAdmin.bundleType.${item.type}`)],
						[t('promotionsAdmin.discountShort'), valueOf(kit, item)],
					];
	const cards =
		kind === 'bundles' && item.type === 'bundle'
			? [
					card(kit, t('promotionsAdmin.bundleItems'), [
						kit.table(
							[t('promotionsAdmin.product'), t('promotionsAdmin.quantity')],
							(item.items ?? []).map((/** @type {any} */ entry) => [
								names.get(entry.productId) ?? entry.productId,
								String(entry.quantity),
							]),
						),
					]),
				]
			: kind === 'bundles'
				? [scopeCard(t('promotionsAdmin.buyScope'), item.scope), scopeCard(t('promotionsAdmin.getScope'), item.getScope)]
				: [scopeCard(t('promotionsAdmin.scope'), item.scope)];
	kit.put(detail.pane, [
		detail.back,
		detailHead(
			kit,
			[spec.label(item), kit.badge(t(`promotionsAdmin.state.${state.key}`), state.tone)],
			[
				kit.button(t('admin.edit'), () => context.editor(item, false, (saved) => done(saved, t('admin.saved'))), {
					primary: true,
				}),
				kit.button(t(item.active ? 'promotionsAdmin.turnOff' : 'promotionsAdmin.turnOn'), toggle),
				kit.moreMenu([
					{ label: t('promotionsAdmin.duplicate'), onSelect: () => context.editor(spec.copy(item), true, context.created) },
					{ label: t('admin.delete'), onSelect: remove, danger: true },
				]),
			],
		),
		note,
		kit.fieldGrid([...facts, .../** @type {Array<[string, string]>} */ (common)]),
		h('div', {}, [kit.masonry(cards)]),
	]);
	kit.say(note, message);
};
