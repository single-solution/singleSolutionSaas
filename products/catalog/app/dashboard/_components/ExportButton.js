'use client';
/**
 * Download the catalog CSV: asks for a short-lived signed link (POST /v1/dashboard/exports:link with the dashboard
 * session and the website), then opens it — the download itself needs no session or header.
 */
import { createElement as h, useState } from 'react';
import { Button } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function ExportButton({ websiteId }) {
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState(/** @type {string | null} */ (null));
	const download = async () => {
		setBusy(true);
		setMessage(null);
		const response = await fetch('/v1/dashboard/exports:link', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify({ params: {} }),
		}).catch(() => null);
		const json = response ? await response.json().catch(() => ({})) : {};
		setBusy(false);
		if (response?.ok && typeof json.url === 'string') globalThis.location.assign(json.url);
		else setMessage(json.detail ?? t('dashboard.export.failed'));
	};
	return h(
		'span',
		{ className: 'flex items-center gap-2' },
		h(Button, { type: 'button', loading: busy, variant: 'secondary', onClick: download }, t('dashboard.export.download')),
		message ? h('span', { role: 'status', className: 'text-sm text-muted' }, message) : null,
	);
}
