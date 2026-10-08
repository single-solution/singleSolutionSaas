/**
 * Condition grades (owner: catalog; stub until built). No I/O.
 * @module
 */

/**
 * Check the list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: any[] } | { ok: false, errors: string[] }}
 */
export const checkGrades = (value) =>
	Array.isArray(value) ? { ok: true, value } : { ok: false, errors: ['A list is expected.'] };
