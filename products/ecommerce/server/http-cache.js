/**
 * Conditional reads of the SEO and shop answers (SEO audit G10, parity P3-11), light on free plans: a JSON answer
 * carries an ETag (a hash of the answer: the same answer, the same ETag; any change of what it says, a new one) and
 * Cache-Control — a server may keep it a minute and serve it while it reads it again, a browser checks it again each
 * time — and an If-None-Match naming it is answered 304 without a body.
 * @module
 */
import { createHash } from 'node:crypto';
import { ok } from '@ss/app-kit';

/** A server keeps an answer a minute, and serves it for ten more while it reads it again. */
const SERVER_CACHE = 'private, max-age=60, stale-while-revalidate=600';
/** A browser checks an answer again each time it uses it (a 304 when it did not change). */
const BROWSER_CACHE = 'private, no-cache';

/**
 * Whether an `If-None-Match` header names an ETag (`*`, or one of a list; weak tags compare as strong).
 * @param {string | null} header
 * @param {string} etag
 */
const namesEtag = (header, etag) =>
	header !== null &&
	header
		.split(',')
		.map((tag) => tag.trim().replace(/^W\//, ''))
		.some((tag) => tag === '*' || tag === etag);

/**
 * A read route's handler whose JSON answer carries its ETag and Cache-Control, and is answered 304 when the request's
 * If-None-Match names it.
 * @param {(ctx: any) => Promise<unknown>} handler
 * @returns {(ctx: any) => Promise<unknown>}
 */
export const conditional = (handler) => async (ctx) => {
	const body = await handler(ctx);
	const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 32)}"`;
	const headers = { etag, 'cache-control': ctx.token?.kind === 'server' ? SERVER_CACHE : BROWSER_CACHE };
	if (namesEtag(ctx.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
	return ok(body, { headers });
};
