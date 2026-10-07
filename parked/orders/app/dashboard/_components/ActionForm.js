'use client';
/**
 * A small dashboard action form: posts its fields as JSON to a dashboard route (`/v1/dashboard/…`) with the session
 * cookie, an Idempotency-Key and the website header, then reloads the page. Numbers are sent as integers; empty fields
 * are left out. Used for status moves, payments, refunds, fulfilment, serials, reviews and the blocklist.
 */
import { createElement as h, useState } from 'react';
import { Button, Input, Select } from '@ss/ui';

/**
 * @typedef {{ name: string, label: string, type?: 'text' | 'number' | 'select' | 'lines', options?: Array<{ value: string, label: string }>, value?: string }} FormField
 */

/**
 * @param {Record<string, string>} values
 * @param {FormField[]} fields
 * @param {Record<string, unknown>} fixed
 */
const bodyOf = (values, fields, fixed) => {
	/** @type {Record<string, unknown>} */
	const body = { ...fixed };
	for (const field of fields) {
		const value = (values[field.name] ?? '').trim();
		if (value === '') continue;
		if (field.type === 'number') body[field.name] = Number(value);
		else if (field.type === 'lines') {
			// serials: `lineId: a, b`
			body.lines = value
				.split('\n')
				.map((row) => row.split(':'))
				.filter((parts) => parts.length === 2)
				.map(([lineId = '', list = '']) => ({
					lineId: lineId.trim(),
					serials: list
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean),
				}));
		} else body[field.name] = value;
	}
	return body;
};

/**
 * @param {{ path: string, websiteId: string, fields: FormField[], submit: string, fixed?: Record<string, unknown>, method?: string }} props
 */
export function ActionForm({ path, websiteId, fields, submit, fixed = {}, method = 'POST' }) {
	const [values, setValues] = useState(
		/** @type {Record<string, string>} */ (
			Object.fromEntries(fields.map((f) => [f.name, f.value ?? f.options?.[0]?.value ?? '']))
		),
	);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState(/** @type {string | null} */ (null));
	/** @param {any} event */
	const send = async (event) => {
		event.preventDefault();
		setBusy(true);
		const response = await fetch(path, {
			method,
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify(bodyOf(values, fields, fixed)),
		});
		const json = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) globalThis.location.reload();
		else setMessage(json.detail ?? json.title ?? String(response.status));
	};
	/** @param {string} name @param {string} value */
	const set = (name, value) => setValues((current) => ({ ...current, [name]: value }));
	return h(
		'form',
		{ className: 'flex flex-wrap items-end gap-2', onSubmit: send },
		...fields.map((field) =>
			field.type === 'select'
				? h(Select, {
						key: field.name,
						label: field.label,
						value: values[field.name],
						options: field.options ?? [],
						onChange: (/** @type {any} */ e) => set(field.name, e.target.value),
					})
				: field.type === 'lines'
					? h('textarea', {
							key: field.name,
							'aria-label': field.label,
							placeholder: field.label,
							rows: 3,
							className: 'min-w-64 rounded-md border border-line bg-surface p-2 text-sm',
							value: values[field.name],
							onChange: (/** @type {any} */ e) => set(field.name, e.target.value),
						})
					: h(Input, {
							key: field.name,
							label: field.label,
							type: field.type === 'number' ? 'number' : 'text',
							value: values[field.name],
							onChange: (/** @type {any} */ e) => set(field.name, e.target.value),
						}),
		),
		h(Button, { type: 'submit', loading: busy, variant: 'secondary' }, submit),
		message ? h('span', { role: 'status', className: 'text-sm text-danger' }, message) : null,
	);
}
