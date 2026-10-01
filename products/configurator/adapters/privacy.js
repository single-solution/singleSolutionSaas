/**
 * Personal data this product stores: none. Configurators and catalog snapshots describe products, not people, and
 * evaluations are computed, never stored. The Portal-signed POST /v1/data:export and /v1/data:anonymize therefore
 * answer with empty results.
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
