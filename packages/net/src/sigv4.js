/**
 * AWS Signature Version 4 (pure, `node:crypto` HMAC-SHA-256 only — no SDK) for S3-compatible object stores (AWS S3,
 * Cloudflare R2, MinIO, GCS interoperability) and other SigV4 services: header signing (`signV4`) and query-string
 * presigning (`presignV4`). Verified against the AWS documentation vectors.
 *
 * The canonical URI is the URL path **as given** (S3 semantics: callers URI-encode object keys once, see
 * {@link uriEncode} / {@link objectUrl}); query parameters are RFC 3986 encoded and sorted by name, then value.
 * @module
 */
import { createHash, createHmac } from 'node:crypto';

/**
 * @typedef {object} SignV4Params
 * @property {string} method
 * @property {string | URL} url
 * @property {Record<string, string>} [headers] extra headers to sign (and send)
 * @property {string | Uint8Array} [body] request payload (default empty)
 * @property {string} region
 * @property {string} [service] default `s3`
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} [sessionToken] adds `x-amz-security-token`
 * @property {number | Date} [now] signing instant (default `Date.now()`)
 * @property {string} [payloadHash] precomputed hex SHA-256 or `UNSIGNED-PAYLOAD` instead of hashing `body`
 * @property {boolean} [contentSha256Header] send/sign `x-amz-content-sha256` (default true; S3 requires it)
 */

/**
 * @typedef {object} PresignV4Params
 * @property {string} method
 * @property {string | URL} url path already URI-encoded; existing query parameters are signed too
 * @property {string} region
 * @property {string} [service] default `s3`
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} [sessionToken]
 * @property {number | Date} [now]
 * @property {number} expiresIn seconds, 1..604800
 * @property {Record<string, string>} [headers] signed headers besides `host` the client must send verbatim
 * @property {Record<string, string>} [query] extra query parameters (e.g. `response-content-disposition`)
 */

export const ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const MAX_PRESIGN_SECONDS = 604_800;

/**
 * RFC 3986 encoding as SigV4 expects it (`/` kept when `keepSlash`).
 * @param {string} value
 * @param {boolean} [keepSlash]
 * @returns {string}
 */
export const uriEncode = (value, keepSlash = false) => {
	const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
};

/** @param {string | Uint8Array} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/**
 * @param {string | Buffer} key
 * @param {string} data
 */
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/**
 * `20130524T000000Z` and `20130524` for an instant.
 * @param {number | Date} [now]
 * @returns {{ amzDate: string, dateStamp: string }}
 */
export const amzDates = (now = Date.now()) => {
	const iso = new Date(now)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
	return { amzDate: iso, dateStamp: iso.slice(0, 8) };
};

/**
 * @param {string} secret
 * @param {string} dateStamp
 * @param {string} region
 * @param {string} service
 */
const signingKey = (secret, dateStamp, region, service) =>
	hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');

/**
 * @param {ReadonlyArray<readonly [string, string]>} pairs
 * @returns {string}
 */
const canonicalQuery = (pairs) =>
	pairs
		.map(([k, v]) => [uriEncode(k), uriEncode(v)])
		.sort(([ak = '', av = ''], [bk = '', bv = '']) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join('&');

/**
 * @param {Record<string, string>} headers
 * @returns {{ names: string[], lower: Record<string, string> }}
 */
const normaliseHeaders = (headers) => {
	/** @type {Record<string, string>} */
	const lower = {};
	for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
	return { names: Object.keys(lower).sort(), lower };
};

/**
 * @param {{ method: string, path: string, query: ReadonlyArray<readonly [string, string]>, headers: Record<string, string>, payloadHash: string }} request
 * @returns {{ signedHeaders: string, text: string }}
 */
const canonicalRequest = ({ method, path, query, headers, payloadHash }) => {
	const { names, lower } = normaliseHeaders(headers);
	const signedHeaders = names.join(';');
	const canonicalHeaders = names.map((name) => `${name}:${lower[name]}\n`).join('');
	return {
		signedHeaders,
		text: [method.toUpperCase(), path, canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash].join('\n'),
	};
};

/**
 * @param {{ secretAccessKey: string, amzDate: string, dateStamp: string, region: string, service: string, canonical: string }} input
 * @returns {{ scope: string, signature: string }}
 */
const sign = ({ secretAccessKey, amzDate, dateStamp, region, service, canonical }) => {
	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const toSign = [ALGORITHM, amzDate, scope, sha256(canonical)].join('\n');
	const signature = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, service))
		.update(toSign)
		.digest('hex');
	return { scope, signature };
};

/**
 * @param {Record<string, unknown>} params
 */
const requireCredentials = (params) => {
	for (const name of ['region', 'accessKeyId', 'secretAccessKey']) {
		if (typeof params[name] !== 'string' || params[name] === '') throw new TypeError(`${name} is required`);
	}
};

/**
 * Sign a request with the `Authorization` header.
 * @param {SignV4Params} params
 * @returns {Record<string, string>} headers to send (everything signed except `host`, plus `authorization`)
 */
export const signV4 = (params) => {
	requireCredentials(/** @type {any} */ (params));
	const {
		method,
		url,
		headers = {},
		body = '',
		region,
		service = 's3',
		accessKeyId,
		secretAccessKey,
		sessionToken,
		now = Date.now(),
		payloadHash: givenHash,
		contentSha256Header = true,
	} = params;
	const target = new URL(url);
	const { amzDate, dateStamp } = amzDates(now);
	const payloadHash = givenHash ?? sha256(body);
	/** @type {Record<string, string>} */
	const all = {
		host: target.host,
		...headers,
		...(contentSha256Header ? { 'x-amz-content-sha256': payloadHash } : {}),
		'x-amz-date': amzDate,
	};
	if (sessionToken) all['x-amz-security-token'] = sessionToken;
	const { text, signedHeaders } = canonicalRequest({
		method,
		path: target.pathname,
		query: [...target.searchParams],
		headers: all,
		payloadHash,
	});
	const { scope, signature } = sign({ secretAccessKey, amzDate, dateStamp, region, service, canonical: text });
	const rest = Object.fromEntries(Object.entries(all).filter(([name]) => name.toLowerCase() !== 'host'));
	return {
		...rest,
		authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
};

/**
 * Presign a URL (query-string authentication, `UNSIGNED-PAYLOAD`).
 * @param {PresignV4Params} params
 * @returns {string}
 */
export const presignV4 = (params) => {
	requireCredentials(/** @type {any} */ (params));
	const {
		method,
		url,
		region,
		service = 's3',
		accessKeyId,
		secretAccessKey,
		sessionToken,
		now = Date.now(),
		expiresIn,
		headers = {},
		query = {},
	} = params;
	if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_PRESIGN_SECONDS)
		throw new RangeError(`expiresIn must be 1..${MAX_PRESIGN_SECONDS} seconds`);
	const target = new URL(url);
	const { amzDate, dateStamp } = amzDates(now);
	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const allHeaders = { host: target.host, ...headers };
	/** @type {Array<[string, string]>} */
	const pairs = [
		...target.searchParams,
		...Object.entries(query).map(([k, v]) => /** @type {[string, string]} */ ([k, String(v)])),
		['X-Amz-Algorithm', ALGORITHM],
		['X-Amz-Credential', `${accessKeyId}/${scope}`],
		['X-Amz-Date', amzDate],
		['X-Amz-Expires', String(expiresIn)],
		['X-Amz-SignedHeaders', normaliseHeaders(allHeaders).names.join(';')],
	];
	if (sessionToken) pairs.push(['X-Amz-Security-Token', sessionToken]);
	const { text } = canonicalRequest({
		method,
		path: target.pathname,
		query: pairs,
		headers: allHeaders,
		payloadHash: UNSIGNED_PAYLOAD,
	});
	const { signature } = sign({ secretAccessKey, amzDate, dateStamp, region, service, canonical: text });
	return `${target.origin}${target.pathname}?${canonicalQuery([...pairs, ['X-Amz-Signature', signature]])}`;
};

/**
 * URL of an S3 object: virtual-hosted or path style; AWS S3 by region when no endpoint is given. Path style is the
 * default with a custom endpoint, virtual-hosted style for AWS.
 * @param {{ endpoint?: string, region: string, bucket: string, forcePathStyle?: boolean }} store
 * @param {string} key object key (unencoded)
 * @returns {string}
 */
export const objectUrl = ({ endpoint, region, bucket, forcePathStyle }, key) => {
	const encoded = uriEncode(key, true);
	const pathStyle = forcePathStyle ?? endpoint !== undefined;
	if (endpoint) {
		const e = new URL(endpoint);
		return pathStyle ? `${e.origin}/${uriEncode(bucket)}/${encoded}` : `${e.protocol}//${bucket}.${e.host}/${encoded}`;
	}
	return pathStyle
		? `https://s3.${region}.amazonaws.com/${uriEncode(bucket)}/${encoded}`
		: `https://${bucket}.s3.${region}.amazonaws.com/${encoded}`;
};
