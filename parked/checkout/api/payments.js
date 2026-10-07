/**
 * Payments after placement: bank-transfer proofs (to the merchant's own storage) and the payment gateway preview (the
 * merchant's own gateway through app-kit's payments connector). Proof files never pass through this product: the
 * shopper's browser PUTs them to a presigned URL whose content type and exact length are signed, and completion checks
 * the object really exists with that size.
 */
import { checkProofUpload, paymentStatusOf, safeReturnUrl } from '../core/gateway.js';

/** @typedef {import('./context.js').Site} Site */
/** @typedef {import('./context.js').Checkout} Checkout */
/** @typedef {import('./carts.js').Requester} Requester */

/**
 * @param {Checkout} checkout
 * @param {import('./orders.js').OrdersService} orders
 */
export const createPaymentsService = (checkout, orders) => {
	const { app, product } = checkout;
	const iso = () => new Date(app.now()).toISOString();

	/** Methods the website offers (no availability: that depends on the checkout, see POST /v1/quotes). @param {Site} site */
	const methods = (site) => {
		const { manual } = site.settings;
		const on = site.settings.enabled('payment_manual');
		return {
			methods: [
				...(on && manual.bank_transfer_enabled ? [{ key: 'bank_transfer', kind: 'manual' }] : []),
				...(on && manual.cod_enabled
					? [
							{
								key: 'cod',
								kind: 'manual',
								surchargeBp: manual.cod_surcharge_bp,
								surchargeFlat: manual.cod_surcharge_flat,
								maxOrder: manual.cod_max_order,
							},
						]
					: []),
				...(on && manual.pickup_pay_enabled ? [{ key: 'pickup_pay', kind: 'manual' }] : []),
				...(site.settings.enabled('payment_gateway') ? [{ key: 'gateway', kind: 'gateway', preview: true }] : []),
			],
			bankDetails: on && manual.bank_transfer_enabled ? manual.bank_details : [],
		};
	};

	/** @param {Record<string, any>} order */
	const takesProof = (order) =>
		order.status === 'pending_payment' &&
		order.payment.status !== 'paid' &&
		(order.payment.method === 'bank_transfer' || (order.payment.method === 'cod' && order.payment.advance > 0));

	/**
	 * Start a proof upload: a presigned PUT into the merchant's storage.
	 * @param {Site} site
	 * @param {Record<string, any>} body `{ orderId, token?, contentType, size, reference? }`
	 * @param {Requester} who
	 */
	const startProof = async (site, body, who) => {
		const order = await orders.access(site, body?.orderId, who, body?.token);
		if (!order) return { ok: false, code: 'order_not_found' };
		if (!takesProof(order)) return { ok: false, code: 'order_state' };
		const { proofs } = site.settings;
		const checked = checkProofUpload(body, { contentTypes: proofs.content_types, maxBytes: proofs.max_bytes });
		if (!checked.ok) return { ok: false, code: 'validation_failed', errors: [{ path: checked.path, code: checked.code }] };
		if (proofs.reference_required && !checked.reference)
			return { ok: false, code: 'validation_failed', errors: [{ path: '/reference', code: 'required' }] };
		if ((order.proofs ?? []).length >= proofs.max_proofs_per_order) return { ok: false, code: 'proof_limit' };
		const id = app.randomId('prf');
		const key = `payment-proofs/${order.id}/${id}.${checked.extension}`;
		const storage = await product.connectors.storage(site.websiteId);
		const upload = await storage.presignPut({
			key,
			contentType: checked.contentType,
			contentLength: checked.size,
			expiresIn: proofs.upload_expiry_seconds,
		});
		const moved = await site.repos.orders.transition(order.id, ['pending_payment'], {
			push: {
				proofs: {
					id,
					key,
					contentType: checked.contentType,
					size: checked.size,
					reference: checked.reference,
					status: 'pending',
					createdAt: iso(),
				},
			},
		});
		if (!moved) return { ok: false, code: 'order_state' };
		return {
			ok: true,
			value: {
				proofId: id,
				upload: { method: upload.method, url: upload.url, headers: upload.headers, expiresAt: upload.expiresAt },
			},
		};
	};

	/**
	 * Complete a proof upload once the file is in the bucket with the signed size.
	 * @param {Site} site
	 * @param {string} proofId
	 * @param {Record<string, any>} body `{ orderId, token? }`
	 * @param {Requester} who
	 */
	const completeProof = async (site, proofId, body, who) => {
		const order = await orders.access(site, body?.orderId, who, body?.token);
		if (!order) return { ok: false, code: 'order_not_found' };
		const proof = (order.proofs ?? []).find((/** @type {any} */ entry) => entry.id === proofId);
		if (!proof) return { ok: false, code: 'not_found' };
		if (proof.status === 'submitted') return { ok: true, value: { proofId, status: 'submitted' } };
		const storage = await product.connectors.storage(site.websiteId);
		const head = await storage.headObject({ key: proof.key });
		if (!head.exists || head.size !== proof.size) return { ok: false, code: 'proof_not_uploaded' };
		const submittedAt = iso();
		const moved = await site.repos.orders.transition(order.id, ['pending_payment', 'confirmed', 'cancelled'], {
			filter: { proofs: { $elemMatch: { id: proofId, status: 'pending' } } },
			set: { 'proofs.$[proof].status': 'submitted', 'proofs.$[proof].submittedAt': submittedAt },
			push: { timeline: { status: order.status, at: submittedAt, actor: { type: 'customer' }, reason: 'payment_proof' } },
			arrayFilters: [{ 'proof.id': proofId }],
		});
		if (!moved) return { ok: true, value: { proofId, status: 'submitted' } };
		await checkout.publish(
			site,
			'checkout.payment_proof_submitted@1',
			{
				orderId: order.id,
				number: order.number,
				proofId,
				method: order.payment.method === 'cod' ? 'cod' : 'bank_transfer',
				amount: { amount: order.payment.dueNow, currency: order.currency },
				...(proof.reference ? { reference: proof.reference } : {}),
			},
			`${order.id}:proof:${proofId}`,
		);
		return { ok: true, value: { proofId, status: 'submitted' } };
	};

	/**
	 * A short-lived link to open a proof (merchant only).
	 * @param {Site} site
	 * @param {string} orderId
	 * @param {string} proofId
	 */
	const proofLink = async (site, orderId, proofId) => {
		const order = await site.repos.orders.get(orderId);
		const proof = (order?.proofs ?? []).find(
			(/** @type {any} */ entry) => entry.id === proofId && entry.status === 'submitted',
		);
		if (!proof) return null;
		const storage = await product.connectors.storage(site.websiteId);
		const link = await storage.presignGet({ key: proof.key, expiresIn: 300 });
		return {
			proofId,
			url: link.url,
			expiresAt: link.expiresAt,
			contentType: proof.contentType,
			reference: proof.reference ?? null,
		};
	};

	/**
	 * Start an online payment for an unpaid order.
	 * @param {Site} site
	 * @param {Record<string, any>} body `{ orderId, token?, returnUrl }`
	 * @param {Requester} who
	 * @param {{ domain: string, allowSubdomains: boolean }} website
	 */
	const startPayment = async (site, body, who, website) => {
		const order = await orders.access(site, body?.orderId, who, body?.token);
		if (!order) return { ok: false, code: 'order_not_found' };
		if (order.payment.kind !== 'gateway' || order.status !== 'pending_payment' || order.payment.status === 'paid')
			return { ok: false, code: 'order_state' };
		const returnUrl = safeReturnUrl(body?.returnUrl, website);
		if (!returnUrl) return { ok: false, code: 'return_url_invalid' };
		const attempts = (order.payments ?? []).filter((/** @type {any} */ p) => p.kind === 'attempt').length;
		if (attempts >= site.settings.gateway.max_attempts) return { ok: false, code: 'rate_limited' };
		const gateway = await product.connectors.payments(site.websiteId);
		const created = await gateway.createPayment({
			amount: order.payment.dueNow,
			currency: order.currency,
			reference: order.number,
			idempotencyKey: `${order.id}:payment:${attempts + 1}`,
			returnUrl,
			metadata: { orderId: order.id },
		});
		const status = paymentStatusOf(created.status);
		await site.repos.orders.transition(order.id, ['pending_payment'], {
			push: {
				payments: {
					kind: 'attempt',
					method: 'gateway',
					provider: gateway.provider,
					paymentId: created.id,
					amount: order.payment.dueNow,
					status,
					at: iso(),
				},
			},
		});
		await product.usage.record({
			websiteId: site.websiteId,
			unit: 'payment',
			quantity: 1,
			idempotencyKey: `${order.id}:payment:${attempts + 1}`,
		});
		if (status === 'paid') await settle(site, order.id, created.id, order.payment.dueNow);
		return { ok: true, value: { paymentId: created.id, status, redirectUrl: created.redirectUrl ?? null } };
	};

	/**
	 * A provider says the payment succeeded: record it (once) and confirm the order.
	 * @param {Site} site
	 * @param {string} orderId
	 * @param {string} paymentId
	 * @param {number} amount
	 */
	const settle = async (site, orderId, paymentId, amount) => {
		const order = await site.repos.orders.get(orderId);
		if (!order) return null;
		return orders.recordPayment(site, order, {
			amount,
			method: 'gateway',
			reference: paymentId,
			actor: { type: 'gateway' },
			publish: true,
		});
	};

	/**
	 * Ask the provider for a payment's status (return page, polling-free: one call per shopper action).
	 * @param {Site} site
	 * @param {string} paymentId
	 * @param {Record<string, any>} body `{ orderId, token? }`
	 * @param {Requester} who
	 */
	const refreshPayment = async (site, paymentId, body, who) => {
		const order = await orders.access(site, body?.orderId, who, body?.token);
		const attempt = (order?.payments ?? []).find((/** @type {any} */ p) => p.kind === 'attempt' && p.paymentId === paymentId);
		if (!order || !attempt) return { ok: false, code: 'not_found' };
		const gateway = await product.connectors.payments(site.websiteId);
		const status = paymentStatusOf((await gateway.status({ id: paymentId })).status);
		if (status === 'paid') await settle(site, order.id, paymentId, attempt.amount);
		return { ok: true, value: { paymentId, status } };
	};

	/**
	 * Provider webhook: verified by the adapter with the merchant's own webhook secret.
	 * @param {Site} site
	 * @param {{ headers: Headers, rawBody: string }} request
	 */
	const webhook = async (site, { headers, rawBody }) => {
		const gateway = await product.connectors.payments(site.websiteId);
		const verified = await gateway.verifyWebhook({ headers, rawBody });
		if (!verified.ok || !verified.event) return { ok: false, code: 'unauthorized' };
		const paymentId = String(verified.event.paymentId ?? '');
		const status = paymentStatusOf(verified.event.status);
		const orderId = String(verified.event.orderId ?? '');
		if (status !== 'paid' || !paymentId) return { ok: true, value: { received: true } };
		const order = orderId ? await site.repos.orders.get(orderId) : null;
		const attempt = (order?.payments ?? []).find((/** @type {any} */ p) => p.kind === 'attempt' && p.paymentId === paymentId);
		if (order && attempt) await settle(site, order.id, paymentId, attempt.amount);
		return { ok: true, value: { received: true } };
	};

	return Object.freeze({ methods, startProof, completeProof, proofLink, startPayment, refreshPayment, webhook });
};

/** @typedef {ReturnType<typeof createPaymentsService>} PaymentsService */
