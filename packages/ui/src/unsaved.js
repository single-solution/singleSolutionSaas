'use client';
/**
 * Unsaved changes are never lost (kit polish KP-1a, points 113 to 115). Every `SaveBar` that draws itself reports here
 * what it holds (`setBar`), and while any of them has changes this module
 * - asks the browser to warn before the tab closes or reloads (`beforeunload`);
 * - catches a click on a link that leaves the page (a sidebar or inner-navigation link, a list row, a breadcrumb: any
 *   `<a href>` of this site that is not a plain jump inside the page) and asks first;
 * - hands `askLeave` to every move that is not a link (a list row picked, a Back button): `askLeave(go)` runs `go` at
 *   once when nothing is unsaved, else the bar's question "You have unsaved changes: Save, Discard or Stay" opens and
 *   runs `go` only after Save went through or Discard was chosen.
 * The question is drawn by the first bar that is on the page (`LeaveGuard` in `blocks.js`). The browser's own Back
 * button is not guarded: the app router answers it before any page code can, and a history entry of our own would fight
 * the router.
 * @module
 */
import { createContext, useSyncExternalStore } from 'react';

/**
 * The words of the unsaved-changes parts (replace them to translate).
 * @typedef {object} UnsavedTexts
 * @property {string} title the question's title
 * @property {string} body the question's one line under it
 * @property {string} save
 * @property {string} discard
 * @property {string} stay
 * @property {string} changedIn the save bar's words before the names of the sections that changed
 * @property {string} changed the mark on a section or row that has changes
 * @property {string} discarded the toast after Discard
 * @property {string} undo the toast's button
 */
/** @type {Readonly<UnsavedTexts>} */
export const UNSAVED_TEXTS = Object.freeze({
	title: 'You have unsaved changes',
	body: 'Save them before you leave, or discard them.',
	save: 'Save',
	discard: 'Discard',
	stay: 'Stay',
	changedIn: 'Unsaved changes in',
	changed: 'Changed',
	discarded: 'Changes discarded',
	undo: 'Undo',
});

/**
 * Whether picking another row of the list beside the page leaves the edits of the page alive (a page that keeps its
 * views mounted, such as the dashboard's views). A `Page` with a `list` says so; a `ListColumn` then asks no question.
 */
export const PickKeepsEditsContext = createContext(false);

/** How long the Undo toast after Discard stays (ms). */
export const UNDO_MS = 8000;

/**
 * What a save bar that draws itself tells this module. `onDiscard` may return a function that brings the edits back.
 * @typedef {object} BarEntry
 * @property {boolean} show
 * @property {() => unknown} onSave
 * @property {() => unknown} onDiscard
 * @property {boolean} disabled
 */

/** The bars on the page, in the order they came (the first one draws the question). @type {Map<string, BarEntry>} */
const bars = new Map();
/** @type {{ host: string, pending: boolean, busy: boolean }} */
let state = { host: '', pending: false, busy: false };
/** What to do once the person chose: the move that was held back. @type {(() => void) | null} */
let held = null;
/** True while the module itself repeats a click it held back. */
let repeating = false;
let attached = false;
/** @type {Set<() => void>} */
const listeners = new Set();

/** @param {Partial<typeof state>} next */
const change = (next) => {
	state = { ...state, ...next };
	for (const listener of [...listeners]) listener();
};

/** @param {() => void} listener */
const subscribe = (listener) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
const snapshot = () => state;

/** The bars that have changes now, in the order they came. */
const dirtyBars = () => [...bars.values()].filter((bar) => bar.show);

/** Whether any save bar on the page has changes. */
export const hasUnsaved = () => dirtyBars().length > 0;

/** @param {BeforeUnloadEvent} event */
const warnBeforeUnload = (event) => {
	if (!hasUnsaved()) return;
	event.preventDefault();
	// the older way the browsers still ask for
	Reflect.set(event, 'returnValue', '');
};

/**
 * Whether a click on this link leaves the page: a link of this site to another address, in this tab. A jump to `#id`,
 * a link to another site (the browser's own warning asks), a new tab or a download leaves nothing behind.
 * @param {HTMLAnchorElement} link
 */
const leavesPage = (link) => {
	if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return false;
	try {
		const url = new URL(link.href, window.location.href);
		if (url.origin !== window.location.origin) return false;
		return url.pathname !== window.location.pathname || url.search !== window.location.search;
	} catch {
		return false;
	}
};

/**
 * A plain click on a link that leaves the page is held back before anything else (the router included) sees it, and
 * repeated once the person chose to go on.
 * @param {MouseEvent} event
 */
const holdLinkClick = (event) => {
	if (repeating || event.defaultPrevented || event.button !== 0) return;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
	if (!(link instanceof HTMLAnchorElement) || !leavesPage(link)) return;
	event.preventDefault();
	event.stopPropagation();
	askLeave(() => {
		repeating = true;
		try {
			link.click();
		} finally {
			repeating = false;
		}
	});
};

/** The two listeners are on the page only while something is unsaved. */
const sync = () => {
	const want = typeof window !== 'undefined' && hasUnsaved();
	if (want === attached) return;
	attached = want;
	if (want) {
		window.addEventListener('beforeunload', warnBeforeUnload);
		document.addEventListener('click', holdLinkClick, true);
	} else {
		window.removeEventListener('beforeunload', warnBeforeUnload);
		document.removeEventListener('click', holdLinkClick, true);
	}
};

/** Make the first bar on the page the one that draws the question. */
const elect = () => {
	const host = bars.keys().next().value ?? '';
	if (host !== state.host) change({ host });
};

/**
 * A save bar that draws itself tells what it holds (call it after every render).
 * @param {string} id
 * @param {BarEntry} entry
 */
export const setBar = (id, entry) => {
	bars.set(id, entry);
	elect();
	sync();
};

/** @param {string} id the bar left the page */
export const dropBar = (id) => {
	if (!bars.delete(id)) return;
	// with no bar left nobody can answer a question that is open
	if (bars.size === 0 && state.pending) {
		held = null;
		change({ pending: false, busy: false });
	}
	elect();
	sync();
};

/**
 * Run `go` (a move away from this screen) now, or after the person answered the question when something is unsaved.
 * @param {() => void} go
 */
export const askLeave = (go) => {
	if (!hasUnsaved()) {
		go();
		return;
	}
	if (state.pending) return;
	held = go;
	change({ pending: true, busy: false });
};

/** @param {'save' | 'discard' | 'stay'} choice */
export const answerLeave = async (choice) => {
	if (!state.pending || state.busy) return;
	const go = held;
	const open = dirtyBars();
	const done = () => {
		held = null;
		change({ pending: false, busy: false });
	};
	if (choice === 'stay') {
		done();
		return;
	}
	if (choice === 'discard') {
		for (const bar of open) bar.onDiscard();
		done();
		go?.();
		return;
	}
	change({ busy: true });
	try {
		for (const bar of open) {
			// a save that did not go through keeps the person here, where the failed section shows why
			if ((await bar.onSave()) === false) {
				done();
				return;
			}
		}
	} catch {
		done();
		return;
	}
	done();
	go?.();
};

/**
 * The question's state for the bar that draws it.
 * @param {string} id the bar's id
 * @returns {{ open: boolean, busy: boolean, canSave: boolean } | null} null for a bar that is not the host
 */
export const useLeaveQuestion = (id) => {
	const now = useSyncExternalStore(subscribe, snapshot, snapshot);
	if (now.host !== id) return null;
	return { open: now.pending, busy: now.busy, canSave: dirtyBars().every((bar) => !bar.disabled) };
};
