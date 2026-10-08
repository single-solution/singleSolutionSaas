'use client';
/**
 * Connections → structured values (PLAN 0.8.3): the AI providers (`ai`, `ai_backup`: provider, key, model, base URL
 * for an OpenAI-compatible service) and the S3-compatible `storage`. A value is saved as one connection (tested live,
 * encrypted, write-only), so each form starts empty and saving replaces the whole value.
 * @module
 */
import { useId, useState } from 'react';
import { Button, Callout, Input, Select } from '@ss/ui';
import { AI_PROVIDERS, MODEL_SUGGESTIONS, checkAiConnection } from '../../core/models.js';
import { TEXTS } from './texts.js';

const N = TEXTS.connections.fields;

/** Connections with their own form. */
export const FORMS = Object.freeze(['ai', 'ai_backup', 'storage']);

/** @param {{ onSave: (value: object) => void }} props */
export function AiForm({ onSave }) {
	const list = useId();
	const [values, setValues] = useState(/** @type {Record<string, string>} */ ({ provider: 'openai' }));
	const [error, setError] = useState(/** @type {string | null} */ (null));
	/** @param {string} key @param {string} value */
	const set = (key, value) => setValues({ ...values, [key]: value });
	const provider = /** @type {import('../../core/models.js').AiProvider} */ (values.provider);
	return (
		<div className="mt-3 space-y-3">
			<div className="grid gap-3 md:grid-cols-2">
				<Select
					label={N.provider}
					value={provider}
					options={AI_PROVIDERS.map((value) => ({ value, label: TEXTS.connections.providers[value] }))}
					onChange={(event) => set('provider', event.target.value)}
				/>
				<Input
					label={N.model}
					list={list}
					autoComplete="off"
					value={values.model ?? ''}
					onChange={(event) => set('model', event.target.value)}
				/>
				<datalist id={list}>
					{(MODEL_SUGGESTIONS[provider] ?? []).map((model) => (
						<option key={model} value={model} />
					))}
				</datalist>
				<Input
					label={N.apiKey}
					type="password"
					autoComplete="off"
					value={values.apiKey ?? ''}
					onChange={(event) => set('apiKey', event.target.value)}
				/>
				{provider === 'compatible' ? (
					<Input
						label={N.baseUrl}
						type="url"
						autoComplete="off"
						value={values.baseUrl ?? ''}
						onChange={(event) => set('baseUrl', event.target.value)}
					/>
				) : null}
			</div>
			{error ? <Callout tone="danger">{error}</Callout> : null}
			<Button
				size="sm"
				onClick={() => {
					const checked = checkAiConnection(
						provider === 'compatible' ? values : { provider, apiKey: values.apiKey, model: values.model },
					);
					if (!checked.ok) return setError(checked.message);
					setError(null);
					onSave(checked.value);
					setValues({ provider });
				}}>
				{TEXTS.connections.save}
			</Button>
		</div>
	);
}

/** Storage fields; optional ones are left out when empty. */
const STORAGE = /** @type {const} */ ([
	{ name: 'endpoint', optional: true },
	{ name: 'region' },
	{ name: 'bucket' },
	{ name: 'accessKeyId' },
	{ name: 'secretAccessKey', secret: true },
	{ name: 'prefix', optional: true },
]);

/** @param {{ onSave: (value: object) => void }} props */
export function StorageForm({ onSave }) {
	const [values, setValues] = useState(/** @type {Record<string, string>} */ ({}));
	/** @param {string} name */
	const valueOf = (name) => (values[name] ?? '').trim();
	const ready = STORAGE.every((field) => 'optional' in field || valueOf(field.name) !== '');
	return (
		<div className="mt-3 space-y-3">
			<div className="grid gap-3 md:grid-cols-2">
				{STORAGE.map((field) => (
					<Input
						key={field.name}
						label={N[field.name]}
						type={'secret' in field ? 'password' : 'text'}
						autoComplete="off"
						value={values[field.name] ?? ''}
						onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
					/>
				))}
			</div>
			<Button
				size="sm"
				disabled={!ready}
				onClick={() => {
					onSave(
						Object.fromEntries(
							STORAGE.filter((field) => valueOf(field.name) !== '').map((field) => [field.name, valueOf(field.name)]),
						),
					);
					setValues({});
				}}>
				{TEXTS.connections.save}
			</Button>
		</div>
	);
}
