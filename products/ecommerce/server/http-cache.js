/**
 * Conditional reads of the SEO and shop answers (SEO audit G10, parity P3-11), light on free plans: a JSON answer
 * carries an ETag (a hash of the answer: the same answer, the same ETag; any change of what it says, a new one) and
 * Cache-Control — a server may keep it a minute and serve it while it reads it again, a browser checks it again each
 * time — and an If-None-Match naming it is answered 304 without a body. Image links signed for each answer (storage
 * connected without a public address) are signed again every second; their signing parts are left out of the hash
 * within a ten-minute window, so the same answer keeps its ETag there while every link a kept answer holds still works
 * (they are signed for an hour).
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

/** The parts of a presigned storage link that change each time it is signed (S3 signature V4). */
const SIGNING_PARTS = /X-Amz-(?:Credential|Date|Signature)=[^&"\\]*/g;
/** How long an answer whose links were only signed again keeps its ETag. */
const SIGNED_WINDOW_MS = 10 * 60_000;

/**
 * The ETag of an answer: a hash of its JSON, presigned links' signing parts left out within the window of `now`.
 * @param {unknown} body @param {number} now
 */
const etagOf = (body, now) => {
	const text = JSON.stringify(body);
	const stable = text.replace(SIGNING_PARTS, '');
	const hashed = stable === text ? text : `${stable}|${Math.floor(now / SIGNED_WINDOW_MS)}`;
	return `"${createHash('sha256').update(hashed).digest('base64url').slice(0, 32)}"`;
};

/**
 * A read route's handler whose JSON answer carries its ETag and Cache-Control, and is answered 304 when the request's
 * If-None-Match names it.
 * @param {(ctx: any) => Promise<unknown>} handler
 * @param {() => number} now the clock (signed links' window)
 * @returns {(ctx: any) => Promise<unknown>}
 */
export const conditional = (handler, now) => async (ctx) => {
	const body = await handler(ctx);
	const etag = etagOf(body, now());
	const headers = { etag, 'cache-control': ctx.token?.kind === 'server' ? SERVER_CACHE : BROWSER_CACHE };
	if (namesEtag(ctx.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
	return ok(body, { headers });
};
