/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with Accounts'
 * manifest (each feature's settings schema from `schemas/` inline), its widget texts, its Connections (the
 * Notifications token for codes, invites and resets; Google, Apple and Facebook keys; the other products' tokens for
 * data rights, permissions and the Orders tab), the merchant database indexes, the data-rights hooks, the widget
 * settings, the `import` feature's collections (`imports.js`, PLAN 0.8.10 K10), the messages it sends through
 * Notifications with their US-English default words (`schemas/messages.json`, parity P1) and its part of the website
 * Setup sheet (the OpenAPI document, the guide's "What your website builds" per feature, and the sign-in methods that
 * are on and who can sign up), and adds the sealer, the outside services and the website signing keys on the same
 * outbound policy.
 * Public entry `./product` of this package, so a system test can compose the product with `./routes`.
 * @module
 */
import { createProduct } from '@ss/app-kit';
import { normalisePhone } from '@ss/contracts/phone';
import { createOutboundPolicy, safeFetch } from '@ss/net';
import guide from '../docs/guide.json' with { type: 'json' };
import manifestFile from '../manifest.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
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
import importSettings from '../schemas/import.settings.json' with { type: 'json' };
import messages from '../schemas/messages.json' with { type: 'json' };
import ordersTab from '../schemas/orders_tab.settings.json' with { type: 'json' };
import phoneCode from '../schemas/phone_code.settings.json' with { type: 'json' };
import phonePassword from '../schemas/phone_password.settings.json' with { type: 'json' };
import phoneShared from '../schemas/phone.shared.json' with { type: 'json' };
import profileShared from '../schemas/profile.shared.json' with { type: 'json' };
import roleRequests from '../schemas/role_requests.settings.json' with { type: 'json' };
import staffLinks from '../schemas/staff_links.settings.json' with { type: 'json' };
import riskChecks from '../schemas/risk_checks.settings.json' with { type: 'json' };
import roles from '../schemas/roles.settings.json' with { type: 'json' };
import terms from '../schemas/terms.settings.json' with { type: 'json' };
import twoStep from '../schemas/two_step.settings.json' with { type: 'json' };
import { normaliseEmail } from '../core/identifiers.js';
import { selfView } from '../core/profile.js';
import { DEFAULT_ROLE } from '../core/roles.js';
import { createSealer, importedTwoStep, resealWebsite, totpAadOf } from './crypto.js';
import { createImportOptions } from './imports.js';
import { createProviders } from './providers.js';
import { INDEXES, createStore } from './store.js';

/** Settings schema of each feature (manifest.json points at them with `$ref`). @type {Record<string, unknown>} */
const SETTINGS = {
	phone_code: phoneCode,
	phone_password: phonePassword,
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
	staff_links: staffLinks,
	role_requests: roleRequests,
	import: importSettings,
};

/** Every sign-in method (feature). */
const SIGN_IN_FEATURES = ['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook'];

/**
 * Settings several features use (PLAN 0.8.10 A2, A11): the phone format of Phone code and Phone + password, and the
 * Profile settings of every sign-in method.
 * @type {Record<string, { name: string, features: string[], settings: any }>}
 */
export const SHARED_SETTINGS = {
	phone: { name: 'Phone numbers', features: ['phone_code', 'phone_password'], settings: phoneShared },
	profile: { name: 'Profile', features: SIGN_IN_FEATURES, settings: profileShared },
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
	contact_unverified: Object.freeze({ status: 409, title: 'Phone number or email address not proven' }),
	weak_password: Object.freeze({ status: 422, title: 'Password refused' }),
	code_invalid: Object.freeze({ status: 422, title: 'Code not valid' }),
	too_soon: Object.freeze({ status: 429, title: 'Too soon' }),
	notifications_not_connected: Object.freeze({ status: 503, title: 'Notifications not connected' }),
	not_sent: Object.freeze({ status: 502, title: 'Not sent' }),
	provider_failed: Object.freeze({ status: 502, title: 'Provider failed' }),
	product_not_connected: Object.freeze({ status: 503, title: 'Product not connected' }),
	two_step_required: Object.freeze({ status: 403, title: 'Two-step sign-in required' }),
	code_cooldown: Object.freeze({ status: 429, title: 'Wait before asking for another code' }),
	code_limit: Object.freeze({ status: 429, title: 'Too many codes' }),
	country_not_allowed: Object.freeze({ status: 422, title: 'Country not allowed' }),
	sign_in_paused: Object.freeze({ status: 403, title: 'Sign-in paused' }),
	method_refused: Object.freeze({ status: 403, title: 'Sign-in method not allowed' }),
	self_reset_off: Object.freeze({ status: 403, title: 'Password reset is off' }),
});

/**
 * Data rights of Accounts itself (PLAN 0.4.11): the user matched on id, email or phone. Export gives the profile and
 * the devices (never the password, two-step secrets or the merchant's notes); delete erases the user, their sessions,
 * their codes and the messages kept for them.
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
			deleted += await store.outbox.removeTo(u);
			if (await store.users.remove(u.id)) deleted += 1;
		}
		return { deleted, anonymised: 0 };
	},
});

/** Who can sign up in each mode of Approval / invite sign-up (its `mode` setting), as the Setup sheet says it. */
const SIGN_UP_TEXTS = Object.freeze({
	open: 'Anyone can sign up.',
	invite: 'Only people you invite can sign up.',
	approval: 'Sign-ups wait for your approval.',
});

/**
 * Accounts' own part of the website Setup sheet: the sign-in methods that are on and, while Approval / invite sign-up
 * is on, who can sign up. Never a secret.
 * @param {{ on: string[], signUp: keyof typeof SIGN_UP_TEXTS | null }} website `signUp`: the sign-up mode, null while
 *   Approval / invite sign-up is off
 */
const setupPart = ({ on, signUp }) => {
	const names = new Map(manifest.features.map((feature) => [feature.key, feature.name]));
	const methods = SIGN_IN_FEATURES.filter((key) => on.includes(key)).map((key) => names.get(key));
	return {
		summaries: [
			{
				title: 'Sign-in methods',
				text: methods.length > 0 ? `${methods.join(', ')}.` : 'None is on yet, so nobody can sign in.',
			},
			...(signUp === null ? [] : [{ title: 'Sign-up', text: SIGN_UP_TEXTS[signUp] }]),
		],
	};
};

/**
 * @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data' | 'problemCodes' | 'openapi' | 'build'>} InstanceOptions
 */

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
	const keys = (options.problems ?? []).length === 0 ? options.config : undefined;
	const sealer = createSealer(
		keys?.encryptionKey ?? 'unconfigured-accounts-encryption-key-000000',
		keys?.previousEncryptionKey ?? null,
	);

	/** @param {'google' | 'apple' | 'facebook'} name */
	const provider = (name) => ({ test: (/** @type {unknown} */ value) => providers.test(name, value) });
	/** @param {string} productId @param {string} label @param {string[]} neededBy */
	const token = (productId, label, neededBy) => ({ label, kind: /** @type {const} */ ('token'), productId, neededBy });

	/**
	 * Two-step sign-in as the importer writes it for a user (PLAN 0.8.10 A8): the plain TOTP secret sealed at once and
	 * the source system's recovery-code hashes (`sha256("recovery:" + code)`), each working once.
	 * @param {string} websiteId @param {string} userId @param {{ secret: string, recoveryHashes: string[] }} input
	 */
	const twoStepFromImport = (websiteId, userId, { secret, recoveryHashes }) =>
		importedTwoStep(sealer, { secret, recoveryHashes, aad: totpAadOf(websiteId, userId), now: now() });

	const product = createProduct({
		...options,
		manifest,
		strings,
		problemCodes: PROBLEM_CODES,
		// codes, links and invites with their default words: every send to Notifications carries them (parity P1)
		messages,
		connections: {
			notifications: token('notifications', 'Notifications token (codes, invites and resets)', [
				'phone_code',
				'phone_password',
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
			// the pepper of `pbkdf2$` password hashes imported from another system (PLAN 0.8.10 A1): write-only, needed by
			// no feature
			imported_password_pepper: { label: 'Pepper of imported passwords', kind: 'secret', neededBy: [] },
		},
		hooks: {
			...ownDataRights(now),
			// the Owner's Re-seal (RT-14): the signing key, two-step secrets and kept messages of each website
			resealWebsite: (data) => resealWebsite(sealer, data),
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
				const phonePassword = on.includes('phone_password')
					? await product.settings.values(websiteId, 'phone_password')
					: null;
				const profile = await product.settings.values(websiteId, 'profile');
				// the role every sign-up gets: its "remember me" and paused sign-in shape the sign-in widget (A6)
				const signUpRole = on.includes('roles') ? await store.roles.get(DEFAULT_ROLE) : null;
				const requests = on.includes('role_requests') ? await product.settings.values(websiteId, 'role_requests') : null;
				const roleNames = requests ? await store.roles.list() : [];
				return {
					signUp: { mode: rules.mode, requiredFields: rules.requiredFields },
					customFields: on.includes('custom_fields') ? await store.fields.list() : [],
					passwordMinLength: password.minLength,
					phonePassword: phonePassword
						? {
								signUp: phonePassword.signUp,
								minLength: phonePassword.minLength,
								letterAndDigit: phonePassword.letterAndDigit,
								selfReset: phonePassword.selfReset,
								forgotUrl: phonePassword.forgotUrl,
							}
						: null,
					terms: termsSettings ? { version: termsSettings.version, url: termsSettings.url } : null,
					remember: signUpRole?.remember ?? 'ask',
					signInPaused: signUpRole?.signIn === 'paused',
					profile: {
						maxAddresses: profile.maxAddresses,
						keepOneAddress: profile.keepOneAddress,
						addressRequired: profile.addressRequired,
					},
					roleRequests: requests
						? {
								roles: roleNames
									.filter((role) => /** @type {string[]} */ (requests.requestableRoles).includes(role.key))
									.map((role) => ({ key: role.key, name: role.name })),
								requireNote: requests.requireNote,
								revealStatus: requests.revealStatus,
							}
						: null,
				};
			},
			// its part of the website Setup sheet: the sign-in methods that are on and who can sign up
			blueprint: async ({ websiteId, on }) =>
				setupPart({
					on,
					signUp: on.includes('approval') ? (await product.settings.values(websiteId, 'approval')).mode : null,
				}),
		},
		data: { indexes: INDEXES },
		// the website Setup sheet: the API document and what the merchant's website builds per feature
		openapi,
		build: guide.build,
		sharedSettings: SHARED_SETTINGS,
		// records moved in from another system with ss-import (feature `import`, PLAN 0.8.10 K10)
		imports: createImportOptions({
			settings: (websiteId, feature) => product.settings.values(websiteId, feature),
			business: (websiteId) => product.business(websiteId),
			twoStepFromImport,
		}),
	});
	return Object.freeze({ ...product, providers, sealer, now, send, twoStepFromImport });
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
