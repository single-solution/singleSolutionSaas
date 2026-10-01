/**
 * Minimal AWS Signature Version 4 header signing (pure, `node:crypto` HMAC only) for the storage connection check.
 * It mirrors `@ss/app-kit` `connectors/sigv4.js` `signHeaders` (the Portal does not depend on app-kit); the two
 * should move to a shared package.
 * @module
 */
import { createHash, createHmac } from 'node:crypto';

/** @typedef {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string }} Credentials */

/**
 * RFC 3986 encoding as S3 expects it (`/` kept when `keepSlash`).
 * @param {string} value
 * @param {boolean} [keepSlash]
 */
export const uriEncode = (value, keepSlash = false) => {
	const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
};

/** @param {string | Buffer} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/**
 * @param {string | Buffer} key
 * @param {string} data
 */
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/**
 * Sign a request with the `Authorization` header.
 * @param {{ method: string, url: string, credentials: Credentials, region: string, service?: string, now: number,
 *   headers?: Record<string, string>, body?: string | Buffer }} params
 * @returns {Record<string, string>} headers to send (without `host`)
 */
export const signHeaders = ({ method, url, credentials, region, service = 's3', now, headers = {}, body = '' }) => {
	const target = new URL(url);
	const amzDate = new Date(now)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
	const dateStamp = amzDate.slice(0, 8);
	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const payloadHash = sha256(body);
	/** @type {Record<string, string>} */
	const all = { host: target.host, ...headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
	if (credentials.sessionToken) all['x-amz-security-token'] = credentials.sessionToken;
	const lower = Object.fromEntries(
		Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]),
	);
	const names = Object.keys(lower).sort();
	const signedHeaders = names.join(';');
	const query = [...target.searchParams]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
		.join('&');
	const canonical = [
		method,
		target.pathname,
		query,
		names.map((name) => `${name}:${lower[name]}\n`).join(''),
		signedHeaders,
		payloadHash,
	].join('\n');
	const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
	const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), region), service), 'aws4_request');
	const signature = createHmac('sha256', key).update(toSign).digest('hex');
	const rest = Object.fromEntries(Object.entries(all).filter(([name]) => name !== 'host'));
	return {
		...rest,
		authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
};

/**
 * URL of an object (virtual-hosted or path style; AWS S3 by region when no endpoint is given).
 * @param {{ endpoint?: string, region: string, bucket: string, forcePathStyle?: boolean }} store
 * @param {string} key object key (unencoded)
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
