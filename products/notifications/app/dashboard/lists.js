'use client';
/**
 * Settings → the merchant's own lists (fixed-choices N2, N4–N7): unsubscribe topics, template settings, fallback
 * channels, quiet hours and unsubscribe keywords per language. Each card adds, renames, reorders and removes rows and saves the list whole with
 * `PUT /v1/dashboard/websites/:websiteId/lists/<name> { value }` (the kit's route; a 422 lists its `errors` by row).
 * @module
 */
import { useState } from 'react';
import {
	Button,
	Callout,
	Card,
	Checkbox,
	EntryGroup,
	Input,
	Select,
	SettingsCardSkeleton,
	TextArea,
	describeProblem,
	SaveBar,
} from '@ss/ui';
import { CHANNELS, FALLBACK_CHANNELS } from '../../core/channels.js';
import { SaveOutcome, call, fill, useLoad } from '@ss/ui/dashboard';
import { TEXTS } from './texts.js';

const L = TEXTS.settings.lists;
const CHANNEL_NAMES = TEXTS.settings.channels;
/** Weekdays as the lists number them (0 = Sunday). */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * @template T
 * @typedef {object} ListCardProps
 * @property {string} websiteId
 * @property {string} name the list
 * @property {string} title
 * @property {string} help
 * @property {boolean} off its feature is off (admins prepare it)
 * @property {() => T} blank a new row
 * @property {(row: T, set: (patch: Partial<T>) => void, at: number) => import('react').ReactNode} render a row's fields
 * @property {(value: any[]) => T[]} [rows] the saved list as rows (default: as is)
 * @property {(rows: T[]) => unknown[]} [value] the rows as the list (default: as is)
 * @property {number} max rows at most
 */

/**
 * The refused rows of a save as lines (`Row 2: message`).
 * @param {any} problem
 * @returns {string[]}
 */
const rowErrors = (problem) =>
	Array.isArray(problem?.errors)
		? problem.errors.map((/** @type {{ path: string, message: string }} */ error) =>
				fill(L.error, { n: Number(error.path.split('/')[2] ?? 0) + 1, message: error.message }),
			)
		: [];

/**
 * A list saved whole: rows with Move up, Move down and Remove, Add, Save, and the errors of a refused save by row.
 * @template T
 * @param {ListCardProps<T>} props
 */
function ListCard({ websiteId, name, title, help, off, blank, render, rows: toRows, value: toValue, max }) {
	const path = `/v1/dashboard/websites/${websiteId}/lists/${name}`;
	const { answer, reload } = useLoad(path);
	const [draft, setDraft] = useState(/** @type {T[] | null} */ (null));
	const [result, setResult] = useState(/** @type {import('@ss/ui/dashboard').Answer | null} */ (null));
	if (!answer) return <SettingsCardSkeleton rows={2} />;
	if (!answer.ok) return <Callout tone="danger">{describeProblem(answer.problem)}</Callout>;
	const saved = /** @type {any[]} */ (answer.data.value);
	const rows = draft ?? (toRows ? toRows(saved) : /** @type {T[]} */ (saved));
	/** @param {number} at @param {Partial<T>} patch */
	const set = (at, patch) => setDraft(rows.map((row, i) => (i === at ? { ...row, ...patch } : row)));
	/** @param {number} from @param {number} to */
	const move = (from, to) => {
		const next = [...rows];
		const [row] = next.splice(from, 1);
		next.splice(to, 0, /** @type {T} */ (row));
		setDraft(next);
	};
	return (
		<Card title={title} subtitle={off ? TEXTS.settings.off : help}>
			<div className="space-y-4">
				{rows.length === 0 ? <p className="text-sm text-muted">{L.none}</p> : null}
				{rows.map((row, at) => (
					<EntryGroup
						key={at}
						first={at === 0}
						last={at === rows.length - 1}
						texts={{ moveUp: L.up, moveDown: L.down, remove: L.remove }}
						onMove={(step) => move(at, at + step)}
						onRemove={() => setDraft(rows.filter((_, i) => i !== at))}>
						{render(row, (patch) => set(at, patch), at)}
					</EntryGroup>
				))}
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="secondary" disabled={rows.length >= max} onClick={() => setDraft([...rows, blank()])}>
						{L.add}
					</Button>
				</div>
				<SaveBar
					show={draft !== null}
					saveLabel={TEXTS.save}
					discardLabel={TEXTS.cancel}
					onDiscard={() => setDraft(null)}
					onSave={async () => {
						const next = await call('PUT', path, { value: toValue ? toValue(rows) : rows });
						setResult(next);
						if (next.ok) {
							setDraft(null);
							reload();
						}
					}}
				/>
				<SaveOutcome result={result} format={rowErrors} />
			</div>
		</Card>
	);
}

/**
 * Channels as checkboxes; an ordered pick (a fallback chain) keeps the order they were picked in and shows it.
 * @param {{ label: string, options: ReadonlyArray<string>, value: string[], onChange: (next: string[]) => void,
 *   ordered?: boolean }} props
 */
function ChannelPicks({ label, options, value, onChange, ordered = false }) {
	return (
		<fieldset className="space-y-2">
			<legend className="text-sm font-medium text-fg">{label}</legend>
			<div className="flex flex-wrap gap-4">
				{options.map((channel) => (
					<Checkbox
						key={channel}
						label={CHANNEL_NAMES[/** @type {keyof typeof CHANNEL_NAMES} */ (channel)]}
						checked={value.includes(channel)}
						onChange={(event) =>
							onChange(event.target.checked ? [...value, channel] : value.filter((other) => other !== channel))
						}
					/>
				))}
			</div>
			{ordered && value.length > 1 ? (
				<p className="text-xs text-muted">
					{fill(L.order, {
						order: value.map((channel) => CHANNEL_NAMES[/** @type {keyof typeof CHANNEL_NAMES} */ (channel)]).join(' → '),
					})}
				</p>
			) : null}
		</fieldset>
	);
}

/** @typedef {{ id?: string, name: string }} TopicRow */

/** @param {{ websiteId: string, off: boolean }} props */
export function TopicsCard({ websiteId, off }) {
	return (
		<ListCard
			websiteId={websiteId}
			name="topics"
			title={L.topics.title}
			help={L.topics.help}
			off={off}
			max={20}
			blank={() => /** @type {TopicRow} */ ({ name: '' })}
			render={(row, set, at) => (
				<Input
					label={fill(L.topics.name, { n: at + 1 })}
					value={row.name}
					maxLength={60}
					help={row.id ? fill(L.topics.id, { id: row.id }) : undefined}
					onChange={(event) => set({ name: event.target.value })}
				/>
			)}
		/>
	);
}

/** @typedef {{ key: string, topic: string | null, fallback: string[] | null, capped: boolean | null }} TemplateSettingsRow */

/** @param {{ websiteId: string, off: boolean }} props */
export function TemplateSettingsCard({ websiteId, off }) {
	const topics = useLoad(`/v1/dashboard/websites/${websiteId}/lists/topics`);
	const known = topics.answer?.ok ? /** @type {Array<{ id: string, name: string }>} */ (topics.answer.data.value) : [];
	return (
		<ListCard
			websiteId={websiteId}
			name="template_settings"
			title={L.templates.title}
			help={L.templates.help}
			off={off}
			max={1000}
			blank={() => /** @type {TemplateSettingsRow} */ ({ key: '', topic: null, fallback: null, capped: null })}
			render={(row, set) => (
				<>
					<Input
						label={L.templates.key}
						value={row.key}
						maxLength={64}
						placeholder="order.shipped"
						onChange={(event) => set({ key: event.target.value.trim() })}
					/>
					<Select
						label={L.templates.topic}
						value={row.topic ?? ''}
						options={[
							{ value: '', label: L.templates.noTopic },
							...known.map((topic) => ({ value: topic.id, label: topic.name })),
						]}
						onChange={(event) => set({ topic: event.target.value || null })}
					/>
					<Select
						label={L.templates.capped}
						value={row.capped === null ? '' : String(row.capped)}
						options={[
							{ value: '', label: L.templates.cappedRule },
							{ value: 'true', label: L.templates.cappedYes },
							{ value: 'false', label: L.templates.cappedNo },
						]}
						onChange={(event) => set({ capped: event.target.value === '' ? null : event.target.value === 'true' })}
					/>
					<Checkbox
						label={L.templates.ownFallback}
						checked={row.fallback !== null}
						onChange={(event) => set({ fallback: event.target.checked ? [] : null })}
					/>
					{row.fallback !== null ? (
						<ChannelPicks
							label={L.templates.fallback}
							options={FALLBACK_CHANNELS}
							value={row.fallback}
							ordered
							onChange={(fallback) => set({ fallback })}
						/>
					) : null}
				</>
			)}
		/>
	);
}

/** @typedef {{ channel: string, then: string[] }} ChainRow */

/** @param {{ websiteId: string, off: boolean }} props */
export function FallbackChainsCard({ websiteId, off }) {
	return (
		<ListCard
			websiteId={websiteId}
			name="fallback_chains"
			title={L.fallback.title}
			help={L.fallback.help}
			off={off}
			max={FALLBACK_CHANNELS.length}
			blank={() => /** @type {ChainRow} */ ({ channel: 'whatsapp', then: [] })}
			render={(row, set) => (
				<>
					<Select
						label={L.fallback.when}
						value={row.channel}
						options={FALLBACK_CHANNELS.map((channel) => ({ value: channel, label: CHANNEL_NAMES[channel] }))}
						onChange={(event) =>
							set({ channel: event.target.value, then: row.then.filter((c) => c !== event.target.value) })
						}
					/>
					<ChannelPicks
						label={L.fallback.then}
						options={FALLBACK_CHANNELS.filter((channel) => channel !== row.channel)}
						value={row.then}
						ordered
						onChange={(then) => set({ then })}
					/>
				</>
			)}
		/>
	);
}

/** @typedef {{ days: number[], from: string, until: string, channels: string[] }} QuietRow */

/** @param {{ websiteId: string, off: boolean }} props */
export function QuietHoursCard({ websiteId, off }) {
	return (
		<ListCard
			websiteId={websiteId}
			name="quiet_hours"
			title={L.quiet.title}
			help={L.quiet.help}
			off={off}
			max={50}
			blank={() => /** @type {QuietRow} */ ({ days: [...WEEKDAYS], from: '21:00', until: '08:00', channels: [] })}
			render={(row, set) => (
				<>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium text-fg">{L.quiet.days}</legend>
						<div className="flex flex-wrap gap-4">
							{WEEKDAYS.map((day) => (
								<Checkbox
									key={day}
									label={/** @type {string} */ (L.quiet.weekdays[day])}
									checked={row.days.includes(day)}
									onChange={(event) =>
										set({
											days: event.target.checked
												? [...row.days, day].sort((a, b) => a - b)
												: row.days.filter((other) => other !== day),
										})
									}
								/>
							))}
						</div>
					</fieldset>
					<Input label={L.quiet.from} type="time" value={row.from} onChange={(event) => set({ from: event.target.value })} />
					<Input
						label={L.quiet.until}
						type="time"
						value={row.until}
						help={L.quiet.untilHelp}
						onChange={(event) => set({ until: event.target.value })}
					/>
					<ChannelPicks
						label={L.quiet.channels}
						options={CHANNELS}
						value={row.channels}
						onChange={(channels) => set({ channels })}
					/>
				</>
			)}
		/>
	);
}

/** @typedef {{ language: string, words: string }} KeywordsRow words as typed: one per line */

/** @param {{ websiteId: string, off: boolean }} props */
export function StopKeywordsCard({ websiteId, off }) {
	return (
		<ListCard
			websiteId={websiteId}
			name="stop_keywords"
			title={L.keywords.title}
			help={L.keywords.help}
			off={off}
			max={30}
			blank={() => /** @type {KeywordsRow} */ ({ language: '', words: '' })}
			rows={(value) => value.map((entry) => ({ language: entry.language, words: entry.words.join('\n') }))}
			value={(rows) =>
				rows.map((/** @type {KeywordsRow} */ row) => ({
					language: row.language.trim(),
					words: row.words
						.split('\n')
						.map((/** @type {string} */ word) => word.trim())
						.filter(Boolean),
				}))
			}
			render={(row, set) => (
				<>
					<Input
						label={L.keywords.language}
						value={row.language}
						maxLength={35}
						onChange={(event) => set({ language: event.target.value })}
					/>
					<TextArea
						label={L.keywords.words}
						rows={3}
						value={row.words}
						onChange={(event) => set({ words: event.target.value })}
					/>
				</>
			)}
		/>
	);
}

/**
 * The lists' cards in Settings, each while one of its features is listed (off: admins prepare it).
 * @param {{ websiteId: string, features: Array<{ key: string, on?: boolean }> }} props
 */
export function MerchantLists({ websiteId, features }) {
	/** @param {string[]} keys @returns {boolean | null} null: none listed; else whether all are off */
	const offOf = (keys) => {
		const listed = features.filter((feature) => keys.includes(feature.key));
		return listed.length === 0 ? null : listed.every((feature) => feature.on === false);
	};
	const customers = offOf(['email', 'sms', 'whatsapp', 'browser_push']);
	const sending = offOf(['email', 'sms', 'whatsapp', 'browser_push', 'staff_push', 'send_api']);
	const fallback = offOf(['fallback']);
	const quiet = offOf(['quiet_hours']);
	const replies = offOf(['sms', 'whatsapp']);
	return (
		<>
			{customers === null ? null : <TopicsCard websiteId={websiteId} off={customers} />}
			{sending === null ? null : <TemplateSettingsCard websiteId={websiteId} off={sending} />}
			{fallback === null ? null : <FallbackChainsCard websiteId={websiteId} off={fallback} />}
			{quiet === null ? null : <QuietHoursCard websiteId={websiteId} off={quiet} />}
			{replies === null ? null : <StopKeywordsCard websiteId={websiteId} off={replies} />}
		</>
	);
}
