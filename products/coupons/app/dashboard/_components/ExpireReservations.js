'use client';
/**
 * "Release expired reservations" (POST /v1/dashboard/reservations:expire): gives back the uses of this website's
 * reservations whose time ran out, right away. Nothing runs on a timer: without the button a lapsed reservation is
 * released when it, its code, customer or device is next used or read.
 */
import { createElement as h, useState } from 'react';
import { Button, Callout } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function ExpireReservations({ websiteId }) {
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	const run = async () => {
		setBusy(true);
		const response = await fetch('/v1/dashboard/reservations:expire', {
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
						text: t(json.more ? 'dashboard.expire.done_more' : 'dashboard.expire.done', { count: String(json.expired) }),
					}
				: { tone: 'danger', text: String(json.title ?? response.status) },
		);
	};
	return h(
		'div',
		{ className: 'space-y-2' },
		h('p', { className: 'text-sm text-muted' }, t('dashboard.expire.help')),
		h(Button, { onClick: run, disabled: busy }, t('dashboard.expire.run')),
		status ? h(Callout, { tone: status.tone }, status.text) : null,
	);
}
