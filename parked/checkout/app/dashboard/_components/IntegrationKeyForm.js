'use client';
/** Set the sealed server key Checkout uses to call the merchant's other products (PUT /v1/dashboard/integration-key). */
import { createElement as h, useState } from 'react';
import { Button, Callout, Input } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string, current: string | null }} props */
export function IntegrationKeyForm({ websiteId, current }) {
	const [key, setKey] = useState('');
	const [status, setStatus] = useState(/** @type {{ tone: 'success' | 'danger', text: string } | null} */ (null));
	return h(
		'form',
		{
			className: 'space-y-2',
			onSubmit: async (/** @type {{ preventDefault: () => void }} */ event) => {
				event.preventDefault();
				const response = await fetch('/v1/dashboard/integration-key', {
					method: 'PUT',
					headers: { 'content-type': 'application/json', 'x-ss-website': websiteId },
					body: JSON.stringify({ key }),
				});
				const json = await response.json().catch(() => ({}));
				setKey('');
				setStatus(
					response.ok
						? { tone: 'success', text: `${t('dashboard.settings.saved')} ${json.key ?? ''}` }
						: { tone: 'danger', text: String(json.title ?? response.status) },
				);
			},
		},
		h(Input, {
			label: t('dashboard.settings.key'),
			help: t('dashboard.settings.key_help'),
			value: key,
			placeholder: current ?? 'sk_…',
			autoComplete: 'off',
			onChange: (/** @type {any} */ e) => setKey(e.target.value),
		}),
		h(Button, { type: 'submit' }, t('dashboard.settings.save')),
		status ? h(Callout, { tone: status.tone }, status.text) : null,
	);
}
