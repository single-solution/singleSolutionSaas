/**
 * Mode A renderers of the layout blocks: `notice_bar` (an announcement region with an optional link and a dismiss
 * button), `mobile_tab_bar` (fixed bottom navigation below the tablet breakpoint, `aria-current` on the active tab,
 * safe-area aware; the page keeps room for it) and `contact_footer` (contacts, opening hours, social and policy
 * links).
 */
import { createTranslator } from '../headless/strings.js';
import { boot, el, icon, windowOf } from './dom.js';

/** Icon paths (24×24, stroked). */
const ICON_PATHS = Object.freeze({
	home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
	search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
	tag: 'M3 12V4h8l10 10-8 8zM7.5 7.5h.01',
	cart: 'M3 4h2l2 12h11l2-8H6M9 20h.01M17 20h.01',
	user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
	chat: 'M4 5h16v11H8l-4 4z',
	heart: 'M12 20s-8-5-8-11a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 6-8 11-8 11z',
	menu: 'M4 6h16M4 12h16M4 18h16',
	grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
	phone: 'M5 3h4l2 5-3 2a12 12 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 3 5a2 2 0 0 1 2-2z',
});

/**
 * @param {{ state: ReturnType<ReturnType<typeof import('../headless/blocks.js').createNoticeBar>['state']>,
 *   actions: ReturnType<typeof import('../headless/blocks.js').createNoticeBar>['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike }} props
 */
export const renderNoticeBar = ({ state, actions, strings, dom }) => {
	const t = createTranslator(strings);
	const text = t('notice_bar.text');
	return el(
		dom,
		'div',
		{
			class: `ss-notice ss-notice--${state.tone}${state.sticky ? ' ss-notice--sticky' : ''}`,
			role: 'region',
			'aria-label': t('notice_bar.label'),
			hidden: state.dismissed || text === '',
		},
		[
			el(dom, 'p', { class: 'ss-notice__text' }, [state.href ? el(dom, 'a', { href: state.href }, [text]) : text]),
			state.dismissible
				? el(
						dom,
						'button',
						{
							type: 'button',
							class: 'ss-notice__close',
							'aria-label': t('notice_bar.dismiss'),
							onclick: () => void actions.dismiss(),
						},
						[el(dom, 'span', { 'aria-hidden': 'true' }, ['×'])],
					)
				: null,
		],
	);
};

/**
 * @param {{ state: ReturnType<ReturnType<typeof import('../headless/blocks.js').createMobileTabBar>['state']>,
 *   actions: ReturnType<typeof import('../headless/blocks.js').createMobileTabBar>['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike }} props
 */
export const renderMobileTabBar = ({ state, actions, strings, dom }) => {
	const t = createTranslator(strings);
	const win = windowOf(dom);
	boot(
		dom,
		actions,
		() => void actions.setPath(String(win?.location?.pathname ?? '/')),
		() => void actions.setPath(String(win?.location?.pathname ?? '/')),
	);
	return el(dom, 'nav', { class: 'ss-tabbar', role: 'navigation', 'aria-label': t('mobile_tab_bar.label') }, [
		el(
			dom,
			'ul',
			{ role: 'list' },
			state.tabs.map((tab) =>
				el(dom, 'li', {}, [
					el(
						dom,
						'a',
						{
							href: tab.href,
							class: 'ss-tabbar__tab',
							'aria-current': tab.key === state.active ? 'page' : null,
							'aria-label': state.labels ? null : tab.label,
							onclick: () => void actions.select(tab.key),
						},
						[icon(dom, ICON_PATHS[tab.icon]), state.labels ? el(dom, 'span', {}, [tab.label]) : null],
					),
				]),
			),
		),
	]);
};

/**
 * @param {{ state: ReturnType<ReturnType<typeof import('../headless/blocks.js').createContactFooter>['state']>,
 *   strings: Record<string, string>, dom: import('./dom.js').DomLike, slots?: Record<string, any> }} props
 */
export const renderContactFooter = ({ state, strings, dom, slots = {} }) => {
	const t = createTranslator(strings);
	/** @param {string} key @param {any} body */
	const block = (key, body) =>
		el(dom, 'section', { class: 'ss-footer__block', 'aria-labelledby': `ss-footer-${key}` }, [
			el(dom, 'h2', { id: `ss-footer-${key}` }, [t(`contact_footer.${key}`)]),
			body,
		]);
	/** @param {Array<{ label: string, href: string | null }>} links @param {boolean} [external] */
	const list = (links, external = false) =>
		el(
			dom,
			'ul',
			{ role: 'list' },
			links.map((link) =>
				el(dom, 'li', {}, [el(dom, 'a', { href: link.href, rel: external ? 'noopener noreferrer me' : null }, [link.label])]),
			),
		);
	const year = new Date().getFullYear();
	return el(dom, 'footer', { class: 'ss-footer', role: 'contentinfo', 'aria-label': t('contact_footer.label') }, [
		slots.before ?? null,
		el(dom, 'div', { class: 'ss-footer__grid' }, [
			state.contacts.length > 0
				? block(
						'contact',
						el(
							dom,
							'ul',
							{ role: 'list' },
							state.contacts.map((c) =>
								el(dom, 'li', {}, [
									c.label ? el(dom, 'span', { class: 'ss-footer__label' }, [c.label, ' ']) : null,
									c.href
										? el(dom, 'a', { href: c.href }, [c.value])
										: c.kind === 'address'
											? el(dom, 'address', {}, [c.value])
											: c.value,
								]),
							),
						),
					)
				: null,
			state.hours.length > 0
				? block(
						'hours',
						el(
							dom,
							'dl',
							{},
							state.hours.map((row) => [el(dom, 'dt', {}, [row.days]), el(dom, 'dd', {}, [row.time])]),
						),
					)
				: null,
			state.socials.length > 0 ? block('social', list(state.socials, true)) : null,
			state.links.length > 0 ? block('links', list(state.links)) : null,
		]),
		state.year || state.name
			? el(dom, 'p', { class: 'ss-footer__legal' }, [
					t('contact_footer.copyright', { year: state.year ? year : '', name: state.name }),
				])
			: null,
		slots.after ?? null,
	]);
};

/** Styles of each block (design tokens only); the build ships each element only its own. */
export const noticeStyles = `.ss-notice{display:flex;align-items:center;justify-content:center;gap:var(--ss-space-2);padding:var(--ss-space-2) var(--ss-space-4);background:var(--ss-color-accent,var(--ss-color-primary));color:var(--ss-color-on-accent,var(--ss-color-on-primary));font:var(--ss-font-body);text-align:center}
.ss-notice--info{background:var(--ss-color-surface-2);color:var(--ss-color-text)}.ss-notice--warning{background:var(--ss-color-danger);color:var(--ss-color-on-primary)}
.ss-notice--sticky{position:sticky;top:0;z-index:var(--ss-z-overlay,40)}.ss-notice[hidden]{display:none}
.ss-notice__text{margin:0}.ss-notice a{color:inherit}
.ss-notice__close{min-width:2.75rem;min-height:2.75rem;border:0;border-radius:var(--ss-radius-full);background:transparent;color:inherit;font-size:1.25rem;cursor:pointer}
.ss-notice :focus-visible{outline:2px solid currentColor;outline-offset:2px}
`;

export const tabBarStyles = `.ss-tabbar{position:fixed;left:var(--ss-space-3);right:var(--ss-space-3);bottom:calc(env(safe-area-inset-bottom,0px) + var(--ss-space-1));z-index:var(--ss-z-overlay,30);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-full);background:var(--ss-color-surface);box-shadow:var(--ss-shadow-lg);font:var(--ss-font-body)}
.ss-tabbar ul{display:flex;margin:0;padding:var(--ss-space-1);list-style:none}.ss-tabbar li{flex:1}
.ss-tabbar__tab{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:3rem;border-radius:var(--ss-radius-full);color:var(--ss-color-text-muted);text-decoration:none;font-size:var(--ss-font-size-xs,.75rem)}
.ss-tabbar__tab[aria-current]{color:var(--ss-color-primary);background:var(--ss-color-surface-2)}.ss-tabbar__tab:focus-visible{outline:2px solid var(--ss-color-focus)}
body:has(.ss-tabbar){padding-bottom:calc(4.5rem + env(safe-area-inset-bottom,0px))}
@media (min-width:768px){.ss-tabbar{display:none}body:has(.ss-tabbar){padding-bottom:0}}
`;

export const footerStyles = `.ss-footer{display:flex;flex-direction:column;gap:var(--ss-space-4);padding:var(--ss-space-6,1.5rem) var(--ss-space-4);background:var(--ss-color-surface-2);color:var(--ss-color-text);font:var(--ss-font-body)}
.ss-footer__grid{display:grid;gap:var(--ss-space-4);grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))}
.ss-footer h2{margin:0 0 var(--ss-space-2);font-size:1rem}.ss-footer ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:var(--ss-space-1)}
.ss-footer dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:var(--ss-space-1) var(--ss-space-3)}.ss-footer dd{margin:0}
.ss-footer a{color:inherit}.ss-footer a:focus-visible{outline:2px solid var(--ss-color-focus)}.ss-footer address{font-style:normal;display:inline}
.ss-footer__label,.ss-footer__legal{color:var(--ss-color-text-muted)}.ss-footer__legal{margin:0}
`;
