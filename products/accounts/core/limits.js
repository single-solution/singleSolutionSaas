/**
 * Fixed limits of Accounts (settings-ownership step 1). Each of these was a merchant setting once. None is a business
 * choice: a wrong value breaks sign-in or weakens its security, so the product owns them and no form offers them.
 * The value is the old default, so nothing changes for anybody. Pure; no I/O.
 * @module
 */

// ------------------------------------------------------------------------------------------------- one-time codes

/** Digits of a sign-in or Forgot password code sent by email, SMS or WhatsApp. */
export const CODE_LENGTH = 6;
/** Minutes a code (and a magic link) works. */
export const CODE_MINUTES = 10;
/** Seconds an address waits before it can get another code. */
export const CODE_COOLDOWN_SECONDS = 30;
/** Codes one address can ask for per hour. */
export const CODES_PER_HOUR = 6;
/** Wrong tries a code takes before it is used up. Also the tries of a two-step step or a staff code. */
export const CODE_ATTEMPTS = 5;
/** Minutes a sign-in code made by staff for a user works. */
export const STAFF_CODE_MINUTES = 15;

// ----------------------------------------------------------------------------------------------------- passwords

/** Longest password accepted. */
export const PASSWORD_MAX_LENGTH = 256;
/** Wrong passwords (or wrong two-step codes) in a row before a lock. */
export const PASSWORD_MAX_ATTEMPTS = 5;
/** Minutes a lock lasts (one fixed lock; it never grows). */
export const PASSWORD_LOCK_MINUTES = 15;
/** Hours of quiet after which earlier wrong passwords are forgotten. */
export const PASSWORD_FORGET_HOURS = 24;
/** Minutes a Forgot password link lasts. */
export const RESET_MINUTES = 60;
/** Forgot password requests per email address in 15 minutes. */
export const RESET_LIMIT = 3;

// ------------------------------------------------------------------------------------------------------- caps

/** Custom fields a website has. */
export const MAX_CUSTOM_FIELDS = 50;
/** Choices one custom field offers. */
export const MAX_CHOICES = 50;
/** Roles a website has. */
export const MAX_ROLES = 100;
/** Addresses one user keeps (an import may bring more, up to the ceiling `MAX_ADDRESSES` of the profile module). */
export const ADDRESSES_PER_USER = 10;
