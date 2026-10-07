'use client';
/** Order actions for write roles: confirm, cancel, record a payment, open a proof (dashboard API, audited). */
import { createElement as h, useState } from 'react';
import { Button, Callout, Card, Input } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string, orderId: string, status: string, proofs: Array<{ id: string }> }} props */
export function OrderActions({ websiteId, orderId, status, proofs }) {
	const [amount, setAmount] = useState('');
	const [reference, setReference] = useState('');
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const base = `/v1/dashboard/orders/${encodeURIComponent(orderId)}`;
	/** @param {string} method @param {string} path @param {unknown} [body] */
	const call = async (method, path, body) => {
		const response = await fetch(path, {
			method,
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const json = await response.json().catch(() => ({}));
		if (!response.ok) setError(String(json.title ?? response.status));
		return response.ok ? json : null;
	};
	const reload = () => globalThis.location.reload();
	const open = ['pending_payment', 'awaiting_confirmation'].includes(status);
	return h(
		Card,
		{ title: t('dashboard.order.record') },
		error ? h(Callout, { tone: 'danger' }, error) : null,
		h(
			'div',
			{ className: 'flex flex-wrap gap-2' },
			open
				? h(
						Button,
						{ onClick: async () => (await call('POST', `${base}/confirm`, {})) && reload() },
						t('dashboard.order.confirm'),
					)
				: null,
			status !== 'cancelled' && status !== 'completed' && status !== 'refunded'
				? h(
						Button,
						{ variant: 'danger', onClick: async () => (await call('POST', `${base}/cancel`, {})) && reload() },
						t('dashboard.order.cancel'),
					)
				: null,
			...proofs.map((proof) =>
				h(
					Button,
					{
						key: proof.id,
						variant: 'secondary',
						onClick: async () => {
							const link = await call('GET', `${base}/proofs/${encodeURIComponent(proof.id)}`);
							if (link?.url) globalThis.open(link.url, '_blank', 'noopener');
						},
					},
					t('dashboard.order.proof'),
				),
			),
		),
		h(
			'form',
			{
				className: 'mt-3 flex flex-wrap items-end gap-2',
				onSubmit: async (/** @type {{ preventDefault: () => void }} */ event) => {
					event.preventDefault();
					if ((await call('POST', `${base}/payments`, { amount: Number(amount), reference })) !== null) reload();
				},
			},
			h(Input, {
				label: t('dashboard.orders.total'),
				value: amount,
				inputMode: 'numeric',
				onChange: (/** @type {any} */ e) => setAmount(e.target.value),
			}),
			h(Input, {
				label: t('proofs.reference'),
				value: reference,
				onChange: (/** @type {any} */ e) => setReference(e.target.value),
			}),
			h(Button, { type: 'submit' }, t('dashboard.order.record')),
		),
	);
}
