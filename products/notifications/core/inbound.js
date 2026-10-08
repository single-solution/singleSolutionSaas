/**
 * Unsubscribe keywords (PLAN 0.8.5): replies the merchant's provider forwards to Notifications (Twilio posts a form,
 * the WhatsApp Cloud API posts JSON; their signatures are checked in `adapters/signatures.js`). No I/O.
 * @module
 */

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
 * Whether a reply is one of the unsubscribe keywords (whole reply, any case, spaces around ignored).
 * @param {string} text
 * @param {unknown} keywords the setting
 */
export const isOptOut = (text, keywords) =>
	Array.isArray(keywords) &&
	keywords.some(
		(word) => typeof word === 'string' && word.trim() !== '' && word.trim().toLowerCase() === text.trim().toLowerCase(),
	);
