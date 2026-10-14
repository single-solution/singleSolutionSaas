/**
 * The source mappings `ss-import read --mapping <name>` knows: the store mappings (PLAN 0.8.10 Migration, one per store
 * as it moves: `sisters-boutique`). The test mappings (`@ss/importer/fixture`) are not among them: tests pass them in.
 * @module
 */
import { SISTERS_BOUTIQUE_MAPPING } from './sisters-boutique/index.js';

/** @type {Readonly<Record<string, import('../mapping.js').Mapping>>} */
export const MAPPINGS = Object.freeze({
	[SISTERS_BOUTIQUE_MAPPING.name]: SISTERS_BOUTIQUE_MAPPING,
});
