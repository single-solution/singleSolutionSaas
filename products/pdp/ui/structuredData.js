/**
 * Mode A renderer of the `structured_data` element: an invisible container holding the item's
 * `<script type="application/ld+json">` (a data block — never executed, CSP-safe), and, when enabled, the standard
 * `item.viewed@1` event through the Loader's public `SS.track`.
 * @module
 */
import { el, loaderApi, once } from './dom.js';
import { pageSource } from './page.js';

/** @typedef {ReturnType<import('../headless/structuredData.js').createStructuredData>} StructuredData */

/**
 * @param {{ state: ReturnType<StructuredData['state']>, actions: StructuredData['actions'], dom: import('./dom.js').DomLike }} props
 * @returns {any}
 */
export const render = ({ state, actions, dom }) => {
	once(actions, () => actions.load(pageSource(dom, 'structured_data')));
	const root = el(dom, 'div', { class: 'ss-pdp ss-structured-data', hidden: true, 'data-ss-pdp': true });
	if (state.json !== '') {
		const script = el(dom, 'script', { type: 'application/ld+json', 'data-ss-pdp': true });
		script.textContent = state.json;
		root.append(script);
	}
	const viewed = state.viewed;
	if (viewed && state.status === 'ready') once(actions, () => loaderApi(dom)?.track?.('item.viewed', viewed), 'viewed');
	return root;
};
