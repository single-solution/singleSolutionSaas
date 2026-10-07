'use client';
/** "Request in the Portal": POST /v1/dashboard/issuer:register with the dashboard session; the merchant approves it. */
import { createElement as h, useState } from 'react';
import { Button, Callout } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function RegisterIssuer({ websiteId }) {
	const [status, setStatus] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	const [busy, setBusy] = useState(false);
	const submit = async () => {
		setBusy(true);
		const response = await fetch('/v1/dashboard/issuer:register', {
			method: 'POST',
			headers: { 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
		});
		const body = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) {
			setStatus({
				tone: 'success',
				text: t(body.status === 'active' ? 'dashboard.identity.registered' : 'dashboard.identity.pending'),
			});
			globalThis.location.reload();
		} else setStatus({ tone: 'danger', text: body.detail ?? body.title ?? String(response.status) });
	};
	return h(
		'div',
		{ className: 'mt-4 space-y-3' },
		h(Button, { type: 'button', loading: busy, onClick: submit }, t('dashboard.identity.request')),
		status ? h(Callout, { tone: status.tone }, status.text) : null,
	);
}
