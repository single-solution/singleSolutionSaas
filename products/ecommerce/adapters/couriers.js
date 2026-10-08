/**
 * Courier APIs (owner: checkout; stub until built): book a shipment and read its latest status with the merchant's
 * own courier keys (the `courier` connection), through `@ss/net`.
 * @module
 */

/**
 * @param {{ send: (url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse> }} options
 */
export const createCouriers = ({ send }) =>
	Object.freeze({
		send,
		/**
		 * The connection test (read-only).
		 * @param {unknown} value
		 * @returns {Promise<{ ok: boolean, message?: string }>}
		 */
		test: async (value) => (value ? { ok: true } : { ok: false, message: 'Courier keys are missing.' }),
	});

/** @typedef {ReturnType<typeof createCouriers>} Couriers */
