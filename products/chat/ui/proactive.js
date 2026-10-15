/**
 * Proactive messages of the visitor chat (PLAN 0.8.3 Proactive): the idle nudge, page rules, exit intent (desktop
 * only) and page-started flows after their delay. Each kind shows at most once per visitor session (sessionStorage),
 * never while the window is open, and none shows for `dismissDays` days after the visitor dismisses one
 * (localStorage, both under PROACTIVE_STORAGE_KEY). The idle nudge (PLAN 0.8.10 C14) says the merchant's text for the
 * kind of page `SSChat.setPage()` named, may show once per product instead of once per session, and may stay away
 * from phones.
 * @module
 */
import { formatText } from '@ss/app-kit/widget';
import { pageTypeOf } from '../core/pages.js';
import { pathMatches } from '../core/text.js';
import { PHONE_MEDIA, PROACTIVE_STORAGE_KEY } from '../core/widgets.js';

const DAY_MS = 86_400_000;
/** Activity that restarts the idle wait. */
const ACTIVITY_EVENTS = Object.freeze(['pointermove', 'pointerdown', 'keydown', 'scroll']);

/** @typedef {'idle' | 'page' | 'exit' | 'flow'} Kind */
/** @typedef {import('./chat.js').PageInfo} PageInfo */
/** @typedef {import('./common.js').ChatSettings['proactive']} Proactive */

/**
 * The visitor's memory of this session and of dismissals: proactive messages and flows shown, and a lead left.
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
		/** @param {string} once what a message is remembered by: its kind, or the idle nudge of one product */
		allowed: (once) => !has('shown', once) && !(Number(read('localStorage').dismissedUntil) > now()),
		/** @param {string} once */
		shown: (once) => add('shown', once),
		/** @param {number} days */
		dismiss: (days) => write('localStorage', { dismissedUntil: now() + days * DAY_MS }),
		/** @param {string} id */
		flowStarted: (id) => has('flows', id),
		/** @param {string} id */
		startFlow: (id) => add('flows', id),
		/** The visitor left a lead this session (the lead form outside office hours is offered once). */
		leadSent: () => add('leads', 'sent'),
		leadWasSent: () => has('leads', 'sent'),
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
 * Whether a media query matches (false where the browser cannot tell).
 * @param {Window} win
 * @param {string} query
 */
const media = (win, query) => typeof win.matchMedia === 'function' && win.matchMedia(query).matches;

/**
 * Is this a desktop pointer (no coarse pointer, can hover)?
 * @param {Window} win
 */
export const isDesktop = (win) => !media(win, '(pointer: coarse)') && !media(win, '(hover: none)');

/**
 * Is this a phone's screen (the width at which the chat window goes full screen)?
 * @param {Window} win
 */
export const isPhone = (win) => media(win, PHONE_MEDIA);

/**
 * The idle nudge's text on a page (C14): the nudge of the merchant's page type of the page (C6: the type setPage named,
 * else the first whose path pattern matches; `{product}` = the product's name), else the general widget text, which
 * names the product when the page gave one. A text of the merchant that names the product needs the product's name,
 * so without it the general text shows.
 * @param {import('./common.js').ChatSettings['pageTypes']} types
 * @param {PageInfo | null} page what `SSChat.setPage()` gave
 * @param {import('./common.js').Texts} t
 * @param {string} [path] the page's path
 */
export const idleText = (types, page, t, path = '') => {
	const product = page?.productName ?? '';
	const key = pageTypeOf(types, page?.kind, path);
	const own = types.find((type) => type.key === key)?.nudge ?? '';
	if (own !== '' && (product !== '' || !own.includes('{product}'))) return formatText(own, { product });
	return product ? formatText(t('chat.idleProduct'), { product }) : t('chat.idle');
};

/**
 * What the idle nudge is remembered by (C14): once per session (`idle`), or, once per product, the product the page
 * names with setPage (its id, else its name), so each product the visitor looks at may nudge once.
 * @param {Proactive['oncePer']} oncePer
 * @param {PageInfo | null} page
 */
export const idleOnce = (oncePer, page) => {
	const product = page?.productId ?? page?.productName ?? '';
	return oncePer === 'product' && product !== '' ? `idle:${product}` : 'idle';
};

/**
 * Start the proactive triggers of a page.
 * @param {import('./transport.js').Clock & {
 *   features: string[], settings: import('./common.js').ChatSettings, t: import('./common.js').Texts, path: string,
 *   page: () => PageInfo | null,
 *   offer: (kind: Kind, text: string, once?: string) => boolean,
 *   startFlow: (flow: import('./common.js').ChatSettings['flows'][number]) => void }} input `page`: what
 *   `SSChat.setPage()` gave last; `offer` shows a message once per `once` (default: its kind) and answers false while
 *   the window is open (the idle nudge waits again)
 * @returns {() => void} stop
 */
export const startProactive = ({ win, schedule, cancel, now, features, settings, t, path, page, offer, startFlow }) => {
	const doc = win.document;
	/** @type {number[]} */
	const timers = [];
	/** @type {Array<() => void>} */
	const stops = [];
	/** @param {() => void} task @param {number} ms */
	const later = (task, ms) => timers.push(schedule(task, ms));

	const { idleMinutes, oncePer, hideOnMobile } = settings.proactive;
	if (features.includes('proactive_idle') && idleMinutes > 0 && !(hideOnMobile && isPhone(win))) {
		const idleMs = idleMinutes * 60_000;
		let last = now();
		const touch = () => {
			last = now();
		};
		const fire = () => {
			const left = idleMs - (now() - last);
			if (left > 0) return later(fire, left);
			const info = page();
			const offered = offer('idle', idleText(settings.pageTypes, info, t, path), idleOnce(oncePer, info));
			// waits again while the window is open; once per product, the next product the visitor looks at may nudge
			if (!offered || oncePer === 'product') later(fire, idleMs);
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
