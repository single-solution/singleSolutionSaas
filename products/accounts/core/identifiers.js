/**
 * Email address parts (pure). Addresses themselves are normalized by the shared rule every product uses
 * (`normalizeEmail` of `@ss/contracts/email`), phone numbers by `normalizePhone` of `@ss/contracts/phone`.
 * @module
 */

/** @param {string} email a normalized address */
export const emailDomain = (email) => email.slice(email.lastIndexOf('@') + 1);
