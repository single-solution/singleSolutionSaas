/**
 * The one small checking adapter (PLAN 0.8.3 Live updates): back-off checks from the browser with the fixed `CHECKS`
 * constants, no websockets. Another transport only has to offer the same two factories.
 *
 * - `createChecks` (open chat window, inbox): every 10 s while the tab is visible, every 20 s after 5 minutes without
 *   activity, stopped after 15 minutes without activity; nothing while the tab is hidden; an immediate check when the
 *   tab becomes visible again or on input after a stop; every 3 s for 45 s while a reply is expected.
 * - `createUnreadChecks` (closed chat window): on start, on focus (at most once a minute) and every 5 minutes while
 *   the tab is visible.
 * @module
 */
import { CHECKS } from '../core/widgets.js';

/**
 * @typedef {object} Clock
 * @property {Window} win
 * @property {(task: () => void, ms: number) => number} schedule
 * @property {(id: number) => void} cancel
 * @property {() => number} now
 */

/** Input that counts as activity (and resumes stopped checks). */
const INPUT_EVENTS = Object.freeze(['pointerdown', 'keydown']);

/**
 * Back-off checks while a chat window or the inbox is open.
 * @param {Clock & { check: () => Promise<void> }} input `check` never throws
 */
export const createChecks = ({ win, schedule, cancel, now, check }) => {
	const doc = win.document;
	let running = false;
	let parked = false;
	let ticking = false;
	let lastActivity = 0;
	let replyUntil = 0;
	/** @type {number | null} */
	let timer = null;

	const clear = () => {
		if (timer !== null) cancel(timer);
		timer = null;
	};
	const idle = () => now() - lastActivity;
	const shouldPark = () => doc.hidden || (idle() >= CHECKS.stopAfterMs && now() >= replyUntil);
	const interval = () => (now() < replyUntil ? CHECKS.replyMs : idle() >= CHECKS.idleAfterMs ? CHECKS.idleMs : CHECKS.activeMs);
	/** @param {number} [ms] */
	const next = (ms) => {
		clear();
		if (!running) return;
		parked = shouldPark();
		if (!parked) timer = schedule(() => void tick(), ms ?? interval());
	};
	const tick = async () => {
		timer = null;
		if (!running || ticking) return;
		ticking = true;
		await check();
		ticking = false;
		next();
	};
	const resume = () => {
		lastActivity = now();
		parked = false;
		clear();
		void tick();
	};
	const onVisibility = () => {
		if (doc.hidden) {
			clear();
			parked = true;
		} else if (running && parked) resume();
	};
	const onInput = () => {
		if (running && parked) resume();
		else lastActivity = now();
	};

	return Object.freeze({
		/** Start checking (the first check after one interval: the caller has just loaded). */
		start: () => {
			if (running) return;
			running = true;
			lastActivity = now();
			doc.addEventListener('visibilitychange', onVisibility);
			for (const name of INPUT_EVENTS) win.addEventListener(name, onInput);
			next();
		},
		stop: () => {
			running = false;
			replyUntil = 0;
			clear();
			doc.removeEventListener('visibilitychange', onVisibility);
			for (const name of INPUT_EVENTS) win.removeEventListener(name, onInput);
		},
		/** Check at once (visitor input). */
		checkNow: () => {
			if (running && !doc.hidden) resume();
		},
		/** A reply is expected: every 3 s for 45 s. */
		expectReply: () => {
			if (!running) return;
			lastActivity = now();
			replyUntil = now() + CHECKS.replyWindowMs;
			next(CHECKS.replyMs);
		},
		/** The reply arrived: back to the normal pace. */
		settle: () => {
			replyUntil = 0;
		},
		running: () => running,
	});
};

/**
 * Unread checks while the chat window is closed.
 * @param {Clock & { check: () => Promise<void> }} input
 */
export const createUnreadChecks = ({ win, schedule, cancel, now, check }) => {
	const doc = win.document;
	let running = false;
	let last = -Infinity;
	/** @type {number | null} */
	let timer = null;

	const clear = () => {
		if (timer !== null) cancel(timer);
		timer = null;
	};
	const plan = () => {
		clear();
		if (running && !doc.hidden) timer = schedule(run, CHECKS.closedEveryMs);
	};
	const run = () => {
		last = now();
		void check();
		plan();
	};
	const onFocus = () => {
		if (doc.hidden) clear();
		else if (now() - last >= CHECKS.closedFocusMinMs) run();
		else if (timer === null) plan();
	};

	return Object.freeze({
		/** @param {boolean} [immediate] check at once (page load) */
		start: (immediate = true) => {
			if (running) return;
			running = true;
			doc.addEventListener('visibilitychange', onFocus);
			win.addEventListener('focus', onFocus);
			if (immediate && !doc.hidden) run();
			else plan();
		},
		stop: () => {
			running = false;
			clear();
			doc.removeEventListener('visibilitychange', onFocus);
			win.removeEventListener('focus', onFocus);
		},
	});
};
