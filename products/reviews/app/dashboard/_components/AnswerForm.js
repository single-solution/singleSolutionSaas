'use client';
/** Publish / reject a pending question, or answer it as the merchant (dashboard session; audited). */
import { createElement as h, useState } from 'react';
import { Button, Callout, TextArea } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ questionId: string, websiteId: string, awaiting: boolean }} props */
export function AnswerForm({ questionId, websiteId, awaiting }) {
	const [answer, setAnswer] = useState('');
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(/** @type {string | null} */ (null));
	/** @param {string} path @param {Record<string, unknown>} body */
	const send = async (path, body) => {
		setBusy(true);
		const response = await fetch(`/v1/dashboard/questions/${encodeURIComponent(questionId)}/${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify(body),
		});
		const json = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) globalThis.location.reload();
		else setNotice(json.detail ?? json.title ?? String(response.status));
	};
	return h(
		'div',
		{ className: 'mt-3 space-y-2' },
		awaiting
			? h(
					'div',
					{ className: 'flex gap-2' },
					h(Button, { type: 'button', loading: busy, onClick: () => send('publish', {}) }, t('dashboard.questions.publish')),
					h(
						Button,
						{ type: 'button', variant: 'secondary', loading: busy, onClick: () => send('reject', {}) },
						t('dashboard.questions.reject'),
					),
				)
			: h(
					'form',
					{
						className: 'space-y-2',
						onSubmit: (/** @type {{ preventDefault: () => void }} */ event) => {
							event.preventDefault();
							void send('answers', { body: answer });
						},
					},
					h(TextArea, {
						label: t('dashboard.questions.answer'),
						value: answer,
						rows: 2,
						onChange: (/** @type {any} */ e) => setAnswer(e.target.value),
					}),
					h(Button, { type: 'submit', loading: busy }, t('dashboard.questions.answer_submit')),
				),
		notice ? h(Callout, { tone: 'danger' }, notice) : null,
	);
}
