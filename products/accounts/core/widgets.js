/**
 * Names the widgets, the API and the docs share (PLAN 0.4.10, 0.8.6).
 * @module
 */

/** The browser global of `widget.js`: `window.SSAccounts`. */
export const WIDGET_GLOBAL = 'SSAccounts';

/** Widgets mount only into elements with this attribute; its value is the widget key from manifest.json. */
export const WIDGET_ATTRIBUTE = 'data-ss-accounts';

/** The sign-in methods (features). The sign-in and My account widgets and the routes of a signed-in user work while any is on. */
export const SIGN_IN_METHODS = Object.freeze(
	/** @type {const} */ (['phone_code', 'email_password', 'email_code', 'google', 'apple', 'facebook']),
);

/** Social sign-in providers (each its own feature and connection). */
export const PROVIDERS = Object.freeze(/** @type {const} */ (['google', 'apple', 'facebook']));

/** The features each widget needs (any of them). */
export const WIDGET_FEATURES = Object.freeze({
	sign_in: SIGN_IN_METHODS,
	my_account: SIGN_IN_METHODS,
	users_admin: Object.freeze(['roles']),
	roles_admin: Object.freeze(['roles']),
});

/** The header that carries a visitor's sign-in next to the browser token. */
export const SIGN_IN_HEADER = 'ss-sign-in';

/** Sign-ins last 15 minutes (PLAN 0.4.6); the widget renews them 1 minute before. */
export const SIGN_IN_SECONDS = 900;

/**
 * Fragment parameters of the links Accounts sends or redirects to (fragments never reach the merchant's server logs):
 * a social sign-in's hand-over code, a magic link, a password reset, an invite and a social sign-in's error code.
 */
export const LINK_PARAMS = Object.freeze({
	handoff: 'ss_accounts_code',
	magic: 'ss_accounts_link',
	reset: 'ss_accounts_reset',
	invite: 'ss_accounts_invite',
	error: 'ss_accounts_error',
});

/** Where the widget keeps the refresh token: localStorage with "remember me", else sessionStorage. */
export const REFRESH_STORAGE_KEY = 'ss-accounts-session';
/** The browser's device id for risk checks (localStorage). */
export const DEVICE_STORAGE_KEY = 'ss-accounts-device';

/** DOM events on `window`: `ss-accounts:signed-in` (`detail: { user }`) and `ss-accounts:signed-out`. */
export const SIGNED_IN_EVENT = 'ss-accounts:signed-in';
export const SIGNED_OUT_EVENT = 'ss-accounts:signed-out';

/** Template keys Accounts sends through Notifications, and the values each gets. */
export const MESSAGE_TEMPLATES = Object.freeze({
	'accounts.phone_code': ['code', 'minutes', 'business'],
	'accounts.email_code': ['code', 'link', 'minutes', 'business'],
	'accounts.password_reset': ['link', 'minutes', 'business'],
	'accounts.invite': ['link', 'name', 'days', 'business'],
});
