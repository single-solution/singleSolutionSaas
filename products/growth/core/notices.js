/**
 * Which announcement a page shows (G4), on its own so the page script carries only this: the patterns of
 * `@ss/contracts/text` `pathMatches` (`*` inside one segment, `**` any number of segments).
 * @module
 */
import { pathMatches } from '@ss/contracts/text';

/**
 * An announcement showing now (G4), as the page script and `GET /v1/notice` get it.
 * @typedef {{ key: string, text: string, linkUrl: string | null, linkText: string, dismissible: boolean,
 *   dismiss: 'page' | 'visit' | 'days', dismissDays: number, pages: string[], hideOnPages: string[] }} Notice
 */

/**
 * Whether an announcement applies to a page: its pages (none: every page) name the page and its hidden pages do not.
 * @param {Notice} notice
 * @param {string} path
 */
export const appliesTo = (notice, path) =>
	(notice.pages.length === 0 || notice.pages.some((pattern) => pathMatches(pattern, path))) &&
	!notice.hideOnPages.some((pattern) => pathMatches(pattern, path));

/**
 * The announcement a page shows: the first showing now that applies to it.
 * @param {ReadonlyArray<Notice>} notices
 * @param {string} path
 * @returns {Notice | null}
 */
export const noticeFor = (notices, path) => notices.find((notice) => appliesTo(notice, path)) ?? null;
