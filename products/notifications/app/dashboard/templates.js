'use client';
/**
 * Settings → Templates (PLAN 0.8.5): the merchant and our admins write every template per template key, channel and
 * language. Templates live in the merchant database, so they need it connected.
 * @module
 */
import { useState } from 'react';
import { Badge, Button, Callout, Card, Checkbox, Input, Section, Select, Skeleton, TextArea, describeProblem } from '@ss/ui';
import { call, useLoad } from './api.js';
import { TEXTS } from './texts.js';

/**
 * @typedef {{ key: string, channel: string, language: string, subject: string, text: string, required: boolean,
 *   urgent: boolean, providerTemplate: string }} Template
 */

const CHANNELS = /** @type {const} */ (['email', 'sms', 'whatsapp', 'push', 'staff_push']);
/** @type {Template} */
const EMPTY = {
	key: '',
	channel: 'email',
	language: 'default',
	subject: '',
	text: '',
	required: false,
	urgent: false,
	providerTemplate: '',
};
const T = TEXTS.settings.template;

/** @param {{ websiteId: string }} props */
export function TemplatesSection({ websiteId }) {
	const base = `/v1/dashboard/websites/${websiteId}/templates`;
	const { answer, reload } = useLoad(base);
	const [draft, setDraft] = useState(/** @type {Template | null} */ (null));
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	/** @param {Partial<Template>} patch */
	const edit = (patch) => setDraft({ .../** @type {Template} */ (draft), ...patch });
	return (
		<Section
			title={TEXTS.settings.templatesTitle}
			description={TEXTS.settings.templatesHelp}
			actions={
				<Button size="sm" onClick={() => setDraft({ ...EMPTY })}>
					{T.add}
				</Button>
			}>
			{!answer ? (
				<Skeleton lines={2} label={TEXTS.loading} />
			) : !answer.ok ? (
				<Callout tone="info">
					{answer.problem?.type?.endsWith('database_not_connected') ? T.needsDatabase : describeProblem(answer.problem)}
				</Callout>
			) : (
				<Card>
					{answer.data.items.length === 0 ? <p className="text-sm text-muted">{T.none}</p> : null}
					<ul className="divide-y divide-line">
						{answer.data.items.map((/** @type {Template} */ item) => (
							<li key={`${item.key}|${item.channel}|${item.language}`} className="flex flex-wrap items-center gap-2 py-3">
								<span className="min-w-0 flex-1 font-semibold">{item.key}</span>
								<Badge tone="info">
									{TEXTS.settings.channels[/** @type {typeof CHANNELS[number]} */ (item.channel)]}
								</Badge>
								<Badge>{item.language === 'default' ? T.default : item.language}</Badge>
								{item.required ? <Badge tone="warning">{T.required_badge}</Badge> : null}
								{item.urgent ? <Badge tone="danger">{T.urgent_badge}</Badge> : null}
								<Button size="sm" variant="secondary" onClick={() => setDraft({ ...item })}>
									{T.edit}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onClick={async () => {
										setResult(
											await call('DELETE', `${base}/${encodeURIComponent(item.key)}/${item.channel}/${item.language}`),
										);
										reload();
									}}>
									{T.delete}
								</Button>
							</li>
						))}
					</ul>
				</Card>
			)}
			{draft ? (
				<Card>
					<div className="grid gap-3 md:grid-cols-3">
						<Input label={T.key} value={draft.key} maxLength={64} onChange={(event) => edit({ key: event.target.value })} />
						<Select
							label={T.channel}
							value={draft.channel}
							options={CHANNELS.map((value) => ({ value, label: TEXTS.settings.channels[value] }))}
							onChange={(event) => edit({ channel: event.target.value })}
						/>
						<Input
							label={T.language}
							value={draft.language === 'default' ? '' : draft.language}
							maxLength={20}
							onChange={(event) => edit({ language: event.target.value.trim() || 'default' })}
						/>
					</div>
					{draft.channel === 'sms' || draft.channel === 'whatsapp' ? null : (
						<Input
							label={T.subject}
							value={draft.subject}
							maxLength={200}
							onChange={(event) => edit({ subject: event.target.value })}
						/>
					)}
					<TextArea label={T.text} rows={6} value={draft.text} onChange={(event) => edit({ text: event.target.value })} />
					<div className="mt-3 space-y-2">
						<Checkbox
							label={T.required}
							checked={draft.required}
							onChange={(event) => edit({ required: event.target.checked })}
						/>
						<Checkbox
							label={T.urgent}
							checked={draft.urgent}
							onChange={(event) => edit({ urgent: event.target.checked })}
						/>
					</div>
					{draft.channel === 'whatsapp' ? (
						<Input
							label={T.providerTemplate}
							value={draft.providerTemplate}
							onChange={(event) => edit({ providerTemplate: event.target.value })}
						/>
					) : null}
					<div className="mt-4 flex gap-2">
						<Button
							onClick={async () => {
								const next = await call('PUT', base, draft);
								setResult(next);
								if (next.ok) {
									setDraft(null);
									reload();
								}
							}}>
							{TEXTS.save}
						</Button>
						<Button variant="ghost" onClick={() => setDraft(null)}>
							{TEXTS.cancel}
						</Button>
					</div>
				</Card>
			) : null}
			{result ? (
				result.ok ? (
					<Callout tone="success">{TEXTS.saved}</Callout>
				) : (
					<Callout tone="danger">{describeProblem(result.problem)}</Callout>
				)
			) : null}
		</Section>
	);
}
