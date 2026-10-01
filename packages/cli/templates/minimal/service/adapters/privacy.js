/**
 * Personal data this product stores (drives the Portal-signed POST /v1/data:export and /v1/data:anonymize). The
 * placeholder stores none, so both answer with empty results. When you store customer data, declare the collections
 * instead (`collections: [{ name, subjectField, fields }]`) and drop the two handlers.
 */

/** @typedef {{ websiteId: string, subject?: Record<string, string>, requestId?: string }} PrivacyInput */

export const PRIVACY = Object.freeze({
	collections: [],
	/** @param {PrivacyInput} input */
	export: async ({ websiteId, subject }) => ({
		websiteId,
		...(subject ? { subject } : {}),
		exportedAt: new Date().toISOString(),
		collections: {},
	}),
	/** @param {PrivacyInput} input */
	anonymize: async ({ websiteId }) => ({ websiteId, anonymized: {} }),
});
