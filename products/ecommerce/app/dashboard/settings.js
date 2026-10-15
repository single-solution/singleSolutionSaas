'use client';
/**
 * Settings tab (PLAN 0.4.3, 0.8.8): the kit's settings forms of the features the viewer may see, split into sections per
 * area of the shop (picked from an inner list, so no long scroll), with the list editors (order flow, couriers,
 * delivery zones, tax rules, grades, booking hours, role prices), the widget texts, the theme and the Format (PLAN 0.8.10 K7, side
 * by side in one masonry). Forms are rendered from the schemas the settings API returns; the `checkout` feature's
 * settings are spread over Checkout and payment, Orders and messages, and Policies. A section shows only when it has
 * something for the visible features (merchants: switched-on features; admins: all, off ones marked). Text settings
 * with room for long values (addresses and templates) span the row; with Atlas Search picked, the catalog card says
 * which index to create and links the docs. Defaults uses the same sections for the global defaults.
 * @module
 */
import { startTransition, useState } from 'react';
import { Callout, Masonry, Section, Select, SwapTransition, cx } from '@ss/ui';
import { call, fill, useLoad } from './api.js';
import { GradesEditor } from './grades.js';
import { ItemTypesEditor } from './item-types.js';
import { OrderFlowEditor } from './flow-editor.js';
import {
	AddressRegionsEditor,
	BookingHoursEditor,
	CouriersEditor,
	RolePricesEditor,
	TaxRulesEditor,
	ZonesEditor,
} from './lists.js';
import { FormatForm, Loaded, SettingsForms, TextsForm, ThemeForm, hasSettings } from './parts.js';
import { TEXTS } from './texts.js';

/** @typedef {import('./parts.js').FeatureSettings} FeatureSettings */
/** @typedef {keyof typeof TEXTS.settings.sections} SectionId */

/** Sections in order. */
const SECTION_ORDER = /** @type {SectionId[]} */ ([
	'catalog',
	'variants',
	'grades',
	'checkout',
	'cod',
	'delivery',
	'taxes',
	'orders',
	'invoices',
	'couriers',
	'promotions',
	'loyalty',
	'rolePrices',
	'reviews',
	'wishlist',
	'returns',
	'reports',
	'seo',
	'ai',
	'policies',
	'texts',
	'theme',
	'other',
]);

/** The section of each feature's settings. @type {Readonly<Record<string, SectionId>>} */
const FEATURE_SECTION = Object.freeze({
	catalog: 'catalog',
	size_charts: 'catalog',
	digital_goods: 'catalog',
	bookings: 'catalog',
	csv: 'catalog',
	bulk_actions: 'catalog',
	variants: 'variants',
	multi_location: 'variants',
	grades_serials: 'grades',
	checkout: 'checkout',
	cod: 'cod',
	delivery_zones: 'delivery',
	taxes: 'taxes',
	invoices: 'invoices',
	courier_apis: 'couriers',
	coupons: 'promotions',
	deals: 'promotions',
	bundles: 'promotions',
	loyalty: 'loyalty',
	role_pricing: 'rolePrices',
	reviews: 'reviews',
	wishlist: 'wishlist',
	alerts: 'wishlist',
	compare: 'wishlist',
	returns: 'returns',
	reports: 'reports',
	seo: 'seo',
	landing_pages: 'seo',
	feeds: 'seo',
	llms_txt: 'seo',
	ai_copy: 'ai',
});

/** Checkout settings shown under Orders and messages (the rest of checkout's go to Checkout and payment or Policies). */
const ORDER_SETTINGS = new Set([
	'numberPattern',
	'numberPrefix',
	'numberSuffix',
	'numberDigits',
	'messageChannels',
	'editPricing',
	'deleteGivesBack',
]);

/**
 * The section of one setting.
 * @param {string} feature
 * @param {string} name
 * @returns {SectionId}
 */
const sectionOf = (feature, name) => {
	if (feature === 'checkout') return name.startsWith('policy') ? 'policies' : ORDER_SETTINGS.has(name) ? 'orders' : 'checkout';
	return FEATURE_SECTION[feature] ?? 'other';
};

/** Text settings this long or longer (addresses and templates with placeholders) span the row of their form. */
const WIDE_TEXT = 200;

/**
 * A setting's schema with long text spanning the row (PLAN 0.6 fields in a grid): a text setting without choices and
 * with room for at least `WIDE_TEXT` characters is wide unless its schema says otherwise.
 * @param {Record<string, any>} node
 * @returns {Record<string, any>}
 */
const widened = (node) =>
	node.type === 'string' && !node.enum && Number(node.maxLength) >= WIDE_TEXT && typeof node['x-ui']?.wide !== 'boolean'
		? { ...node, 'x-ui': { ...node['x-ui'], wide: true } }
		: node;

/**
 * The features' settings that belong to a section: each feature with only those settings (features with none left out).
 * @param {FeatureSettings[]} features
 * @param {SectionId} section
 * @returns {FeatureSettings[]}
 */
const settingsIn = (features, section) =>
	features.filter(hasSettings).flatMap((feature) => {
		/** @type {Record<string, any>} */
		const properties = feature.schema.properties;
		const names = Object.keys(properties).filter((name) => sectionOf(feature.key, name) === section);
		if (names.length === 0) return [];
		return [
			{
				...feature,
				schema: {
					...feature.schema,
					properties: Object.fromEntries(names.map((name) => [name, widened(properties[name])])),
				},
				values: Object.fromEntries(Object.entries(feature.values).filter(([name]) => names.includes(name))),
			},
		];
	});

/**
 * The sections picked from an inner list, and the picked one's forms (a masonry) and extras (list editors, texts and
 * theme, each the full width of the section under the forms). The list sits beside the section where
 * the content area is at least 64rem wide and is a select above it in a narrower one (its container, not the screen:
 * PLAN 0.6 medium widths).
 * @param {{ features: FeatureSettings[], forms: (features: FeatureSettings[]) => import('react').ReactNode,
 *   extras: Partial<Record<SectionId, import('react').ReactNode>> }} props
 */
export function SettingsSections({ features, forms, extras }) {
	const [picked, setPicked] = useState(/** @type {SectionId | null} */ (null));
	/** The picked section cross-fades in (PLAN 0.6 motion). @param {SectionId} id */
	const pick = (id) => startTransition(() => setPicked(id));
	const shown = SECTION_ORDER.map((id) => ({ id, features: settingsIn(features, id) })).filter(
		(section) => section.features.length > 0 || (extras[section.id] ?? null) !== null,
	);
	const active = shown.find((section) => section.id === picked) ?? shown[0];
	if (!active) return <p className="text-sm text-muted">{TEXTS.settings.nothing}</p>;
	const S = TEXTS.settings.sections;
	return (
		<div className="@container min-w-0">
			<div className="grid gap-6 @5xl:grid-cols-[15rem_minmax(0,1fr)] @5xl:items-start">
				<nav aria-label={TEXTS.settings.sectionsLabel} className="min-w-0 @5xl:sticky @5xl:top-24">
					<div className="max-w-md @5xl:hidden">
						<Select
							label={TEXTS.settings.section}
							value={active.id}
							options={shown.map((section) => ({ value: section.id, label: S[section.id].title }))}
							onChange={(event) => pick(/** @type {SectionId} */ (event.target.value))}
						/>
					</div>
					<ul className="hidden space-y-0.5 rounded-card border border-line-soft bg-surface p-2 @5xl:block">
						{shown.map((section) => (
							<li key={section.id}>
								<button
									type="button"
									aria-current={section.id === active.id ? 'true' : undefined}
									onClick={() => pick(section.id)}
									className={cx(
										'ss-motion ss-press w-full rounded-[10px] px-3 py-2 text-left text-sm',
										'focus-visible:outline-2 focus-visible:outline-focus',
										section.id === active.id
											? 'bg-primary-soft font-semibold text-on-primary-soft'
											: 'font-medium text-fg/80 hover:bg-surface-2 hover:text-fg',
									)}>
									{S[section.id].title}
								</button>
							</li>
						))}
					</ul>
				</nav>
				<SwapTransition id={active.id}>
					<Section title={S[active.id].title} description={S[active.id].help}>
						{active.features.length > 0 ? (
							<Masonry columns={2} wideAlone>
								{forms(active.features)}
							</Masonry>
						) : null}
						{extras[active.id] ?? null}
					</Section>
				</SwapTransition>
			</div>
		</div>
	);
}

/**
 * The notice on a feature's settings card: with the `catalog` setting `search` or `chatSearch` at `atlas` (saved or
 * being edited), the index Atlas Search needs and where the docs explain it (E14, SF-13).
 * @param {string} key the feature
 * @param {Record<string, unknown>} values its settings shown in this section, edits included
 * @returns {import('react').ReactNode}
 */
export const settingsNotice = (key, values) =>
	key === 'catalog' && (values.search === 'atlas' || values.chatSearch === 'atlas') ? (
		<Callout
			tone="info"
			className="mb-4"
			actions={
				<a className="text-sm font-semibold text-primary hover:underline" href="/docs#atlas-search">
					{TEXTS.settings.atlasDocs}
				</a>
			}>
			{fill(TEXTS.settings.atlasNotice, { index: String(values.searchIndex || 'ss_ecommerce_products_search') })}
		</Callout>
	) : null;

/** @param {import('./tabs.js').TabProps} props */
export function SettingsTab({ websiteId: id }) {
	const websiteId = /** @type {string} */ (id);
	const base = `/v1/dashboard/websites/${websiteId}`;
	const settings = useLoad(`${base}/settings`);
	const texts = useLoad(`${base}/texts`);
	const theme = useLoad(`${base}/theme`);
	const format = useLoad(`${base}/format`);
	return (
		<Loaded answer={settings.answer}>
			{(data) => {
				/** @type {FeatureSettings[]} */
				const features = data.features;
				/** @param {string} key */
				const seen = (key) => features.some((feature) => feature.key === key);
				/** @param {string} key */
				const off = (key) => features.find((feature) => feature.key === key)?.on === false;
				const currency = String(features.find((feature) => feature.key === 'catalog')?.values.currency?.value ?? '');
				return (
					<SettingsSections
						features={features}
						forms={(shown) => (
							<SettingsForms
								features={shown}
								saveUrl={(key) => `${base}/settings/${encodeURIComponent(key)}`}
								resetBody={false}
								savedSource="website"
								reload={settings.reload}
								notice={settingsNotice}
							/>
						)}
						extras={{
							catalog: (
								<>
									<ItemTypesEditor websiteId={websiteId} off={off('catalog')} />
									{seen('bookings') ? <BookingHoursEditor websiteId={websiteId} off={off('bookings')} /> : null}
								</>
							),
							grades: seen('grades_serials') ? <GradesEditor websiteId={websiteId} off={off('grades_serials')} /> : null,
							checkout: seen('checkout') ? <AddressRegionsEditor websiteId={websiteId} off={off('checkout')} /> : null,
							delivery: seen('delivery_zones') ? (
								<ZonesEditor websiteId={websiteId} off={off('delivery_zones')} currency={currency} />
							) : null,
							taxes: seen('taxes') ? <TaxRulesEditor websiteId={websiteId} off={off('taxes')} /> : null,
							orders: seen('checkout') ? <OrderFlowEditor websiteId={websiteId} off={off('checkout')} /> : null,
							couriers: seen('checkout') ? <CouriersEditor websiteId={websiteId} off={off('checkout')} /> : null,
							rolePrices: seen('role_pricing') ? (
								<RolePricesEditor websiteId={websiteId} off={off('role_pricing')} />
							) : null,
							texts: (
								<Loaded answer={texts.answer}>
									{(found) => (
										<TextsForm
											texts={found.texts}
											saveUrl={(key) => `${base}/texts/${encodeURIComponent(key)}`}
											resetBody={false}
											savedSource="website"
											reload={texts.reload}
										/>
									)}
								</Loaded>
							),
							theme: (
								<Masonry columns={2} wideAlone>
									<Loaded answer={theme.answer}>
										{(found) => (
											<ThemeForm
												theme={found.theme}
												save={(next) => call('PUT', `${base}/theme`, next)}
												reload={theme.reload}
											/>
										)}
									</Loaded>
									<Loaded answer={format.answer}>
										{(found) => (
											<FormatForm
												format={found.format}
												save={(next) => call('PUT', `${base}/format`, next)}
												reload={format.reload}
											/>
										)}
									</Loaded>
								</Masonry>
							),
						}}
					/>
				);
			}}
		</Loaded>
	);
}
