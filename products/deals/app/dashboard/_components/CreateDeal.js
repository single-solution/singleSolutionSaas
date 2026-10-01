'use client';
/** Create a deal from JSON (POST /v1/dashboard/deals; the same validation as POST /v1/deals). */
import { createElement as h, useState } from 'react';
import { Button, Callout, TextArea } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

const EXAMPLE = JSON.stringify(
	{
		kind: 'item',
		name: 'Weekday evenings: 15% off shoes',
		scope: { collections: ['shoes'] },
		action: { type: 'percent', percent: 15 },
		schedule: { windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '18:00', end: '02:00' }] },
	},
	null,
	2,
);

/** @param {{ websiteId: string }} props */
export function CreateDeal({ websiteId }) {
	const [source, setSource] = useState(EXAMPLE);
	const [status, setStatus] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	const [busy, setBusy] = useState(false);
	/** @param {{ preventDefault: () => void }} event */
	const submit = async (event) => {
		event.preventDefault();
		/** @type {unknown} */
		let body;
		try {
			body = JSON.parse(source);
		} catch (error) {
			setStatus({ tone: 'danger', text: String(/** @type {Error} */ (error).message) });
			return;
		}
		setBusy(true);
		const response = await fetch('/v1/dashboard/deals', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify(body),
		});
		const result = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) {
			setStatus({ tone: 'success', text: t('dashboard.deals.created') });
			globalThis.location.reload();
		} else
			setStatus({
				tone: 'danger',
				text: [
					result.detail ?? result.title ?? String(response.status),
					...(result.errors ?? []).map((/** @type {any} */ e) => `${e.path} ${e.code}`),
				].join(' · '),
			});
	};
	return h(
		'form',
		{ onSubmit: submit, className: 'space-y-3' },
		h(TextArea, {
			label: t('dashboard.deals.create'),
			value: source,
			rows: 12,
			spellCheck: false,
			className: 'font-mono',
			onChange: (/** @type {{ target: { value: string } }} */ event) => setSource(event.target.value),
		}),
		h(Button, { type: 'submit', loading: busy }, t('dashboard.deals.create.submit')),
		status ? h(Callout, { tone: status.tone }, status.text) : null,
	);
}
