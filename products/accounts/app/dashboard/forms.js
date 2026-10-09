'use client';
/**
 * Connections → social sign-in key forms (PLAN 0.8.6): Google, Apple and Facebook each take the merchant's own app
 * keys as one structured value. The value is saved as one connection (tested live, encrypted, write-only), so the form
 * always starts empty and saving replaces the whole value. Each form also shows the return address the merchant must
 * register with the provider.
 * @module
 */
import { useState } from 'react';
import { Button, CodeBlock, FieldGrid, Input, TextArea } from '@ss/ui';
import { TEXTS } from './texts.js';

/** @typedef {{ name: keyof typeof TEXTS.connections.fields, type?: 'text' | 'password' | 'textarea' }} Field */

/** The object-valued connections and their fields. @type {Record<string, Field[]>} */
export const KEY_FORMS = {
	google: [{ name: 'clientId' }, { name: 'clientSecret', type: 'password' }],
	apple: [{ name: 'servicesId' }, { name: 'teamId' }, { name: 'keyId' }, { name: 'privateKey', type: 'textarea' }],
	facebook: [{ name: 'appId' }, { name: 'appSecret', type: 'password' }],
};

/**
 * @param {{ name: string, onSave: (value: Record<string, string>) => unknown }} props `onSave` may return a promise (the
 *   button shows its spinner until it settles)
 */
export function KeyForm({ name, onSave }) {
	const fields = KEY_FORMS[name] ?? [];
	const [values, setValues] = useState(/** @type {Record<string, string>} */ ({}));
	/** @param {string} key @param {string} value */
	const set = (key, value) => setValues({ ...values, [key]: value });
	const ready = fields.every((field) => (values[field.name] ?? '').trim() !== '');
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
	return (
		<div className="mt-3 space-y-3">
			<CodeBlock label={TEXTS.connections.returnAddress} code={`${origin}/oauth/${name}/callback`} />
			<FieldGrid>
				{fields.map((field) =>
					field.type === 'textarea' ? (
						<TextArea
							key={field.name}
							label={TEXTS.connections.fields[field.name]}
							rows={5}
							spellCheck={false}
							autoComplete="off"
							value={values[field.name] ?? ''}
							onChange={(event) => set(field.name, event.target.value)}
						/>
					) : (
						<Input
							key={field.name}
							label={TEXTS.connections.fields[field.name]}
							type={field.type ?? 'text'}
							autoComplete="off"
							value={values[field.name] ?? ''}
							onChange={(event) => set(field.name, event.target.value)}
						/>
					),
				)}
			</FieldGrid>
			<Button
				size="sm"
				disabled={!ready}
				onClick={() => {
					const done = onSave(Object.fromEntries(fields.map((field) => [field.name, (values[field.name] ?? '').trim()])));
					setValues({});
					return done;
				}}>
				{TEXTS.connections.save}
			</Button>
		</div>
	);
}
