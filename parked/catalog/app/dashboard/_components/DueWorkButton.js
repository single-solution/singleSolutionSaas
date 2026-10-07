'use client';
/**
 * "Process due changes": runs the website's work that became due with time (scheduled publish / unpublish events,
 * expired stock holds, leftover item events) now — POST /v1/dashboard/due-work with the dashboard session. Nothing runs
 * on a timer; the same work otherwise happens when the items are next read.
 */
import { createElement as h, useState } from 'react';
import { Button } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function DueWorkButton({ websiteId }) {
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState(/** @type {string | null} */ (null));
	const run = async () => {
		setBusy(true);
		setMessage(null);
		const response = await fetch('/v1/dashboard/due-work', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: '{}',
		}).catch(() => null);
		const json = response ? await response.json().catch(() => ({})) : {};
		setBusy(false);
		setMessage(
			response?.ok
				? t('dashboard.due.done', {
						transitions: json.transitions ?? 0,
						reservations: json.expiredReservations ?? 0,
						events: json.republished ?? 0,
					})
				: (json.detail ?? t('dashboard.due.failed')),
		);
	};
	return h(
		'span',
		{ className: 'flex items-center gap-2' },
		h(Button, { type: 'button', loading: busy, variant: 'secondary', onClick: run }, t('dashboard.due.run')),
		message ? h('span', { role: 'status', className: 'text-sm text-muted' }, message) : null,
	);
}
