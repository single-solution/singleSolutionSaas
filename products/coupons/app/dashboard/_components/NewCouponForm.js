'use client';
/** Create a percent coupon (POST /v1/dashboard/coupons with the dashboard session; audited). */
import { createElement as h, useState } from 'react';
import { Button, Callout, Input } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function NewCouponForm({ websiteId }) {
	const [name, setName] = useState('');
	const [code, setCode] = useState('');
	const [count, setCount] = useState('');
	const [percent, setPercent] = useState('10');
	const [total, setTotal] = useState('');
	const [status, setStatus] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	const [busy, setBusy] = useState(false);
	/** @param {{ preventDefault: () => void }} event */
	const submit = async (event) => {
		event.preventDefault();
		setBusy(true);
		const body = {
			name,
			action: { type: 'percent', percent: Number(percent), target: 'order' },
			...(code ? { code } : {}),
			...(count ? { count: Number(count) } : {}),
			...(total ? { limits: { total: Number(total) } } : {}),
		};
		const response = await fetch('/v1/dashboard/coupons', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify(body),
		});
		const result = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) {
			setStatus({ tone: 'success', text: t('dashboard.coupons.created') });
			globalThis.location.reload();
		} else
			setStatus({
				tone: 'danger',
				text:
					result.errors?.map((/** @type {{ path: string, message: string }} */ e) => `${e.path}: ${e.message}`).join(', ') ||
					result.detail ||
					result.title ||
					String(response.status),
			});
	};
	const field = (
		/** @type {string} */ label,
		/** @type {string} */ value,
		/** @type {(v: string) => void} */ set,
		/** @type {Record<string, unknown>} */ extra = {},
	) => h(Input, { label, value, onChange: (/** @type {any} */ e) => set(e.target.value), ...extra });
	return h(
		'form',
		{ onSubmit: submit, className: 'grid gap-3 sm:grid-cols-2' },
		field(t('dashboard.coupons.name'), name, setName, { required: true, maxLength: 120 }),
		field(t('dashboard.coupons.code'), code, setCode, { maxLength: 64 }),
		field(t('dashboard.coupons.count'), count, setCount, { type: 'number', min: 1, disabled: code.length > 0 }),
		field(t('dashboard.coupons.percent'), percent, setPercent, { type: 'number', min: 1, max: 100, required: true }),
		field(t('dashboard.coupons.total'), total, setTotal, { type: 'number', min: 1 }),
		h('div', { className: 'sm:col-span-2' }, h(Button, { type: 'submit', loading: busy }, t('dashboard.coupons.create'))),
		status ? h('div', { className: 'sm:col-span-2' }, h(Callout, { tone: status.tone }, status.text)) : null,
	);
}
