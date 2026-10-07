/**
 * Fake neighbour modules implementing only the INTERFACES.md functions identity depends on: `commerce`
 * (`onMerchantStatus`, the products on a website) and `catalog` (notices, product names and the `productKeys` port for
 * product routes), plus a `whoami` route that reports how a request authenticated.
 */
import { createJwks, createKeyResolver, createSigner, generateSigningKey, signAssertion } from '@ss/protocol';
import { ok } from '../../../../src/infra/http.js';
import { defineModule } from '../../../../src/infra/modules.js';

/** @param {{ fail?: boolean }} [options] */
export const fakeCommerce = (options = {}) => {
	/** @type {Array<{ merchantId: string, status: string }>} */
	const calls = [];
	/** @type {Array<{ productId: string, websiteId: string, merchantId: string }>} products on websites (not removed) */
	const products = [];
	const module = defineModule({
		name: 'commerce',
		service: () => ({
			/** @param {string} websiteId */
			productsOnWebsite: async (websiteId) => products.filter((p) => p.websiteId === websiteId),
			allProductNumbers: async () => [],
			/** @param {string} websiteId */
			productsOnWebsiteCount: async (websiteId) => products.filter((p) => p.websiteId === websiteId).length,
			/** @param {{ merchantId: string, status: string }} input */
			onMerchantStatus: async (input) => {
				calls.push(input);
				if (options.fail) throw new Error('commerce is down');
			},
		}),
	});
	return { module, calls, products };
};

/** Catalog stand-in: records notices and registers one product key so product routes can be called. */
export const fakeCatalog = async (productId = 'notes') => {
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: `${productId}-1` });
	const resolver = createKeyResolver({ jwks: createJwks([publicJwk]) });
	const signer = createSigner(privateJwk);
	/** @type {Array<{ productId: string, body: Record<string, unknown> }>} */
	const notices = [];
	let failing = false;
	const module = defineModule({
		name: 'catalog',
		service: () => ({
			/** @param {string} id @param {Record<string, unknown>} body */
			notify: async (id, body) => {
				if (failing) throw new Error('catalog is down');
				notices.push({ productId: id, body });
			},
			/** @param {Record<string, unknown>} body */
			notifyAll: async (body) => {
				if (failing) throw new Error('catalog is down');
				notices.push({ productId: '*', body });
			},
			listProducts: async () => [],
			/** @param {string} id */
			getProduct: async (id) => {
				if (id !== productId) throw new Error('not connected');
				return {
					productId,
					name: 'Notes',
					widgetScriptUrl: 'https://notes.example.dev/widget.js',
					docsUrl: 'https://notes.example.dev/docs',
				};
			},
		}),
		ports: () => ({ productKeys: (/** @type {string} */ id) => (id === productId ? resolver : null) }),
	});
	return {
		module,
		productId,
		notices,
		/** @param {boolean} value */
		setFailing: (value) => {
			failing = value;
		},
		/** @param {string} audience @param {() => number} now */
		assertion: (audience, now) => signAssertion({ signer, productId, audience, now }),
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

/** `GET /v1/test/whoami`: the authentication mode, actor and session of the request. */
export const whoamiModule = defineModule({
	name: 'whoami',
	routes: () => [
		{
			method: 'GET',
			path: '/v1/test/whoami',
			auth: ['admin', 'merchant', 'product'],
			handler: (c) =>
				ok({
					authMode: c.authMode,
					actor: c.actor,
					...(c.session ? { session: { kind: c.session.kind, mfa: c.session.mfa } } : {}),
				}),
		},
	],
});
