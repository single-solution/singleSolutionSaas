/**
 * Shared helpers of the system tests: a controllable clock and databases on the run's MongoMemoryReplSet
 * (`SS_TEST_MONGO_URI`, started by the `@ss/config` Mongo global setup).
 * @module
 */

/**
 * Controllable clock.
 * @param {number} start epoch milliseconds
 */
export const createClock = (start) => {
	let t = start;
	return {
		now: () => t,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
		/** @param {number} ms */
		set: (ms) => {
			t = ms;
		},
	};
};

/**
 * MongoDB URI of a database on the shared replica set.
 * @param {string} name
 */
export const mongoUri = (name) => {
	const base = process.env.SS_TEST_MONGO_URI;
	if (!base) throw new Error('SS_TEST_MONGO_URI is not set (run through vitest with the @ss/config Mongo setup)');
	const url = new URL(base);
	url.pathname = `/${name}`;
	return url.toString();
};
