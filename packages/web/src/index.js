/**
 * @ss/web — the browser SDK: website events and identity federation (`client`), the headless element runtime
 * (`element`), default-renderer helpers (`renderer`) and the Loader runtime (`loader`). Every export is side-effect free
 * and tree-shakes; `@ss/rules` is only reached through `./audience.js`.
 * @module
 */
export { createClient, DEFAULT_EVENT_CATEGORIES, NECESSARY } from './client.js';
export {
	CLIENT_PROBLEMS,
	createElementApi,
	createStore,
	defineElement,
	err,
	formatString,
	isResult,
	mountHeadless,
	ok,
	parseProblem,
	problem,
	resolveStrings,
} from './element.js';
export {
	ATTRIBUTES,
	HTML_TAGS,
	SVG_TAGS,
	VISUALLY_HIDDEN,
	button,
	createH,
	focusFirst,
	focusables,
	h,
	liveRegion,
	prefersReducedMotion,
	reserveSpace,
	safeCssValue,
	safeUrl,
	saveFocus,
	slot,
	tokens,
	trapFocus,
	uniqueId,
} from './renderer.js';
export { DEFAULT_BREAKPOINTS, deviceOf, inSchedule, localTime, matchPath, matchPlacement, matchReferrer } from './placement.js';
export { createFrequency } from './frequency.js';
export { boot } from './loader.js';
export { createUseElement } from './adapters/react.js';

/** @typedef {import('./client.js').Client} Client */
/** @typedef {import('./client.js').ClientOptions} ClientOptions */
/** @typedef {import('./client.js').EventEnvelope} EventEnvelope */
/** @typedef {import('./element.js').Problem} Problem */
/** @typedef {import('./element.js').FieldProblem} FieldProblem */
/** @typedef {import('./element.js').ElementDefinition} ElementDefinition */
/** @typedef {import('./element.js').HeadlessElement} HeadlessElement */
/** @typedef {import('./element.js').ElementApi} ElementApi */
/** @typedef {import('./loader.js').Bundle} Bundle */
/** @typedef {import('./loader.js').BootOptions} BootOptions */
/** @typedef {import('./loader.js').LoaderInstance} LoaderInstance */
/**
 * @template T
 * @typedef {import('./element.js').Result<T>} Result
 */
