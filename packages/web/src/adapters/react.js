/**
 * React adapter for headless elements (Mode B). React is an optional peer dependency and is never imported here:
 * pass your React once, `export const useElement = createUseElement(React)`, so this module typechecks and bundles
 * without React installed and cannot pull a second copy of React into a page.
 *
 * Other frameworks follow the same three steps: mount once per component (`mountHeadless`), subscribe to the store
 * and read `state()` as the snapshot, destroy on unmount — e.g. Vue: `shallowRef(el.state())` updated in
 * `el.subscribe`, `onUnmounted(el.destroy)`; Svelte: `readable(el.state(), (set) => el.subscribe(set))`.
 * @module
 */
import { mountHeadless } from '../element.js';

/**
 * The slice of React this adapter needs.
 * @typedef {object} ReactLike
 * @property {<T>(initial: T | null) => { current: T | null }} useRef
 * @property {(subscribe: (onChange: () => void) => () => void, getSnapshot: () => any, getServerSnapshot?: () => any) => any} useSyncExternalStore
 * @property {(effect: () => void | (() => void), deps?: ReadonlyArray<unknown>) => void} useEffect
 * @property {(reducer: (count: number) => number, initial: number) => [number, () => void]} useReducer
 */

/**
 * @param {ReactLike} React
 * @returns {(definition: Readonly<import('../element.js').ElementDefinition>, options?: import('../element.js').MountOptions) => { state: Readonly<Record<string, any>>, element: import('../element.js').HeadlessElement }}
 */
export const createUseElement = (React) => (definition, options) => {
	/** @type {{ current: { definition: unknown, element: import('../element.js').HeadlessElement } | null }} */
	const ref = React.useRef(null);
	const [, rerender] = React.useReducer((count) => count + 1, 0);
	if (ref.current === null || ref.current.definition !== definition || ref.current.element.isDestroyed())
		ref.current = { definition, element: mountHeadless(definition, options) };
	const { element } = ref.current;
	const state = React.useSyncExternalStore(element.subscribe, element.state, element.state);
	React.useEffect(() => {
		// StrictMode runs cleanup + effect again: remount if the previous cleanup destroyed our instance.
		if (element.isDestroyed()) rerender();
		return () => element.destroy();
	}, [element]);
	return { state, element };
};
