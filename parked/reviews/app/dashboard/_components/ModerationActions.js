'use client';
/** Approve, reject (with a reason) or reply to a review (POST /v1/dashboard/moderation/{id}/… with the dashboard session; audited). */
import { createElement as h, useState } from 'react';
import { Button, Callout, Select, TextArea } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ reviewId: string, websiteId: string, status: string, reasons: string[], replies: boolean }} props */
export function ModerationActions({ reviewId, websiteId, status, reasons, replies }) {
	const [reason, setReason] = useState(reasons[0] ?? '');
	const [reply, setReply] = useState('');
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	/** @param {'approve' | 'reject' | 'reply'} action @param {Record<string, unknown>} body */
	const send = async (action, body) => {
		setBusy(true);
		const response = await fetch(`/v1/dashboard/moderation/${encodeURIComponent(reviewId)}/${action}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify(body),
		});
		const json = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) {
			setNotice({ tone: 'success', text: t('dashboard.moderation.saved') });
			globalThis.location.reload();
		} else setNotice({ tone: 'danger', text: json.detail ?? json.title ?? String(response.status) });
	};
	return h(
		'div',
		{ className: 'mt-3 space-y-3' },
		h(
			'div',
			{ className: 'flex flex-wrap items-end gap-2' },
			status !== 'approved'
				? h(Button, { type: 'button', loading: busy, onClick: () => send('approve', {}) }, t('dashboard.moderation.approve'))
				: null,
			status !== 'rejected'
				? h(Select, {
						label: t('dashboard.moderation.reason'),
						value: reason,
						options: reasons.map((code) => ({ value: code, label: code })),
						onChange: (/** @type {any} */ e) => setReason(e.target.value),
					})
				: null,
			status !== 'rejected'
				? h(
						Button,
						{ type: 'button', variant: 'secondary', loading: busy, onClick: () => send('reject', { reason }) },
						t('dashboard.moderation.reject'),
					)
				: null,
		),
		replies && status === 'approved'
			? h(
					'form',
					{
						className: 'space-y-2',
						onSubmit: (/** @type {{ preventDefault: () => void }} */ event) => {
							event.preventDefault();
							void send('reply', { body: reply });
						},
					},
					h(TextArea, {
						label: t('dashboard.moderation.reply'),
						value: reply,
						rows: 2,
						onChange: (/** @type {any} */ e) => setReply(e.target.value),
					}),
					h(Button, { type: 'submit', variant: 'secondary', loading: busy }, t('dashboard.moderation.reply_submit')),
				)
			: null,
		notice ? h(Callout, { tone: notice.tone }, notice.text) : null,
	);
}
