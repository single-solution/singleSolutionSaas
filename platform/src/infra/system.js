/**
 * The Portal's own state in its control database (`platform_system`), so that nothing but the database and the asset
 * storage is configured through the environment:
 *
 * - `secrets` — generated on first start and inserted only if absent (`_id` unique), so concurrent cold starts agree on
 *   one set: the Ed25519 Portal signing key(s), the website-key signing key(s), the encryption keys (KEKs), the session
 *   secret, the key pepper and the idempotency secret. Rotation prepends a new key and keeps the old ones published
 *   (signing) or able to open (encryption).
 * - `settings` — recorded at `/setup` and by admins: the Portal URL (issuer/audience, e-mail links, CSRF origin), an
 *   optional preview URL and the mailer (its password sealed with the encryption keys). `version` increases with every
 *   change so other instances notice and rebuild.
 * - `schema` — the fingerprint of the indexes and migrations last applied (applied once per deploy, under a lock).
 *
 * Loaded once per instance and cached by the runtime.
 * @module
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { signingKeyFromSeed } from '@ss/protocol';
import { createEnvelope } from './crypto.js';
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
 * @property {string | null} portalUrl
 * @property {string | null} previewUrl
 * @property {MailSettings | null} mail
 * @property {Date | null} setupAt
 * @property {Date} updatedAt
 */

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
 * @returns {Omit<SystemState, 'portalUrl' | 'previewUrl' | 'mail'>}
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
 * @param {{ portalUrl?: string | null, previewUrl?: string | null, mail?: SystemState['mail'] }} [settings]
 * @returns {SystemState}
 */
export const testSystemState = ({ portalUrl = null, previewUrl = null, mail = null } = {}) => ({
	...secretsOf(generateSecrets()),
	portalUrl,
	previewUrl,
	mail,
});

/**
 * @param {unknown} error
 * @returns {boolean}
 */
const isDuplicateKey = (error) => typeof error === 'object' && error !== null && /** @type {any} */ (error).code === 11000;

/**
 * Access to the system state in a control database.
 * @param {import('mongodb').Db} db
 * @param {{ now?: () => number, randomBytes?: (n: number) => Uint8Array }} [options]
 */
export const createSystemStore = (db, { now = Date.now, randomBytes = (n) => new Uint8Array(nodeRandomBytes(n)) } = {}) => {
	const collection = /** @type {import('mongodb').Collection<any>} */ (db.collection(SYSTEM_COLLECTION));

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

	/** @returns {Promise<number>} the settings version (0 before setup), a cheap read for cache checks */
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
		const envelope = createEnvelope({ keks: base.keks, randomBytes });
		const mail = settingsDoc?.mail ?? null;
		return {
			state: {
				...base,
				portalUrl: settingsDoc?.portalUrl ?? null,
				previewUrl: settingsDoc?.previewUrl ?? null,
				mail: mail
					? {
							host: mail.host,
							port: mail.port,
							secure: mail.secure,
							user: mail.user,
							pass: mail.passSealed ? envelope.openText(mail.passSealed, { aad: MAIL_AAD }) : null,
							from: mail.from,
						}
					: null,
			},
			version: typeof settingsDoc?.version === 'number' ? settingsDoc.version : 0,
		};
	};

	/**
	 * Change settings (bumps the version). `mail.pass`: a new password (sealed here), `undefined` keeps the stored one,
	 * `null` removes it. `setup: true` records the first-run setup time.
	 * @param {{ portalUrl?: string, previewUrl?: string | null, setup?: boolean,
	 *   mail?: { host: string, port: number, secure: boolean, user: string | null, pass?: string | null, from: string } | null }} patch
	 * @returns {Promise<SettingsDoc>}
	 */
	const update = async (patch) => {
		/** @type {Record<string, unknown>} */
		const set = { updatedAt: new Date(now()) };
		if (patch.portalUrl !== undefined) set.portalUrl = patch.portalUrl;
		if (patch.previewUrl !== undefined) set.previewUrl = patch.previewUrl;
		if (patch.setup) set.setupAt = new Date(now());
		if (patch.mail !== undefined) {
			if (patch.mail === null) set.mail = null;
			else {
				const current = (await settings())?.mail ?? null;
				let passSealed = current?.passSealed ?? null;
				if (patch.mail.pass === null) passSealed = null;
				else if (typeof patch.mail.pass === 'string' && patch.mail.pass.length > 0) {
					const envelope = createEnvelope({ keks: secretsOf(await secrets()).keks, randomBytes });
					passSealed = envelope.seal(patch.mail.pass, { aad: MAIL_AAD });
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
					...(set.portalUrl === undefined ? { portalUrl: null } : {}),
					...(set.previewUrl === undefined ? { previewUrl: null } : {}),
					...(set.mail === undefined ? { mail: null } : {}),
					...(set.setupAt === undefined ? { setupAt: null } : {}),
				},
			},
			{ upsert: true, returnDocument: 'after' },
		);
		return /** @type {SettingsDoc} */ (doc);
	};

	/**
	 * Rotate a key: prepend a new one (it signs or seals from now on) and keep the others published / able to open.
	 * Bumps the settings version so every instance reloads.
	 * @param {'signing' | 'website' | 'encryption'} kind
	 * @returns {Promise<{ kind: string, id: string, count: number }>}
	 */
	const rotate = async (kind) => {
		await secrets();
		const createdAt = new Date(now()).toISOString();
		const field = kind === 'signing' ? 'signingKeys' : kind === 'website' ? 'websiteSigningKeys' : 'encryptionKeys';
		/** @type {Record<string, string>} */
		const entry =
			kind === 'encryption'
				? { id: kidOf('k', now, randomBytes), key: b64url(randomBytes), createdAt }
				: { kid: kidOf(kind === 'signing' ? 'portal' : 'website', now, randomBytes), seed: b64url(randomBytes), createdAt };
		const updated = /** @type {Record<string, unknown> | null} */ (
			await collection.findOneAndUpdate(
				{ _id: 'secrets' },
				/** @type {any} */ ({ $push: { [field]: { $each: [entry], $position: 0 } } }),
				{ returnDocument: 'after' },
			)
		);
		await update({});
		const list = updated?.[field];
		return { kind, id: String(entry.kid ?? entry.id), count: Array.isArray(list) ? list.length : 1 };
	};

	/**
	 * Public facts about the keys (for the admin settings page): ids and creation dates, never key material.
	 * @returns {Promise<Record<'signing' | 'website' | 'encryption', Array<{ id: string, createdAt: string, active: boolean }>>>}
	 */
	const keyInfo = async () => {
		const doc = await secrets();
		/** @param {Array<{ kid?: string, id?: string, createdAt: string }>} keys */
		const list = (keys) =>
			keys.map((key, index) => ({ id: String(key.kid ?? key.id), createdAt: key.createdAt, active: index === 0 }));
		return { signing: list(doc.signingKeys), website: list(doc.websiteSigningKeys), encryption: list(doc.encryptionKeys) };
	};

	/** @returns {Promise<string | null>} the schema fingerprint last applied */
	const appliedSchema = async () => {
		const doc = await collection.findOne({ _id: 'schema' });
		return typeof doc?.fingerprint === 'string' ? doc.fingerprint : null;
	};
	/** @param {string} fingerprint */
	const recordSchema = async (fingerprint) => {
		await collection.updateOne({ _id: 'schema' }, { $set: { fingerprint, appliedAt: new Date(now()) } }, { upsert: true });
	};

	return Object.freeze({ secrets, settings, version, load, update, rotate, keyInfo, appliedSchema, recordSchema });
};

/** @typedef {ReturnType<typeof createSystemStore>} SystemStore */
