'use client';
/** Add a FAQ entry (POST /v1/dashboard/knowledge-entries with the dashboard session; indexed immediately). */
import { createElement as h, useState } from 'react';
import { Button, Callout, Input, TextArea } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string }} props */
export function EntryForm({ websiteId }) {
	const [question, setQuestion] = useState('');
	const [answer, setAnswer] = useState('');
	const [status, setStatus] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	/** @param {{ preventDefault: () => void }} event */
	const submit = async (event) => {
		event.preventDefault();
		const response = await fetch('/v1/dashboard/knowledge-entries', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify({ question, answer }),
		});
		const body = await response.json().catch(() => ({}));
		if (response.ok) {
			setStatus({ tone: 'success', text: t('dashboard.knowledge.added') });
			globalThis.location.reload();
		} else setStatus({ tone: 'danger', text: body.detail ?? body.title ?? String(response.status) });
	};
	return h(
		'form',
		{ onSubmit: submit, className: 'mt-6 grid gap-3' },
		h(Input, {
			label: t('dashboard.knowledge.question'),
			required: true,
			value: question,
			onChange: (/** @type {any} */ e) => setQuestion(e.target.value),
		}),
		h(TextArea, {
			label: t('dashboard.knowledge.answer'),
			required: true,
			rows: 3,
			value: answer,
			onChange: (/** @type {any} */ e) => setAnswer(e.target.value),
		}),
		h('div', null, h(Button, { type: 'submit' }, t('dashboard.knowledge.add'))),
		status ? h(Callout, { tone: status.tone }, status.text) : null,
	);
}
