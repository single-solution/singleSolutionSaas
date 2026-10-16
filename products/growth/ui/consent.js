/**
 * The visitor's consent in the page (PLAN 0.8.9): the choice kept in their own browser (localStorage), whoever made it
 * (the banner, or the merchant's own consent tool through `SSGrowth.consent.set()`), and the consent banner (visitor
 * widget `consent_banner`): the merchant's categories (G3, each with its own name and description), Accept all, Only
 * necessary, or Choose and Save; at the bottom, the top, in the middle of the page (a dialog over it) or in a corner
 * (G7). The banner's other words are widget texts.
 * @module
 */
import { element, mountWidget, toggle } from '@ss/app-kit/widget';
import { BANNER_POSITIONS, CONSENT_STORAGE_KEY } from '../core/widgets.js';
import { grantedOf, makeChoice, readChoice } from '../core/consent.js';
import { WIDGET_CSS } from './styles.js';

/** @typedef {import('../core/consent.js').Choice} Choice */
/** @typedef {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void }} KeyValue */

/**
 * The page's localStorage, or a store that keeps nothing when the browser refuses it.
 * @param {Window} win
 * @param {'localStorage' | 'sessionStorage'} name
 * @returns {KeyValue}
 */
export const storageOf = (win, name) => {
	try {
		const storage = win[name];
		storage.getItem('ss-growth-probe');
		return storage;
	} catch {
		return { getItem: () => null, setItem: () => {} };
	}
};

/**
 * The consent state of the page. The merchant's categories come with the widget config (`configure`); until then a
 * choice the page makes waits for them.
 * @param {{ storage: KeyValue, now: () => number }} input
 */
export const createConsent = ({ storage, now }) => {
	/** @type {ReadonlyArray<import('../core/consent.js').Category> | null} */
	let categories = null;
	/** @type {Choice | null} */
	let choice = null;
	/** @type {Record<string, unknown> | null} a choice made before the categories were known */
	let early = null;
	/** @type {Set<(choice: Choice) => void>} */
	const listeners = new Set();
	/** @param {Record<string, unknown>} picked */
	const keep = (picked) => {
		choice = makeChoice(picked, now(), categories ?? []);
		try {
			storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(choice));
		} catch {
			// the browser refuses storage: the choice holds for this page only
		}
		for (const listener of listeners) listener(choice);
		return choice;
	};
	return Object.freeze({
		/** The choice now, or null before the visitor chose (or before the categories are known). */
		get: () => choice,
		/**
		 * Keep a choice and tell the listeners: each category's key, true or false (an opt-out category left out stays on).
		 * @param {Record<string, unknown>} picked
		 */
		set: (picked) => {
			const given = typeof picked === 'object' && picked !== null ? picked : {};
			if (categories === null) {
				early = given;
				return null;
			}
			return keep(given);
		},
		/**
		 * The merchant's categories and months (G3, G6, from the widget config): the kept choice is read with them (asked
		 * again when it is too old or a category is new), and a choice the page made before is kept now.
		 * @param {{ months: number, categories: ReadonlyArray<import('../core/consent.js').Category> }} options
		 */
		configure: ({ months, categories: list }) => {
			categories = list;
			choice = readChoice(storage.getItem(CONSENT_STORAGE_KEY), now(), months, list);
			if (early) {
				const waiting = early;
				early = null;
				keep(waiting);
			}
		},
		/** The merchant's categories, once known. */
		categories: () => categories ?? [],
		/** @param {(choice: Choice) => void} listener */
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
};

/** @typedef {ReturnType<typeof createConsent>} Consent */

/**
 * The consent banner, mounted into `host`; it closes itself once the visitor chose.
 * @param {{ host: HTMLElement, config: import('./widget.js').WidgetConfig, consent: Consent, gpc?: boolean }} input
 *   `gpc`: the browser sends Global Privacy Control (opt-out categories start off)
 * @returns {{ open: () => void, close: () => void }}
 */
export const mountConsentBanner = ({ host, config, consent, gpc = false }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	const settings = config.settings.consent;
	const categories = settings.categories;
	/** @type {HTMLElement | null} */
	let panel = null;
	/** @type {HTMLElement | null} */
	let backdrop = null;
	/** @type {HTMLElement | null} */
	let main = null;
	/** @type {HTMLElement | null} */
	let choose = null;
	/** @type {Map<string, HTMLInputElement>} */
	const boxes = new Map();
	const position = BANNER_POSITIONS.includes(settings.position) ? settings.position : 'bottom';
	mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			// in the middle of the page, the banner is a dialog over a dimmed page (G7)
			backdrop = position === 'center' ? element(doc, 'div', { class: 'banner-backdrop', hidden: '' }) : null;
			panel = element(doc, 'section', {
				class: `banner ${position}`,
				role: 'dialog',
				'aria-label': t('consent.label'),
				...(position === 'center' ? { 'aria-modal': 'true' } : {}),
				hidden: '',
			});
			main = element(doc, 'div');
			const privacy = settings.privacyUrl ? element(doc, 'a', { href: settings.privacyUrl }, t('consent.privacy')) : null;
			const text = element(doc, 'p', {}, t('consent.text'));
			if (privacy) text.append(' ', privacy);
			/** @param {string} label @param {string} kind @param {() => void} act */
			const button = (label, kind, act) => {
				const node = element(doc, 'button', { type: 'button', ...(kind ? { class: kind } : {}) }, label);
				node.addEventListener('click', act);
				return node;
			};
			/** @param {boolean} on every category on, or only the required ones */
			const everything = (on) => Object.fromEntries(categories.map((category) => [category.key, on]));
			/** @param {Record<string, boolean>} picked */
			const decide = (picked) => {
				consent.set(picked);
				close();
			};
			const actions = element(doc, 'div', { class: 'actions' });
			actions.append(
				button(t('consent.acceptAll'), '', () => decide(everything(true))),
				button(t('consent.rejectAll'), 'secondary', () => decide(everything(false))),
				button(t('consent.customize'), 'link', () => show('choose')),
			);
			main.append(element(doc, 'h2', {}, t('consent.title')), text, actions);

			choose = element(doc, 'div', { hidden: '' });
			const list = element(doc, 'div', { class: 'choices' });
			for (const category of categories) {
				const required = category.mode === 'required';
				const { box, node } = toggle(doc, category.name, {
					help: category.description || undefined,
					checked: required,
					disabled: required,
				});
				if (!required) boxes.set(category.key, box);
				list.append(node);
			}
			const save = element(doc, 'div', { class: 'actions' });
			save.append(
				button(t('consent.save'), '', () =>
					decide(Object.fromEntries([...boxes].map(([key, input]) => [key, input.checked]))),
				),
				button(t('consent.acceptAll'), 'secondary', () => decide(everything(true))),
			);
			choose.append(element(doc, 'h2', {}, t('consent.title')), list, save);
			panel.append(main, choose);
			if (backdrop) root.append(backdrop);
			root.append(panel);
		},
	});

	/** @param {'main' | 'choose'} view */
	const show = (view) => {
		const current = grantedOf(consent.get(), categories, { consentRequired: true, gpc });
		for (const [key, input] of boxes) input.checked = current[key] === true;
		main?.toggleAttribute('hidden', view !== 'main');
		choose?.toggleAttribute('hidden', view !== 'choose');
		backdrop?.removeAttribute('hidden');
		panel?.removeAttribute('hidden');
	};
	const close = () => {
		panel?.setAttribute('hidden', '');
		backdrop?.setAttribute('hidden', '');
	};
	if (consent.get() === null) show('main');
	return { open: () => show('choose'), close };
};
