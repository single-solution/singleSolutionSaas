/**
 * SEO copy written when staff save (PLAN 0.8.10 E43, SEO audit G6). With the `seo` setting `autoSeo` at `on_save`,
 * saving a product (or, with Landing pages on, an attribute) asks the merchant's AI provider (AI copy on and the website's
 * AI key, set in the Portal) for its empty SEO title, description and questions, and keeps what it gives as AI copy (`seo.source`
 * `ai`). Formula copy is never stored: without AI, or when the provider gives nothing usable, nothing is written and
 * the patterns fill the pages on every read (so they never go stale). With the `landing_pages` setting `autoCopy` at
 * `ai`, saving a product also writes the AI copy of one of its automatic landing pages that has no record yet. Nothing
 * goes to an AI provider without the merchant's own key; the work runs in the save's request (no timer), and an empty
 * field is written once (later saves keep it).
 * @module
 */
import { aiPrompt, glossaryPrompt, readSuggestions } from '../core/catalog-ai.js';
import { specsOf } from '../core/catalog-views.js';
import { COLLECTIONS } from '../core/model.js';
import { NO_KEYS, attributesOf } from '../adapters/catalog-store.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').AttributeRecord} AttributeRecord */

/** Values of an attribute its patterns and prompt name. */
const NAMED_VALUES = 5;

/**
 * @param {Product} product
 * @param {Service} service
 * @param {{ writeAutoLanding: (s: Site, item: ProductRecord) => Promise<string | null> }} landings
 */
export const createAutoSeo = (product, service, landings) => {
	/** Whether saves write SEO copy. @param {Site} s */
	const onSave = async (s) => s.has('seo') && (await s.values('seo')).autoSeo === 'on_save';

	/**
	 * The merchant's AI provider while AI copy is on (never a provider without the merchant's own key), else null.
	 * @param {Site} s
	 */
	const aiOf = async (s) => (s.has('ai_copy') ? await product.connections.value(s.websiteId, 'ai') : null);

	/**
	 * Texts from the merchant's AI provider, or null when it gives nothing usable.
	 * @template {string} F
	 * @param {unknown} connection @param {{ system: string, prompt: string }} request @param {F[]} fields
	 * @param {Readonly<Record<F, number>>} [limits]
	 */
	const ask = async (connection, { system, prompt }, fields, limits) => {
		const answer = await product.ai.write(connection, { system, prompt, maxTokens: 1500 });
		return answer.ok ? readSuggestions(answer.text, fields, limits) : null;
	};

	/**
	 * What the merchant's AI provider writes into a product's empty SEO fields (MongoDB `$set` paths); nothing without
	 * AI copy and its key, or when the provider gives nothing usable.
	 * @param {Site} s @param {ProductRecord} item
	 * @returns {Promise<Record<string, unknown>>}
	 */
	const productCopy = async (s, item) => {
		const empty = { title: !item.seo.title, description: !item.seo.description, faqs: item.faqs.length === 0 };
		if (!empty.title && !empty.description && !empty.faqs) return {};
		const connection = await aiOf(s);
		if (!connection) return {};
		const data = await s.data();
		const [primary, brand, ai, attributes] = await Promise.all([
			item.categoryIds[0]
				? data.collection(COLLECTIONS.categories).findOne({ websiteId: data.websiteId, id: item.categoryIds[0] }, NO_KEYS)
				: null,
			item.brandId
				? data.collection(COLLECTIONS.brands).findOne({ websiteId: data.websiteId, id: item.brandId }, NO_KEYS)
				: null,
			s.values('ai_copy'),
			attributesOf(data),
		]);
		/** @type {Array<'seoTitle' | 'seoDescription' | 'faqs'>} */
		const fields = [
			...(empty.title ? /** @type {const} */ (['seoTitle']) : []),
			...(empty.description ? /** @type {const} */ (['seoDescription']) : []),
			...(empty.faqs ? /** @type {const} */ (['faqs']) : []),
		];
		const request = aiPrompt(
			{
				name: item.name,
				summary: item.summary,
				description: item.description,
				brand: brand ? String(brand.name) : null,
				categories: primary ? [String(primary.name)] : [],
				specs: specsOf(item, new Map(attributes.map((attribute) => [attribute.id, attribute]))),
				options: item.options,
				kind: item.kind,
			},
			{
				fields,
				tone: String(ai.tone ?? ''),
				language: String(ai.language ?? ''),
				words: Number(ai.words ?? 150),
			},
		);
		/** @type {{ seoTitle?: unknown, seoDescription?: unknown, faqs?: unknown }} */
		const written = (await ask(connection, request, fields)) ?? {};
		/** @type {Record<string, unknown>} */
		const set = {};
		if (empty.title && typeof written.seoTitle === 'string' && written.seoTitle) set['seo.title'] = written.seoTitle;
		if (empty.description && typeof written.seoDescription === 'string' && written.seoDescription)
			set['seo.description'] = written.seoDescription;
		// copy kept from AI is marked so (G6); a block the merchant or an import already wrote keeps its own mark
		if ((set['seo.title'] || set['seo.description']) && !item.seo.source) set['seo.source'] = 'ai';
		if (empty.faqs && Array.isArray(written.faqs) && written.faqs.length > 0) set.faqs = written.faqs;
		return set;
	};

	/**
	 * A product was created or changed by staff: the route answers the saved copy (`replace`) when texts were written;
	 * then one automatic landing page may be written (E43).
	 * @param {Site} s @param {{ product: ProductRecord, replace: (next: ProductRecord) => void }} payload
	 */
	const productSaved = async (s, payload) => {
		const item = payload.product;
		const set = (await onSave(s)) ? await productCopy(s, item) : {};
		if (Object.keys(set).length > 0) {
			const data = await s.data();
			await data.collection(COLLECTIONS.products).updateOne({ websiteId: data.websiteId, id: item.id }, { $set: set });
			payload.replace({
				...item,
				seo: {
					...item.seo,
					...(set['seo.title'] ? { title: String(set['seo.title']) } : {}),
					...(set['seo.description'] ? { description: String(set['seo.description']) } : {}),
					...(set['seo.source'] ? { source: /** @type {'ai'} */ ('ai') } : {}),
				},
				...(set.faqs ? { faqs: /** @type {ProductRecord['faqs']} */ (set.faqs) } : {}),
			});
		}
		await landings.writeAutoLanding(s, item);
	};

	/**
	 * An attribute was created or changed by staff: the merchant's AI provider writes its empty glossary title,
	 * description and questions while Landing pages is on (its glossary page exists); nothing without AI (the
	 * `attributeTitle` and `attributeDescription` patterns fill the page on read). The route answers the saved copy
	 * (`replace`).
	 * @param {Site} s @param {{ attribute: AttributeRecord & { seo?: any }, replace: (next: AttributeRecord) => void }} payload
	 */
	const attributeSaved = async (s, payload) => {
		if (!s.has('landing_pages') || !(await onSave(s))) return;
		const attribute = payload.attribute;
		const { seo } = attribute;
		const empty = { title: !seo.title, description: !seo.description, faqs: seo.faqs.length === 0 };
		if (!empty.title && !empty.description && !empty.faqs) return;
		const connection = await aiOf(s);
		if (!connection) return;
		const data = await s.data();
		const [category, ai] = await Promise.all([
			attribute.categoryId
				? data.collection(COLLECTIONS.categories).findOne({ websiteId: data.websiteId, id: attribute.categoryId }, NO_KEYS)
				: null,
			s.values('ai_copy'),
		]);
		/** @type {Array<'title' | 'description' | 'faqs'>} */
		const fields = [
			...(empty.title ? /** @type {const} */ (['title']) : []),
			...(empty.description ? /** @type {const} */ (['description']) : []),
			...(empty.faqs ? /** @type {const} */ (['faqs']) : []),
		];
		const request = glossaryPrompt(
			{
				name: attribute.name,
				unit: attribute.unit,
				category: category ? String(category.name) : null,
				values: attribute.choices.map((choice) => choice.label).slice(0, NAMED_VALUES),
			},
			{ fields, tone: String(ai.tone ?? ''), language: String(ai.language ?? '') },
		);
		/** @type {{ title?: unknown, description?: unknown, faqs?: unknown }} */
		const written = (await ask(connection, request, fields, request.limits)) ?? {};
		const next = {
			...seo,
			title: seo.title || (typeof written.title === 'string' ? written.title : ''),
			description: seo.description || (typeof written.description === 'string' ? written.description : ''),
			faqs: empty.faqs && Array.isArray(written.faqs) ? written.faqs : seo.faqs,
		};
		if (next.title === seo.title && next.description === seo.description && next.faqs === seo.faqs) return;
		await data
			.collection(COLLECTIONS.attributes)
			.updateOne({ websiteId: data.websiteId, id: attribute.id }, { $set: { seo: next } });
		payload.replace({ ...attribute, seo: next });
	};

	service.on('product.saved', productSaved);
	service.on('attribute.saved', attributeSaved);
};
