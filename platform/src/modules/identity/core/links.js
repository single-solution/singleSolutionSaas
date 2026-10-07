/**
 * Console links sent by e-mail or copied by an admin. The token travels in the URL **fragment** so it never reaches
 * server logs, proxies or `Referer` headers; the console page reads it and posts it to the API.
 * @module
 */

/** Console paths of each link kind. */
export const LINK_PATHS = Object.freeze({
	setup: '/set-password',
	password_reset: '/reset-password',
	email_change: '/confirm-email',
});

/**
 * @param {string} portalUrl `PORTAL_URL` (no trailing slash)
 * @param {keyof typeof LINK_PATHS} kind
 * @param {string} token
 */
export const linkFor = (portalUrl, kind, token) =>
	`${portalUrl.replace(/\/+$/, '')}${LINK_PATHS[kind]}#token=${encodeURIComponent(token)}`;
