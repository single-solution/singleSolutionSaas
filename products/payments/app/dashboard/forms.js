'use client';
/**
 * Connections → forms (PLAN 0.8.7): the storage for transfer proofs and each gateway's keys. A value is saved as one
 * connection (tested live, encrypted, write-only), so each form starts empty and saving replaces the whole value.
 * @module
 */
import { useState } from 'react';
import { Button, Checkbox, FieldGrid, Input } from '@ss/ui';
import { TEXTS } from './texts.js';

/** @typedef {{ name: string, secret?: boolean, optional?: boolean, check?: boolean }} Field */

/** @type {Field} */
const SANDBOX = { name: 'sandbox', check: true };

/** The fields of each connection that has a form. @type {Readonly<Record<string, Field[]>>} */
export const FORMS = Object.freeze({
	storage: [
		{ name: 'endpoint', optional: true },
		{ name: 'region' },
		{ name: 'bucket' },
		{ name: 'accessKeyId' },
		{ name: 'secretAccessKey', secret: true },
		{ name: 'prefix', optional: true },
	],
	stripe: [
		{ name: 'secretKey', secret: true },
		{ name: 'webhookSecret', secret: true },
	],
	paypal: [{ name: 'clientId' }, { name: 'secret', secret: true }, { name: 'webhookId' }, SANDBOX],
	payfast: [{ name: 'merchantId' }, { name: 'merchantKey' }, { name: 'passphrase', secret: true }, SANDBOX],
	jazzcash: [{ name: 'merchantId' }, { name: 'password', secret: true }, { name: 'integritySalt', secret: true }, SANDBOX],
	easypaisa: [
		{ name: 'storeId' },
		{ name: 'hashKey', secret: true },
		{ name: 'username' },
		{ name: 'password', secret: true },
		{ name: 'accountNum' },
		SANDBOX,
	],
	generic: [
		{ name: 'name' },
		{ name: 'url' },
		{ name: 'secret', secret: true },
		{ name: 'refundUrl', optional: true },
		{ name: 'currencies', optional: true },
	],
});

/**
 * @param {{ name: string, onSave: (value: Record<string, string | boolean>) => void }} props
 */
export function ConnectionForm({ name, onSave }) {
	const fields = FORMS[name] ?? [];
	const [values, setValues] = useState(/** @type {Record<string, string | boolean>} */ ({}));
	const labels = /** @type {Record<string, string>} */ (TEXTS.connections.fields);
	/** @param {string} key */
	const text = (key) => String(values[key] ?? '').trim();
	const ready = fields.every((field) => field.optional || field.check || text(field.name) !== '');
	return (
		<div className="mt-3 space-y-3">
			<FieldGrid>
				{fields.map((field) =>
					field.check ? (
						<Checkbox
							key={field.name}
							label={labels[field.name] ?? field.name}
							checked={values[field.name] === true}
							onChange={(event) => setValues({ ...values, [field.name]: event.target.checked })}
						/>
					) : (
						<Input
							key={field.name}
							label={labels[field.name] ?? field.name}
							type={field.secret ? 'password' : 'text'}
							autoComplete="off"
							value={String(values[field.name] ?? '')}
							onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
						/>
					),
				)}
			</FieldGrid>
			<Button
				size="sm"
				disabled={!ready}
				onClick={() => {
					/** @type {Record<string, string | boolean>} */
					const value = {};
					for (const field of fields)
						if (field.check) value[field.name] = values[field.name] === true;
						else if (text(field.name) !== '') value[field.name] = text(field.name);
					const done = onSave(value);
					setValues({});
					return done;
				}}>
				{TEXTS.connections.save}
			</Button>
		</div>
	);
}
