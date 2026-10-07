/**
 * Mode B cores of the layout blocks: `notice_bar`, `mobile_tab_bar` and `contact_footer`. Their content is the
 * merchant's (configuration and string catalog); scheduling, audiences and dismiss memory come from the shared
 * placement (`placement.schedule`, `placement.frequency.dismissMemory`), which the Loader enforces.
 */
import { activeTab, footerOf, tabsOf } from '../core/nav.js';
import { bool, oneOf, safeUrl } from '../core/util.js';
import { createCore, emitter, ok } from './kit.js';

/** @param {import('./kit.js').Options} [options] */
export const createNoticeBar = (options = {}) => {
	const config = options.config ?? {};
	const emit = emitter(options.emit);
	const core = createCore(
		{
			href: safeUrl(config.link_href),
			tone: oneOf(config.tone, /** @type {const} */ (['info', 'accent', 'warning']), 'accent'),
			dismissible: bool(config.dismissible, true),
			sticky: bool(config.sticky, false),
			dismissed: false,
		},
		options,
	);
	return core.expose({
		/** Hide the bar; the Loader remembers it for `placement.frequency.dismissMemory`. */
		dismiss: async () => {
			if (!core.get().dismissible) return ok(false);
			core.set({ dismissed: true });
			emit('dismissed', {});
			return ok(true);
		},
	});
};

/** @param {import('./kit.js').Options} [options] */
export const createMobileTabBar = (options = {}) => {
	const config = options.config ?? {};
	const strings = options.strings ?? {};
	const tabs = tabsOf(config.tabs ?? DEFAULT_TABS, (key) => {
		const text = strings[`mobile_tab_bar.tab.${key}`];
		return typeof text === 'string' && text !== '' ? text : null;
	});
	const emit = emitter(options.emit);
	const core = createCore(
		{ tabs, active: /** @type {string | null} */ (null), labels: bool(config.show_labels, true) },
		options,
	);
	return core.expose({
		/** The current path (the renderer passes `location.pathname`). @param {string} path */
		setPath: async (path) => {
			core.set({ active: activeTab(tabs, String(path ?? '/')) });
			return ok(core.get().active);
		},
		/** @param {string} key */
		select: async (key) => {
			emit('action', { action: `tab_${String(key).slice(0, 32)}` });
			return ok(key);
		},
	});
};

/** Tabs when none are configured: the home page only (every website has one). */
const DEFAULT_TABS = Object.freeze([{ key: 'home', href: '/', icon: 'home' }]);

/** @param {import('./kit.js').Options} [options] */
export const createContactFooter = (options = {}) => {
	const core = createCore(footerOf(options.config ?? {}), options);
	return core.expose({});
};
