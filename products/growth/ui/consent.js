/**
 * The visitor's consent in the page (PLAN 0.8.9): the choice kept in their own browser (localStorage), whoever made it
 * (the banner, or the merchant's own consent tool through `SSGrowth.consent.set()`), and the consent banner (visitor
 * widget `consent_banner`): necessary, analytics and marketing, Accept all, Only necessary, or Choose and Save. Every
 * word is a widget text.
 * @module
 */
import { mountWidget } from '@ss/app-kit/widget';
import { CONSENT_STORAGE_KEY } from '../core/widgets.js';
import { makeChoice, readChoice } from '../core/consent.js';
import { element } from './dom.js';
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
 * The consent state of the page.
 * @param {{ storage: KeyValue, now: () => number }} input
 */
export const createConsent = ({ storage, now }) => {
	/** @type {Choice | null} */
	let choice = readChoice(storage.getItem(CONSENT_STORAGE_KEY), now());
	/** @type {Set<(choice: Choice) => void>} */
	const listeners = new Set();
	return Object.freeze({
		/** The choice now, or null before the visitor chose. */
		get: () => choice,
		/**
		 * Keep a choice and tell the listeners.
		 * @param {{ analytics?: unknown, marketing?: unknown }} picked
		 */
		set: (picked) => {
			choice = makeChoice({ analytics: picked?.analytics === true, marketing: picked?.marketing === true }, now());
			try {
				storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(choice));
			} catch {
				// the browser refuses storage: the choice holds for this page only
			}
			for (const listener of listeners) listener(choice);
			return choice;
		},
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
 * @param {{ host: HTMLElement, config: import('./widget.js').WidgetConfig, consent: Consent }} input
 * @returns {{ open: () => void, close: () => void }}
 */
export const mountConsentBanner = ({ host, config, consent }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	const settings = config.settings.consent;
	/** @type {HTMLElement | null} */
	let panel = null;
	/** @type {HTMLElement | null} */
	let main = null;
	/** @type {HTMLElement | null} */
	let choose = null;
	/** @type {Record<'analytics' | 'marketing', HTMLInputElement>} */
	const boxes = /** @type {any} */ ({});
	mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			panel = element(doc, 'section', {
				class: `banner ${settings.position}`,
				role: 'dialog',
				'aria-label': t('consent.label'),
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
			/** @param {{ analytics: boolean, marketing: boolean }} picked */
			const decide = (picked) => {
				consent.set(picked);
				close();
			};
			const actions = element(doc, 'div', { class: 'actions' });
			actions.append(
				button(t('consent.acceptAll'), '', () => decide({ analytics: true, marketing: true })),
				button(t('consent.rejectAll'), 'secondary', () => decide({ analytics: false, marketing: false })),
				button(t('consent.customize'), 'link', () => show('choose')),
			);
			main.append(element(doc, 'h2', {}, t('consent.title')), text, actions);

			choose = element(doc, 'div', { hidden: '' });
			const list = element(doc, 'div', { class: 'choices' });
			/** @param {'necessary' | 'analytics' | 'marketing'} category */
			const row = (category) => {
				const input = /** @type {HTMLInputElement} */ (element(doc, 'input', { type: 'checkbox' }));
				if (category === 'necessary') {
					input.checked = true;
					input.disabled = true;
				} else boxes[category] = input;
				const label = element(doc, 'label', { class: 'check' });
				const words = element(doc, 'span', {}, t(`consent.${category}`));
				words.append(element(doc, 'span', { class: 'help' }, t(`consent.${category}Help`)));
				label.append(input, words);
				return label;
			};
			list.append(row('necessary'), row('analytics'), row('marketing'));
			const save = element(doc, 'div', { class: 'actions' });
			save.append(
				button(t('consent.save'), '', () =>
					decide({ analytics: boxes.analytics.checked, marketing: boxes.marketing.checked }),
				),
				button(t('consent.acceptAll'), 'secondary', () => decide({ analytics: true, marketing: true })),
			);
			choose.append(element(doc, 'h2', {}, t('consent.title')), list, save);
			panel.append(main, choose);
			root.append(panel);
		},
	});

	/** @param {'main' | 'choose'} view */
	const show = (view) => {
		const current = consent.get();
		boxes.analytics.checked = current?.analytics === true;
		boxes.marketing.checked = current?.marketing === true;
		main?.toggleAttribute('hidden', view !== 'main');
		choose?.toggleAttribute('hidden', view !== 'choose');
		panel?.removeAttribute('hidden');
	};
	const close = () => panel?.setAttribute('hidden', '');
	if (consent.get() === null) show('main');
	return { open: () => show('choose'), close };
};
