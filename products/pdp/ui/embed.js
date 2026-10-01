/**
 * Renderer of the embed elements. While the other product's element is mounted, its Loader container
 * (`[data-ss-element="<target>"]`) moves into this block — inside the item's scope — and is asked to `refresh()`;
 * otherwise the block stays hidden and empty. Self-contained (smallest budget); only `SS.elements` / `SS.on` used.
 */

/** @typedef {ReturnType<import('../headless/embed.js').createReviewsBlock>} Embed */

export const styles = '.ss-embed[hidden]{display:none!important}';

/** @type {WeakSet<object>} */
const connected = new WeakSet();

/**
 * @param {{ state: ReturnType<Embed['state']>, actions: Embed['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike & { querySelector?: (selector: string) => any } }} props
 * @returns {any}
 */
export const render = ({ state, actions, strings, dom }) => {
	const ss = dom.defaultView?.SS;
	if (!connected.has(actions)) {
		connected.add(actions);
		const api = ss?.elements ? { list: ss.elements.list, get: ss.elements.get, on: ss.on } : null;
		void Promise.resolve().then(() => actions.connect(api));
	}
	const active = state.status === 'active';
	const root = dom.createElement('section');
	root.setAttribute('class', `ss-pdp ss-embed ss-embed--${state.key}`);
	root.setAttribute('role', 'region');
	root.setAttribute('aria-label', strings[`${state.key}.label`] ?? state.key);
	root.setAttribute('data-ss-embed', state.target);
	if (!active) {
		root.setAttribute('hidden', '');
		return root;
	}
	const target = dom.querySelector?.(`[data-ss-element="${state.target}"]`);
	if (target) {
		const fresh = !root.contains?.(target) && target.parentElement?.getAttribute?.('data-ss-embed') !== state.target;
		root.append(target);
		if (fresh && state.refresh) void Promise.resolve().then(() => ss?.elements?.get?.(state.target)?.actions?.refresh?.());
	}
	return root;
};
