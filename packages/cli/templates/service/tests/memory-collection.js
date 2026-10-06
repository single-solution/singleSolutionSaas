/**
 * In-memory stand-in for a guarded MongoDB collection: supports the operators the repository uses and, like app-kit's
 * data guard, rejects any filter without `websiteId`.
 */

/**
 * @param {any} value
 * @param {any} condition
 */
const matches = (value, condition) => {
	if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
		return Object.entries(condition).every(([op, operand]) => {
			if (op === '$lt') return value !== undefined && value !== null && value < operand;
			if (op === '$gt') return value !== undefined && value !== null && value > operand;
			if (op === '$type') return typeof value === operand;
			throw new Error(`unsupported operator ${op}`);
		});
	}
	return condition === null ? value === null || value === undefined : value === condition;
};

/** @param {Record<string, any>} filter */
const guard = (filter) => {
	if (typeof filter?.websiteId !== 'string') {
		const error = /** @type {Error & { code?: string }} */ (new Error('query without websiteId'));
		error.code = 'data_guard';
		throw error;
	}
};

export const createMemoryCollection = () => {
	/** @type {Record<string, any>[]} */
	const docs = [];
	/** @param {Record<string, any>} filter */
	const select = (filter) =>
		docs.filter((doc) => Object.entries(filter).every(([key, condition]) => matches(doc[key], condition)));
	return {
		docs,
		/** @param {Record<string, any>} filter @param {{ sort?: Record<string, 1 | -1>, limit?: number }} [options] */
		find: (filter, options = {}) => ({
			toArray: async () => {
				guard(filter);
				const [[field, direction] = ['id', 1]] = Object.entries(options.sort ?? {});
				const sorted = select(filter).sort((a, b) =>
					a[field] < b[field] ? -direction : a[field] > b[field] ? direction : 0,
				);
				return sorted.slice(0, options.limit ?? sorted.length).map((doc) => ({ ...doc }));
			},
		}),
		/** @param {Record<string, any>} filter */
		findOne: async (filter) => {
			guard(filter);
			const [doc] = select(filter);
			return doc ? { ...doc } : null;
		},
		/** @param {Record<string, any>} doc */
		insertOne: async (doc) => {
			guard(doc);
			docs.push({ _id: docs.length + 1, ...doc });
			return { acknowledged: true };
		},
		/** @param {Record<string, any>} filter @param {{ $set?: object, $setOnInsert?: object }} update @param {{ upsert?: boolean }} [options] */
		updateOne: async (filter, update, options = {}) => {
			guard(filter);
			const [doc] = select(filter);
			if (doc) {
				Object.assign(doc, update.$set ?? {});
				return { matchedCount: 1, upsertedCount: 0 };
			}
			if (options.upsert) {
				docs.push({ _id: docs.length + 1, ...filter, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) });
				return { matchedCount: 0, upsertedCount: 1 };
			}
			return { matchedCount: 0, upsertedCount: 0 };
		},
		/** @param {Record<string, any>} filter */
		countDocuments: async (filter) => {
			guard(filter);
			return select(filter).length;
		},
	};
};
