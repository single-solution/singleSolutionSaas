/**
 * Polling transport (DOM-free), ported from the ibrahimMobiles chat transport. Closed = zero timers; open =
 * visibility-aware polling that costs nothing while nobody is looking:
 *
 * - visible: every `intervalMs`, backing off to `idleIntervalMs` after `idleAfterMs` without activity;
 * - hidden: no polling; an immediate tick when the page becomes visible again;
 * - `stopAfterMs` without activity (`touch()`, input, new messages): parked until visibility or input resumes it;
 * - `expectReply()` after the customer sends: a short-interval burst for `burstWindowMs`, so a person's reply shows up
 *   within seconds; `settleReply()` ends it early.
 *
 * Timers, the clock and the visibility source are injected (`scheduler`, `visibility`), so the same core runs in
 * browsers, React Native, tests and server-side previews. Overlapping ticks are never started.
 * @module
 */

/**
 * @typedef {object} Scheduler
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 * @property {() => number} now
 */
/**
 * @typedef {object} Visibility
 * @property {() => boolean} hidden
 * @property {(listener: () => void) => () => void} subscribe called when visibility or user input changes
 */
/**
 * @typedef {object} TransportOptions
 * @property {number} intervalMs
 * @property {number} idleAfterMs
 * @property {number} idleIntervalMs
 * @property {number} stopAfterMs
 * @property {number} burstIntervalMs
 * @property {number} burstWindowMs
 * @property {() => Promise<void> | void} onTick
 * @property {(error: unknown) => void} [onError]
 * @property {Scheduler} scheduler
 * @property {Visibility | null} [visibility]
 */

/** Floor of the visible interval (requests per tab per hour stay bounded whatever the configuration says). */
export const MIN_INTERVAL_MS = 2_000;

/**
 * @param {TransportOptions} options
 */
export const createTransport = (options) => {
	const { scheduler, visibility = null } = options;
	const interval = Math.max(MIN_INTERVAL_MS, options.intervalMs);
	let running = false;
	let parked = false;
	let ticking = false;
	/** @type {unknown} */
	let timer = null;
	let lastActivity = 0;
	let burstUntil = 0;
	/** @type {(() => void) | null} */
	let unsubscribe = null;
	let ticks = 0;

	const hidden = () => visibility?.hidden() === true;
	const clear = () => {
		if (timer !== null) scheduler.clearTimeout(timer);
		timer = null;
	};
	/** Current interval. */
	const currentInterval = () => {
		const now = scheduler.now();
		if (now < burstUntil) return Math.max(MIN_INTERVAL_MS / 2, options.burstIntervalMs);
		if (now - lastActivity >= options.idleAfterMs) return Math.max(interval, options.idleIntervalMs);
		return interval;
	};
	const shouldPark = () => {
		const now = scheduler.now();
		return hidden() || (now - lastActivity >= options.stopAfterMs && now >= burstUntil);
	};
	const schedule = (/** @type {number} */ ms) => {
		clear();
		if (!running) return;
		if (shouldPark()) {
			parked = true;
			return;
		}
		parked = false;
		timer = scheduler.setTimeout(() => void tick(), ms);
	};
	const tick = async () => {
		timer = null;
		if (!running || ticking) return;
		if (shouldPark()) {
			parked = true;
			return;
		}
		ticking = true;
		ticks += 1;
		try {
			await options.onTick();
		} catch (error) {
			options.onError?.(error);
		} finally {
			ticking = false;
			schedule(currentInterval());
		}
	};
	const resume = () => {
		if (!running) return;
		if (hidden()) {
			clear();
			parked = true;
			return;
		}
		lastActivity = scheduler.now();
		if (parked) {
			parked = false;
			clear();
			void tick();
		}
	};

	return Object.freeze({
		start: () => {
			if (running) return;
			running = true;
			parked = false;
			lastActivity = scheduler.now();
			unsubscribe = visibility?.subscribe(resume) ?? null;
			void tick();
		},
		stop: () => {
			running = false;
			parked = false;
			burstUntil = 0;
			clear();
			unsubscribe?.();
			unsubscribe = null;
		},
		/** Record activity (keeps polling at the visible interval). */
		touch: () => {
			lastActivity = scheduler.now();
			if (parked) resume();
		},
		/** Poll now (e.g. after the window opens). */
		pollNow: () => {
			if (!running) return;
			lastActivity = scheduler.now();
			if (hidden()) {
				parked = true;
				return;
			}
			clear();
			parked = false;
			void tick();
		},
		/** Poll quickly for a while (a reply is expected). @param {number} [windowMs] */
		expectReply: (windowMs = options.burstWindowMs) => {
			if (!running) return;
			const now = scheduler.now();
			lastActivity = now;
			burstUntil = now + windowMs;
			schedule(currentInterval());
		},
		/** End a burst early. */
		settleReply: () => {
			if (burstUntil === 0) return;
			burstUntil = 0;
			if (running && !parked && !ticking) schedule(currentInterval());
		},
		isRunning: () => running,
		isParked: () => parked,
		/** Ticks run so far (diagnostics). */
		ticks: () => ticks,
	});
};

/** @typedef {ReturnType<typeof createTransport>} Transport */
