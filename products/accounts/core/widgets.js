/**
 * Names the widgets, the API and the docs share (PLAN 0.4.10, 0.8.6).
 * @module
 */
import { PLACE_LIMITS } from '@ss/contracts/address';

/** The browser global of `widget.js`: `window.SSAccounts`. */
export const WIDGET_GLOBAL = 'SSAccounts';

/** Widgets mount only into elements with this attribute; its value is the widget key from manifest.json. */
export const WIDGET_ATTRIBUTE = 'data-ss-accounts';

/** The other products the Portal can link Accounts to (data rights and the permission list; Ecommerce: Orders tab). */
export const OTHER_PRODUCTS = Object.freeze(/** @type {const} */ (['notifications', 'chat', 'ecommerce', 'payments', 'growth']));

/** The sign-in methods (features). The sign-in and My account widgets and the routes of a signed-in user work while any is on. */
export const SIGN_IN_METHODS = Object.freeze(
	/** @type {const} */ (['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook']),
);

/**
 * The address fields with the longest value the API takes for each (PLAN 0.8.10 A11): the place parts of the one
 * address-format table (`@ss/contracts/address`, shared with Ecommerce), the country as its ISO code.
 */
export const ADDRESS_LIMITS = Object.freeze({
	label: 40,
	name: 120,
	...PLACE_LIMITS,
	country: 2,
	phone: 40,
});

// the address-format table the widgets use too (they import packages only through core/)
export { LABEL_KINDS, PLACE_PARTS, addressFields, addressLines, countryChoices, countryName } from '@ss/contracts/address';

/** Social sign-in providers (each its own feature and connection). */
export const PROVIDERS = Object.freeze(/** @type {const} */ (['google', 'apple', 'facebook']));

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

/** The query parameter of a setup link to the sign-in widget's page (PLAN 0.8.10 A3; the setup page may take `{code}`). */
export const SETUP_PARAM = 'ss_setup';

/** Where the widget keeps the refresh token: localStorage with "remember me", else sessionStorage. */
export const REFRESH_STORAGE_KEY = 'ss-accounts-session';
/** The browser's device id for risk checks (localStorage). */
export const DEVICE_STORAGE_KEY = 'ss-accounts-device';
/** The random value a social sign-in is tied to while the person is at the provider (sessionStorage, SR-4-4). */
export const BINDING_STORAGE_KEY = 'ss-accounts-binding';

/** DOM events on `window`: `ss-accounts:signed-in` (`detail: { user }`) and `ss-accounts:signed-out`. */
export const SIGNED_IN_EVENT = 'ss-accounts:signed-in';
export const SIGNED_OUT_EVENT = 'ss-accounts:signed-out';
