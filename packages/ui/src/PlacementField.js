'use client';
/**
 * The `placement` widget of {@link SchemaForm} (F.18): edits a placement v1 object — where (paths, selectors, page
 * types, devices, referrers), when (schedule, triggers, frequency incl. cooldown and dismiss memory) and for whom
 * (consent categories, audience rule) an element renders. Only the members the element supports and the plan allows
 * are shown (`x-placement.members`, `x-plan[plan].members`); "Edit as JSON" edits the whole object. The Portal
 * validates the value against the placement v1 schema.
 * @module
 */
import { useState } from 'react';
import { Button } from './Button.js';
import { CheckboxGroup, Input, LABEL_CLASS, Select, TextArea } from './fields.js';
import { cx } from './cx.js';
import { placementMembersOf } from './schema.js';

/** @typedef {import('./schema.js').FeatureNode} FeatureNode */
/** @typedef {Record<string, any>} Placement */

const POSITIONS = ['append', 'prepend', 'before', 'after', 'replace'];
const DEVICES = ['mobile', 'tablet', 'desktop'];
const TRIGGERS = /** @type {const} */ ({
	load: { label: 'On load', param: 'delayMs', hint: 'Delay (ms)' },
	idle: { label: 'After idle time', param: 'afterMs', hint: 'Idle (ms)' },
	scroll: { label: 'On scroll', param: 'percent', hint: 'Scrolled (%)' },
	exit: { label: 'On exit intent', param: null, hint: '' },
	'selector-click': { label: 'On click', param: 'selector', hint: 'CSS selector' },
	event: { label: 'On event', param: 'event', hint: 'Event, e.g. cart.updated@1' },
});

/** @param {string} text @returns {string[]} */
const lines = (text) =>
	text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '');

/**
 * A copy of `value` with `key` set (or removed when `next` is empty).
 * @param {Placement} value
 * @param {string} key
 * @param {unknown} next
 * @returns {Placement}
 */
export const setMember = (value, key, next) => {
	const { [key]: _old, ...rest } = value;
	const empty =
		next === undefined ||
		next === '' ||
		(Array.isArray(next) && next.length === 0) ||
		(typeof next === 'object' && next !== null && !Array.isArray(next) && Object.keys(next).length === 0);
	return empty ? rest : { ...rest, [key]: next };
};

/**
 * Include/exclude lists (paths, referrers).
 * @param {{ id: string, label: string, value: Record<string, string[]> | undefined, onChange: (next: unknown) => void,
 *   placeholder: string, disabled: boolean }} props
 */
function IncludeExclude({ id, label, value, onChange, placeholder, disabled }) {
	const current = value ?? {};
	return (
		<div className="grid gap-3 sm:grid-cols-2">
			{
				/** @type {const} */ (['include', 'exclude']).map((side) => (
					<TextArea
						key={side}
						id={`${id}-${side}`}
						label={`${label}: ${side}`}
						rows={2}
						placeholder={placeholder}
						disabled={disabled}
						value={(current[side] ?? []).join('\n')}
						onChange={(e) => onChange(setMember(current, side, lines(e.currentTarget.value)))}
					/>
				))
			}
		</div>
	);
}

/**
 * @param {{ id: string, label: string, node: FeatureNode, value: unknown, onChange: (value: unknown) => void,
 *   error?: string, help?: import('react').ReactNode, aside?: import('react').ReactNode, disabled?: boolean,
 *   plan?: string | null }} props
 */
export function PlacementField({ id, label, node, value, onChange, error, help, aside, disabled = false, plan = null }) {
	const placement = /** @type {Placement} */ (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
	const members = placementMembersOf(node, plan);
	const [json, setJson] = useState(/** @type {string | null} */ (null));
	const [jsonError, setJsonError] = useState(/** @type {string | null} */ (null));
	/** @param {string} key @param {unknown} next */
	const set = (key, next) => onChange(setMember(placement, key, next));
	const has = (/** @type {string} */ key) => members.includes(key);
	const frequency = /** @type {Record<string, unknown>} */ (placement.frequency ?? {});
	const schedule = /** @type {Record<string, unknown>} */ (placement.schedule ?? {});
	/** @type {Array<Record<string, any>>} */
	const selectors = Array.isArray(placement.selectors) ? placement.selectors : [];
	/** @type {Array<Record<string, any>>} */
	const triggers = Array.isArray(placement.triggers) ? placement.triggers : [];

	return (
		<fieldset className="space-y-4 rounded-xl border border-line p-4" disabled={disabled} data-widget="placement">
			<legend className={cx(LABEL_CLASS, 'px-1')}>
				{label}
				{aside ? <span className="ml-2 normal-case tracking-normal">{aside}</span> : null}
			</legend>
			{help ? <p className="text-xs text-muted">{help}</p> : null}
			{json !== null ? (
				<TextArea
					id={`${id}-json`}
					label="Placement (JSON)"
					rows={10}
					className="font-mono text-xs"
					value={json}
					error={jsonError ?? undefined}
					onChange={(e) => {
						const text = e.currentTarget.value;
						setJson(text);
						try {
							const parsed = JSON.parse(text);
							if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
							onChange(parsed);
							setJsonError(null);
						} catch {
							setJsonError('Enter a JSON object.');
						}
					}}
				/>
			) : (
				<div className="space-y-4">
					{has('paths') ? (
						<IncludeExclude
							id={`${id}-paths`}
							label="Paths"
							placeholder="/products/**"
							disabled={disabled}
							value={placement.paths}
							onChange={(next) => set('paths', next)}
						/>
					) : null}
					{has('selectors') ? (
						<div className="space-y-2">
							<p className={LABEL_CLASS}>Mount at</p>
							{selectors.map((entry, index) => (
								<div key={index} className="flex flex-wrap items-end gap-2">
									<Input
										id={`${id}-selector-${index}`}
										label="CSS selector"
										value={String(entry.selector ?? '')}
										onChange={(e) =>
											set(
												'selectors',
												selectors.map((s, i) => (i === index ? { ...s, selector: e.currentTarget.value } : s)),
											)
										}
									/>
									<Select
										id={`${id}-position-${index}`}
										label="Position"
										options={POSITIONS.map((p) => ({ value: p, label: p }))}
										value={String(entry.position ?? 'append')}
										onChange={(e) =>
											set(
												'selectors',
												selectors.map((s, i) => (i === index ? { ...s, position: e.currentTarget.value } : s)),
											)
										}
									/>
									<Button
										variant="ghost"
										size="sm"
										onClick={() =>
											set(
												'selectors',
												selectors.filter((_, i) => i !== index),
											)
										}>
										Remove
									</Button>
								</div>
							))}
							<Button
								variant="secondary"
								size="sm"
								onClick={() => set('selectors', [...selectors, { selector: 'body', position: 'append' }])}>
								Add a mount point
							</Button>
						</div>
					) : null}
					{has('pageTypes') ? (
						<TextArea
							id={`${id}-pageTypes`}
							label="Page types"
							rows={2}
							placeholder="product"
							value={(placement.pageTypes ?? []).join('\n')}
							onChange={(e) => set('pageTypes', lines(e.currentTarget.value))}
						/>
					) : null}
					{has('devices') ? (
						<CheckboxGroup
							legend="Devices"
							options={DEVICES.map((d) => ({ value: d, label: d }))}
							value={placement.devices ?? []}
							onChange={(next) => set('devices', next)}
							disabled={disabled}
						/>
					) : null}
					{has('referrers') ? (
						<IncludeExclude
							id={`${id}-referrers`}
							label="Referrers"
							placeholder="*.google.com"
							disabled={disabled}
							value={placement.referrers}
							onChange={(next) => set('referrers', next)}
						/>
					) : null}
					{has('schedule') ? (
						<div className="grid gap-3 sm:grid-cols-3">
							{
								/** @type {const} */ ([
									['timezone', 'Time zone', 'Europe/Zurich'],
									['from', 'From (UTC)', '2026-12-01T00:00:00Z'],
									['until', 'Until (UTC)', '2026-12-31T23:59:59Z'],
								]).map(([key, text, example]) => (
									<Input
										key={key}
										id={`${id}-schedule-${key}`}
										label={text}
										placeholder={example}
										value={String(schedule[key] ?? '')}
										onChange={(e) => set('schedule', setMember(schedule, key, e.currentTarget.value.trim()))}
									/>
								))
							}
						</div>
					) : null}
					{has('consent') ? (
						<TextArea
							id={`${id}-consent`}
							label="Consent categories"
							rows={2}
							placeholder="marketing"
							value={(placement.consent ?? []).join('\n')}
							onChange={(e) => set('consent', lines(e.currentTarget.value))}
						/>
					) : null}
					{has('triggers') ? (
						<div className="space-y-2">
							<p className={LABEL_CLASS}>Triggers</p>
							{triggers.map((trigger, index) => {
								const type = /** @type {keyof typeof TRIGGERS} */ (trigger.type in TRIGGERS ? trigger.type : 'load');
								const param = TRIGGERS[type].param;
								/** @param {Record<string, any>} next */
								const replace = (next) =>
									set(
										'triggers',
										triggers.map((t, i) => (i === index ? next : t)),
									);
								return (
									<div key={index} className="flex flex-wrap items-end gap-2">
										<Select
											id={`${id}-trigger-${index}`}
											label="When"
											options={Object.entries(TRIGGERS).map(([v, t]) => ({ value: v, label: t.label }))}
											value={type}
											onChange={(e) => replace({ type: e.currentTarget.value })}
										/>
										{param ? (
											<Input
												id={`${id}-trigger-${index}-${param}`}
												label={TRIGGERS[type].hint}
												value={trigger[param] === undefined ? '' : String(trigger[param])}
												onChange={(e) => {
													const raw = e.currentTarget.value;
													const numeric = param === 'delayMs' || param === 'afterMs' || param === 'percent';
													replace(setMember(trigger, param, numeric ? (raw === '' ? undefined : Number(raw)) : raw));
												}}
											/>
										) : null}
										<Button
											variant="ghost"
											size="sm"
											onClick={() =>
												set(
													'triggers',
													triggers.filter((_, i) => i !== index),
												)
											}>
											Remove
										</Button>
									</div>
								);
							})}
							<Button variant="secondary" size="sm" onClick={() => set('triggers', [...triggers, { type: 'load' }])}>
								Add a trigger
							</Button>
						</div>
					) : null}
					{has('frequency') ? (
						<div className="grid gap-3 sm:grid-cols-3">
							{
								/** @type {const} */ ([
									['maxPerSession', 'Max per session'],
									['maxPerDay', 'Max per day'],
									['maxPerVisitor', 'Max per visitor'],
								]).map(([key, text]) => (
									<Input
										key={key}
										id={`${id}-frequency-${key}`}
										label={text}
										type="number"
										min={1}
										value={frequency[key] === undefined ? '' : String(frequency[key])}
										onChange={(e) => {
											const raw = e.currentTarget.value;
											set('frequency', setMember(frequency, key, raw === '' ? undefined : Number(raw)));
										}}
									/>
								))
							}
							{
								/** @type {const} */ ([
									['cooldown', 'Cooldown', 'P1D'],
									['dismissMemory', 'Remember a dismissal for', 'P7D'],
								]).map(([key, text, example]) => (
									<Input
										key={key}
										id={`${id}-frequency-${key}`}
										label={text}
										placeholder={example}
										value={String(frequency[key] ?? '')}
										onChange={(e) => set('frequency', setMember(frequency, key, e.currentTarget.value.trim()))}
									/>
								))
							}
						</div>
					) : null}
					{has('audience') ? (
						<TextArea
							id={`${id}-audience`}
							label="Audience rule"
							rows={2}
							className="font-mono text-xs"
							placeholder="device == 'mobile' and page.pageType == 'product'"
							value={String(placement.audience ?? '')}
							onChange={(e) => set('audience', e.currentTarget.value)}
						/>
					) : null}
				</div>
			)}
			<Button
				variant="ghost"
				size="sm"
				onClick={() => {
					setJson(json === null ? JSON.stringify(placement, null, 2) : null);
					setJsonError(null);
				}}>
				{json === null ? 'Edit as JSON' : 'Back to the form'}
			</Button>
			{error ? (
				<p role="alert" className="text-xs font-medium text-danger">
					{error}
				</p>
			) : null}
		</fieldset>
	);
}
