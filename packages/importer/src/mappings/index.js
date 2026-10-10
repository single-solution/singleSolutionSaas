/**
 * The source mappings `ss-import read --mapping <name>` knows. Phase 5 adds the one mapping of the store schema family
 * (PLAN 0.8.10 Migration); until then only the fixture mapping exists.
 * @module
 */
import { FIXTURE_MAPPING } from '../fixture/index.js';

/** @type {Readonly<Record<string, import('../mapping.js').Mapping>>} */
export const MAPPINGS = Object.freeze({ [FIXTURE_MAPPING.name]: FIXTURE_MAPPING });
