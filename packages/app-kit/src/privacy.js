/**
 * Data export / anonymisation (Part E §7, Portal-signed `POST /v1/data:export|anonymize`). Products either pass their
 * own handlers or declare the collections holding personal data; the defaults then export every document of the
 * website (or of one subject) and anonymise a subject by nulling the declared fields.
 * @module
 */
import { problem } from './http/results.js';

/**
 * @typedef {object} PrivacyCollection
 * @property {string} name unprefixed collection name
 * @property {string} [subjectField] field (and subject key) identifying the data subject, default `customerId`
 * @property {string[]} [fields] personal fields nulled on anonymisation
 */

/** @typedef {{ websiteId: string, subject?: Record<string, string>, requestId?: string }} PrivacyInput */

/**
 * @param {{
 *   data: { forWebsite: (websiteId: string) => Promise<import('./data.js').WebsiteData> },
 *   collections?: PrivacyCollection[],
 *   export?: (input: PrivacyInput) => Promise<unknown>,
 *   anonymize?: (input: PrivacyInput) => Promise<unknown>,
 *   now?: () => number,
 *   maxDocuments?: number,
 * }} options
 */
export const createPrivacy = ({
	data,
	collections = [],
	export: exportHandler,
	anonymize: anonymizeHandler,
	now = Date.now,
	maxDocuments = 10_000,
}) => {
	/**
	 * @param {PrivacyCollection} collection
	 * @param {PrivacyInput} input
	 * @returns {Record<string, unknown> | null}
	 */
	const filterFor = (collection, { websiteId, subject }) => {
		if (!subject) return { websiteId };
		const field = collection.subjectField ?? 'customerId';
		return Object.hasOwn(subject, field) ? { websiteId, [field]: subject[field] } : null;
	};

	/** @param {PrivacyInput} input */
	const exportData = async (input) => {
		if (exportHandler) return exportHandler(input);
		if (collections.length === 0) throw problem('not_implemented', 'This product declares no personal data export.');
		const scope = await data.forWebsite(input.websiteId);
		/** @type {Record<string, unknown[]>} */
		const out = {};
		for (const collection of collections) {
			const filter = filterFor(collection, input);
			if (!filter) continue;
			out[collection.name] = await scope.collection(collection.name).find(filter, { limit: maxDocuments }).toArray();
		}
		return {
			websiteId: input.websiteId,
			...(input.subject ? { subject: input.subject } : {}),
			exportedAt: new Date(now()).toISOString(),
			collections: out,
		};
	};

	/** @param {PrivacyInput} input */
	const anonymize = async (input) => {
		if (anonymizeHandler) return anonymizeHandler(input);
		if (collections.length === 0) throw problem('not_implemented', 'This product declares no personal data to anonymise.');
		const scope = await data.forWebsite(input.websiteId);
		/** @type {Record<string, number>} */
		const counts = {};
		for (const collection of collections) {
			const filter = filterFor(collection, input);
			if (!filter || !collection.fields || collection.fields.length === 0) continue;
			const set = Object.fromEntries(collection.fields.map((field) => [field, null]));
			const result = await scope
				.collection(collection.name)
				.updateMany(filter, { $set: { ...set, anonymizedAt: new Date(now()) } });
			counts[collection.name] = result.modifiedCount;
		}
		return { websiteId: input.websiteId, anonymized: counts };
	};

	return Object.freeze({ export: exportData, anonymize });
};
