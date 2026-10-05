'use client';
/** A dashboard action (POST to a dashboard route with the session cookie and an Idempotency-Key; audited server-side). */
import { createElement as h, useState } from 'react';
import { Button } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ path: string, label: string, websiteId: string }} props */
export function ActionButton({ path, label, websiteId }) {
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState(/** @type {string | null} */ (null));
	const run = async () => {
		setBusy(true);
		const response = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: '{}',
		}).catch(() => null);
		const json = response ? await response.json().catch(() => ({})) : {};
		setBusy(false);
		if (response?.ok) {
			setMessage(t('dashboard.action.done'));
			globalThis.location?.reload();
		} else setMessage(json.detail ?? json.title ?? t('dashboard.action.failed'));
	};
	return h(
		'span',
		{ className: 'inline-flex items-center gap-2' },
		h(Button, { type: 'button', variant: 'secondary', loading: busy, onClick: run }, label),
		message ? h('span', { role: 'status', className: 'text-sm text-muted' }, message) : null,
	);
}
