'use client';
/**
 * Settings → Templates (PLAN 0.8.5): the merchant and our admins write every template per template key, channel and
 * language. Templates live in the merchant database, so they need it connected.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	Checkbox,
	Dialog,
	EmptyState,
	Form,
	Input,
	Section,
	Select,
	Skeleton,
	TextArea,
	describeProblem,
} from '@ss/ui';
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
	const [draft, setDraft] = useState(/** @type {(Template & { isNew: boolean }) | null} */ (null));
	const [result, setResult] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	const [problem, setProblem] = useState(/** @type {any} */ (null));
	/** @param {Partial<Template>} patch */
	const edit = (patch) => setDraft({ .../** @type {Template & { isNew: boolean }} */ (draft), ...patch });
	/** @param {Template & { isNew: boolean }} next */
	const open = (next) => {
		setProblem(null);
		setDraft(next);
	};
	const save = async () => {
		if (!draft) return;
		const { isNew: _isNew, ...template } = draft;
		const next = await call('PUT', base, template);
		if (!next.ok) return setProblem(next.problem);
		setResult(next);
		setDraft(null);
		reload();
	};
	const title = draft?.isNew === false ? T.editTitle : T.add;
	return (
		<Section
			title={TEXTS.settings.templatesTitle}
			description={TEXTS.settings.templatesHelp}
			actions={
				<Button size="sm" onClick={() => open({ ...EMPTY, isNew: true })}>
					{T.add}
				</Button>
			}>
			{!answer ? (
				<Skeleton lines={2} label={TEXTS.loading} />
			) : !answer.ok ? (
				<Callout tone="info">
					{answer.problem?.type?.endsWith('database_not_connected') ? T.needsDatabase : describeProblem(answer.problem)}
				</Callout>
			) : answer.data.items.length === 0 ? (
				<EmptyState compact icon="mail" kind="settings" title={T.none} />
			) : (
				<Card>
					<ul className="divide-y divide-line-soft">
						{answer.data.items.map((/** @type {Template} */ item) => (
							<li
								key={`${item.key}|${item.channel}|${item.language}`}
								className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
								<span className="min-w-0 flex-[1_1_12rem] break-words text-sm font-semibold text-fg">{item.key}</span>
								<span className="flex flex-wrap gap-1.5">
									<Badge kind="settings">
										{TEXTS.settings.channels[/** @type {typeof CHANNELS[number]} */ (item.channel)]}
									</Badge>
									<Badge>{item.language === 'default' ? T.default : item.language}</Badge>
									{item.required ? <Badge>{T.required_badge}</Badge> : null}
									{item.urgent ? <Badge>{T.urgent_badge}</Badge> : null}
								</span>
								<span className="flex flex-wrap gap-2">
									<Button size="sm" variant="secondary" onClick={() => open({ ...item, isNew: false })}>
										{T.edit}
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={async () => {
											setResult(
												await call(
													'DELETE',
													`${base}/${encodeURIComponent(item.key)}/${item.channel}/${item.language}`,
												),
											);
											reload();
										}}>
										{T.delete}
									</Button>
								</span>
							</li>
						))}
					</ul>
				</Card>
			)}
			{result ? (
				result.ok ? (
					<Callout tone="success">{TEXTS.saved}</Callout>
				) : (
					<Callout tone="danger">{describeProblem(result.problem)}</Callout>
				)
			) : null}
			<Dialog open={draft !== null} onClose={() => setDraft(null)} title={title} size="lg">
				{draft ? (
					<Form onSubmit={save} aria-label={title}>
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
						{draft.channel === 'whatsapp' ? (
							<Input
								label={T.providerTemplate}
								value={draft.providerTemplate}
								onChange={(event) => edit({ providerTemplate: event.target.value })}
							/>
						) : null}
						{draft.channel === 'sms' || draft.channel === 'whatsapp' ? null : (
							<Input
								wide
								label={T.subject}
								value={draft.subject}
								maxLength={200}
								onChange={(event) => edit({ subject: event.target.value })}
							/>
						)}
						<TextArea label={T.text} rows={6} value={draft.text} onChange={(event) => edit({ text: event.target.value })} />
						<Checkbox
							wide
							label={T.required}
							checked={draft.required}
							onChange={(event) => edit({ required: event.target.checked })}
						/>
						<Checkbox
							wide
							label={T.urgent}
							checked={draft.urgent}
							onChange={(event) => edit({ urgent: event.target.checked })}
						/>
						{problem ? <Callout tone="danger">{describeProblem(problem)}</Callout> : null}
						<div className="flex flex-wrap gap-2">
							<Button type="submit">{TEXTS.save}</Button>
							<Button variant="ghost" onClick={() => setDraft(null)}>
								{TEXTS.cancel}
							</Button>
						</div>
					</Form>
				) : null}
			</Dialog>
		</Section>
	);
}
