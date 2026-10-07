/**
 * Response views (pure). Public views (`pk_` keys, widgets, feeds) carry only what shoppers may see: visible
 * collections, public custom fields, stock as a state unless the website shows quantities, and **never** the private
 * cost. Owner views (`sk_` keys, the dashboard) carry everything; cost only when `api.expose_cost` allows it.
 * @module
 */
import { optionLabel } from './attributes.js';
import { publicCustom } from './fields.js';
import { mediaUrl, mediaView, orderedMedia } from './media.js';
import { statusDef } from './items.js';
import { availabilityOf } from './variants.js';
import { fill } from './text.js';

/** @param {unknown} value */
const iso = (value) => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null);

/**
 * @typedef {object} ViewContext
 * @property {import('./items.js').ItemSettings & Record<string, any>} items
 * @property {{ trackInventory: boolean, backorders: 'deny' | 'allow', lowStock: number, showQuantity: boolean }} stock
 * @property {import('./media.js').MediaSettings} media
 * @property {readonly import('./attributes.js').Attribute[]} attributes
 * @property {string | null} currency the item's effective currency
 * @property {{ id: string, slug: string, name: string } | null} brand
 * @property {string} domain the website's domain
 * @property {string | null} [lang]
 * @property {ReadonlySet<string> | null} [visibleCollections] null = every collection
 * @property {ReadonlyMap<string, string>} [signed] signed links of storage keys
 */

/**
 * The item's URL on the website (`items.item_url_template`).
 * @param {Record<string, any>} item
 * @param {{ template: string, domain: string }} context
 */
export const itemUrl = (item, { template, domain }) =>
	fill(template, { domain, slug: encodeURIComponent(item.slug), id: encodeURIComponent(item.id), type: item.type });

/**
 * Title, summary, description and SEO in the requested language (the default text when there is no translation).
 * @param {Record<string, any>} item
 * @param {string | null | undefined} lang
 */
export const localized = (item, lang) => {
	const t = lang ? item.translations?.[lang] : undefined;
	return {
		title: t?.title ?? item.title,
		summary: t?.summary ?? item.summary ?? null,
		description: t?.description ?? item.description ?? null,
		seo: { title: t?.seo?.title ?? item.seo?.title ?? null, description: t?.seo?.description ?? item.seo?.description ?? null },
		lang: t ? lang : null,
	};
};

/**
 * Option dimensions with labels (only the values used by active variants, in attribute order).
 * @param {Record<string, any>} item
 * @param {readonly import('./attributes.js').Attribute[]} attributes
 */
export const optionsView = (item, attributes) =>
	(item.options ?? []).map((/** @type {string} */ key) => {
		const attribute = attributes.find((a) => a.key === key);
		const used = new Set(
			(item.variants ?? [])
				.filter((/** @type {any} */ v) => v.status !== 'inactive')
				.map((/** @type {any} */ v) => v.options?.[key])
				.filter(Boolean),
		);
		const values = attribute
			? attribute.options
					.filter((o) => used.has(o.value))
					.map((o) => ({ value: o.value, label: optionLabel(attribute, o.value) }))
			: [...used].map((value) => ({ value, label: String(value) }));
		return { key, label: attribute?.label ?? key, values };
	});

/**
 * A variant for shoppers.
 * @param {import('./variants.js').Variant} variant
 * @param {ViewContext['stock']} stock
 */
export const publicVariant = (variant, stock) => {
	const availability = availabilityOf(variant, stock);
	return {
		id: variant.id,
		sku: variant.sku,
		title: variant.title,
		options: variant.options,
		price: variant.price,
		compareAtPrice: variant.compareAtPrice,
		availability: availability.state,
		purchasable: availability.purchasable,
		...(stock.showQuantity && availability.tracked ? { quantity: Math.max(0, variant.quantity) } : {}),
		mediaIds: variant.mediaIds,
	};
};

/**
 * A variant for the merchant (cost only when exposed).
 * @param {import('./variants.js').Variant} variant
 * @param {ViewContext['stock']} stock
 * @param {boolean} exposeCost
 * @param {string} itemId
 */
export const ownerVariant = (variant, stock, exposeCost, itemId) => {
	const availability = availabilityOf(variant, stock);
	const { cost, ...rest } = variant;
	return {
		...rest,
		itemId,
		...(exposeCost ? { cost } : {}),
		availability: availability.state,
		purchasable: availability.purchasable,
		lowStock: availability.state === 'low_stock',
	};
};

/**
 * @param {Record<string, any>} item
 * @param {ViewContext} context
 * @param {string} title
 */
const mediaOf = (item, context, title) =>
	orderedMedia(item.media ?? []).map((media, index) =>
		mediaView(media, {
			settings: context.media,
			index,
			title,
			brand: context.brand?.name ?? null,
			...(context.signed ? { signed: context.signed } : {}),
		}),
	);

/**
 * An item for shoppers (`pk_`).
 * @param {Record<string, any>} item
 * @param {ViewContext} context
 */
export const publicItem = (item, context) => {
	const text = localized(item, context.lang);
	const type = context.items.item_types.find((t) => t.key === item.type);
	const visible = context.visibleCollections;
	return {
		id: item.id,
		slug: item.slug,
		url: itemUrl(item, { template: context.items.item_url_template, domain: context.domain }),
		type: item.type,
		kind: type?.kind ?? 'other',
		requiresShipping: type?.requires_shipping ?? type?.kind === 'physical',
		...text,
		brand: context.brand ? { id: context.brand.id, slug: context.brand.slug, name: context.brand.name } : null,
		collectionIds: visible
			? (item.collectionIds ?? []).filter((/** @type {string} */ id) => visible.has(id))
			: (item.collectionIds ?? []),
		attributes: item.attributes ?? {},
		custom: publicCustom(context.items.custom_fields, item.custom),
		tags: item.tags ?? [],
		currency: context.currency,
		priceMin: item.priceMin ?? null,
		priceMax: item.priceMax ?? null,
		...listingFields(item, context),
		inStock: item.inStock === true,
		options: optionsView(item, context.attributes),
		variants: [...(item.variants ?? [])]
			.filter((v) => v.status !== 'inactive')
			.sort((a, b) => a.position - b.position)
			.map((v) => publicVariant(v, context.stock)),
		media: mediaOf(item, context, text.title),
		createdAt: iso(item.createdAt),
		updatedAt: iso(item.updatedAt),
	};
};

/**
 * Card fields of a public item (listing widgets): the lowest price of a purchasable variant (else of any) with its
 * compare-at price, and the first image's URL.
 * @param {Record<string, any>} item
 * @param {ViewContext} context
 */
export const listingFields = (item, context) => {
	const active = (item.variants ?? []).filter((/** @type {any} */ v) => v.status !== 'inactive');
	const purchasable = active.filter((/** @type {any} */ v) => availabilityOf(v, context.stock).purchasable);
	const cheapest = [...(purchasable.length > 0 ? purchasable : active)].sort((a, b) => a.price - b.price)[0];
	const image = orderedMedia(item.media ?? []).find(
		(m) => m.kind === 'image' && mediaUrl(m, { baseUrl: context.media.storage_base_url }),
	);
	return {
		price: cheapest?.price ?? null,
		compareAtPrice:
			cheapest && typeof cheapest.compareAtPrice === 'number' && cheapest.compareAtPrice > cheapest.price
				? cheapest.compareAtPrice
				: null,
		image: image ? mediaUrl(image, { baseUrl: context.media.storage_base_url }) : null,
	};
};

/**
 * An item for the merchant (`sk_`, dashboard).
 * @param {Record<string, any>} item
 * @param {ViewContext & { exposeCost: boolean }} context
 */
export const ownerItem = (item, context) => {
	const status = statusDef(context.items.statuses, item.status);
	return {
		id: item.id,
		slug: item.slug,
		previousSlugs: item.previousSlugs ?? [],
		externalId: item.externalId ?? null,
		url: itemUrl(item, { template: context.items.item_url_template, domain: context.domain }),
		type: item.type,
		status: item.status,
		baseStatus: status.base,
		title: item.title,
		summary: item.summary ?? null,
		description: item.description ?? null,
		brandId: item.brandId ?? null,
		collectionIds: item.collectionIds ?? [],
		attributes: item.attributes ?? {},
		custom: item.custom ?? {},
		tags: item.tags ?? [],
		currency: context.currency,
		itemCurrency: item.currency ?? null,
		options: item.options ?? [],
		optionPool: item.optionPool ?? {},
		variants: [...(item.variants ?? [])]
			.sort((a, b) => a.position - b.position)
			.map((v) => ownerVariant(v, context.stock, context.exposeCost, item.id)),
		media: mediaOf(item, context, item.title).map((view, index) => ({
			...view,
			storageKey: orderedMedia(item.media ?? [])[index]?.key ?? null,
		})),
		seo: item.seo ?? { title: null, description: null },
		translations: item.translations ?? {},
		publishAt: item.publishAt ?? null,
		unpublishAt: item.unpublishAt ?? null,
		priceMin: item.priceMin ?? null,
		priceMax: item.priceMax ?? null,
		available: item.available ?? 0,
		inStock: item.inStock === true,
		version: item.version ?? 1,
		createdAt: iso(item.createdAt),
		updatedAt: iso(item.updatedAt),
		deletedAt: iso(item.deletedAt),
	};
};

/**
 * A collection for readers.
 * @param {import('./collections.js').Collection} collection
 * @param {{ owner: boolean, mediaBase: string }} context
 */
export const collectionView = (collection, { owner, mediaBase }) => ({
	id: collection.id,
	slug: collection.slug,
	title: collection.title,
	heading: collection.heading,
	description: collection.description,
	parentId: collection.parentId,
	ancestors: collection.ancestors,
	depth: collection.depth,
	position: collection.position,
	seo: collection.seo,
	image: collection.image ? imageView(collection.image, mediaBase) : null,
	...(owner ? { visible: collection.visible } : {}),
});

/**
 * A brand for readers.
 * @param {import('./brands.js').Brand} brand
 * @param {{ owner: boolean, mediaBase: string }} context
 */
export const brandView = (brand, { owner, mediaBase }) => ({
	id: brand.id,
	slug: brand.slug,
	name: brand.name,
	description: brand.description,
	logo: brand.logo ? imageView(brand.logo, mediaBase) : null,
	collectionIds: brand.collectionIds,
	position: brand.position,
	...(owner ? { visible: brand.visible } : {}),
});

/**
 * @param {{ url?: string, key?: string, alt?: string | null }} image
 * @param {string} base
 */
const imageView = (image, base) => ({
	url: image.url ?? (image.key && base ? `${base.replace(/\/+$/, '')}/${image.key}` : null),
	alt: image.alt ?? null,
	...(image.key ? { key: image.key } : {}),
});

/**
 * An attribute definition for readers (public: no scope internals beyond what filters need).
 * @param {import('./attributes.js').Attribute} attribute
 */
export const attributeView = (attribute) => ({
	id: attribute.id,
	key: attribute.key,
	label: attribute.label,
	type: attribute.type,
	unit: attribute.unit,
	options: attribute.options.map((o) => ({ value: o.value, label: o.label, display: optionLabel(attribute, o.value) })),
	filterable: attribute.filterable,
	variantOption: attribute.variantOption,
	cardPosition: attribute.cardPosition,
	collectionIds: attribute.collectionIds,
	visibility: attribute.visibility,
	position: attribute.position,
	required: attribute.required,
});
