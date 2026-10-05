/**
 * Class-name joiner: falsy parts are dropped.
 * @param {...(string | false | null | undefined | 0)} parts
 * @returns {string}
 */
export const cx = (...parts) => parts.filter(Boolean).join(' ');
