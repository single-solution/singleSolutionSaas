'use client';
/**
 * The sections of a page (flat layout 2026-10-21): a `Page` with `sections` shows every section at once, all open,
 * stacked in its body, instead of one sub-page per address. From {@link SECTION_JUMPS_FROM} sections up its inner
 * navigation lists them as jumps: a click scrolls the body (the only thing that scrolls) to the section and puts
 * `#id` in the address, and the highlighted item follows the scrolling. A page with sections has ONE save bar: every
 * `SaveBar` inside it registers here instead of drawing itself, and the page draws one bar while any section has
 * changes.
 * @module
 */
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** @typedef {import('react').ReactNode} ReactNode */

/** From this many sections up, the inner navigation lists them as jumps (fewer: no inner navigation). */
export const SECTION_JUMPS_FROM = 4;

/**
 * One section of a page. `dot` is an attention dot beside its jump (named for screen readers by `dotLabel`).
 * @typedef {object} PageSection
 * @property {string} id the address hash (`#id`) and the section's element id
 * @property {string} label the section's name: its jump and its `aria-label`
 * @property {import('./icons.js').IconName} [icon]
 * @property {import('./display.js').Tone} [dot]
 * @property {string} [dotLabel]
 * @property {ReactNode} body
 */

/**
 * What a `SaveBar` tells the page it sits in.
 * @typedef {object} SaveEntry
 * @property {boolean} show
 * @property {() => unknown} onSave
 * @property {() => void} onDiscard
 * @property {boolean} saving
 * @property {boolean} disabled
 * @property {ReactNode} message
 * @property {string} saveLabel
 * @property {string} discardLabel
 */
/** @typedef {{ put: (id: string, entry: SaveEntry) => void, drop: (id: string) => void }} SaveScope */

/** The page a `SaveBar` registers with (null outside a page with sections: the bar then draws itself). */
export const PageSavesContext = createContext(/** @type {SaveScope | null} */ (null));

/**
 * What the page's one bar shows.
 * @typedef {{ show: boolean, saving: boolean, disabled: boolean, message?: ReactNode, saveLabel?: string,
 *   discardLabel?: string }} SaveView
 */
/** @type {SaveView} */
const NO_SAVE = { show: false, saving: false, disabled: false };

/**
 * The page's one save bar: the bars of its sections register here, and Save and Discard act on every section that
 * has changes, in the order of the page.
 * @param {number} count the number of sections
 */
function usePageSaves(count) {
	const live = useRef(/** @type {Map<string, { order: number, seq: number, entry: SaveEntry }>} */ (new Map()));
	const seq = useRef(0);
	const [view, setView] = useState(/** @type {SaveView} */ (NO_SAVE));
	/** The bars with changes, in the order of the page (a bar that came later comes later in its section). */
	const dirty = useCallback(
		() =>
			[...live.current.entries()]
				.filter(([, known]) => known.entry.show)
				.sort(([, a], [, b]) => a.order - b.order || a.seq - b.seq)
				.map(([id, known]) => ({ id, entry: known.entry })),
		[],
	);
	const refresh = useCallback(() => {
		const changed = dirty().map((one) => one.entry);
		setView((prev) => {
			// the last words stay while the bar leaves
			if (!changed[0]) return prev.show ? { ...prev, show: false, saving: false } : prev;
			/** @type {SaveView} */
			const next = {
				show: true,
				saving: changed.some((entry) => entry.saving),
				disabled: changed.some((entry) => entry.disabled),
				message: changed[0].message,
				saveLabel: changed[0].saveLabel,
				discardLabel: changed[0].discardLabel,
			};
			return /** @type {Array<keyof SaveView>} */ (Object.keys(next)).every((key) => Object.is(prev[key], next[key]))
				? prev
				: next;
		});
	}, [dirty]);
	const put = useCallback(
		(/** @type {string} */ id, /** @type {number} */ order, /** @type {SaveEntry} */ entry) => {
			live.current.set(id, { order, seq: live.current.get(id)?.seq ?? seq.current++, entry });
			refresh();
		},
		[refresh],
	);
	const drop = useCallback(
		(/** @type {string} */ id) => {
			if (live.current.delete(id)) refresh();
		},
		[refresh],
	);
	/** One scope per section, so a section's bars keep the place of their section. */
	const scopes = useMemo(
		() =>
			Array.from({ length: count }, (_, order) => ({
				put: (/** @type {string} */ id, /** @type {SaveEntry} */ entry) => put(id, order, entry),
				drop,
			})),
		[count, put, drop],
	);
	// Save runs each section in turn and stops at the first that did not go through (it returned `false` or threw); a
	// section that saved meanwhile (or started over) has nothing left to save and is skipped
	const onSave = useCallback(async () => {
		for (const { id } of dirty()) {
			const entry = live.current.get(id)?.entry;
			if (entry?.show && (await entry.onSave()) === false) return false;
		}
		return true;
	}, [dirty]);
	const onDiscard = useCallback(() => {
		for (const { entry } of dirty()) entry.onDiscard();
	}, [dirty]);
	return { scopes, view, onSave, onDiscard };
}

/** @param {string} hash the address hash with or without its `#` */
const hashId = (hash) => {
	try {
		return decodeURIComponent(hash.replace(/^#/, ''));
	} catch {
		return '';
	}
};

/** How long a jump keeps the highlight from following the scrolling it started (ms). */
const JUMP_MS = 800;

/**
 * Scrolling to a section and the highlighted jump that follows the scrolling.
 * @param {string[]} ids
 */
function useJumps(ids) {
	const key = ids.join('|');
	const body = useRef(/** @type {HTMLDivElement | null} */ (null));
	const [active, setActive] = useState(ids[0] ?? '');
	const busy = useRef(false);
	const timer = useRef(/** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined));
	const scrollTo = useCallback((/** @type {string} */ id, /** @type {boolean} */ instant) => {
		const pane = body.current;
		const target = pane && [...pane.querySelectorAll('[data-ss-section]')].find((el) => el.id === id);
		if (!pane || !target) return;
		// the section lands where the first one starts: under the body's own padding
		const pad = target.parentElement ? parseFloat(getComputedStyle(target.parentElement).paddingTop) || 0 : 0;
		const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - pad;
		const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (typeof pane.scrollTo === 'function') pane.scrollTo({ top, behavior: instant || reduced ? 'auto' : 'smooth' });
		else pane.scrollTop = top;
		setActive(id);
		busy.current = true;
		clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			busy.current = false;
		}, JUMP_MS);
	}, []);
	/** A click on a jump: scroll there and name the section in the address (no history entry). */
	const jump = useCallback(
		(/** @type {string} */ id) => {
			scrollTo(id, false);
			try {
				window.history.replaceState(window.history.state, '', `#${encodeURIComponent(id)}`);
			} catch {
				// no history (a sandboxed frame): the jump still scrolls
			}
		},
		[scrollTo],
	);
	// an address with `#id` (on load, Back, Forward) scrolls to the section
	useEffect(() => {
		const read = () => {
			const id = hashId(window.location.hash);
			if (ids.includes(id)) scrollTo(id, true);
		};
		read();
		window.addEventListener('hashchange', read);
		window.addEventListener('popstate', read);
		return () => {
			window.removeEventListener('hashchange', read);
			window.removeEventListener('popstate', read);
		};
	}, [key, scrollTo]);
	// the highlight follows the scrolling: the first section still in the top of the body; at the very end the last
	useEffect(() => {
		const root = body.current;
		if (!root || typeof IntersectionObserver === 'undefined') return undefined;
		const seen = new Set();
		const pick = () => {
			if (busy.current) return;
			const atEnd = root.scrollTop > 0 && root.scrollHeight - root.scrollTop - root.clientHeight < 2;
			const id = atEnd ? ids[ids.length - 1] : ids.find((one) => seen.has(one));
			if (id) setActive(id);
		};
		const watcher = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) seen.add(entry.target.id);
					else seen.delete(entry.target.id);
				}
				pick();
			},
			{ root, rootMargin: '-16px 0px -65% 0px' },
		);
		for (const el of root.querySelectorAll('[data-ss-section]')) watcher.observe(el);
		root.addEventListener('scroll', pick, { passive: true });
		return () => {
			watcher.disconnect();
			root.removeEventListener('scroll', pick);
		};
	}, [key]);
	useEffect(() => () => clearTimeout(timer.current), []);
	return { body, active: ids.includes(active) ? active : (ids[0] ?? ''), jump };
}

/**
 * Everything a `Page` needs for its `sections`: the ref of the body pane, the scopes that connect each section's save
 * bars to the page, the props of the page's one `SaveBar` (null without sections) and of its inner navigation (the
 * jumps; null under {@link SECTION_JUMPS_FROM} sections).
 * @param {PageSection[] | undefined} sections
 */
export function usePageSections(sections) {
	const list = sections ?? [];
	const { scopes, view, onSave, onDiscard } = usePageSaves(list.length);
	const { body, active, jump } = useJumps(list.map((section) => section.id));
	const nav =
		list.length >= SECTION_JUMPS_FROM
			? {
					items: list.map((section) => ({
						id: section.id,
						label: section.label,
						...(section.icon ? { icon: section.icon } : {}),
						...(section.dot ? { dot: section.dot } : {}),
						...(section.dotLabel ? { dotLabel: section.dotLabel } : {}),
					})),
					value: active,
					onSelect: jump,
				}
			: null;
	return { body, scopes, nav, bar: sections ? { ...view, onSave, onDiscard } : null };
}

/**
 * The sections, each a `<section>` with its own name, stacked with the body's gap.
 * @param {{ sections: PageSection[], scopes: SaveScope[] }} props
 */
export function PageSectionList({ sections, scopes }) {
	return (
		<>
			{sections.map((section, index) => (
				<PageSavesContext.Provider key={section.id} value={scopes[index] ?? null}>
					<section id={section.id} data-ss-section="" aria-label={section.label} className="flex min-w-0 flex-col gap-6">
						{section.body}
					</section>
				</PageSavesContext.Provider>
			))}
		</>
	);
}
