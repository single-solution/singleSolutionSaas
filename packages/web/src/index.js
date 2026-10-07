/**
 * @ss/web — helpers a product may bundle into its own `widget.js`: the DOM-free widget core (`widget`) and safe DOM
 * helpers for a ready-made UI (`renderer`). Every export is side-effect free and tree-shakes.
 * @module
 */
export {
	CLIENT_PROBLEMS,
	createApiClient,
	createStore,
	defineWidget,
	err,
	formatString,
	isResult,
	mountHeadless,
	ok,
	parseProblem,
	problem,
	resolveStrings,
} from './widget.js';
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

/** @typedef {import('./widget.js').Problem} Problem */
/** @typedef {import('./widget.js').FieldProblem} FieldProblem */
/** @typedef {import('./widget.js').WidgetDefinition} WidgetDefinition */
/** @typedef {import('./widget.js').HeadlessWidget} HeadlessWidget */
/** @typedef {import('./widget.js').ApiClient} ApiClient */
/**
 * @template T
 * @typedef {import('./widget.js').Result<T>} Result
 */
