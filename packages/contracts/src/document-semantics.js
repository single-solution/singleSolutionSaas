/**
 * Pure semantic checks for entitlement documents and placements (rules JSON Schema cannot express).
 * @module
 */
import { isUtcTimestamp } from './manifest-semantics.js';
import { pointer } from './util.js';

/** @typedef {import('./types.js').ValidationProblem} ValidationProblem */

/** Stable ids of the rules below. */
export const DOCUMENT_RULES = Object.freeze({
	validityWindow: 'validityWindow',
	unknownElement: 'unknownElement',
	duplicateExperiment: 'duplicateExperiment',
	duplicateResource: 'duplicateResource',
	duplicateIdentityKey: 'duplicateIdentityKey',
	timezone: 'timezone',
	languageTag: 'languageTag',
	timeWindow: 'timeWindow',
	scheduleRange: 'scheduleRange',
});

/**
 * @param {ReadonlyArray<string | number>} tokens
 * @param {string} keyword
 * @param {string} message
 * @returns {ValidationProblem}
 */
const at = (tokens, keyword, message) => Object.freeze({ path: pointer(tokens), keyword, message });

/**
 * True for an IANA time zone name the runtime knows (e.g. `Europe/Berlin`, `UTC`).
 * @param {string} timeZone
 * @returns {boolean}
 */
export const isTimeZone = (timeZone) => {
	try {
		new Intl.DateTimeFormat('en', { timeZone });
		return true;
	} catch {
		return false;
	}
};

/**
 * True for a well-formed BCP-47 language tag (`en`, `pt-BR`, `zh-Hant-TW`) as the runtime's `Intl` understands it.
 * @param {string} tag
 * @returns {boolean}
 */
export const isLanguageTag = (tag) => {
	try {
		return Intl.getCanonicalLocales(tag).length === 1;
	} catch {
		return false;
	}
};

/**
 * Semantic checks on a schema-valid entitlement document.
 * @param {import('./types.js').EntitlementDocument} doc
 * @returns {ValidationProblem[]}
 */
export const checkEntitlementDocument = (doc) => {
	/** @type {ValidationProblem[]} */
	const out = [];
	const times = /** @type {const} */ (['issuedAt', 'validFrom', 'validUntil']);
	const invalid = times.filter((key) => !isUtcTimestamp(doc[key]));
	for (const key of invalid) out.push(at([key], DOCUMENT_RULES.validityWindow, `${key} is not a real UTC timestamp`));
	if (invalid.length === 0) {
		if (Date.parse(doc.validUntil) <= Date.parse(doc.validFrom)) {
			out.push(at(['validUntil'], DOCUMENT_RULES.validityWindow, 'validUntil must be after validFrom'));
		}
		if (Date.parse(doc.validUntil) <= Date.parse(doc.issuedAt)) {
			out.push(at(['validUntil'], DOCUMENT_RULES.validityWindow, 'validUntil must be after issuedAt'));
		}
	}
	const known = (/** @type {string} */ key) => Object.hasOwn(doc.elements, key);
	for (const key of Object.keys(doc.features)) {
		const element = key.split('.')[0] ?? '';
		if (!known(element))
			out.push(at(['features', key], DOCUMENT_RULES.unknownElement, `feature refers to unknown element '${element}'`));
	}
	for (const key of Object.keys(doc.config)) {
		if (!known(key)) out.push(at(['config', key], DOCUMENT_RULES.unknownElement, `config refers to unknown element '${key}'`));
	}
	/** @type {Set<string>} */
	const experimentElements = new Set();
	for (const [index, experiment] of doc.experiments.entries()) {
		if (!known(experiment.element))
			out.push(
				at(['experiments', index, 'element'], DOCUMENT_RULES.unknownElement, `unknown element '${experiment.element}'`),
			);
		if (experimentElements.has(experiment.element)) {
			out.push(
				at(
					['experiments', index],
					DOCUMENT_RULES.duplicateExperiment,
					`element '${experiment.element}' is assigned more than one variant`,
				),
			);
		}
		experimentElements.add(experiment.element);
	}
	/** @type {Set<string>} */
	const resourceKinds = new Set();
	for (const [index, resource] of doc.resources.entries()) {
		const id = `${resource.kind}:${resource.ref}`;
		if (resourceKinds.has(id))
			out.push(at(['resources', index], DOCUMENT_RULES.duplicateResource, `duplicate resource '${id}'`));
		resourceKinds.add(id);
	}
	/** @type {Set<string>} */
	const kids = new Set();
	for (const [index, key] of (doc.identity?.jwks ?? []).entries()) {
		if (kids.has(key.kid))
			out.push(at(['identity', 'jwks', index, 'kid'], DOCUMENT_RULES.duplicateIdentityKey, `duplicate key id '${key.kid}'`));
		kids.add(key.kid);
	}
	const website = doc.website;
	if (website?.timeZone !== undefined && !isTimeZone(website.timeZone))
		out.push(at(['website', 'timeZone'], DOCUMENT_RULES.timezone, `unknown IANA time zone '${website.timeZone}'`));
	if (website?.language !== undefined && !isLanguageTag(website.language))
		out.push(at(['website', 'language'], DOCUMENT_RULES.languageTag, `'${website.language}' is not a BCP-47 language tag`));
	return out;
};

/**
 * Semantic checks on a schema-valid placement.
 * @param {import('./types.js').Placement} placement
 * @returns {ValidationProblem[]}
 */
export const checkPlacement = (placement) => {
	/** @type {ValidationProblem[]} */
	const out = [];
	const schedule = placement.schedule;
	if (schedule === undefined) return out;
	if (!isTimeZone(schedule.timezone))
		out.push(at(['schedule', 'timezone'], DOCUMENT_RULES.timezone, `unknown IANA time zone '${schedule.timezone}'`));
	for (const [key, value] of /** @type {const} */ ([
		['from', schedule.from],
		['until', schedule.until],
	])) {
		if (value !== undefined && !isUtcTimestamp(value))
			out.push(at(['schedule', key], DOCUMENT_RULES.scheduleRange, `${key} is not a real UTC timestamp`));
	}
	if (schedule.from !== undefined && schedule.until !== undefined && Date.parse(schedule.until) <= Date.parse(schedule.from)) {
		out.push(at(['schedule', 'until'], DOCUMENT_RULES.scheduleRange, 'until must be after from'));
	}
	for (const [index, window] of (schedule.windows ?? []).entries()) {
		if (window.start === window.end)
			out.push(
				at(
					['schedule', 'windows', index],
					DOCUMENT_RULES.timeWindow,
					'start and end must differ (use no window for all day)',
				),
			);
	}
	return out;
};
