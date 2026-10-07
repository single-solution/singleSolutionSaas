/**
 * Configuration targets: which layer of which subscription (or app across merchants) a change
 * addresses. Pure.
 * @module
 */

/** Layer levels in precedence order (`@ss/entitlements` `LAYERS` without product and plan). */
export const LEVELS = Object.freeze(/** @type {const} */ (['platform', 'website', 'admin']));

/** @typedef {typeof LEVELS[number]} Level */

/** Levels written by staff only. */
export const STAFF_LEVELS = Object.freeze(new Set(['platform', 'admin']));

/**
 * @typedef {{ level: 'platform', appId: string } | { level: 'website' | 'admin', subscriptionId: string }} TargetRef
 */

/**
 * @typedef {object} FieldError
 * @property {string} path
 * @property {string} message
 * @property {string} [code]
 */

const ID = /^[a-z][a-z0-9]{1,15}_[0-9a-z]{10,64}$/;
const APP = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** @param {unknown} value */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validate a target reference. `level` may be given separately (INTERFACES `setOverride({ level, target })`), and a
 * bare string target is the subscription id (website/admin) or the app id (platform).
 * @param {unknown} input
 * @param {unknown} [level]
 * @returns {{ ok: true, value: TargetRef } | { ok: false, errors: FieldError[] }}
 */
export const parseTarget = (input, level) => {
	const raw = typeof input === 'string' ? {} : isRecord(input) ? /** @type {Record<string, unknown>} */ (input) : null;
	if (raw === null)
		return { ok: false, errors: [{ path: '/target', message: 'target must be an object', code: 'invalid_target' }] };
	const lvl = level ?? raw.level;
	if (!LEVELS.includes(/** @type {Level} */ (lvl)))
		return {
			ok: false,
			errors: [{ path: '/level', message: `level must be one of ${LEVELS.join(', ')}`, code: 'invalid_target' }],
		};
	/** @type {FieldError[]} */
	const errors = [];
	/**
	 * @param {string} name
	 * @param {RegExp} pattern
	 * @param {unknown} value
	 */
	const need = (name, pattern, value) => {
		if (typeof value !== 'string' || !pattern.test(value))
			errors.push({ path: `/target/${name}`, message: `${name} is required`, code: 'invalid_target' });
		return /** @type {string} */ (value);
	};
	switch (lvl) {
		case 'platform': {
			const appId = need('appId', APP, typeof input === 'string' ? input : raw.appId);
			return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { level: 'platform', appId } };
		}
		default: {
			const subscriptionId = need('subscriptionId', ID, typeof input === 'string' ? input : raw.subscriptionId);
			return errors.length > 0
				? { ok: false, errors }
				: { ok: true, value: { level: /** @type {'website' | 'admin'} */ (lvl), subscriptionId } };
		}
	}
};

/**
 * Stable storage key of a target.
 * @param {TargetRef} target
 * @returns {string}
 */
export const targetKey = (target) => {
	switch (target.level) {
		case 'platform':
			return `platform:${target.appId}`;
		default:
			return `${target.level}:${target.subscriptionId}`;
	}
};

/**
 * Whether an actor type may write a level at all (staff levels are staff-only; product/website actors never write).
 * @param {string | undefined} actorType
 * @param {Level} level
 */
export const actorMayWrite = (actorType, level) => {
	if (actorType === 'admin' || actorType === 'system') return true;
	return actorType === 'merchant' && !STAFF_LEVELS.has(level);
};

/**
 * Only staff (and system jobs acting for staff) set or clear locks (PLAN Part D L8).
 * @param {string | undefined} actorType
 */
export const actorMayLock = (actorType) => actorType === 'admin' || actorType === 'system';
