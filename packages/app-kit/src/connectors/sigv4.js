/**
 * AWS Signature Version 4 for S3-compatible object stores (AWS S3, Cloudflare R2, MinIO, GCS interoperability),
 * implemented with `node:crypto` HMAC-SHA-256 only — no SDK dependency. Supports query-string presigning (browser
 * uploads/downloads straight to the merchant's bucket) and header signing (server-side calls).
 * @module
 */
import { createHash, createHmac } from 'node:crypto';

/** @typedef {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string }} Credentials */

/**
 * RFC 3986 encoding as S3 expects it (`/` kept when `keepSlash`).
 * @param {string} value
 * @param {boolean} [keepSlash]
 * @returns {string}
 */
export const uriEncode = (value, keepSlash = false) => {
	const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
};

/** @param {string | Buffer} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** @param {string | Buffer} key @param {string} data */
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/**
 * `20130524T000000Z` and `20130524` for an instant.
 * @param {number} ms
 */
export const amzDates = (ms) => {
	const iso = new Date(ms)
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
 * @param {Record<string, string>} query
 * @returns {string}
 */
const canonicalQuery = (query) =>
	Object.keys(query)
		.sort()
		.map((key) => `${uriEncode(key)}=${uriEncode(String(query[key]))}`)
		.join('&');

/**
 * @param {{ method: string, path: string, query: Record<string, string>, headers: Record<string, string>, payloadHash: string }} request
 */
const canonicalRequest = ({ method, path, query, headers, payloadHash }) => {
	const names = Object.keys(headers)
		.map((name) => name.toLowerCase())
		.sort();
	const lower = Object.fromEntries(
		Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]),
	);
	const canonicalHeaders = names.map((name) => `${name}:${lower[name]}\n`).join('');
	const signedHeaders = names.join(';');
	return {
		signedHeaders,
		text: [method, path, canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash].join('\n'),
	};
};

/**
 * Presign a URL (query-string authentication).
 * @param {{
 *   method: string, url: string, credentials: Credentials, region: string, service?: string, now: number,
 *   expiresIn: number, headers?: Record<string, string>, query?: Record<string, string>,
 * }} params `url` must already contain the URI-encoded path; `headers` (besides host) become signed headers the
 *   client must send verbatim (e.g. `content-type`).
 * @returns {string}
 */
export const presignUrl = ({ method, url, credentials, region, service = 's3', now, expiresIn, headers = {}, query = {} }) => {
	if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604_800)
		throw new RangeError('expiresIn must be 1..604800 seconds');
	const target = new URL(url);
	const { amzDate, dateStamp } = amzDates(now);
	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const allHeaders = { host: target.host, ...headers };
	const signedHeaderNames = Object.keys(allHeaders)
		.map((name) => name.toLowerCase())
		.sort()
		.join(';');
	/** @type {Record<string, string>} */
	const q = {
		...query,
		'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
		'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
		'X-Amz-Date': amzDate,
		'X-Amz-Expires': String(expiresIn),
		'X-Amz-SignedHeaders': signedHeaderNames,
	};
	if (credentials.sessionToken) q['X-Amz-Security-Token'] = credentials.sessionToken;
	const { text } = canonicalRequest({
		method,
		path: target.pathname,
		query: q,
		headers: allHeaders,
		payloadHash: 'UNSIGNED-PAYLOAD',
	});
	const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(text)].join('\n');
	const signature = createHmac('sha256', signingKey(credentials.secretAccessKey, dateStamp, region, service))
		.update(toSign)
		.digest('hex');
	return `${target.origin}${target.pathname}?${canonicalQuery({ ...q, 'X-Amz-Signature': signature })}`;
};

/**
 * Sign a request with the `Authorization` header.
 * @param {{
 *   method: string, url: string, credentials: Credentials, region: string, service?: string, now: number,
 *   headers?: Record<string, string>, body?: string | Buffer,
 * }} params
 * @returns {Record<string, string>} headers to send (including `authorization`, `x-amz-date`, `x-amz-content-sha256`)
 */
export const signHeaders = ({ method, url, credentials, region, service = 's3', now, headers = {}, body = '' }) => {
	const target = new URL(url);
	const { amzDate, dateStamp } = amzDates(now);
	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const payloadHash = sha256(body);
	/** @type {Record<string, string>} */
	const all = { host: target.host, ...headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
	if (credentials.sessionToken) all['x-amz-security-token'] = credentials.sessionToken;
	/** @type {Record<string, string>} */
	const query = {};
	for (const [key, value] of target.searchParams) query[key] = value;
	const { text, signedHeaders } = canonicalRequest({ method, path: target.pathname, query, headers: all, payloadHash });
	const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(text)].join('\n');
	const signature = createHmac('sha256', signingKey(credentials.secretAccessKey, dateStamp, region, service))
		.update(toSign)
		.digest('hex');
	const rest = Object.fromEntries(Object.entries(all).filter(([name]) => name !== 'host'));
	return {
		...rest,
		authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
};
