/**
 * The Portal's own state in its control database (`platform_system`), so that only the database, the Portal address,
 * the encryption key and (until step 5) the asset storage are configured through the environment:
 *
 * - `secrets` — generated on first start and inserted only if absent (`_id` unique), so concurrent cold starts agree on
 *   one set: the Ed25519 Portal signing key(s), the website-key signing key(s), the encryption keys (KEKs), the session
 *   secret, the key pepper and the idempotency secret. Lists stay lists (first signs or seals; all are published or
 *   able to open), so older data keeps working.
 * - `settings` — recorded by Owners (PLAN 0.8.2 Settings): e-mail sending (its password sealed with `ENCRYPTION_KEY`),
 *   branding, support contact, security and billing rules. `version` increases with every change so other instances
 *   notice and rebuild.
 * - `logo` — the Branding logo (PNG, JPEG or WebP, at most 200 kB), served at `/branding/logo`.
 * - `schema` — the fingerprint of the indexes and migrations last applied (applied once per deploy, under a lock).
 *
 * Loaded once per instance and cached by the runtime.
 * @module
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { signingKeyFromSeed } from '@ss/protocol';
import { createSecretBox } from './crypto.js';
import { platformError } from './errors.js';
import { COLLECTIONS } from './schema.js';

/** The collection (registered in `INFRA_COLLECTIONS`). */
export const SYSTEM_COLLECTION = COLLECTIONS.system;

/** @typedef {import('./config.js').SystemState} SystemState */
/** @typedef {{ kid: string, seed: string, createdAt: string }} StoredKey */
/**
 * @typedef {object} SecretsDoc
 * @property {'secrets'} _id
 * @property {StoredKey[]} signingKeys
 * @property {StoredKey[]} websiteSigningKeys
 * @property {Array<{ id: string, key: string, createdAt: string }>} encryptionKeys
 * @property {string} sessionSecret
 * @property {string} keyPepper
 * @property {string} idempotencySecret
 */
/**
 * @typedef {object} MailSettings
 * @property {string} host
 * @property {number} port
 * @property {boolean} secure implicit TLS (465); otherwise STARTTLS
 * @property {string | null} user
 * @property {string | null} passSealed the password, sealed with the encryption keys
 * @property {string} from
 */
/**
 * @typedef {object} SettingsDoc
 * @property {'settings'} _id
 * @property {number} version
 * @property {MailSettings | null} mail
 * @property {Partial<import('./config.js').PortalSettings['security']>} [security]
 * @property {Partial<import('./config.js').PortalSettings['branding']>} [branding]
 * @property {Partial<import('./config.js').PortalSettings['support']>} [support]
 * @property {Partial<import('./config.js').PortalSettings['billing']>} [billing]
 * @property {Date} updatedAt
 */

/** Logo file types (never SVG) and size cap (PLAN 0.8.2 Branding). */
export const LOGO_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const LOGO_MAX_BYTES = 200 * 1024;

const MAIL_AAD = { purpose: 'platform-mail' };

/**
 * @param {(n: number) => Uint8Array} randomBytes
 * @param {number} n
 */
const b64url = (randomBytes, n = 32) => Buffer.from(randomBytes(n)).toString('base64url');

/**
 * @param {string} prefix
 * @param {() => number} now
 * @param {(n: number) => Uint8Array} randomBytes
 */
const kidOf = (prefix, now, randomBytes) =>
	`${prefix}-${new Date(now()).toISOString().slice(0, 10).replace(/-/g, '')}-${Buffer.from(randomBytes(3)).toString('hex')}`;

/**
 * A fresh set of secrets (first start; tests).
 * @param {{ now?: () => number, randomBytes?: (n: number) => Uint8Array }} [options]
 * @returns {Omit<SecretsDoc, '_id'>}
 */
export const generateSecrets = ({ now = Date.now, randomBytes = (n) => new Uint8Array(nodeRandomBytes(n)) } = {}) => {
	const createdAt = new Date(now()).toISOString();
	return {
		signingKeys: [{ kid: kidOf('portal', now, randomBytes), seed: b64url(randomBytes), createdAt }],
		websiteSigningKeys: [{ kid: kidOf('website', now, randomBytes), seed: b64url(randomBytes), createdAt }],
		encryptionKeys: [{ id: kidOf('k', now, randomBytes), key: b64url(randomBytes), createdAt }],
		sessionSecret: b64url(randomBytes),
		keyPepper: b64url(randomBytes),
		idempotencySecret: b64url(randomBytes),
	};
};

/**
 * The secrets part of the system state.
 * @param {Omit<SecretsDoc, '_id'>} doc
 * @returns {Omit<SystemState, 'mail'>}
 */
export const secretsOf = (doc) => ({
	signingKeys: doc.signingKeys.map((key) => signingKeyFromSeed(key.kid, key.seed)),
	websiteKeySigningKeys: doc.websiteSigningKeys.map((key) => signingKeyFromSeed(key.kid, key.seed)),
	keks: doc.encryptionKeys.map((key) => ({ id: key.id, key: Buffer.from(key.key, 'base64url') })),
	sessionSecret: Buffer.from(doc.sessionSecret, 'base64url'),
	websiteKeyPepper: Buffer.from(doc.keyPepper, 'base64url'),
	idempotencySecret: Buffer.from(doc.idempotencySecret, 'base64url'),
});

/**
 * A complete system state for tests and tools: fresh secrets plus the given settings.
 * @param {{ mail?: SystemState['mail'], settings?: SystemState['settings'] }} [settings]
 * @returns {SystemState}
 */
export const testSystemState = ({ mail = null, settings } = {}) => ({
	...secretsOf(generateSecrets()),
	mail,
	...(settings ? { settings } : {}),
});

/**
 * @param {unknown} error
 * @returns {boolean}
 */
const isDuplicateKey = (error) => typeof error === 'object' && error !== null && /** @type {any} */ (error).code === 11000;

/**
 * Access to the system state in a control database.
 * @param {import('mongodb').Db} db
 * @param {{ encryptionKey: string, now?: () => number, randomBytes?: (n: number) => Uint8Array }} options
 */
export const createSystemStore = (
	db,
	{ encryptionKey, now = Date.now, randomBytes = (n) => new Uint8Array(nodeRandomBytes(n)) },
) => {
	const collection = /** @type {import('mongodb').Collection<any>} */ (db.collection(SYSTEM_COLLECTION));
	const box = createSecretBox({ encryptionKey, randomBytes });
	/**
	 * The SMTP password, or null when none is stored or it was sealed under another `ENCRYPTION_KEY` (PLAN 0.4.8).
	 * @param {string | null | undefined} sealed
	 */
	const openPassword = (sealed) => {
		if (!sealed) return null;
		try {
			return box.openText(sealed, { aad: MAIL_AAD });
		} catch {
			return null;
		}
	};

	/** @returns {Promise<SecretsDoc>} the secrets, generated and inserted if absent (concurrent starts agree) */
	const secrets = async () => {
		const found = await collection.findOne({ _id: 'secrets' });
		if (found) return /** @type {SecretsDoc} */ (found);
		try {
			await collection.insertOne({ _id: 'secrets', ...generateSecrets({ now, randomBytes }) });
		} catch (error) {
			if (!isDuplicateKey(error)) throw error;
		}
		const stored = await collection.findOne({ _id: 'secrets' });
		if (!stored) throw platformError('internal_error', 'the Portal secrets could not be stored');
		return /** @type {SecretsDoc} */ (stored);
	};

	/** @returns {Promise<SettingsDoc | null>} */
	const settings = async () => /** @type {SettingsDoc | null} */ (await collection.findOne({ _id: 'settings' }));

	/** @returns {Promise<number>} the settings version (0 before the first change), a cheap read for cache checks */
	const version = async () => {
		const doc = await collection.findOne({ _id: 'settings' }, { projection: { version: 1 } });
		return typeof doc?.version === 'number' ? doc.version : 0;
	};

	/**
	 * The complete system state: secrets and settings (the mail password unsealed).
	 * @returns {Promise<{ state: SystemState, version: number }>}
	 */
	const load = async () => {
		const [secretsDoc, settingsDoc] = await Promise.all([secrets(), settings()]);
		const base = secretsOf(secretsDoc);
		const mail = settingsDoc?.mail ?? null;
		return {
			state: {
				...base,
				mail: mail
					? {
							host: mail.host,
							port: mail.port,
							secure: mail.secure,
							user: mail.user,
							pass: openPassword(mail.passSealed),
							from: mail.from,
						}
					: null,
				settings: {
					security: { ...(settingsDoc?.security ?? {}) },
					branding: { ...(settingsDoc?.branding ?? {}) },
					support: { ...(settingsDoc?.support ?? {}) },
					billing: { ...(settingsDoc?.billing ?? {}) },
				},
			},
			version: typeof settingsDoc?.version === 'number' ? settingsDoc.version : 0,
		};
	};

	/**
	 * Change settings (bumps the version). `mail.pass`: a new password (sealed here), `undefined` keeps the stored one,
	 * `null` removes it. `security`, `branding`, `support` and `billing` replace the named fields only.
	 * @param {{
	 *   mail?: { host: string, port: number, secure: boolean, user: string | null, pass?: string | null, from: string } | null,
	 *   security?: Partial<import('./config.js').PortalSettings['security']>,
	 *   branding?: Partial<import('./config.js').PortalSettings['branding']>,
	 *   support?: Partial<import('./config.js').PortalSettings['support']>,
	 *   billing?: Partial<import('./config.js').PortalSettings['billing']> }} patch
	 * @returns {Promise<SettingsDoc>}
	 */
	const update = async (patch) => {
		/** @type {Record<string, unknown>} */
		const set = { updatedAt: new Date(now()) };
		for (const group of /** @type {const} */ (['security', 'branding', 'support', 'billing']))
			for (const [key, value] of Object.entries(patch[group] ?? {})) if (value !== undefined) set[`${group}.${key}`] = value;
		if (patch.mail !== undefined) {
			if (patch.mail === null) set.mail = null;
			else {
				const current = (await settings())?.mail ?? null;
				let passSealed = current?.passSealed ?? null;
				if (patch.mail.pass === null) passSealed = null;
				else if (typeof patch.mail.pass === 'string' && patch.mail.pass.length > 0) {
					passSealed = box.seal(patch.mail.pass, { aad: MAIL_AAD });
				}
				set.mail = {
					host: patch.mail.host,
					port: patch.mail.port,
					secure: patch.mail.secure,
					user: patch.mail.user,
					passSealed,
					from: patch.mail.from,
				};
			}
		}
		const doc = await collection.findOneAndUpdate(
			{ _id: 'settings' },
			{
				$set: set,
				$inc: { version: 1 },
				$setOnInsert: {
					...(set.mail === undefined ? { mail: null } : {}),
				},
			},
			{ upsert: true, returnDocument: 'after' },
		);
		return /** @type {SettingsDoc} */ (doc);
	};

	/**
	 * Store the Branding logo (type and size checked by the caller) and bump the settings version.
	 * @param {{ type: string, data: Buffer } | null} logo null removes it
	 */
	const setLogo = async (logo) => {
		if (logo) await collection.updateOne({ _id: 'logo' }, { $set: { type: logo.type, data: logo.data } }, { upsert: true });
		else await collection.deleteOne({ _id: 'logo' });
		const current = await settings();
		return update({
			branding: { hasLogo: Boolean(logo), logoVersion: Number(current?.branding?.logoVersion ?? 0) + 1 },
		});
	};

	/** @returns {Promise<{ type: string, data: Buffer } | null>} the Branding logo */
	const logo = async () => {
		const doc = await collection.findOne({ _id: 'logo' });
		if (!doc || typeof doc.type !== 'string' || !doc.data) return null;
		const data = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer ?? doc.data);
		return { type: doc.type, data };
	};

	/** @param {string | null | undefined} sealed true when the stored SMTP password opens with this `ENCRYPTION_KEY` */
	const passwordReadable = (sealed) => openPassword(sealed) !== null;

	/** @returns {Promise<string | null>} the schema fingerprint last applied */
	const appliedSchema = async () => {
		const doc = await collection.findOne({ _id: 'schema' });
		return typeof doc?.fingerprint === 'string' ? doc.fingerprint : null;
	};
	/** @param {string} fingerprint */
	const recordSchema = async (fingerprint) => {
		await collection.updateOne({ _id: 'schema' }, { $set: { fingerprint, appliedAt: new Date(now()) } }, { upsert: true });
	};

	return Object.freeze({
		secrets,
		settings,
		version,
		load,
		update,
		setLogo,
		logo,
		passwordReadable,
		appliedSchema,
		recordSchema,
	});
};

/** @typedef {ReturnType<typeof createSystemStore>} SystemStore */
