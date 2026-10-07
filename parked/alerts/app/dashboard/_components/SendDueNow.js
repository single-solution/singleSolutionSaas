'use client';
/** "Send due now": runs the website's outbox (POST /v1/dashboard/messages:dispatch with the dashboard session). */
import { createElement as h, useState } from 'react';
import { Button, Callout } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function SendDueNow({ websiteId }) {
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	const run = async () => {
		setBusy(true);
		const response = await fetch('/v1/dashboard/messages:dispatch', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: '{}',
		});
		const json = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) {
			setNotice({
				tone: 'success',
				text: t('dashboard.send_due.done', { sent: String(json.sent ?? 0), deferred: String(json.deferred ?? 0) }),
			});
			globalThis.location.reload();
		} else setNotice({ tone: 'danger', text: json.detail ?? json.title ?? String(response.status) });
	};
	return h(
		'div',
		{ className: 'flex flex-wrap items-center gap-3' },
		h(Button, { type: 'button', loading: busy, onClick: run }, t('dashboard.send_due.button')),
		h('p', { className: 'text-sm text-muted' }, t('dashboard.send_due.hint')),
		notice ? h(Callout, { tone: notice.tone }, notice.text) : null,
	);
}
