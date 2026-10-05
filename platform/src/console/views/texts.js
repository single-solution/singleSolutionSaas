'use client';
/**
 * Per-website texts of a product's drop-in elements (F.18): the merchant rewords an element's strings for this website,
 * for one language (BCP 47) or every language (`*`). The Portal applies them on top of the product's catalogs when it
 * compiles the website bundle (`PUT /v1/merchants/:m/websites/:w/delivery/strings/:appId/:element/:language`).
 * @module
 */
import { useEffect, useState } from 'react';
import { Button, Callout, Card, Form, FormActions, FormError, Input, Select, TextArea, describeProblem, useToast } from '@ss/ui';
import { apiFetch } from '../client.js';
import { api } from '../paths.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * `key = text` lines → strings (blank lines and lines without `=` are ignored).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export const parseTexts = (text) =>
	Object.fromEntries(
		text
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.includes('='))
			.map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()])
			.filter(([key]) => key !== ''),
	);

/**
 * strings → `key = text` lines.
 * @param {Record<string, string> | undefined} strings
 */
export const formatTexts = (strings) =>
	Object.entries(strings ?? {})
		.map(([key, value]) => `${key} = ${value}`)
		.join('\n');

/**
 * @param {{ merchantId: string, website: any, product: any, readOnly?: boolean }} props
 */
export function TextsPanel({ merchantId, website, product, readOnly = false }) {
	const toast = useToast();
	const elements = /** @type {any[]} */ (product?.elements ?? []).filter((e) => (e.modes ?? []).includes('A'));
	const [elementKey, setElementKey] = useState(elements[0]?.key ?? '');
	const [language, setLanguage] = useState(String(website?.language ?? '*'));
	const [items, setItems] = useState(/** @type {any[] | null} */ (null));
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const appId = product?.appId ?? '';

	useEffect(() => {
		let live = true;
		void apiFetch(api.deliveryStrings(merchantId, website.websiteId)).then((result) => {
			if (!live) return;
			if (result.ok) setItems(/** @type {any} */ (result.data).items ?? []);
			else setProblem(result.problem);
		});
		return () => {
			live = false;
		};
	}, [merchantId, website.websiteId]);

	const current = (items ?? []).find((i) => i.appId === appId && i.element === elementKey);
	useEffect(() => {
		setText(formatTexts(current?.languages?.[language]));
	}, [current, language]);

	if (elements.length === 0) return <p className="text-sm text-muted">This product has no drop-in elements.</p>;

	const save = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(api.deliveryString(merchantId, website.websiteId, appId, elementKey, language || '*'), {
			method: 'PUT',
			body: { strings: parseTexts(text) },
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		const saved = /** @type {any} */ (result.data);
		setItems((list) => [...(list ?? []).filter((i) => !(i.appId === appId && i.element === elementKey)), saved]);
		toast.show({ title: 'Texts saved', description: 'The website bundle is recompiled.' });
	};

	return (
		<Card title="Texts on this website" subtitle="Reword an element's texts for this website, per language.">
			{items === null && !problem ? <p className="text-sm text-muted">Loading…</p> : null}
			{problem && items === null ? <Callout tone="danger">{describeProblem(problem)}</Callout> : null}
			<Form onSubmit={save} busy={busy} aria-label="Element texts">
				<div className="grid gap-3 sm:grid-cols-2">
					<Select
						label="Element"
						value={elementKey}
						onChange={(e) => setElementKey(e.currentTarget.value)}
						options={elements.map((e) => ({ value: e.key, label: e.name ?? e.key }))}
					/>
					<Input
						label="Language"
						value={language}
						maxLength={35}
						help="A language tag such as de or de-CH, or * for every language."
						onChange={(e) => setLanguage(e.currentTarget.value.trim())}
					/>
				</div>
				<TextArea
					label="Texts"
					rows={8}
					className="font-mono text-xs"
					value={text}
					placeholder="grid.title = Our collection"
					help="One `key = text` per line. Keys are the element's string keys; an empty list removes the override."
					disabled={readOnly}
					onChange={(e) => setText(e.currentTarget.value)}
				/>
				<FormError problem={items === null ? null : problem} />
				<FormActions>
					<Button type="submit" loading={busy} disabled={readOnly}>
						Save texts
					</Button>
				</FormActions>
			</Form>
		</Card>
	);
}
