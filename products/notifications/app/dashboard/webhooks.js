'use client';
/**
 * Settings → Webhook URLs (PLAN 0.8.10 N5): up to `webhooks.maxUrls` https URLs (five by default), each with the events it takes (none: every event),
 * saved whole with `PUT /v1/dashboard/websites/:websiteId/lists/webhook_urls { value }` (a 422 lists its `errors`).
 * @module
 */
import { useState } from 'react';
import {
	Button,
	Callout,
	Card,
	Input,
	Skeleton,
	TextArea,
	ToastOnce,
	describeProblem,
} from '@ss/ui';
import { call, fill, useLoad } from '@ss/ui/dashboard';
import { TEXTS } from './texts.js';

/** @typedef {{ url: string, events: string }} Row events as typed: one type per line */

const W = TEXTS.settings.webhooks;

/** @param {Array<{ url: string, events: string[] }>} value @returns {Row[]} */
const rowsOf = (value) => value.map((entry) => ({ url: entry.url, events: entry.events.join('\n') }));
/** @param {Row[]} rows */
const valueOf = (rows) =>
	rows.map((row) => ({
		url: row.url.trim(),
		events: row.events
			.split(/[\n,]/)
			.map((type) => type.trim())
			.filter((type) => type !== ''),
	}));

/**
 * The website's webhook URLs and the events each one takes.
 * @param {{ websiteId: string, off: boolean, max: number }} props `off`: the Outgoing webhooks feature is off (admins
 *   prepare it); `max`: the setting `webhooks.maxUrls`
 */
export function WebhookUrlsCard({ websiteId, off, max }) {
	const path = `/v1/dashboard/websites/${websiteId}/lists/webhook_urls`;
	const { answer, reload } = useLoad(path);
	const [draft, setDraft] = useState(/** @type {Row[] | null} */ (null));
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
	if (!answer) return <Skeleton lines={2} label={TEXTS.loading} />;
	if (!answer.ok) return <Callout tone="danger">{describeProblem(answer.problem)}</Callout>;
	const rows = draft ?? rowsOf(answer.data.value);
	/** @param {number} at @param {Partial<Row>} patch */
	const set = (at, patch) => setDraft(rows.map((row, i) => (i === at ? { ...row, ...patch } : row)));
	const errors = result && !result.ok && Array.isArray(result.problem?.errors) ? result.problem.errors : [];
	return (
		<Card title={W.title} subtitle={off ? TEXTS.settings.off : fill(W.help, { max })}>
			<div className="space-y-4">
				{rows.length === 0 ? <p className="text-sm text-muted">{W.none}</p> : null}
				{rows.map((row, at) => (
					<div key={at} className="space-y-3 rounded-card border border-line-soft p-4">
						<Input
							label={fill(W.url, { n: at + 1 })}
							type="url"
							value={row.url}
							maxLength={2048}
							placeholder="https://"
							onChange={(event) => set(at, { url: event.target.value })}
						/>
						<TextArea
							label={W.events}
							help={W.eventsHelp}
							rows={3}
							value={row.events}
							onChange={(event) => set(at, { events: event.target.value })}
						/>
						<Button size="sm" variant="ghost" onClick={() => setDraft(rows.filter((_, i) => i !== at))}>
							{W.remove}
						</Button>
					</div>
				))}
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="secondary"
						disabled={rows.length >= max}
						onClick={() => setDraft([...rows, { url: '', events: '' }])}>
						{W.add}
					</Button>
					<Button
						size="sm"
						disabled={draft === null}
						onClick={async () => {
							const next = await call('PUT', path, { value: valueOf(rows) });
							setResult(next);
							if (next.ok) {
								setDraft(null);
								reload();
							}
						}}>
						{TEXTS.save}
					</Button>
				</div>
				{result ? (
					result.ok ? (
						<ToastOnce title={TEXTS.saved} trigger={result} />
					) : (
						<Callout tone="danger">
							{errors.length > 0
								? errors.map((/** @type {{ path: string, message: string }} */ error) => (
										<span key={error.path} className="block">
											{fill(W.error, { n: Number(error.path.split('/')[2] ?? 0) + 1, message: error.message })}
										</span>
									))
								: describeProblem(result.problem)}
						</Callout>
					)
				) : null}
			</div>
		</Card>
	);
}
