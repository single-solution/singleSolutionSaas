/**
 * Fake modules implementing the INTERFACES.md functions the catalog depends on.
 * @module
 */
import { defineModule } from '../../../../src/infra/modules.js';

/** Fake `integration`: records `emitControl` calls. */
export const fakeIntegration = () => {
	/** @type {Array<{ type: string, data: any, options: any }>} */
	const emitted = [];
	let failNext = false;
	const module = defineModule({
		name: 'integration',
		service: () => ({
			/** @param {string} type @param {any} data @param {any} options */
			emitControl: async (type, data, options) => {
				if (failNext) {
					failNext = false;
					throw new Error('integration down');
				}
				emitted.push({ type, data, options });
				return { id: `ctl_${emitted.length}` };
			},
		}),
	});
	return {
		module,
		emitted,
		failOnce: () => {
			failNext = true;
		},
	};
};

/**
 * Fake `commerce`: `subscriptionsForWebsite(websiteId)`.
 * @param {Array<{ subscriptionId: string, websiteId: string, merchantId: string, appId: string, status: string }>} subscriptions
 */
export const fakeCommerce = (subscriptions) =>
	defineModule({
		name: 'commerce',
		service: () => ({
			/** @param {string} websiteId */
			subscriptionsForWebsite: async (websiteId) => subscriptions.filter((s) => s.websiteId === websiteId),
		}),
	});
