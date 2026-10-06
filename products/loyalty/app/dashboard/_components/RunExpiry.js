'use client';
/**
 * "Run expiry now": expires lapsed points, publishes due expiry notices and reviews due tiers for this website
 * (POST /v1/dashboard/expiry:run with the dashboard session). Nothing runs on a timer; members are also handled one at
 * a time when they are read.
 */
import { createElement as h, useState } from 'react';
import { Button, Callout } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function RunExpiry({ websiteId }) {
	const [status, setStatus] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		const response = await fetch('/v1/dashboard/expiry:run', { method: 'POST', headers: { 'x-ss-website': websiteId } });
		const body = await response.json().catch(() => ({}));
		setBusy(false);
		setStatus(
			response.ok
				? {
						tone: 'success',
						text: t('dashboard.expiry.done', {
							expired: String(body.expired ?? 0),
							notices: String(body.notices ?? 0),
							tierReviews: String(body.tierReviews ?? 0),
						}),
					}
				: { tone: 'danger', text: body.detail ?? body.title ?? String(response.status) },
		);
	};
	return h(
		'div',
		{ className: 'grid gap-3' },
		h('p', null, t('dashboard.expiry.intro')),
		h('div', null, h(Button, { type: 'button', loading: busy, onClick: run }, t('dashboard.expiry.run'))),
		status ? h(Callout, { tone: status.tone }, status.text) : null,
	);
}
