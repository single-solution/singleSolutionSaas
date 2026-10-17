'use client';
/**
 * Connections → structured values (PLAN 0.8.8): the OpenAI-compatible `ai` key (base URL,
 * key, model) and each courier API connection's generic adapter (booking and tracking addresses, key, extra headers as JSON object
 * text, booking body template, where the answers hold the tracking number and status). A value is saved as one
 * connection (tested live, encrypted, write-only), so each form starts empty and saving replaces the whole value.
 * @module
 */
import { useState } from 'react';
import { Button, FieldGrid, Input, TextArea } from '@ss/ui';
import { TEXTS } from './texts.js';

const N = TEXTS.connections.fields;

/**
 * @typedef {{ name: keyof typeof N, optional?: boolean, secret?: boolean, type?: string, area?: boolean }} FieldSpec
 */

/** Connections with their own form, and their fields. @type {Readonly<Record<string, ReadonlyArray<FieldSpec>>>} */
const FORMS = Object.freeze({
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
 * The form a connection takes: every courier API connection (`courier_1` … `courier_5`, E25) takes the courier form;
 * null for a connection of one value.
 * @param {string} name
 * @returns {keyof typeof FORMS | null}
 */
export const formOf = (name) => (/^courier_\d+$/.test(name) ? 'courier' : Object.hasOwn(FORMS, name) ? name : null);

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
	const form = formOf(name);
	const fields = (form && FORMS[form]) || [];
	const [values, setValues] = useState(/** @type {Record<string, string>} */ ({}));
	/** @param {string} field */
	const valueOf = (field) => (values[field] ?? '').trim();
	const problem = form === 'courier' ? headersProblem(values.headers ?? '') : null;
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
			<FieldGrid>{fields.filter((field) => !field.area).map(input)}</FieldGrid>
			{fields.filter((field) => field.area).map(input)}
			<Button
				size="sm"
				disabled={!ready}
				onClick={() => {
					const done = onSave(
						Object.fromEntries(
							fields.filter((field) => valueOf(field.name) !== '').map((field) => [field.name, valueOf(field.name)]),
						),
					);
					setValues({});
					return done;
				}}>
				{TEXTS.connections.save}
			</Button>
		</div>
	);
}
