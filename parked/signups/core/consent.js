/**
 * Terms and privacy acceptance (pure). The merchant lists documents with versions (`consent.documents`); a customer's
 * acceptances are recorded per document key and version (append-only records in the merchant database, the current
 * version on the customer). A required document whose current version the customer has not accepted blocks sign-in
 * until it is accepted — on sign-up, and again after a new version when `require_reacceptance` is on.
 * @module
 */

/**
 * @typedef {object} ConsentDocument
 * @property {string} key
 * @property {string} version
 * @property {string} [title]
 * @property {string} [url]
 * @property {boolean} [required]
 */
/** @typedef {Record<string, { version: string, acceptedAt: string }>} Accepted */

/**
 * Required documents the customer still has to accept.
 * @param {readonly ConsentDocument[]} documents
 * @param {Accepted | undefined} accepted
 * @param {{ isNew: boolean, requireReacceptance: boolean }} options
 * @returns {ConsentDocument[]}
 */
export const pendingConsents = (documents, accepted, { isNew, requireReacceptance }) =>
	documents.filter((doc) => {
		if (!doc.required) return false;
		const current = accepted?.[doc.key];
		if (!current) return isNew || requireReacceptance;
		return requireReacceptance && current.version !== doc.version;
	});

/**
 * Validate acceptances sent by a client (`[{ key, version }]`): only configured documents at their current version.
 * @param {unknown} input
 * @param {readonly ConsentDocument[]} documents
 * @returns {{ ok: true, accepted: Array<{ key: string, version: string }> } | { ok: false, problems: Array<{ path: string, code: string }> }}
 */
export const parseAcceptances = (input, documents) => {
	if (input === undefined || input === null) return { ok: true, accepted: [] };
	if (!Array.isArray(input) || input.length > 20) return { ok: false, problems: [{ path: '/consents', code: 'type' }] };
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	/** @type {Map<string, string>} */
	const accepted = new Map();
	input.forEach((item, index) => {
		const doc = documents.find((d) => d.key === item?.key);
		if (!doc) problems.push({ path: `/consents/${index}/key`, code: 'unknown_document' });
		else if (item.version !== doc.version) problems.push({ path: `/consents/${index}/version`, code: 'outdated_version' });
		else accepted.set(doc.key, doc.version);
	});
	return problems.length > 0
		? { ok: false, problems }
		: { ok: true, accepted: [...accepted].map(([key, version]) => ({ key, version })) };
};

/**
 * Merge acceptances into the customer's current map.
 * @param {Accepted | undefined} current
 * @param {ReadonlyArray<{ key: string, version: string }>} accepted
 * @param {string} at ISO time
 * @returns {Accepted}
 */
export const mergeAcceptances = (current, accepted, at) => ({
	...(current ?? {}),
	...Object.fromEntries(accepted.map(({ key, version }) => [key, { version, acceptedAt: at }])),
});

/**
 * Whether the pending list is covered by the acceptances.
 * @param {readonly ConsentDocument[]} pending
 * @param {ReadonlyArray<{ key: string }>} accepted
 */
export const covers = (pending, accepted) => pending.every((doc) => accepted.some((a) => a.key === doc.key));
