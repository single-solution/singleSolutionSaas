'use client';
/**
 * Connections → structured values (PLAN 0.8.3): the AI providers (`ai`, `ai_backup`: provider, key, model, base URL
 * for an OpenAI-compatible service). A value is saved as one connection (tested live, encrypted, write-only), so each
 * form starts empty and saving replaces the whole value. The storage is the Portal's (one bucket for every product).
 * @module
 */
import { useId, useState } from 'react';
import { Button, Callout, FieldGrid, Input, Select } from '@ss/ui';
import { AI_PROVIDERS, MODEL_SUGGESTIONS, checkAiConnection } from '../../core/models.js';
import { TEXTS } from './texts.js';

const N = TEXTS.connections.fields;

/** Connections with their own form. */
export const FORMS = Object.freeze(['ai', 'ai_backup']);

/** @param {{ onSave: (value: object) => Promise<void> }} props */
export function AiForm({ onSave }) {
	const list = useId();
	const [values, setValues] = useState(/** @type {Record<string, string>} */ ({ provider: 'openai' }));
	const [error, setError] = useState(/** @type {string | null} */ (null));
	/** @param {string} key @param {string} value */
	const set = (key, value) => setValues({ ...values, [key]: value });
	const provider = /** @type {import('../../core/models.js').AiProvider} */ (values.provider);
	return (
		<div className="mt-3 space-y-3">
			<FieldGrid>
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
			</FieldGrid>
			{error ? <Callout tone="danger">{error}</Callout> : null}
			<Button
				size="sm"
				onClick={() => {
					const checked = checkAiConnection(
						provider === 'compatible' ? values : { provider, apiKey: values.apiKey, model: values.model },
					);
					if (!checked.ok) return setError(checked.message);
					setError(null);
					const done = onSave(checked.value);
					setValues({ provider });
					return done;
				}}>
				{TEXTS.connections.save}
			</Button>
		</div>
	);
}
