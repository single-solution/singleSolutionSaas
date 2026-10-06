'use client';
/** "Run due deletions": POST /v1/dashboard/deletions:run with the dashboard session (deletions past their cooling-off). */
import { createElement as h, useState } from 'react';
import { Button, Callout } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function RunDeletions({ websiteId }) {
	const [status, setStatus] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		const response = await fetch('/v1/dashboard/deletions:run', { method: 'POST', headers: { 'x-ss-website': websiteId } });
		const body = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) {
			setStatus({ tone: 'success', text: t('dashboard.deletions.done', { count: body.deleted ?? 0 }) });
			if (body.deleted > 0) globalThis.location.reload();
		} else setStatus({ tone: 'danger', text: body.detail ?? body.title ?? String(response.status) });
	};
	return h(
		'div',
		{ className: 'mt-4 space-y-3' },
		h(Button, { type: 'button', variant: 'secondary', loading: busy, onClick: run }, t('dashboard.deletions.run')),
		status ? h(Callout, { tone: status.tone }, status.text) : null,
	);
}
