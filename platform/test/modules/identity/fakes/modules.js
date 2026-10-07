/**
 * Fake neighbour modules implementing only the INTERFACES.md functions identity depends on:
 * `commerce.onMerchantStatus`, `integration.emitControl`, and the `appKeys` port (catalog) for product routes, plus a
 * `whoami` route that reports how a request authenticated.
 */
import { createJwks, createKeyResolver, createSigner, generateSigningKey, signAssertion } from '@ss/protocol';
import { ok } from '../../../../src/infra/http.js';
import { defineModule } from '../../../../src/infra/modules.js';

/** @param {{ fail?: boolean }} [options] */
export const fakeCommerce = (options = {}) => {
	/** @type {Array<{ merchantId: string, status: string }>} */
	const calls = [];
	/** @type {string[]} websites whose documents were re-signed */
	const invalidated = [];
	/** @type {Array<{ appId: string, websiteId: string, status: string }>} subscriptions the identity module sees (F.16) */
	const subscriptions = [];
	const module = defineModule({
		name: 'commerce',
		service: () => ({
			/** @param {string} websiteId */
			invalidateWebsite: async (websiteId) => {
				invalidated.push(websiteId);
				if (options.fail) throw new Error('commerce is down');
				return { invalidated: 1 };
			},
			/** @param {string} websiteId */
			subscriptionsForWebsite: async (websiteId) => subscriptions.filter((s) => s.websiteId === websiteId),
			/** @param {{ merchantId: string, status: string }} input */
			onMerchantStatus: async (input) => {
				calls.push(input);
				if (options.fail) throw new Error('commerce is down');
			},
		}),
	});
	return { module, calls, invalidated, subscriptions };
};

/** @param {{ fail?: boolean }} [options] */
export const fakeIntegration = (options = {}) => {
	/** @type {Array<{ type: string, data: any, options: any }>} */
	const events = [];
	const module = defineModule({
		name: 'integration',
		service: () => ({
			/** @param {string} type @param {any} data @param {any} opts */
			emitControl: async (type, data, opts) => {
				if (options.fail) throw new Error('integration is down');
				events.push({ type, data, options: opts });
			},
		}),
	});
	return { module, events };
};

/** Catalog stand-in: registers one app key so product routes can be called with client assertions. */
export const fakeCatalog = async (appId = 'app_test') => {
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: `${appId}-1` });
	const resolver = createKeyResolver({ jwks: createJwks([publicJwk]) });
	const signer = createSigner(privateJwk);
	/** The app's manifest capabilities (F.16 `identityIssuer`), mutable by tests. */
	const capabilities = /** @type {Record<string, unknown>} */ ({});
	const module = defineModule({
		name: 'catalog',
		service: () => ({
			getApp: async (/** @type {string} */ id) => ({ appId: id, slug: 'signups', kind: 'service', status: 'active' }),
			getManifest: async () => ({ product: { slug: 'signups', name: 'Signups' }, capabilities: { ...capabilities } }),
			activeProducts: async () => [{ appId, slug: 'signups', name: 'Signups', kind: 'service' }],
		}),
		ports: () => ({ appKeys: (/** @type {string} */ id) => (id === appId ? resolver : null) }),
	});
	return {
		module,
		appId,
		capabilities,
		/** @param {string} audience @param {() => number} now */
		assertion: (audience, now) => signAssertion({ signer, appId, audience, now }),
	};
};

/** Mailer capturing messages; `tokenFrom(message)` extracts the fragment token of its link. */
export const memoryMailer = () => {
	/** @type {import('../../../../src/infra/mailer.js').MailMessage[]} */
	const sent = [];
	let available = true;
	let failing = false;
	return {
		get available() {
			return available;
		},
		/** @param {any} message */
		send: async (message) => {
			if (failing) throw new Error('smtp down');
			sent.push(message);
		},
		sent,
		/** @param {boolean} value */
		setAvailable: (value) => {
			available = value;
		},
		/** @param {boolean} value */
		setFailing: (value) => {
			failing = value;
		},
		/**
		 * Token of the last message to `to` (optionally of a template).
		 * @param {string} to
		 * @param {string} [template]
		 */
		token: (to, template) => {
			const message = [...sent].reverse().find((m) => m.to === to && (!template || m.template === template));
			const link = message?.data.link ?? '';
			return decodeURIComponent(link.split('#token=')[1] ?? '');
		},
	};
};

/** `GET /v1/test/whoami`: the authentication mode, actor, session and website key of the request. */
export const whoamiModule = defineModule({
	name: 'whoami',
	routes: () => [
		{
			method: 'GET',
			path: '/v1/test/whoami',
			auth: ['staff', 'merchant', 'product', 'websiteKey'],
			handler: (c) =>
				ok({
					authMode: c.authMode,
					actor: c.actor,
					...(c.session ? { session: { kind: c.session.kind, mfa: c.session.mfa } } : {}),
					...(c.website ? { website: { websiteId: c.website.websiteId, kind: c.website.kind, env: c.website.env } } : {}),
				}),
		},
	],
});
