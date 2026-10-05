/**
 * Compatibility wrappers over `@ss/net` SigV4 (`signV4` / `presignV4`), kept for the published app-kit API
 * (`presignUrl`, `signHeaders` with a `credentials` object). New code should import from `@ss/net` directly.
 * @module
 */
import { amzDates, presignV4, signV4, uriEncode } from '@ss/net';

export { amzDates, uriEncode };

/** @typedef {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string }} Credentials */

/**
 * Presign a URL (query-string authentication).
 * @param {{
 *   method: string, url: string, credentials: Credentials, region: string, service?: string, now: number,
 *   expiresIn: number, headers?: Record<string, string>, query?: Record<string, string>,
 * }} params `url` must already contain the URI-encoded path; `headers` (besides host) become signed headers the
 *   client must send verbatim (e.g. `content-type`).
 * @returns {string}
 */
export const presignUrl = ({ credentials, ...rest }) => presignV4({ ...rest, ...credentials });

/**
 * Sign a request with the `Authorization` header.
 * @param {{
 *   method: string, url: string, credentials: Credentials, region: string, service?: string, now: number,
 *   headers?: Record<string, string>, body?: string | Buffer,
 * }} params
 * @returns {Record<string, string>} headers to send (including `authorization`, `x-amz-date`, `x-amz-content-sha256`)
 */
export const signHeaders = ({ credentials, ...rest }) => signV4({ ...rest, ...credentials });
