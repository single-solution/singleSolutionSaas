/**
 * Payment gateway (preview) and bank-transfer proofs (pure).
 *
 * The gateway is a provider-adapter interface (app-kit `connectors.payments`: `createPayment`, `capture`, `refund`,
 * `status`, `verifyWebhook`) executed with the merchant's own gateway credentials; this module only maps provider
 * statuses to Checkout's and checks the return address. Proofs are images or PDFs uploaded straight to the merchant's
 * own storage with a presigned PUT whose content type and exact length are signed.
 * @module
 */
import { cleanText } from './text.js';

/** Provider statuses → Checkout payment statuses. */
const STATUS = Object.freeze({
	succeeded: 'paid',
	paid: 'paid',
	captured: 'paid',
	authorized: 'authorized',
	requires_capture: 'authorized',
	pending: 'pending',
	processing: 'pending',
	requires_action: 'pending',
	requires_payment_method: 'pending',
	failed: 'failed',
	canceled: 'failed',
	cancelled: 'failed',
	refunded: 'refunded',
});

/**
 * @param {unknown} status provider status
 * @returns {'paid' | 'authorized' | 'pending' | 'failed' | 'refunded'}
 */
export const paymentStatusOf = (status) =>
	typeof status === 'string' && Object.hasOwn(STATUS, status) ? /** @type {any} */ (STATUS)[status] : 'pending';

/**
 * A return URL the gateway may send the shopper back to: https on the website's own domain (or a subdomain when the
 * website allows them). Anything else is refused (no open redirects).
 * @param {unknown} value
 * @param {{ domain: string, allowSubdomains: boolean }} website
 */
export const safeReturnUrl = (value, { domain, allowSubdomains }) => {
	if (typeof value !== 'string' || value.length > 2048) return null;
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		const ok =
			url.protocol === 'https:' &&
			!url.username &&
			!url.password &&
			(host === domain || (allowSubdomains && host.endsWith(`.${domain}`)));
		return ok ? url.href : null;
	} catch {
		return null;
	}
};

/** Extensions of the proof content types. */
const EXTENSIONS = Object.freeze({
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/heic': 'heic',
	'application/pdf': 'pdf',
});

/**
 * Validate a proof upload request.
 * @param {unknown} body
 * @param {{ contentTypes: string[], maxBytes: number }} rules
 * @returns {{ ok: true, contentType: string, size: number, extension: string, reference: string | null } | { ok: false, path: string, code: string }}
 */
export const checkProofUpload = (body, rules) => {
	const input = /** @type {Record<string, any>} */ (body ?? {});
	const contentType = typeof input.contentType === 'string' ? input.contentType.toLowerCase() : '';
	if (!rules.contentTypes.includes(contentType) || !Object.hasOwn(EXTENSIONS, contentType))
		return { ok: false, path: '/contentType', code: 'content_type_unsupported' };
	if (!Number.isSafeInteger(input.size) || input.size < 1) return { ok: false, path: '/size', code: 'size_invalid' };
	if (input.size > rules.maxBytes) return { ok: false, path: '/size', code: 'too_large' };
	if (input.reference !== undefined && (typeof input.reference !== 'string' || input.reference.length > 120))
		return { ok: false, path: '/reference', code: 'reference_invalid' };
	return {
		ok: true,
		contentType,
		size: input.size,
		extension: /** @type {any} */ (EXTENSIONS)[contentType],
		reference: cleanText(input.reference, 120),
	};
};
