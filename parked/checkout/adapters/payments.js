/**
 * Payment-gateway adapters (preview). The interface is app-kit's payments connector (`connectors.payments(websiteId)` →
 * `{ provider, createPayment, capture, refund, status, verifyWebhook }`), resolved with the merchant's own gateway
 * credentials (the Portal `payments` connector: `{ provider, credentials }`). Clients bring their own payment keys;
 * Checkout never holds platform provider keys.
 *
 * Only the `test` provider ships: it moves no money and calls nothing. Credentials: `mode` (`succeed` | `fail` |
 * `action`, default `action` — the shopper is "redirected" and the payment then succeeds) and `webhookSecret` (HMAC-SHA256
 * of the raw body in `x-test-signature`). Real providers are adapters with the same five methods, added here through
 * `ADAPTERS`, making their HTTP calls with the context's SSRF-guarded `send`.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * @param {{ descriptor: Record<string, any> }} context app-kit adapter context
 */
export const createTestGateway = ({ descriptor }) => {
	const credentials = /** @type {Record<string, string>} */ (descriptor?.credentials ?? {});
	const mode = ['succeed', 'fail', 'action'].includes(credentials.mode ?? '') ? credentials.mode : 'action';
	const secret = credentials.webhookSecret ?? '';
	/** @param {string} key */
	const idFor = (key) => `tpay_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
	const settled = mode === 'fail' ? 'failed' : 'succeeded';
	return Object.freeze({
		provider: 'test',
		/** @param {{ amount: number, currency: string, reference: string, idempotencyKey: string, returnUrl?: string }} input */
		createPayment: async (input) => {
			const id = idFor(input.idempotencyKey);
			if (mode !== 'action') return { id, status: settled };
			const redirect = input.returnUrl ? new URL(input.returnUrl) : null;
			redirect?.searchParams.set('payment', id);
			return { id, status: 'requires_action', ...(redirect ? { redirectUrl: redirect.href } : {}) };
		},
		/** @param {{ id: string }} input */
		capture: async ({ id }) => ({ id, status: settled }),
		/** @param {{ id: string }} input */
		refund: async ({ id }) => ({ id, status: 'refunded' }),
		/** @param {{ id: string }} input */
		status: async ({ id }) => ({ id, status: settled }),
		/** @param {{ headers: Headers | Record<string, string>, rawBody: string }} input */
		verifyWebhook: async ({ headers, rawBody }) => {
			const given =
				typeof (/** @type {any} */ (headers).get) === 'function'
					? /** @type {Headers} */ (headers).get('x-test-signature')
					: /** @type {Record<string, string>} */ (headers)['x-test-signature'];
			if (!secret || typeof given !== 'string') return { ok: false };
			const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
			if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected)))
				return { ok: false };
			try {
				const event = JSON.parse(rawBody);
				return {
					ok: true,
					event: {
						paymentId: String(event.paymentId ?? ''),
						orderId: String(event.orderId ?? ''),
						status: String(event.status ?? ''),
					},
				};
			} catch {
				return { ok: false };
			}
		},
	});
};

/** Payment adapters by provider (app-kit `createProduct({ connectors: { payments: ADAPTERS } })`). */
export const ADAPTERS = Object.freeze({ test: createTestGateway });
