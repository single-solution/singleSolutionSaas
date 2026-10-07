/**
 * Fake `catalog`, `commerce` and `identity` modules implementing the INTERFACES.md functions the config module uses.
 * Commerce resolves previews with the real `@ss/entitlements` resolver.
 * @module
 */
import { testSessionActor } from '../../../helpers.js';
import { normaliseProduct, resolveEntitlement } from '@ss/entitlements';
import { defineModule } from '../../../../src/infra/modules.js';
import { problem } from '../../../../src/infra/http.js';
import { APP, MER_A, MER_B, SUB_A1, SUB_A2, SUB_B1, WEB_A1, WEB_A2, WEB_A3, WEB_B1, manifest } from '../fixtures.js';

/**
 * @param {{ withPreview?: boolean, withInvalidateApp?: boolean, merchantOnSubscription?: boolean }} [options]
 */
export const createFakes = ({ withPreview = true, withInvalidateApp = true, merchantOnSubscription = true } = {}) => {
	/** @type {Map<string, any>} */
	const subscriptions = new Map([
		[
			SUB_A1,
			{
				subscriptionId: SUB_A1,
				websiteId: WEB_A1,
				merchantId: MER_A,
				appId: APP,
				planCode: 'starter',
				status: 'active',
				manifestVersion: '1.4.0',
			},
		],
		[
			SUB_A2,
			{
				subscriptionId: SUB_A2,
				websiteId: WEB_A2,
				merchantId: MER_A,
				appId: APP,
				planCode: 'starter',
				status: 'active',
				manifestVersion: '1.4.0',
			},
		],
		[
			SUB_B1,
			{
				subscriptionId: SUB_B1,
				websiteId: WEB_B1,
				merchantId: MER_B,
				appId: APP,
				planCode: 'starter',
				status: 'active',
				manifestVersion: '1.4.0',
			},
		],
	]);
	/** @type {Map<string, any>} */
	const websites = new Map([
		[WEB_A1, { websiteId: WEB_A1, merchantId: MER_A }],
		[WEB_A2, { websiteId: WEB_A2, merchantId: MER_A }],
		[WEB_A3, { websiteId: WEB_A3, merchantId: MER_A }], // no subscription
		[WEB_B1, { websiteId: WEB_B1, merchantId: MER_B }],
	]);
	/** @type {Map<string, any>} */
	const manifests = new Map([
		['1.4.0', manifest('1.4.0')],
		['1.5.0', manifest('1.5.0')],
	]);
	let current = '1.4.0';
	/** @type {string[]} */
	const invalidated = [];
	/** @type {string[]} */
	const invalidatedApps = [];
	let failInvalidate = false;

	const catalog = defineModule({
		name: 'catalog',
		service: () => ({
			/** @param {string} appId @param {string} [version] */
			getManifest: async (appId, version) => {
				if (appId !== APP) throw problem('not_found', 'no app');
				return manifests.get(version ?? current) ?? null;
			},
		}),
	});

	/** @param {string} subscriptionId */
	const getSubscription = async (subscriptionId) => {
		const sub = subscriptions.get(subscriptionId);
		if (!sub) throw problem('not_found', 'no subscription');
		if (merchantOnSubscription) return { ...sub };
		const { merchantId: _m, ...rest } = sub;
		void _m;
		return rest;
	};

	const commerce = defineModule({
		name: 'commerce',
		service: (ctx) => ({
			getSubscription,
			/** @param {string} subscriptionId */
			invalidate: async (subscriptionId) => {
				if (failInvalidate) throw new Error('commerce down');
				invalidated.push(subscriptionId);
			},
			...(withInvalidateApp ? { invalidateApp: async (/** @type {string} */ appId) => void invalidatedApps.push(appId) } : {}),
			...(withPreview
				? {
						/** @param {{ subscriptionId: string, layers: any }} input */
						previewDocument: async ({ subscriptionId, layers }) => {
							const sub = await getSubscription(subscriptionId);
							const product = normaliseProduct(manifests.get(sub.manifestVersion));
							return resolveEntitlement({
								product,
								subscription: { id: subscriptionId, plan: sub.planCode, status: 'active' },
								layers,
								runtime: {},
								now: ctx.now(),
							});
						},
					}
				: {}),
		}),
	});

	const identity = defineModule({
		name: 'identity',
		ports: () => ({ sessionActor: testSessionActor }),
		service: () => ({
			/** @param {string} websiteId */
			getWebsite: async (websiteId) => {
				const website = websites.get(websiteId);
				if (!website) throw problem('not_found', 'no website');
				return { ...website };
			},
		}),
	});

	return {
		modules: [catalog, commerce, identity],
		subscriptions,
		websites,
		manifests,
		invalidated,
		invalidatedApps,
		/** @param {string} version */
		setCurrentVersion: (version) => {
			current = version;
		},
		/** @param {boolean} value */
		setFailInvalidate: (value) => {
			failInvalidate = value;
		},
	};
};
