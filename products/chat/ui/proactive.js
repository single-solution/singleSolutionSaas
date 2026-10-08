/**
 * Proactive messages of the visitor chat (PLAN 0.8.3 Proactive): the idle nudge, page rules, exit intent (desktop
 * only) and page-started flows after their delay. Each kind shows at most once per visitor session (sessionStorage),
 * never while the window is open, and none shows for `dismissDays` days after the visitor dismisses one
 * (localStorage, both under PROACTIVE_STORAGE_KEY).
 * @module
 */
import { formatText } from '@ss/app-kit/widget';
import { pathMatches } from '../core/text.js';
import { PROACTIVE_STORAGE_KEY } from '../core/widgets.js';

const DAY_MS = 86_400_000;
/** Activity that restarts the idle wait. */
const ACTIVITY_EVENTS = Object.freeze(['pointermove', 'pointerdown', 'keydown', 'scroll']);

/** @typedef {'idle' | 'page' | 'exit' | 'flow'} Kind */

/**
 * The visitor's proactive memory.
 * @param {{ win: Window, now: () => number }} input
 */
export const createMemory = ({ win, now }) => {
	/** @param {'localStorage' | 'sessionStorage'} name @returns {Record<string, any>} */
	const read = (name) => {
		try {
			return JSON.parse(win[name].getItem(PROACTIVE_STORAGE_KEY) ?? '{}') ?? {};
		} catch {
			return {};
		}
	};
	/** @param {'localStorage' | 'sessionStorage'} name @param {Record<string, unknown>} value */
	const write = (name, value) => {
		try {
			win[name].setItem(PROACTIVE_STORAGE_KEY, JSON.stringify(value));
		} catch {
			// storage blocked: proactive messages may repeat
		}
	};
	/** @param {string} list @param {string} item */
	const add = (list, item) => {
		const session = read('sessionStorage');
		write('sessionStorage', { ...session, [list]: [...(session[list] ?? []), item] });
	};
	/** @param {string} list @param {string} item */
	const has = (list, item) => (read('sessionStorage')[list] ?? []).includes(item);
	return Object.freeze({
		/** @param {Kind} kind */
		allowed: (kind) => !has('shown', kind) && !(Number(read('localStorage').dismissedUntil) > now()),
		/** @param {Kind} kind */
		shown: (kind) => add('shown', kind),
		/** @param {number} days */
		dismiss: (days) => write('localStorage', { dismissedUntil: now() + days * DAY_MS }),
		/** @param {string} id */
		flowStarted: (id) => has('flows', id),
		/** @param {string} id */
		startFlow: (id) => add('flows', id),
	});
};

/**
 * The first page-started flow whose path matches.
 * @param {import('./common.js').ChatSettings['flows']} flows
 * @param {string} path
 */
export const pageFlow = (flows, path) =>
	flows.find((flow) => flow.start?.kind === 'page' && pathMatches(flow.start.path, path)) ?? null;

/**
 * Is this a desktop pointer (no coarse pointer, can hover)?
 * @param {Window} win
 */
export const isDesktop = (win) => {
	/** @param {string} query */
	const media = (query) => typeof win.matchMedia === 'function' && win.matchMedia(query).matches;
	return !media('(pointer: coarse)') && !media('(hover: none)');
};

/**
 * Start the proactive triggers of a page.
 * @param {import('./transport.js').Clock & {
 *   features: string[], settings: import('./common.js').ChatSettings, t: import('./common.js').Texts, path: string,
 *   productName: () => string | null,
 *   offer: (kind: Kind, text: string) => boolean,
 *   startFlow: (flow: import('./common.js').ChatSettings['flows'][number]) => void }} input `offer` answers false while
 *   the window is open (the idle nudge waits again)
 * @returns {() => void} stop
 */
export const startProactive = ({ win, schedule, cancel, now, features, settings, t, path, productName, offer, startFlow }) => {
	const doc = win.document;
	/** @type {number[]} */
	const timers = [];
	/** @type {Array<() => void>} */
	const stops = [];
	/** @param {() => void} task @param {number} ms */
	const later = (task, ms) => timers.push(schedule(task, ms));

	if (features.includes('proactive_idle') && settings.proactive.idleMinutes > 0) {
		const idleMs = settings.proactive.idleMinutes * 60_000;
		let last = now();
		const touch = () => {
			last = now();
		};
		const fire = () => {
			const left = idleMs - (now() - last);
			if (left > 0) return later(fire, left);
			const product = productName();
			const text = product ? formatText(t('chat.idleProduct'), { product }) : t('chat.idle');
			if (!offer('idle', text)) later(fire, idleMs);
		};
		for (const name of ACTIVITY_EVENTS) win.addEventListener(name, touch, { passive: true });
		stops.push(() => ACTIVITY_EVENTS.forEach((name) => win.removeEventListener(name, touch)));
		later(fire, idleMs);
	}

	const rule = features.includes('proactive_pages')
		? settings.proactive.pageRules.find((each) => pathMatches(each.path, path))
		: undefined;
	if (rule) later(() => void offer('page', rule.message), Math.max(0, rule.delay) * 1000);

	const flow = features.includes('leads_flows') ? pageFlow(settings.flows, path) : null;
	if (flow && flow.start.delay > 0) later(() => startFlow(flow), flow.start.delay * 1000);

	if (features.includes('proactive_exit') && isDesktop(win)) {
		/** @param {MouseEvent} event */
		const leave = (event) => {
			if (!event.relatedTarget && event.clientY <= 0) offer('exit', t('chat.exit'));
		};
		doc.addEventListener('mouseout', leave);
		stops.push(() => doc.removeEventListener('mouseout', leave));
	}

	return () => {
		timers.forEach((id) => cancel(id));
		stops.forEach((stop) => stop());
	};
};
