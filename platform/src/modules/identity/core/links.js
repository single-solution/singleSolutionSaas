/**
 * Console links sent by e-mail. The token travels in the URL **fragment** so it never reaches server logs, proxies
 * or `Referer` headers; the console page reads it and posts it to the API.
 * @module
 */

/** Console paths of each link kind. */
export const LINK_PATHS = Object.freeze({
	verify_email: '/signup/verify',
	password_reset: '/reset-password',
	staff_password_reset: '/staff/reset-password',
	invite: '/invites/accept',
});

/**
 * @param {string} portalUrl canonical Portal URL (no trailing slash)
 * @param {keyof typeof LINK_PATHS} kind
 * @param {string} token
 */
export const linkFor = (portalUrl, kind, token) =>
	`${portalUrl.replace(/\/+$/, '')}${LINK_PATHS[kind]}#token=${encodeURIComponent(token)}`;
