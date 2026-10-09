'use client';
/**
 * Connections → provider forms (PLAN 0.8.5): the merchant picks a provider per channel and fills its fields; the push
 * keys have their own form. The value is saved as one connection (tested live, encrypted, write-only), so the form
 * always starts empty and saving replaces the whole value.
 * @module
 */
import { useState } from 'react';
import { Button, Checkbox, FieldGrid, Input, Select, TextArea } from '@ss/ui';
import { TEXTS } from './texts.js';

/** @typedef {{ name: string, type?: 'text' | 'password' | 'number' | 'checkbox' | 'textarea' | 'select', options?: string[], optional?: boolean }} Field */

/** @type {Field} */
const SECRET = { name: 'secret', type: 'password' };
/** @type {Field} */
const FROM = { name: 'from' };
/** @type {Field[]} */
const TWILIO = [{ name: 'accountSid' }, SECRET, { name: 'from' }];
/** @type {Field[]} */
const HTTP = [
	{ name: 'url' },
	{ name: 'contentType', type: 'select', options: ['json', 'form'] },
	{ name: 'headers', type: 'textarea', optional: true },
	{ name: 'body', type: 'textarea' },
	{ ...SECRET, optional: true },
];

/** The providers of each connection and their fields. @type {Record<string, Record<string, Field[]>>} */
export const PROVIDER_FORMS = {
	email: {
		smtp: [
			{ name: 'host' },
			{ name: 'port', type: 'number', optional: true },
			{ name: 'secure', type: 'checkbox' },
			{ name: 'username' },
			SECRET,
			FROM,
		],
		resend: [SECRET, FROM],
		sendgrid: [SECRET, FROM],
		mailgun: [{ name: 'domain' }, { name: 'region', type: 'select', options: ['us', 'eu'] }, SECRET, FROM],
		ses: [{ name: 'region' }, { name: 'accessKeyId' }, SECRET, FROM],
	},
	sms: { twilio: TWILIO, http: HTTP },
	whatsapp: {
		meta: [
			{ name: 'phoneNumberId' },
			SECRET,
			{ name: 'appSecret', type: 'password', optional: true },
			{ name: 'verifyToken', optional: true },
		],
		twilio: TWILIO,
		http: HTTP,
	},
	push_keys: { '': [{ name: 'publicKey' }, { name: 'privateKey', type: 'password' }, { name: 'subject' }] },
};

/**
 * @param {{ name: string, onSave: (value: Record<string, string | number | boolean>) => void }} props
 */
export function ProviderForm({ name, onSave }) {
	const forms = /** @type {Record<string, Field[]>} */ (PROVIDER_FORMS[name]);
	const choices = Object.keys(forms);
	const [provider, setProvider] = useState(/** @type {string} */ (choices[0]));
	const [values, setValues] = useState(/** @type {Record<string, string | boolean>} */ ({}));
	const fields = forms[provider] ?? [];
	const labels = /** @type {Record<string, string>} */ (TEXTS.connections.fields);
	/** @param {string} key @param {string | boolean} value */
	const set = (key, value) => setValues({ ...values, [key]: value });
	const ready = fields.every(
		(field) => field.optional || field.type === 'checkbox' || String(values[field.name] ?? '').trim() !== '',
	);
	return (
		<div className="mt-3 space-y-3">
			<FieldGrid>
				{provider === '' ? null : (
					<Select
						label={TEXTS.connections.provider}
						value={provider}
						options={choices.map((value) => ({
							value,
							label: TEXTS.connections.providers[/** @type {keyof typeof TEXTS.connections.providers} */ (value)],
						}))}
						onChange={(event) => {
							setProvider(event.target.value);
							setValues({});
						}}
					/>
				)}
				{fields.map((field) => {
					const label = labels[field.name] ?? field.name;
					const value = values[field.name];
					if (field.type === 'checkbox')
						return (
							<Checkbox
								key={field.name}
								label={label}
								checked={value === true}
								onChange={(event) => set(field.name, event.target.checked)}
							/>
						);
					if (field.type === 'select')
						return (
							<Select
								key={field.name}
								label={label}
								value={String(value ?? field.options?.[0] ?? '')}
								options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
								onChange={(event) => set(field.name, event.target.value)}
							/>
						);
					if (field.type === 'textarea')
						return (
							<TextArea
								key={field.name}
								label={label}
								rows={3}
								value={String(value ?? '')}
								onChange={(event) => set(field.name, event.target.value)}
							/>
						);
					return (
						<Input
							key={field.name}
							label={label}
							type={field.type ?? 'text'}
							autoComplete="off"
							value={String(value ?? '')}
							onChange={(event) => set(field.name, event.target.value)}
						/>
					);
				})}
			</FieldGrid>
			<Button
				size="sm"
				disabled={!ready}
				onClick={() => {
					/** @type {Record<string, string | number | boolean>} */
					const value = provider === '' ? {} : { provider };
					for (const field of fields) {
						const raw = values[field.name] ?? (field.type === 'select' ? field.options?.[0] : undefined);
						if (field.type === 'checkbox') {
							if (raw === true) value[field.name] = true;
						} else if (typeof raw === 'string' && raw.trim() !== '')
							value[field.name] = field.type === 'number' ? Number(raw) : raw.trim();
					}
					const done = onSave(value);
					setValues({});
					return done;
				}}>
				{TEXTS.connections.save}
			</Button>
		</div>
	);
}
