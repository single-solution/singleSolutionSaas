/**
 * Mode A renderer of the `share` element: the device share sheet and copy-link buttons (shown only when the browser
 * supports them) and links to the networks' public share pages (new tab, no opener). A polite live region confirms
 * a copied link. Design tokens only.
 * @module
 */
import { createTranslator } from '../headless/strings.js';
import { BASE_STYLES, el, listen, once, refocusing, winOf } from './dom.js';
import { pageSource } from './page.js';

/** @typedef {ReturnType<import('../headless/share.js').createShare>} Share */

export const styles = `${BASE_STYLES}
.ss-share{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ss-space-2)}
.ss-share__title{font-size:var(--ss-font-size-sm);color:var(--ss-color-text-muted);margin:0}
.ss-share__link{display:inline-flex;padding:var(--ss-space-1) var(--ss-space-2);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-full);background:var(--ss-color-surface);color:var(--ss-color-text);text-decoration:none;font-size:var(--ss-font-size-sm)}
.ss-share__status{font-size:var(--ss-font-size-sm);color:var(--ss-color-success);margin:0}`;

/**
 * @param {{ state: ReturnType<Share['state']>, actions: Share['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike }} props
 * @returns {any}
 */
export const render = ({ state, actions, strings, dom }) => {
	const t = createTranslator(strings);
	once(actions, () => actions.load(pageSource(dom, 'share')));
	const nav = winOf(dom)?.navigator;
	const links = state.links.filter(
		(link) =>
			(link.channel !== 'native' || typeof nav?.share === 'function') &&
			(link.channel !== 'copy' || typeof nav?.clipboard?.writeText === 'function'),
	);
	const shown = state.status === 'ready' && links.length > 0;
	const root = el(dom, 'div', { class: 'ss-pdp ss-share', role: 'group', 'aria-label': t('share.label'), hidden: !shown });
	if (!shown) return root;
	root.append(el(dom, 'p', { class: 'ss-share__title', 'aria-hidden': 'true' }, [t('share.label')]));
	for (const link of links) {
		const label = t(`share.channel.${link.channel}`);
		const node = link.href
			? el(
					dom,
					'a',
					{
						class: 'ss-share__link',
						href: link.href,
						target: '_blank',
						rel: 'noopener noreferrer',
						'data-ss-focus': link.channel,
					},
					[label],
				)
			: el(dom, 'button', { type: 'button', class: 'ss-share__link', 'data-ss-focus': link.channel }, [label]);
		listen(node, 'click', async () => {
			const result = await actions.share(link.channel);
			if (!result.ok) return;
			try {
				if (link.channel === 'native') await nav.share({ url: result.value.url, title: result.value.title });
				else if (link.channel === 'copy') {
					await nav.clipboard.writeText(result.value.url);
					await actions.copied(true);
				}
			} catch {
				if (link.channel === 'copy') await actions.copied(false);
			}
		});
		root.append(node);
	}
	root.append(el(dom, 'p', { class: 'ss-share__status', role: 'status' }, [state.copied ? t('share.copied') : '']));
	return root;
};

/** In-place update for the Loader that keeps focus on the pressed channel. */
export const update = refocusing(render);
