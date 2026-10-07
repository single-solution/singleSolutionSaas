'use client';
/**
 * "Process expired now" (POST /v1/dashboard/expiry:run): cancels this website's expired holds and publishes the due
 * abandoned-cart events right away, for merchants who do not want to wait for the next read. Nothing runs on a timer.
 */
import { createElement as h, useState } from 'react';
import { Button, Callout } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function ExpiryRun({ websiteId }) {
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	const run = async () => {
		setBusy(true);
		const response = await fetch('/v1/dashboard/expiry:run', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: '{}',
		});
		const json = await response.json().catch(() => ({}));
		setBusy(false);
		setStatus(
			response.ok
				? {
						tone: 'success',
						text: t(json.more ? 'dashboard.expiry.done_more' : 'dashboard.expiry.done', {
							expired: String(json.expired),
							abandoned: String(json.abandoned),
						}),
					}
				: { tone: 'danger', text: String(json.title ?? response.status) },
		);
	};
	return h(
		'div',
		{ className: 'space-y-2' },
		h('p', { className: 'text-sm text-muted' }, t('dashboard.expiry.help')),
		h(Button, { onClick: run, disabled: busy }, t('dashboard.expiry.run')),
		status ? h(Callout, { tone: status.tone }, status.text) : null,
	);
}
