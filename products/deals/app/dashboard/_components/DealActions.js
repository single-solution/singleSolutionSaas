'use client';
/** Pause / resume a deal (POST /v1/dashboard/deals/{id}/status with the dashboard session; audited). */
import { createElement as h, useState } from 'react';
import { Button, Callout } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ dealId: string, websiteId: string, status: string }} props */
export function DealActions({ dealId, websiteId, status }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const next = status === 'active' ? 'paused' : 'active';
	const submit = async () => {
		setBusy(true);
		const response = await fetch(`/v1/dashboard/deals/${encodeURIComponent(dealId)}/status`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify({ status: next }),
		});
		const body = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) globalThis.location.reload();
		else setError(body.detail ?? body.title ?? String(response.status));
	};
	return h(
		'div',
		{ className: 'flex flex-wrap items-center gap-3' },
		h(
			Button,
			{ type: 'button', variant: 'secondary', loading: busy, onClick: submit },
			t(next === 'paused' ? 'dashboard.deals.pause' : 'dashboard.deals.resume'),
		),
		error ? h(Callout, { tone: 'danger' }, error) : null,
	);
}
