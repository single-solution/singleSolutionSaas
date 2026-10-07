/**
 * The tiny state runtime every Grades headless element uses (Part E §4): immutable snapshots, change listeners,
 * destroy, and the shared Mode C client / problem types. Framework-agnostic and DOM-free.
 */

/** @typedef {{ code?: string, status?: number, detail?: string, errors?: Array<{ path: string, code: string }> }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: Problem }} Result
 */
/**
 * @typedef {object} ElementClient the element's Mode C client (`@ss/web/element` ElementApi subset)
 * @property {(path: string, options?: { query?: Record<string, string | number | boolean | undefined> }) => Promise<Result<any>>} get
 * @property {(path: string, body?: unknown) => Promise<Result<any>>} post
 */
/** @typedef {(name: string, data: Record<string, unknown>) => void} Emit */

/**
 * @template {Record<string, any>} S
 * @param {S} initial
 */
export const createStore = (initial) => {
	/** @type {Readonly<S>} */
	let state = Object.freeze({ ...initial });
	/** @type {Set<(state: Readonly<S>) => void>} */
	const listeners = new Set();
	let destroyed = false;
	return {
		get: () => state,
		/** @param {Partial<S>} patch */
		set: (patch) => {
			if (destroyed) return;
			state = Object.freeze({ ...state, ...patch });
			for (const listener of listeners) listener(state);
		},
		/** @param {(state: Readonly<S>) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
		isDestroyed: () => destroyed,
	};
};

/**
 * A user-facing error message for a problem: `<prefix>.error.<code>` when the catalog has it, else the fallback key.
 * @param {(key: string) => string} t
 * @param {Readonly<Record<string, string>>} strings
 * @param {string} prefix
 * @param {Problem} problem
 */
export const errorMessage = (t, strings, prefix, problem) => {
	const key = `${prefix}.error.${problem.code ?? 'unknown'}`;
	return Object.hasOwn(strings, key) ? t(key) : t('grades.error.generic');
};

/** Field problem of an invalid id. */
export const ID_PROBLEM = 'id_invalid';

/**
 * The colour a renderer paints: the tier's CSS value (token `var(...)` or validated hex) or null.
 * @param {{ color?: { css?: string | null } | null } | null | undefined} tier
 * @returns {string | null}
 */
export const cssColor = (tier) => {
	const css = tier?.color?.css;
	return typeof css === 'string' && /^(?:var\(--[a-z][a-z0-9-]*\)|#[0-9a-f]{6})$/.test(css) ? css : null;
};

/**
 * Badge model of a tier view.
 * @param {Record<string, any>} tier `tierView` from the API
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 */
export const badgeOf = (tier, t) => ({
	key: String(tier.key),
	label: String(tier.label),
	shortLabel: String(tier.shortLabel ?? tier.label),
	description: String(tier.description ?? ''),
	icon: typeof tier.icon === 'string' ? tier.icon : null,
	color: cssColor(tier),
	style: tier.badge === 'solid' || tier.badge === 'outline' ? tier.badge : 'soft',
	ariaLabel: t('tiers.badge.label', { tier: String(tier.label) }),
});

/** @typedef {ReturnType<typeof badgeOf>} Badge */
