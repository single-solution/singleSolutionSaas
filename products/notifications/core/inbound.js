/**
 * Unsubscribe keywords (PLAN 0.8.5): replies the merchant's provider forwards to Notifications (Twilio posts a form,
 * the WhatsApp Cloud API posts JSON; their signatures are checked in `adapters/signatures.js`), and any gateway's
 * incoming request read by the merchant's own mapping (fixed-choices N4): where the sender and the text are, as a JSON
 * path or a form field. The keywords are a list per language (`stop_keywords`). No I/O.
 * @module
 */
import { valueAt } from './gateway.js';

/** @typedef {{ from: string, text: string }} Reply */
/**
 * Where a gateway's incoming request has the sender and the text: a JSON path (`message.sender`) or a form field.
 * @typedef {{ from: string, text: string }} InboundMapping
 */
/** The unsubscribe keywords of one language (`''`: any language). @typedef {{ language: string, words: string[] }} StopKeywords */

/** Today's keywords, the list's default. */
export const DEFAULT_STOP_KEYWORDS = Object.freeze([
	Object.freeze({ language: 'en', words: Object.freeze(['STOP', 'UNSUBSCRIBE']) }),
]);

/**
 * The reply in a gateway's incoming request, read by the merchant's mapping: a JSON body by paths, else a form body by
 * field names.
 * @param {string} body the raw body
 * @param {InboundMapping} mapping
 * @returns {Reply[]}
 */
export const gatewayRepliesOf = (body, mapping) => {
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		parsed = undefined;
	}
	/** @param {string} where */
	const read = (where) => {
		const found = parsed === undefined ? new URLSearchParams(body).get(where) : valueAt(parsed, where);
		return typeof found === 'string' || typeof found === 'number' ? String(found) : null;
	};
	const from = read(mapping.from);
	return from ? [{ from, text: read(mapping.text) ?? '' }] : [];
};

/**
 * The replies in a provider's request: `{ from, text }` with `from` in international form.
 * @param {'twilio' | 'meta'} provider
 * @param {string} body the raw body
 * @returns {Array<{ from: string, text: string }>}
 */
export const repliesOf = (provider, body) => {
	if (provider === 'twilio') {
		const params = new URLSearchParams(body);
		const from = (params.get('From') ?? '').replace(/^whatsapp:/, '');
		return from ? [{ from, text: params.get('Body') ?? '' }] : [];
	}
	/** @type {any} */
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return [];
	}
	/** @type {Array<{ from: string, text: string }>} */
	const out = [];
	for (const entry of Array.isArray(parsed?.entry) ? parsed.entry : [])
		for (const change of Array.isArray(entry?.changes) ? entry.changes : [])
			for (const message of Array.isArray(change?.value?.messages) ? change.value.messages : [])
				if (typeof message?.from === 'string')
					out.push({
						from: `+${message.from.replace(/\D/g, '')}`,
						text: typeof message?.text?.body === 'string' ? message.text.body : '',
					});
	return out;
};

/**
 * Whether a reply is one of the unsubscribe keywords of any language (whole reply, any case, spaces around ignored).
 * @param {string} text
 * @param {ReadonlyArray<StopKeywords>} lists the list `stop_keywords`
 */
export const isOptOut = (text, lists) => {
	const reply = text.trim().toLocaleLowerCase();
	return reply !== '' && lists.some((list) => list.words.some((word) => word.trim().toLocaleLowerCase() === reply));
};
