/**
 * Route result helpers. Handlers return (or throw) these; the request handler renders them. `problem()` results are
 * rendered as RFC 9457 documents with the product's type base URI and the request id.
 * @module
 */
import { isObject } from '../util.js';

const BRAND = Symbol.for('ss.app-kit.result');

/**
 * @typedef {{ [BRAND]: 'response', status: number, body: unknown, headers: Record<string, string> }} ResponseResult
 * @typedef {{ [BRAND]: 'problem', code: string, status?: number, detail?: string, errors?: Array<{ path: string, message: string, keyword?: string, code?: string }>, extensions?: Readonly<Record<string, unknown>>, headers: Record<string, string> }} ProblemResult
 * @typedef {ResponseResult | ProblemResult} RouteResult
 */

/**
 * A JSON response (default 200).
 * @param {unknown} body
 * @param {{ status?: number, headers?: Record<string, string> }} [init]
 * @returns {ResponseResult}
 */
export const ok = (body, { status = 200, headers = {} } = {}) => ({ [BRAND]: 'response', status, body, headers });

/**
 * 201 Created, with an optional `Location`.
 * @param {unknown} body
 * @param {{ location?: string, headers?: Record<string, string> }} [init]
 * @returns {ResponseResult}
 */
export const created = (body, { location, headers = {} } = {}) =>
	ok(body, { status: 201, headers: { ...headers, ...(location ? { location } : {}) } });

/** 204 No Content. @returns {ResponseResult} */
export const noContent = () => ok(undefined, { status: 204 });

/** Members the kit renders itself; extensions cannot use these names. */
const RESERVED_PROBLEM_MEMBERS = Object.freeze(['type', 'title', 'status', 'detail', 'instance', 'requestId', 'errors']);
/** RFC 9457 §3.2: extension member names start with a letter and use letters, digits and `_` (≥ 3 characters). */
const EXTENSION_NAME = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;

/**
 * @param {unknown} extensions
 * @returns {Readonly<Record<string, unknown>> | undefined}
 */
const checkExtensions = (extensions) => {
	if (extensions === undefined) return undefined;
	if (!isObject(extensions)) throw new TypeError('problem extensions must be a plain object');
	for (const [name, value] of Object.entries(extensions)) {
		if (!EXTENSION_NAME.test(name)) throw new TypeError(`invalid problem extension member name: ${name}`);
		if (RESERVED_PROBLEM_MEMBERS.includes(name)) throw new TypeError(`problem extension cannot redefine '${name}'`);
		if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
			throw new TypeError(`problem extension '${name}' must be JSON`);
	}
	return Object.freeze({ ...extensions });
};

/**
 * An RFC 9457 problem for a registered code (`@ss/contracts` `PROBLEM_CODES` or the product's own codes).
 * `extensions` adds RFC 9457 extension members (e.g. `{ retryAfterSeconds: 30, limit: 'daily' }`): names must match
 * `^[A-Za-z][A-Za-z0-9_]{2,63}$` and may not redefine `type`, `title`, `status`, `detail`, `instance`, `requestId` or
 * `errors` (a TypeError is thrown at construction otherwise).
 * @param {string} code
 * @param {string} [detail]
 * @param {{ errors?: ProblemResult['errors'], headers?: Record<string, string>, status?: number, extensions?: Record<string, unknown> }} [extra]
 * @returns {ProblemResult}
 */
export const problem = (code, detail, { errors, headers = {}, status, extensions } = {}) => {
	const checked = checkExtensions(extensions);
	return {
		[BRAND]: 'problem',
		code,
		...(status === undefined ? {} : { status }),
		...(detail === undefined ? {} : { detail }),
		...(errors === undefined ? {} : { errors }),
		...(checked === undefined || Object.keys(checked).length === 0 ? {} : { extensions: checked }),
		headers,
	};
};

/**
 * @param {unknown} value
 * @returns {unknown}
 */
const brandOf = (value) => (isObject(value) ? /** @type {Record<symbol, unknown>} */ (value)[BRAND] : undefined);

/**
 * @param {unknown} value
 * @returns {value is RouteResult}
 */
export const isResult = (value) => brandOf(value) === 'response' || brandOf(value) === 'problem';

/**
 * @param {unknown} value
 * @returns {value is ProblemResult}
 */
export const isProblem = (value) => brandOf(value) === 'problem';

/** @typedef {string | number | boolean | null} CursorScalar */
/** @typedef {CursorScalar | CursorScalar[]} CursorKey a key, or a compound key (array of scalars, e.g. `[createdAt, id]`) */

const MAX_COMPOUND = 8;

/**
 * @param {unknown} value
 * @returns {value is CursorScalar}
 */
const isCursorScalar = (value) =>
	value === null ||
	typeof value === 'string' ||
	typeof value === 'boolean' ||
	(typeof value === 'number' && Number.isFinite(value));

/**
 * @param {unknown} value
 * @returns {CursorKey}
 */
const toCursorKey = (value) => {
	const normal = value instanceof Date ? value.toISOString() : value;
	if (Array.isArray(normal)) {
		const parts = normal.map((part) => (part instanceof Date ? part.toISOString() : part));
		if (parts.length === 0 || parts.length > MAX_COMPOUND || !parts.every(isCursorScalar))
			throw new TypeError(`a compound cursor key is 1..${MAX_COMPOUND} strings, numbers, booleans, nulls or dates`);
		return parts;
	}
	if (normal === null || !isCursorScalar(normal)) throw new TypeError('a cursor key is a string, number, boolean or date');
	return normal;
};

/**
 * @param {unknown} value
 * @returns {string}
 */
const encodeCursor = (value) => Buffer.from(JSON.stringify({ k: toCursorKey(value) })).toString('base64url');

/**
 * @param {string} cursor
 * @returns {CursorKey}
 */
const decodeCursor = (cursor) => {
	if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw problem('bad_request', 'cursor is invalid');
	try {
		const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		if (!isObject(parsed) || !('k' in parsed)) throw new Error('shape');
		const key = parsed.k;
		if (Array.isArray(key)) {
			if (key.length === 0 || key.length > MAX_COMPOUND || !key.every(isCursorScalar)) throw new Error('type');
			return key;
		}
		if (typeof key !== 'string' && typeof key !== 'number' && typeof key !== 'boolean') throw new Error('type');
		return key;
	} catch {
		throw problem('bad_request', 'cursor is invalid');
	}
};

/**
 * Cursor pagination (Part E §5): opaque cursors, `limit` bounded. Fetch `fetchLimit` (= limit + 1) items sorted by the
 * key and pass them to `page()`, which slices and returns the next cursor, or to `respond()`, which also emits
 * `Link: <url>; rel="next"` when a next page exists (`url` = the request URL, e.g. `ctx.request.url`).
 *
 * Keyset keys may be compound: `keyOf` returns an array (e.g. `(r) => [r.createdAt, r.id]`, dates become ISO strings),
 * the cursor encodes the array opaquely and `after` is that array on the next request (build the keyset filter with
 * it, e.g. `{ $or: [{ createdAt: { $lt: a } }, { createdAt: a, _id: { $lt: b } }] }`). A scalar key stays a scalar.
 * @param {{ cursor?: string | null, limit?: string | number | null, url?: string | URL }} [input]
 * @param {{ defaultLimit?: number, maxLimit?: number }} [options]
 * @throws {ProblemResult} `bad_request` for an invalid cursor or limit
 */
export const paginate = ({ cursor, limit, url } = {}, { defaultLimit = 20, maxLimit = 100 } = {}) => {
	/** @type {number} */
	let n = defaultLimit;
	if (limit !== undefined && limit !== null && limit !== '') {
		n = typeof limit === 'number' ? limit : /^\d{1,6}$/.test(limit) ? Number(limit) : Number.NaN;
		if (!Number.isInteger(n) || n < 1 || n > maxLimit) throw problem('bad_request', `limit must be 1..${maxLimit}`);
	}
	/** @type {CursorKey | null} */
	const after = cursor ? decodeCursor(cursor) : null;
	/**
	 * @template T
	 * @param {T[]} items
	 * @param {(item: T) => unknown} [keyOf]
	 * @returns {{ items: T[], nextCursor: string | null, hasMore: boolean }}
	 */
	const page = (items, keyOf = (item) => /** @type {any} */ (item)?.id) => {
		const hasMore = items.length > n;
		const slice = hasMore ? items.slice(0, n) : items;
		const last = slice[slice.length - 1];
		return { items: slice, nextCursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null, hasMore };
	};
	/**
	 * `Link` header value for the next page, or null.
	 * @param {string | null} nextCursor
	 * @returns {string | null}
	 */
	const link = (nextCursor) => {
		if (!nextCursor || !url) return null;
		const next = new URL(url);
		next.searchParams.set('cursor', nextCursor);
		next.searchParams.set('limit', String(n));
		return `<${next.pathname}${next.search}>; rel="next"`;
	};
	return {
		limit: n,
		after,
		fetchLimit: n + 1,
		page,
		link,
		/**
		 * A 200 response `{ items, nextCursor, hasMore }` with the `Link` header.
		 * @template T
		 * @param {T[]} items
		 * @param {(item: T) => unknown} [keyOf]
		 * @returns {ResponseResult}
		 */
		respond: (items, keyOf) => {
			const body = page(items, keyOf);
			const header = link(body.nextCursor);
			return ok(body, { headers: header ? { link: header } : {} });
		},
	};
};
