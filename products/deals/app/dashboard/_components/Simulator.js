'use client';
/** Quote a sample cart against the live deals (POST /v1/dashboard/quotes:preview — nothing stored, nothing metered). */
import { createElement as h, useState } from 'react';
import { Button, Callout, CodeBlock, TextArea } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

const EXAMPLE = JSON.stringify(
	{
		currency: 'EUR',
		lines: [
			{ itemId: 'itm_runner', quantity: 1, unitAmount: 8900, collections: ['shoes'] },
			{ itemId: 'itm_socks', quantity: 3, unitAmount: 900, collections: ['socks'] },
		],
		paymentMethod: 'card',
		shippingAmount: 495,
	},
	null,
	2,
);

/** @param {{ websiteId: string | null, sample?: unknown }} props */
export function Simulator({ websiteId, sample = null }) {
	const [source, setSource] = useState(EXAMPLE);
	const [result, setResult] = useState(/** @type {unknown} */ (sample));
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const [busy, setBusy] = useState(false);
	/** @param {{ preventDefault: () => void }} event */
	const submit = async (event) => {
		event.preventDefault();
		if (!websiteId) return;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch('/v1/dashboard/quotes:preview', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-ss-website': websiteId },
				body: JSON.stringify(JSON.parse(source)),
			});
			const body = await response.json();
			if (response.ok) setResult(body);
			else
				setError(
					[body.detail ?? body.title, ...(body.errors ?? []).map((/** @type {any} */ e) => `${e.path} ${e.code}`)].join(
						' · ',
					),
				);
		} catch (failure) {
			setError(String(/** @type {Error} */ (failure).message));
		}
		setBusy(false);
	};
	return h(
		'form',
		{ onSubmit: submit, className: 'space-y-3' },
		h('p', { className: 'text-sm text-muted' }, t('dashboard.simulator.intro')),
		h(TextArea, {
			label: t('dashboard.simulator.cart'),
			value: source,
			rows: 12,
			spellCheck: false,
			className: 'font-mono',
			onChange: (/** @type {{ target: { value: string } }} */ e) => setSource(e.target.value),
		}),
		h(Button, { type: 'submit', loading: busy, disabled: !websiteId }, t('dashboard.simulator.run')),
		error ? h(Callout, { tone: 'danger' }, error) : null,
		result ? h(CodeBlock, { code: JSON.stringify(result, null, 2), label: 'JSON' }) : null,
	);
}
