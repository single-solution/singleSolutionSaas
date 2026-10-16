/**
 * The object check the core modules share, for code that checks JSON by hand: the members of what it finds are read as
 * `any`, since the code then trusts what it checked. No I/O.
 * @module
 */
import { isObject as isPlainObject } from '@ss/contracts/util';

/** @type {(value: unknown) => value is Record<string, any>} */
export const isObject = isPlainObject;
