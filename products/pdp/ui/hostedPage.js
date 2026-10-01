/**
 * Mode A renderer of the `hosted_page` element: on a matching sub-path it renders the item page — heading, primary
 * image, description, attributes and the named slots (`[data-ss-slot="…"]`) the other elements are placed into — and
 * publishes the item to the page (`data-ss-item-id` and an inline `data-ss-item` JSON blob) so those elements read the
 * same item. It sets the document title, description, canonical link and robots, then asks the Loader to re-evaluate
 * placements (`SS.refresh()`), which mounts the elements targeting the new slots. Design tokens only.
 * @module
 */
import { createTranslator } from '../headless/strings.js';
import { BASE_STYLES, el, loaderApi, once, query } from './dom.js';
import { pageSource } from './page.js';

/** @typedef {ReturnType<import('../headless/hostedPage.js').createHostedPage>} HostedPage */

export const styles = `${BASE_STYLES}
.ss-hosted{display:grid;gap:var(--ss-space-3)}
.ss-hosted__title{margin:0}
.ss-hosted__brand{margin:0;color:var(--ss-color-text-muted)}
.ss-hosted__image{width:100%;height:auto;border-radius:var(--ss-radius-md)}
.ss-hosted__specs{display:grid;grid-template-columns:max-content 1fr;gap:var(--ss-space-1) var(--ss-space-3);margin:0}
.ss-hosted__specs dt{color:var(--ss-color-text-muted)}
.ss-hosted__specs dd{margin:0}`;

/**
 * Set or create a `<meta name>` / `<link rel>` in the document head.
 * @param {import('./dom.js').DomLike} dom
 * @param {'meta' | 'link'} tag
 * @param {string} key name / rel
 * @param {string} value content / href
 */
const head = (dom, tag, key, value) => {
	const selector = tag === 'meta' ? `meta[name="${key}"]` : `link[rel="${key}"]`;
	const existing = query(dom, selector);
	const node = existing ?? dom.createElement(tag);
	node.setAttribute(tag === 'meta' ? 'name' : 'rel', key);
	node.setAttribute(tag === 'meta' ? 'content' : 'href', value);
	if (!existing) query(dom, 'head')?.append(node);
};

/**
 * @param {import('./dom.js').DomLike} dom
 * @param {NonNullable<ReturnType<HostedPage['state']>['meta']>} meta
 */
const applyMeta = (dom, meta) => {
	const doc = /** @type {any} */ (dom);
	if (meta.title) Object.assign(doc, { title: meta.title });
	if (meta.description) head(dom, 'meta', 'description', meta.description);
	if (meta.canonical) head(dom, 'link', 'canonical', meta.canonical);
	if (meta.robots === 'noindex') head(dom, 'meta', 'robots', 'noindex');
};

/**
 * @param {{ state: ReturnType<HostedPage['state']>, actions: HostedPage['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike }} props
 * @returns {any}
 */
export const render = ({ state, actions, strings, dom }) => {
	const t = createTranslator(strings);
	once(actions, () => actions.load(pageSource(dom, 'hosted_page')));
	const item = state.status === 'ready' ? state.item : null;
	const root = el(dom, 'article', {
		class: 'ss-pdp ss-hosted',
		role: 'region',
		'aria-label': item?.title || t('hosted_page.label'),
		hidden: item === null,
		'data-ss-page-type': item ? 'product' : null,
		'data-ss-item-id': item ? item.id || 'hosted' : null,
	});
	if (!item) return root;
	const blob = el(dom, 'script', { type: 'application/json', 'data-ss-item': true });
	blob.textContent = JSON.stringify(item).replace(/</g, '\\u003c');
	const image = item.images.find((entry) => entry.type === 'image');
	root.append(
		blob,
		el(dom, 'header', {}, [
			el(dom, 'h1', { class: 'ss-hosted__title' }, [item.title]),
			item.brand ? el(dom, 'p', { class: 'ss-hosted__brand' }, [item.brand]) : null,
			item.subtitle ? el(dom, 'p', { class: 'ss-hosted__brand' }, [item.subtitle]) : null,
		]),
		state.showImage && image
			? el(dom, 'img', {
					class: 'ss-hosted__image',
					src: image.src,
					alt: image.alt || item.title,
					width: image.width || null,
					height: image.height || null,
					fetchpriority: 'high',
				})
			: null,
		...state.slots.map((slot) => el(dom, 'div', { 'data-ss-slot': slot })),
		item.description ? el(dom, 'p', { class: 'ss-hosted__description' }, [item.description]) : null,
		state.showAttributes && item.attributes.length > 0
			? el(
					dom,
					'dl',
					{ class: 'ss-hosted__specs', 'aria-label': t('hosted_page.specs') },
					item.attributes.flatMap((entry) => [el(dom, 'dt', {}, [entry.name]), el(dom, 'dd', {}, [entry.value])]),
				)
			: null,
	);
	const meta = state.meta;
	if (meta)
		once(
			actions,
			() => {
				applyMeta(dom, meta);
				loaderApi(dom)?.refresh?.();
			},
			'meta',
		);
	return root;
};
