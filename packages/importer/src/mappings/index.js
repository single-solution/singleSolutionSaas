/**
 * The source mappings `ss-import read --mapping <name>` knows: the store mappings (PLAN 0.8.10 Migration, one per store
 * as it moves: `sisters-boutique`) and the test mappings (`fixture` into Notes, `example-shop` into Accounts,
 * Ecommerce, Chat and Growth).
 * @module
 */
import { FIXTURE_MAPPING, SHOP_MAPPING } from '../fixture/index.js';
import { SISTERS_BOUTIQUE_MAPPING } from './sisters-boutique/index.js';

/** @type {Readonly<Record<string, import('../mapping.js').Mapping>>} */
export const MAPPINGS = Object.freeze({
	[FIXTURE_MAPPING.name]: FIXTURE_MAPPING,
	[SHOP_MAPPING.name]: SHOP_MAPPING,
	[SISTERS_BOUTIQUE_MAPPING.name]: SISTERS_BOUTIQUE_MAPPING,
});
