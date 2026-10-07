'use client';
/**
 * Schema editor: the configurator as JSON, checked as you type by the server (`POST /v1/dashboard/configurators:check`,
 * the same validation and rules@1 compiler as the API), saved with optimistic concurrency (`PATCH` with `version`) or
 * created (`POST /v1/dashboard/configurators`). Every change is audited with the dashboard actor.
 */
import { createElement as h, useState } from 'react';
import { Button, Callout, Select, TextArea } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/**
 * @param {{ websiteId: string, record?: { id: string, version: number, status: string, schema: Record<string, unknown> } | null,
 *   samples?: Array<Record<string, unknown>> }} props
 */
export function Editor({ websiteId, record = null, samples = [] }) {
	const [text, setText] = useState(JSON.stringify(record ? record.schema : (samples[0] ?? { name: '', groups: [] }), null, 2));
	const [status, setStatus] = useState(record?.status ?? 'draft');
	const [message, setMessage] = useState(/** @type {{ tone: 'success' | 'danger' | 'info', text: string } | null} */ (null));
	const [busy, setBusy] = useState(false);
	const headers = { 'content-type': 'application/json', 'x-ss-website': websiteId };
	/** @returns {Record<string, unknown> | null} */
	const parsed = () => {
		try {
			const value = JSON.parse(text);
			return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
		} catch {
			return null;
		}
	};
	/** @param {any} body */
	const describe = (body) =>
		Array.isArray(body?.errors) && body.errors.length > 0
			? body.errors.map((/** @type {any} */ e) => `${e.path || '/'}: ${e.message}`).join('\n')
			: (body?.detail ?? body?.title ?? t('dashboard.editor.failed'));
	const check = async () => {
		const value = parsed();
		if (!value) return setMessage({ tone: 'danger', text: t('dashboard.editor.json') });
		setBusy(true);
		const response = await fetch('/v1/dashboard/configurators:check', { method: 'POST', headers, body: JSON.stringify(value) });
		const body = await response.json().catch(() => ({}));
		setBusy(false);
		setMessage(
			body.valid
				? {
						tone: 'success',
						text: t('dashboard.editor.valid', { groups: body.summary.groups, options: body.summary.options }),
					}
				: { tone: 'danger', text: describe({ errors: body.problems ?? [], detail: body.detail }) },
		);
	};
	/** @param {{ preventDefault: () => void }} event */
	const save = async (event) => {
		event.preventDefault();
		const value = parsed();
		if (!value) return setMessage({ tone: 'danger', text: t('dashboard.editor.json') });
		setBusy(true);
		const response = record
			? await fetch(`/v1/dashboard/configurators/${encodeURIComponent(record.id)}`, {
					method: 'PATCH',
					headers,
					body: JSON.stringify({ ...value, status, version: record.version }),
				})
			: await fetch('/v1/dashboard/configurators', {
					method: 'POST',
					headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
					body: JSON.stringify({ ...value, status }),
				});
		const body = await response.json().catch(() => ({}));
		setBusy(false);
		if (!response.ok) return setMessage({ tone: 'danger', text: describe(body) });
		setMessage({ tone: 'success', text: t('dashboard.editor.saved') });
		globalThis.location.assign(
			`/dashboard/configurators/${encodeURIComponent(body.id)}?website=${encodeURIComponent(websiteId)}`,
		);
	};
	return h(
		'form',
		{ onSubmit: save, className: 'space-y-3' },
		samples.length > 1
			? h(Select, {
					label: t('dashboard.editor.sample'),
					options: samples.map((sample, index) => ({ value: String(index), label: String(sample.name) })),
					onChange: (/** @type {any} */ e) => setText(JSON.stringify(samples[Number(e.target.value)], null, 2)),
				})
			: null,
		h(TextArea, {
			label: t('dashboard.editor.schema'),
			help: t('dashboard.editor.help'),
			value: text,
			rows: 18,
			spellCheck: false,
			className: 'font-mono',
			onChange: (/** @type {any} */ e) => setText(e.target.value),
		}),
		h(Select, {
			label: t('dashboard.column.status'),
			value: status,
			options: ['draft', 'published'].map((value) => ({ value, label: t(`dashboard.status.${value}`) })),
			onChange: (/** @type {any} */ e) => setStatus(e.target.value),
		}),
		h(
			'div',
			{ className: 'flex gap-2' },
			h(Button, { type: 'button', variant: 'secondary', loading: busy, onClick: check }, t('dashboard.editor.check')),
			h(Button, { type: 'submit', loading: busy }, record ? t('dashboard.editor.save') : t('dashboard.editor.create')),
		),
		message ? h(Callout, { tone: message.tone }, h('pre', { className: 'whitespace-pre-wrap text-sm' }, message.text)) : null,
	);
}
