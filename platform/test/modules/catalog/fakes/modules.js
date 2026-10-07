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
 * Fake `commerce`: `subscriptionsForWebsite(websiteId)` and `invalidateApp(appId)` (recorded in `invalidated`; throws
 * when it is null).
 * @param {Array<{ subscriptionId: string, websiteId: string, merchantId: string, appId: string, status: string }>} subscriptions
 * @param {string[] | null} [invalidated]
 */
export const fakeCommerce = (subscriptions, invalidated = []) =>
	defineModule({
		name: 'commerce',
		service: () => ({
			/** @param {string} websiteId */
			subscriptionsForWebsite: async (websiteId) => subscriptions.filter((s) => s.websiteId === websiteId),
			/** @param {string} appId */
			invalidateApp: async (appId) => {
				if (invalidated === null) throw new Error('commerce down');
				invalidated.push(appId);
			},
		}),
	});

/** Fake `delivery`: records `registerWidgets` calls and answers like delivery does. */
export const fakeDelivery = () => {
	/** @type {any[]} */
	const calls = [];
	const module = defineModule({
		name: 'delivery',
		service: () => ({
			/** @param {{ appId: string, descriptor: any, actor: any }} input */
			registerWidgets: async (input) => {
				calls.push(input);
				return {
					version: calls.length,
					status: 'uploading',
					missing: input.descriptor.assets.map((/** @type {any} */ a) => a.path),
					uploadPath: `/v1/admin/packs/${input.appId}/versions/${calls.length}/assets/`,
					changed: true,
				};
			},
		}),
	});
	return { module, calls };
};
