/**
 * Mode B headless core of the `launcher` (Part E §4): visibility (hide rules by path and device), unread badge,
 * open/close of the window and the auto-open triggers (delay, scroll depth, exit intent, idle, selector click).
 * DOM-free: the renderer (or the merchant's code) reports environment signals with `actions.signal(...)`; the
 * launcher drives the window headless core passed as `window` (the Loader passes the mounted window element).
 * @module
 */
import { pathMatches } from '../core/text.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {object} LauncherState
 * @property {boolean} visible
 * @property {boolean} open
 * @property {number} unread
 * @property {string} label accessible label (open / close)
 * @property {string | null} badge unread badge text
 * @property {'bottom_end' | 'bottom_start'} position
 * @property {'small' | 'medium' | 'large'} size
 * @property {string} icon
 * @property {string} avatarUrl
 * @property {boolean} showLabel
 * @property {boolean} pulse
 * @property {boolean} mobileTab
 * @property {{ x: number, y: number }} offset
 * @property {boolean} autoOpened
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client?: unknown, identity?: unknown,
 *   emit?: (name: string, data: Record<string, unknown>) => void,
 *   window?: { state: () => { open: boolean, unread: number }, actions: { open: () => Promise<unknown>, close: () => Promise<unknown> }, subscribe: (fn: (s: any) => void) => () => void } | null,
 *   environment?: { path?: string, device?: 'mobile' | 'tablet' | 'desktop' },
 *   scheduler?: { setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (handle: unknown) => void },
 *   session?: { get: (key: string) => string | null, set: (key: string, value: string) => void } | null }} options
 */
export const createLauncher = ({
	config = {},
	strings = {},
	emit = () => {},
	window: chatWindow = null,
	environment = {},
	scheduler = {
		setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
		clearTimeout: (h) => globalThis.clearTimeout(/** @type {any} */ (h)),
	},
	session = null,
}) => {
	const t = createTranslator(strings);
	/** @type {Set<(state: LauncherState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {unknown} */
	let delayTimer = null;
	let env = { ...environment };

	/** Hidden on this path or device? */
	const hiddenHere = () => {
		const paths = Array.isArray(config.hide_on_paths) ? config.hide_on_paths : [];
		const devices = Array.isArray(config.hide_on_devices) ? config.hide_on_devices : [];
		return (
			(env.path ? paths.some((/** @type {string} */ p) => pathMatches(p, /** @type {string} */ (env.path))) : false) ||
			(env.device ? devices.includes(env.device) : false)
		);
	};
	/** @param {boolean} open @param {number} unread */
	const derived = (open, unread) => ({
		open,
		unread,
		label: t(open ? 'launcher.close' : 'launcher.open'),
		badge: config.unread_badge !== false && unread > 0 && !open ? (unread > 9 ? '9+' : String(unread)) : null,
	});

	/** @type {LauncherState} */
	let state = Object.freeze({
		visible: !hiddenHere(),
		...derived(chatWindow?.state().open ?? false, chatWindow?.state().unread ?? 0),
		position: config.position === 'bottom_start' ? 'bottom_start' : 'bottom_end',
		size: ['small', 'large'].includes(config.size) ? config.size : 'medium',
		icon: typeof config.icon === 'string' ? config.icon : 'chat',
		avatarUrl: typeof config.avatar_url === 'string' ? config.avatar_url : '',
		showLabel: config.show_label === true,
		pulse: config.pulse !== false,
		mobileTab: config.mobile_tab === true,
		offset: { x: Number(config.offset_x ?? 20), y: Number(config.offset_y ?? 20) },
		autoOpened: false,
	});
	/** @param {Partial<LauncherState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	const unsubscribeWindow = chatWindow?.subscribe((w) => {
		if (w.open !== state.open || w.unread !== state.unread) set(derived(w.open, w.unread));
	});

	const SESSION_KEY = 'ss_chatbot_auto_opened';
	const autoOpen = async (/** @type {string} */ trigger) => {
		if (!state.visible || state.open || state.autoOpened) return { ok: false, error: { code: 'skipped', status: 0 } };
		if (config.auto_open_once_per_session !== false && session?.get(SESSION_KEY))
			return { ok: false, error: { code: 'skipped', status: 0 } };
		session?.set(SESSION_KEY, '1');
		set({ autoOpened: true });
		emit('auto_opened', { trigger });
		await chatWindow?.actions.open();
		set(derived(true, 0));
		return { ok: true, value: state };
	};

	if (config.auto_open === 'delay' && state.visible) {
		delayTimer = scheduler.setTimeout(
			() => void autoOpen('delay'),
			Math.max(0, Number(config.auto_open_delay_seconds ?? 15)) * 1000,
		);
	}

	const actions = Object.freeze({
		toggle: async () => {
			if (state.open) {
				await chatWindow?.actions.close();
				set(derived(false, state.unread));
			} else {
				await chatWindow?.actions.open();
				set(derived(true, 0));
				emit('clicked', {});
			}
			return { ok: true, value: state };
		},
		open: async () => (state.open ? { ok: true, value: state } : actions.toggle()),
		close: async () => (state.open ? actions.toggle() : { ok: true, value: state }),
		/**
		 * Environment signal from the page: `scroll` (percent), `idle` (seconds), `exit`, `selector`, `navigate` (path).
		 * @param {'scroll' | 'idle' | 'exit' | 'selector' | 'navigate'} kind
		 * @param {number | string} [value]
		 */
		signal: async (kind, value) => {
			if (kind === 'navigate' && typeof value === 'string') {
				env = { ...env, path: value };
				set({ visible: !hiddenHere() });
				return { ok: true, value: state };
			}
			if (kind === 'selector') return actions.open();
			const mode = config.auto_open;
			if (kind === 'scroll' && mode === 'scroll' && Number(value) >= Number(config.auto_open_scroll_percent ?? 50))
				return autoOpen('scroll');
			if (kind === 'idle' && mode === 'idle' && Number(value) >= Number(config.auto_open_idle_seconds ?? 30))
				return autoOpen('idle');
			if (kind === 'exit' && mode === 'exit_intent') return autoOpen('exit_intent');
			return { ok: false, error: { code: 'skipped', status: 0 } };
		},
	});

	return Object.freeze({
		/** @returns {LauncherState} */
		state: () => state,
		actions,
		/** @param {(state: LauncherState) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** The launcher takes no user input. @returns {Array<{ path: string, code: string, message: string }>} */
		validate: () => [],
		/** The CSS selector whose clicks open the window ('' = none). */
		openSelector: typeof config.open_selector === 'string' ? config.open_selector : '',
		strings,
		t,
		destroy: () => {
			destroyed = true;
			if (delayTimer !== null) scheduler.clearTimeout(delayTimer);
			unsubscribeWindow?.();
			listeners.clear();
		},
	});
};
