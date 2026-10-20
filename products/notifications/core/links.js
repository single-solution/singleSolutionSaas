/**
 * The links of a message (SR-7-3). A product names the values of its message that hold a link (`linkValues`); a link
 * goes into the message only when it is an https address on one of the website's own hosts (its domain, the other
 * hosts the merchant listed for it, the sending product's own host), so that no page address a visitor gave can make
 * a message under the merchant's name point at another site. Pure; no I/O.
 * @module
 */

const LONGEST_LINK = 2048;

/** @param {unknown} host */
const lowerHost = (host) => String(host).toLowerCase().replace(/\.$/, '');

/**
 * Whether the value of a link may go into a message: empty (no link), or an https address on one of `hosts` without
 * credentials, a port, a space or a backslash.
 * @param {string} value
 * @param {ReadonlyArray<unknown>} hosts the host names that count as the website's own
 * @returns {boolean}
 */
export const isOwnLink = (value, hosts) => {
	if (value === '') return true;
	if (value.length > LONGEST_LINK || !/^[^\s\\]+$/.test(value)) return false;
	/** @type {URL} */
	let url;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.port !== '') return false;
	const host = lowerHost(url.hostname);
	return hosts.some((own) => own !== '' && lowerHost(own) === host);
};
