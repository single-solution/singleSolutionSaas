/**
 * jsdom for tests that need a real HTML parser or a page realm (the package ships no type declarations, so it is
 * loaded through `require` and typed here).
 */
import { createRequire } from 'node:module';

/** @type {{ JSDOM: new (html?: string, options?: Record<string, unknown>) => { window: any } }} */
export const { JSDOM } = createRequire(import.meta.url)('jsdom');
