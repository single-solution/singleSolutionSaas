/**
 * Ids (node:crypto): random opaque ids (`ord_…`, `pay_…`) and stable ids derived from text, so ids made from
 * idempotency keys or event ids converge when a request or delivery is retried.
 */
import { createHash } from 'node:crypto';
import { createId } from '@ss/contracts';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * A random id with a prefix (2–8 lowercase letters).
 * @param {string} prefix
 */
export const newId = (prefix) => createId(prefix);

/**
 * 26 lowercase Crockford base32 characters of SHA-256(text), behind a prefix.
 * @param {string} prefix
 * @param {string} text
 */
export const stableId = (prefix, text) => {
	const digest = createHash('sha256').update(text).digest();
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of digest) {
		value = ((value << 8) | byte) & 0xffff;
		bits += 8;
		while (bits >= 5 && out.length < 26) {
			out += CROCKFORD[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		if (out.length >= 26) break;
	}
	return `${prefix}_${out}`;
};

/**
 * A customer key as stored (`e:<hash>`): the kind prefix stays readable, the contact value is a SHA-256 over the
 * website id and the value, so risk profiles and order key lists never hold an e-mail address or phone number in clear.
 * @param {string} websiteId
 * @param {string} key raw key from `core/orders.js` customerKeys (`e:ada@example.com`)
 */
export const hashKey = (websiteId, key) => {
	const split = key.indexOf(':');
	return `${key.slice(0, split)}:${createHash('sha256').update(`${websiteId}\n${key}`).digest('hex').slice(0, 40)}`;
};
