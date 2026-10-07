/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration
 * (feature schemas' defaults overlaid with the document's values). Every number, flag, list and text the product uses
 * comes from here — nothing is hard-coded. An element that is off yields `null`.
 */
import { effectiveConfig } from '../core/config.js';
import { zoneOr } from '../core/time.js';
import aiReplies from '../schemas/ai_replies.features.json' with { type: 'json' };
import csat from '../schemas/csat.features.json' with { type: 'json' };
import flows from '../schemas/flows.features.json' with { type: 'json' };
import handoff from '../schemas/handoff.features.json' with { type: 'json' };
import inbox from '../schemas/inbox.features.json' with { type: 'json' };
import knowledge from '../schemas/knowledge.features.json' with { type: 'json' };
import launcher from '../schemas/launcher.features.json' with { type: 'json' };
import leadCapture from '../schemas/lead_capture.features.json' with { type: 'json' };
import moderation from '../schemas/moderation.features.json' with { type: 'json' };
import proactive from '../schemas/proactive.features.json' with { type: 'json' };
import tools from '../schemas/tools.features.json' with { type: 'json' };
import transcripts from '../schemas/transcripts.features.json' with { type: 'json' };
import windowSchema from '../schemas/window.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({
	window: windowSchema,
	launcher,
	ai_replies: aiReplies,
	knowledge,
	flows,
	tools,
	inbox,
	handoff,
	proactive,
	lead_capture: leadCapture,
	csat,
	transcripts,
	moderation,
});

/** @typedef {keyof typeof SCHEMAS} ElementKey */

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {string} timeZone
 * @property {Record<string, any>} window
 * @property {Record<string, any>} launcher
 * @property {Record<string, any> | null} ai
 * @property {Record<string, any> | null} knowledge
 * @property {Record<string, any> | null} flows
 * @property {import('../core/tools.js').ToolsConfig & Record<string, any> | null} tools
 * @property {Record<string, any> | null} inbox
 * @property {Record<string, any> | null} handoff
 * @property {Record<string, any> | null} proactive
 * @property {Record<string, any> | null} leads
 * @property {import('../core/csat.js').CsatConfig | null} csat
 * @property {Record<string, any>} transcripts always resolved (retention applies even with the element off)
 * @property {import('../core/moderation.js').ModerationConfig | null} moderation
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const enabled = (/** @type {ElementKey} */ key) => can(key);
	const on = (/** @type {ElementKey} */ key) => (enabled(key) ? of(key) : null);
	const win = of('window');
	return {
		enabled,
		timeZone: zoneOr(win.time_zone),
		window: win,
		launcher: of('launcher'),
		ai: on('ai_replies'),
		knowledge: on('knowledge'),
		flows: on('flows'),
		tools: /** @type {any} */ (on('tools')),
		inbox: on('inbox'),
		handoff: on('handoff'),
		proactive: on('proactive'),
		leads: on('lead_capture'),
		csat: /** @type {any} */ (on('csat')),
		transcripts: of('transcripts'),
		moderation: /** @type {any} */ (on('moderation')),
	};
};

/**
 * Settings from a signed entitlement document through the app-kit helpers.
 * @param {any} product app-kit product
 * @param {any} doc entitlement document
 * @returns {Settings}
 */
export const settingsForDoc = (product, doc) =>
	settingsFrom({
		can: (key) => product.entitlements.can(doc, key),
		config: (key) => product.entitlements.config(doc, key) ?? {},
	});
