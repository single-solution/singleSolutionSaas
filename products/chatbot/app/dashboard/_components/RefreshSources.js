'use client';
/** Refresh the web pages that are due (POST /v1/dashboard/knowledge-sources:refresh with the dashboard session). */
import { createElement as h, useState } from 'react';
import { Button, Callout } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function RefreshSources({ websiteId }) {
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	const refresh = async () => {
		setBusy(true);
		const response = await fetch('/v1/dashboard/knowledge-sources:refresh', {
			method: 'POST',
			headers: { 'x-ss-website': websiteId },
		});
		const body = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) {
			setStatus({
				tone: body.failed > 0 ? 'danger' : 'success',
				text: t('dashboard.knowledge.refreshed', {
					refreshed: body.refreshed ?? 0,
					failed: body.failed ?? 0,
					remaining: body.remaining ?? 0,
				}),
			});
			if (body.refreshed > 0) globalThis.location.reload();
		} else setStatus({ tone: 'danger', text: body.detail ?? body.title ?? String(response.status) });
	};
	return h(
		'div',
		{ className: 'mt-4 grid gap-3' },
		h('div', null, h(Button, { type: 'button', onClick: refresh, disabled: busy }, t('dashboard.knowledge.refresh'))),
		status ? h(Callout, { tone: status.tone }, status.text) : null,
	);
}
