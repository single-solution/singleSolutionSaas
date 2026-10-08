/**
 * Bookings: weekly hours and slots (owner: checkout; stub until built). No I/O.
 * @module
 */

/**
 * Check the list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: any[] } | { ok: false, errors: string[] }}
 */
export const checkBookingHours = (value) =>
	Array.isArray(value) ? { ok: true, value } : { ok: false, errors: ['A list is expected.'] };
