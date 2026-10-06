'use client';
/** "Clean up stale photos": POST /v1/dashboard/photos:sweep with the dashboard session (never-confirmed photo slots). */
import { createElement as h, useState } from 'react';
import { Button } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function SweepPhotos({ websiteId }) {
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(/** @type {string | null} */ (null));
	const sweep = async () => {
		setBusy(true);
		const response = await fetch('/v1/dashboard/photos:sweep', { method: 'POST', headers: { 'x-ss-website': websiteId } });
		const json = await response.json().catch(() => ({}));
		setBusy(false);
		setNotice(
			response.ok
				? t('dashboard.inspections.swept', { deleted: (json.deleted ?? 0) + (json.missing ?? 0), failed: json.failed ?? 0 })
				: (json.detail ?? json.title ?? String(response.status)),
		);
	};
	return h(
		'div',
		{ className: 'mt-4 flex flex-wrap items-center gap-2' },
		h(Button, { type: 'button', variant: 'secondary', loading: busy, onClick: sweep }, t('dashboard.inspections.sweep')),
		notice ? h('p', { role: 'status', className: 'text-sm text-muted' }, notice) : null,
	);
}
