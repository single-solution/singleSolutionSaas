'use client';
/**
 * Connections → structured values (PLAN 0.8.8): the S3-compatible `storage`, the OpenAI-compatible `ai` key (base URL,
 * key, model) and the generic `courier` API adapter (booking and tracking addresses, key, extra headers as JSON object
 * text, booking body template, where the answers hold the tracking number and status). A value is saved as one
 * connection (tested live, encrypted, write-only), so each form starts empty and saving replaces the whole value.
 * @module
 */
import { useState } from 'react';
import { Button, Input, TextArea } from '@ss/ui';
import { TEXTS } from './texts.js';

const N = TEXTS.connections.fields;

/**
 * @typedef {{ name: keyof typeof N, optional?: boolean, secret?: boolean, type?: string, area?: boolean }} FieldSpec
 */

/** Connections with their own form, and their fields. @type {Readonly<Record<string, ReadonlyArray<FieldSpec>>>} */
export const FORMS = Object.freeze({
	storage: [
		{ name: 'endpoint', optional: true, type: 'url' },
		{ name: 'region' },
		{ name: 'bucket' },
		{ name: 'accessKeyId' },
		{ name: 'secretAccessKey', secret: true },
		{ name: 'prefix', optional: true },
	],
	ai: [{ name: 'baseUrl', type: 'url' }, { name: 'model' }, { name: 'apiKey', secret: true }],
	courier: [
		{ name: 'bookUrl', type: 'url' },
		{ name: 'trackUrl', type: 'url' },
		{ name: 'apiKey', secret: true },
		{ name: 'trackingPath', optional: true },
		{ name: 'statusPath', optional: true },
		{ name: 'headers', optional: true, area: true },
		{ name: 'bodyTemplate', optional: true, area: true },
	],
});

/**
 * Why extra headers are not a JSON object of text values, or null (empty is fine).
 * @param {string} text
 * @returns {string | null}
 */
const headersProblem = (text) => {
	if (text.trim() === '') return null;
	try {
		const parsed = JSON.parse(text);
		const fine =
			typeof parsed === 'object' &&
			parsed !== null &&
			!Array.isArray(parsed) &&
			Object.values(parsed).every((value) => typeof value === 'string');
		return fine ? null : TEXTS.connections.badHeaders;
	} catch {
		return TEXTS.connections.badHeaders;
	}
};

/**
 * One structured connection: its fields, then Save and test. Optional fields are left out when empty.
 * @param {{ name: string, onSave: (value: object) => void }} props
 */
export function ConnectionForm({ name, onSave }) {
	const fields = FORMS[name] ?? [];
	const [values, setValues] = useState(/** @type {Record<string, string>} */ ({}));
	/** @param {string} field */
	const valueOf = (field) => (values[field] ?? '').trim();
	const problem = name === 'courier' ? headersProblem(values.headers ?? '') : null;
	const ready = problem === null && fields.every((field) => field.optional === true || valueOf(field.name) !== '');
	/** @param {FieldSpec} field */
	const input = (field) => {
		const common = {
			label: N[field.name],
			autoComplete: 'off',
			value: values[field.name] ?? '',
			/** @param {{ target: { value: string } }} event */
			onChange: (event) => setValues({ ...values, [field.name]: event.target.value }),
		};
		return field.area ? (
			<TextArea key={field.name} {...common} rows={4} error={field.name === 'headers' ? (problem ?? undefined) : undefined} />
		) : (
			<Input key={field.name} {...common} type={field.secret ? 'password' : (field.type ?? 'text')} />
		);
	};
	return (
		<div className="mt-3 space-y-3">
			<div className="grid gap-3 md:grid-cols-2">{fields.filter((field) => !field.area).map(input)}</div>
			{fields.filter((field) => field.area).map(input)}
			<Button
				size="sm"
				disabled={!ready}
				onClick={() => {
					onSave(
						Object.fromEntries(
							fields.filter((field) => valueOf(field.name) !== '').map((field) => [field.name, valueOf(field.name)]),
						),
					);
					setValues({});
				}}>
				{TEXTS.connections.save}
			</Button>
		</div>
	);
}
