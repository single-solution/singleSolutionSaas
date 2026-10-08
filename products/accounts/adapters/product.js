/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with Accounts'
 * manifest (each feature's settings schema from `schemas/` inline), its widget texts, its Connections (the
 * Notifications token for codes, invites and resets; Google, Apple and Facebook keys; the other products' tokens for
 * data rights, permissions and the Orders tab), the merchant database indexes, the data-rights hooks and the widget
 * settings, and adds the sealer, the outside services and the website signing keys on the same outbound policy.
 * Public entry `./product` of this package, so a system test can compose the product with `./routes`.
 * @module
 */
import { createProduct } from '@ss/app-kit';
import { createOutboundPolicy, safeFetch } from '@ss/net';
import manifestFile from '../manifest.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import activityCopies from '../schemas/activity_copies.settings.json' with { type: 'json' };
import apple from '../schemas/apple.settings.json' with { type: 'json' };
import approval from '../schemas/approval.settings.json' with { type: 'json' };
import customFields from '../schemas/custom_fields.settings.json' with { type: 'json' };
import dataRights from '../schemas/data_rights.settings.json' with { type: 'json' };
import emailCode from '../schemas/email_code.settings.json' with { type: 'json' };
import emailPassword from '../schemas/email_password.settings.json' with { type: 'json' };
import facebook from '../schemas/facebook.settings.json' with { type: 'json' };
import google from '../schemas/google.settings.json' with { type: 'json' };
import ordersTab from '../schemas/orders_tab.settings.json' with { type: 'json' };
import phoneCode from '../schemas/phone_code.settings.json' with { type: 'json' };
import riskChecks from '../schemas/risk_checks.settings.json' with { type: 'json' };
import roles from '../schemas/roles.settings.json' with { type: 'json' };
import terms from '../schemas/terms.settings.json' with { type: 'json' };
import twoStep from '../schemas/two_step.settings.json' with { type: 'json' };
import { normaliseEmail, normalisePhone } from '../core/identifiers.js';
import { selfView } from '../core/profile.js';
import { createSealer } from './crypto.js';
import { createProviders } from './providers.js';
import { INDEXES, createStore } from './store.js';

/** Settings schema of each feature (manifest.json points at them with `$ref`). @type {Record<string, unknown>} */
const SETTINGS = {
	phone_code: phoneCode,
	email_password: emailPassword,
	email_code: emailCode,
	google,
	apple,
	facebook,
	roles,
	custom_fields: customFields,
	two_step: twoStep,
	approval,
	risk_checks: riskChecks,
	terms,
	data_rights: dataRights,
	activity_copies: activityCopies,
	orders_tab: ordersTab,
};

/** The manifest as the kit and the Portal take it: settings schemas inline. */
export const manifest = /** @type {import('@ss/contracts').Manifest} */ (
	/** @type {unknown} */ ({
		...manifestFile,
		features: manifestFile.features.map((feature) => ({ ...feature, settings: SETTINGS[feature.key] })),
	})
);

export { strings };

/** The other products whose server tokens can be pasted (data rights and the permission list; Ecommerce: Orders tab). */
export const OTHER_PRODUCTS = Object.freeze(/** @type {const} */ (['notifications', 'chat', 'ecommerce', 'payments', 'growth']));

/** Accounts' own problem codes. */
const PROBLEM_CODES = Object.freeze({
	sign_in_failed: Object.freeze({ status: 401, title: 'Sign-in failed' }),
	signed_out: Object.freeze({ status: 401, title: 'Signed out' }),
	locked: Object.freeze({ status: 423, title: 'Locked' }),
	blocked: Object.freeze({ status: 403, title: 'Blocked' }),
	pending_approval: Object.freeze({ status: 403, title: 'Waiting for approval' }),
	sign_up_closed: Object.freeze({ status: 403, title: 'Sign-up is closed' }),
	terms_required: Object.freeze({ status: 403, title: 'Terms not accepted' }),
	risk_refused: Object.freeze({ status: 403, title: 'Refused by the risk checks' }),
	already_exists: Object.freeze({ status: 409, title: 'Already exists' }),
	weak_password: Object.freeze({ status: 422, title: 'Password refused' }),
	code_invalid: Object.freeze({ status: 422, title: 'Code not valid' }),
	too_soon: Object.freeze({ status: 429, title: 'Too soon' }),
	notifications_not_connected: Object.freeze({ status: 503, title: 'Notifications not connected' }),
	not_sent: Object.freeze({ status: 502, title: 'Not sent' }),
	provider_failed: Object.freeze({ status: 502, title: 'Provider failed' }),
	product_not_connected: Object.freeze({ status: 503, title: 'Product not connected' }),
	two_step_required: Object.freeze({ status: 403, title: 'Two-step sign-in required' }),
});

/**
 * Data rights of Accounts itself (PLAN 0.4.11): the user matched on id, e-mail or phone. Export gives the profile and
 * the devices (never the password, two-step secrets or the merchant's notes); delete erases the user, their sessions
 * and their codes.
 * @param {() => number} now
 * @returns {Pick<NonNullable<import('@ss/app-kit').ProductOptions['hooks']>, 'exportUser' | 'deleteUser'>}
 */
const ownDataRights = (now) => ({
	exportUser: async (ctx, user) => {
		const store = createStore(await ctx.data(), { now });
		const found = await store.users.matching({
			...(user.id ? { id: user.id } : {}),
			email: normaliseEmail(user.email),
			phone: normalisePhone(user.phone),
		});
		const devices = await Promise.all(found.map((u) => store.sessions.ofUser(u.id)));
		return {
			users: found.map(selfView),
			devices: devices.flat().map((s) => ({
				device: s.device,
				method: s.method,
				signedInAt: s.createdAt.toISOString(),
				lastUsedAt: s.lastUsedAt.toISOString(),
			})),
		};
	},
	deleteUser: async (ctx, user) => {
		const store = createStore(await ctx.data(), { now });
		const found = await store.users.matching({
			...(user.id ? { id: user.id } : {}),
			email: normaliseEmail(user.email),
			phone: normalisePhone(user.phone),
		});
		let deleted = 0;
		for (const u of found) {
			deleted += await store.sessions.removeAll(u.id);
			for (const target of [u.id, u.email, u.phone]) if (target) deleted += await store.codes.removeTarget(target);
			if (await store.users.remove(u.id)) deleted += 1;
		}
		return { deleted, anonymised: 0 };
	},
});

/** @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data' | 'problemCodes'>} InstanceOptions */

/**
 * The product (kit routes, status, settings, connections, merchant database …) plus its sealer and outside services.
 * @param {InstanceOptions} options at least `config` and `problems` from `configFromEnv()`
 */
export const createProductInstance = (options) => {
	const now = options.now ?? Date.now;
	const production = (options.nodeEnv ?? process.env.NODE_ENV) === 'production';
	const { allowHosts = [], ...outboundRest } = options.outbound ?? {};
	const policy = createOutboundPolicy({ ...outboundRest, allowHosts: production ? [] : allowHosts });
	/** @type {import('./providers.js').Send} */
	const send = options.outboundSend ?? ((url, init) => safeFetch(url, init, policy));
	const providers = createProviders({ send, now });
	// a misconfigured product answers 503 everywhere; the sealer still needs a key to be built
	const sealer = createSealer(options.config?.encryptionKey ?? 'unconfigured-accounts-encryption-key-000000');

	/** @param {'google' | 'apple' | 'facebook'} name */
	const provider = (name) => ({ test: (/** @type {unknown} */ value) => providers.test(name, value) });
	/** @param {string} productId @param {string} label @param {string[]} neededBy */
	const token = (productId, label, neededBy) => ({ label, kind: /** @type {const} */ ('token'), productId, neededBy });

	const product = createProduct({
		...options,
		manifest,
		strings,
		problemCodes: PROBLEM_CODES,
		connections: {
			notifications: token('notifications', 'Notifications token (codes, invites and resets)', [
				'phone_code',
				'email_password',
				'email_code',
				'approval',
			]),
			google: {
				label: 'Google OAuth client',
				kind: 'secret',
				neededBy: ['google'],
				secretField: 'clientSecret',
				...provider('google'),
			},
			apple: { label: 'Apple Sign in key', kind: 'secret', neededBy: ['apple'], secretField: 'keyId', ...provider('apple') },
			facebook: {
				label: 'Facebook app',
				kind: 'secret',
				neededBy: ['facebook'],
				secretField: 'appSecret',
				...provider('facebook'),
			},
			ecommerce: token('ecommerce', 'Ecommerce token (Orders tab, permissions, data rights)', ['orders_tab']),
			chat: token('chat', 'Chat token (permissions, data rights)', []),
			payments: token('payments', 'Payments token (permissions, data rights)', []),
			growth: token('growth', 'Growth token (permissions, data rights)', []),
		},
		hooks: {
			...ownDataRights(now),
			// what the widgets need (GET /v1/widget/config): sign-up rules, custom fields and terms, never a secret
			widgetConfig: async (ctx) => {
				const websiteId = /** @type {string} */ (ctx.websiteId);
				const on = await product.featuresOn(websiteId);
				const store = createStore(await ctx.data(), { now });
				const rules = on.includes('approval')
					? await product.settings.values(websiteId, 'approval')
					: { mode: 'open', requiredFields: [] };
				const password = await product.settings.values(websiteId, 'email_password');
				const termsSettings = on.includes('terms') ? await product.settings.values(websiteId, 'terms') : null;
				return {
					signUp: { mode: rules.mode, requiredFields: rules.requiredFields },
					customFields: on.includes('custom_fields') ? await store.fields.list() : [],
					passwordMinLength: password.minLength,
					terms: termsSettings ? { version: termsSettings.version, url: termsSettings.url } : null,
				};
			},
		},
		data: { indexes: INDEXES },
	});
	return Object.freeze({ ...product, providers, sealer, now, send });
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
