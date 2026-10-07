'use client';
/**
 * On-demand runs (nothing runs on a timer): "Send due requests now" (POST /v1/dashboard/request-flow:run) and "Clean up
 * photo uploads" (POST /v1/dashboard/photos:sweep), with the dashboard session.
 */
import { createElement as h, useState } from 'react';
import { Button, Callout } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string, requests: boolean, photos: boolean }} props */
export function DashboardActions({ websiteId, requests, photos }) {
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	/** @param {'request-flow:run' | 'photos:sweep'} action */
	const run = async (action) => {
		setBusy(true);
		const response = await fetch(`/v1/dashboard/${action}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: '{}',
		});
		const json = await response.json().catch(() => ({}));
		setBusy(false);
		if (!response.ok) setNotice({ tone: 'danger', text: json.detail ?? json.title ?? String(response.status) });
		else
			setNotice({
				tone: 'success',
				text:
					action === 'photos:sweep'
						? t('dashboard.actions.sweep_photos_done', { deleted: String(json.deleted ?? 0) })
						: t('dashboard.actions.run_requests_done', {
								sent: String(json.sent ?? 0),
								reminded: String(json.reminded ?? 0),
							}),
			});
	};
	return h(
		'div',
		{ className: 'space-y-3' },
		h('p', { className: 'text-sm text-muted' }, t('dashboard.actions.intro')),
		h(
			'div',
			{ className: 'flex flex-wrap gap-2' },
			requests
				? h(
						Button,
						{ type: 'button', loading: busy, onClick: () => run('request-flow:run') },
						t('dashboard.actions.run_requests'),
					)
				: null,
			photos
				? h(
						Button,
						{ type: 'button', variant: 'secondary', loading: busy, onClick: () => run('photos:sweep') },
						t('dashboard.actions.sweep_photos'),
					)
				: null,
		),
		notice ? h(Callout, { tone: notice.tone }, notice.text) : null,
	);
}
