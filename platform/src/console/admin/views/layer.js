'use client';
/**
 * Staff editor of one configuration layer — the per-subscription **admin override** layer or an app's **platform
 * policy** — rendered from the manifest feature schemas with SchemaForm, plus per-element switches and a lock toggle
 * for every lockable feature (`x-lock` not `false`). Admin values may exceed plan maxima (absolute schema bounds
 * still apply), so plan bounds are not enforced here. Also: the version history of a layer with rollback.
 * @module
 */
import { useMemo, useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	ConfirmDialog,
	EmptyState,
	Form,
	FormActions,
	FormError,
	Input,
	SchemaForm,
	Select,
	Switch,
	Table,
	changedNames,
	describeProblem,
	fieldErrors,
	fieldsOf,
	formatDateTime,
	sameValue,
	validateValues,
} from '@ss/ui';
import { diffLine } from '../../views/configure.js';
import { ActorLabel, localProblem } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */
/** @typedef {{ elements: Record<string, { enabled: boolean, locked?: boolean }>, features: Record<string, { value: unknown, locked?: boolean }> }} LayerState */

/**
 * Feature values shown for an element: the layer's own value, else the effective document value, else the default.
 * @param {any} element manifest element
 * @param {LayerState} layer
 * @param {any} effective preview document (optional)
 * @returns {Record<string, unknown>}
 */
export const layerValues = (element, layer, effective) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const [name, node] of Object.entries(/** @type {Record<string, any>} */ (element.features?.properties ?? {}))) {
		const key = `${element.key}.${name}`;
		if (Object.hasOwn(layer.features, key)) out[name] = /** @type {any} */ (layer.features[key]).value;
		else if (effective?.features?.[key]) out[name] = effective.features[key].value;
		else out[name] = node.default;
	}
	return out;
};

/**
 * Change ops (config `ChangeOps`) of an element edit: set / lock features that changed, remove reset ones, and the
 * element switch.
 * @param {{ element: any, layer: LayerState, values: Record<string, unknown>, baseline: Record<string, unknown>,
 *   locks: Record<string, boolean>, removed: readonly string[], elementMode: 'inherit' | 'on' | 'off', elementLocked: boolean }} input
 */
export const layerChange = ({ element, layer, values, baseline, locks, removed, elementMode, elementLocked }) => {
	/** @type {Record<string, { value: unknown, locked?: boolean } | null>} */
	const features = {};
	const names = new Set([...changedNames(baseline, values), ...Object.keys(locks)]);
	for (const name of names) {
		const key = `${element.key}.${name}`;
		const current = layer.features[key];
		const locked = locks[name] ?? current?.locked === true;
		const valueChanged = !sameValue(baseline[name], values[name]);
		if (!valueChanged && current && (current.locked === true) === locked) continue;
		if (!valueChanged && !current && !locked) continue;
		features[key] = { value: values[name], ...(locked ? { locked: true } : {}) };
	}
	for (const name of removed) features[`${element.key}.${name}`] = null;
	/** @type {Record<string, { enabled: boolean, locked?: boolean } | null>} */
	const elements = {};
	const before = layer.elements[element.key];
	if (elementMode === 'inherit') {
		if (before) elements[element.key] = null;
	} else {
		const enabled = elementMode === 'on';
		if (!before || before.enabled !== enabled || (before.locked === true) !== elementLocked)
			elements[element.key] = { enabled, ...(elementLocked ? { locked: true } : {}) };
	}
	return {
		...(Object.keys(features).length > 0 ? { features } : {}),
		...(Object.keys(elements).length > 0 ? { elements } : {}),
	};
};

/**
 * @param {{ title: string, subtitle?: import('react').ReactNode, manifest: any, layer: LayerState, effective?: any,
 *   canWrite: boolean, onSave: (change: Record<string, unknown>, reason: string) => Promise<{ ok: boolean, problem?: Problem }>,
 *   requireReason?: boolean }} props
 */
export function LayerEditor({ title, subtitle, manifest, layer, effective = null, canWrite, onSave, requireReason = true }) {
	const elements = /** @type {any[]} */ (manifest?.elements ?? []);
	const [elementKey, setElementKey] = useState(elements[0]?.key ?? '');
	const element = elements.find((e) => e.key === elementKey) ?? elements[0];
	const baseline = useMemo(() => (element ? layerValues(element, layer, effective) : {}), [element, layer, effective]);
	const [drafts, setDrafts] = useState(/** @type {Record<string, unknown>} */ ({}));
	const [locks, setLocks] = useState(/** @type {Record<string, boolean>} */ ({}));
	const [removed, setRemoved] = useState(/** @type {string[]} */ ([]));
	const current = element ? layer.elements[element.key] : undefined;
	const [elementMode, setElementMode] = useState(
		/** @type {'inherit' | 'on' | 'off'} */ (current ? (current.enabled ? 'on' : 'off') : 'inherit'),
	);
	const [elementLocked, setElementLocked] = useState(current?.locked === true);
	const [reason, setReason] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);

	if (!element)
		return (
			<Card title={title}>
				<EmptyState compact icon="sliders" title="No elements" description="The manifest declares no elements." />
			</Card>
		);
	const schema = element.features ?? null;
	const fields = fieldsOf(schema);
	const values = { ...baseline, ...drafts };
	const switchTo = (/** @type {string} */ key) => {
		const next = elements.find((e) => e.key === key);
		const entry = next ? layer.elements[next.key] : undefined;
		setElementKey(key);
		setDrafts({});
		setLocks({});
		setRemoved([]);
		setErrors({});
		setProblem(null);
		setElementMode(entry ? (entry.enabled ? 'on' : 'off') : 'inherit');
		setElementLocked(entry?.locked === true);
	};
	const change = layerChange({ element, layer, values, baseline, locks, removed, elementMode, elementLocked });
	const dirty = Object.keys(change).length > 0;
	const save = async () => {
		const local = schema ? validateValues(schema, values, { plan: null }) : {};
		const relevant = Object.fromEntries(
			Object.entries(local).filter(([n]) => Object.hasOwn(drafts, n) || Object.hasOwn(locks, n)),
		);
		setErrors(relevant);
		if (Object.keys(relevant).length > 0) return;
		if (requireReason && !reason.trim()) {
			setErrors({ _reason: 'Give a reason; it is stored with the version.' });
			return;
		}
		setBusy(true);
		setProblem(null);
		const result = await onSave(change, reason.trim());
		setBusy(false);
		if (!result.ok) {
			const p = result.problem ?? null;
			setProblem(p);
			const prefix = `${element.key}.`;
			setErrors(
				Object.fromEntries(
					Object.entries(fieldErrors(p, { base: '/features/' }))
						.filter(([k]) => k.startsWith(prefix))
						.map(([k, v]) => [k.slice(prefix.length).split('.')[0] ?? k, v]),
				),
			);
			return;
		}
		setDrafts({});
		setLocks({});
		setRemoved([]);
		setReason('');
	};
	/** @type {Record<string, boolean>} */
	const overridden = Object.fromEntries(
		fields.map((f) => [f.name, Object.hasOwn(layer.features, `${element.key}.${f.name}`) && !removed.includes(f.name)]),
	);
	return (
		<Card
			title={title}
			subtitle={subtitle}
			actions={
				elements.length > 1 ? (
					<Select
						label="Element"
						hideLabel
						value={element.key}
						onChange={(e) => switchTo(e.currentTarget.value)}
						options={elements.map((e) => ({ value: e.key, label: e.name ?? e.key }))}
					/>
				) : null
			}>
			<Form onSubmit={save} busy={busy} aria-label={`${element.name ?? element.key} ${title}`}>
				<fieldset className="space-y-3 rounded-xl border border-line p-4">
					<legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted">
						Element {element.name ?? element.key}
					</legend>
					<Select
						label="Element switch"
						value={elementMode}
						disabled={!canWrite}
						onChange={(e) => setElementMode(/** @type {any} */ (e.currentTarget.value))}
						options={[
							{ value: 'inherit', label: 'Inherit (no override)' },
							{ value: 'on', label: 'Force on' },
							{ value: 'off', label: 'Force off' },
						]}
					/>
					{elementMode !== 'inherit' ? (
						<Switch
							label="Lock the element switch"
							description="Lower levels (website overrides) cannot change it."
							checked={elementLocked}
							disabled={!canWrite}
							onChange={setElementLocked}
						/>
					) : null}
				</fieldset>
				{schema ? (
					<>
						<SchemaForm
							schema={schema}
							values={values}
							plan={null}
							errors={errors}
							overridden={overridden}
							disabled={!canWrite || busy}
							idPrefix={`layer-${element.key}`}
							onReset={(name) => {
								setRemoved((r) => [...new Set([...r, name])]);
								setDrafts(({ [name]: _gone, ...rest }) => rest);
								setLocks(({ [name]: _l, ...rest }) => rest);
							}}
							onChange={(name, value) => {
								setDrafts((d) => ({ ...d, [name]: value }));
								setRemoved((r) => r.filter((n) => n !== name));
							}}
						/>
						<fieldset className="space-y-2 rounded-xl border border-line p-4">
							<legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted">Locks</legend>
							<p className="text-xs text-muted">A locked value wins over every lower level (website overrides).</p>
							{fields.map((f) => {
								const key = `${element.key}.${f.name}`;
								const locked = locks[f.name] ?? layer.features[key]?.locked === true;
								return f.lockable ? (
									<Switch
										key={f.name}
										size="sm"
										label={`Lock ${f.title}`}
										checked={locked && !removed.includes(f.name)}
										disabled={!canWrite || removed.includes(f.name)}
										onChange={(next) => setLocks((l) => ({ ...l, [f.name]: next }))}
									/>
								) : (
									<p key={f.name} className="text-xs text-muted">
										{f.title}: not lockable (x-lock false)
									</p>
								);
							})}
						</fieldset>
					</>
				) : (
					<p className="text-sm text-muted">This element has no settings.</p>
				)}
				{canWrite ? (
					<>
						<Input
							label="Reason"
							value={reason}
							maxLength={200}
							onChange={(e) => setReason(e.currentTarget.value)}
							error={errors._reason}
							required={requireReason}
							help="Stored with the version and in the audit log."
						/>
						<FormError problem={problem} fields={fields.map((f) => `${element.key}.${f.name}`)} />
						<FormActions>
							<span className="w-full text-xs text-muted sm:mr-auto sm:w-auto" aria-live="polite">
								{dirty ? 'Unsaved changes.' : 'No unsaved changes.'}
							</span>
							<Button
								variant="secondary"
								disabled={!dirty || busy}
								onClick={() => {
									setDrafts({});
									setLocks({});
									setRemoved([]);
									switchTo(element.key);
								}}>
								Discard
							</Button>
							<Button type="submit" loading={busy} disabled={!dirty}>
								Save version
							</Button>
						</FormActions>
					</>
				) : (
					<Callout tone="info" live={false}>
						Your role can read this layer but not change it.
					</Callout>
				)}
			</Form>
		</Card>
	);
}

/**
 * Version history of a layer with rollback (a rollback creates a new version with the old state).
 * @param {{ title: string, history: { items: any[] }, canWrite: boolean,
 *   onRollback: (version: number, reason: string) => Promise<{ ok: boolean, problem?: Problem }> }} props
 */
export function LayerHistory({ title, history, canWrite, onRollback }) {
	const [target, setTarget] = useState(/** @type {any} */ (null));
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const items = /** @type {any[]} */ (history?.items ?? []);
	const latest = items[0]?.version ?? null;
	const rollback = async () => {
		if (!reason.trim()) {
			setProblem(localProblem('A reason is required', 'Say why you roll back; it is stored with the new version.'));
			return;
		}
		setBusy(true);
		setProblem(null);
		const result = await onRollback(target.version, reason.trim());
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem ?? null);
			return;
		}
		setTarget(null);
		setReason('');
	};
	return (
		<Card title={title}>
			<Table
				caption={title}
				dense
				rows={items}
				rowKey={(v) => String(v.version)}
				empty="No versions yet."
				columns={[
					{
						key: 'version',
						header: 'Version',
						rowHeader: true,
						render: (v) => <span className="tabular-nums">v{v.version}</span>,
					},
					{ key: 'at', header: 'When', render: (v) => formatDateTime(v.at) },
					{ key: 'actor', header: 'By', render: (v) => <ActorLabel actor={v.actor} /> },
					{
						key: 'diff',
						header: 'Change',
						render: (v) => (
							<span className="block space-y-0.5 text-xs">
								{v.rollbackOf !== undefined ? <Badge tone="info">Rollback to v{v.rollbackOf}</Badge> : null}
								{
									/** @type {any[]} */ (v.diff ?? []).slice(0, 4).map((d, i) => (
										<span key={i} className="block">
											{diffLine(d)}
										</span>
									))
								}
								{(v.diff ?? []).length > 4 ? <span className="block text-muted">+{v.diff.length - 4} more</span> : null}
								{v.reason ? <span className="block text-muted">“{v.reason}”</span> : null}
							</span>
						),
					},
					{
						key: 'actions',
						header: <span className="sr-only">Actions</span>,
						align: 'right',
						render: (v) =>
							canWrite && v.version !== latest ? (
								<Button size="sm" variant="ghost" onClick={() => setTarget(v)}>
									Roll back
								</Button>
							) : null,
					},
				]}
			/>
			<ConfirmDialog
				open={Boolean(target)}
				onClose={() => setTarget(null)}
				onConfirm={() => void rollback()}
				busy={busy}
				title={`Roll back to v${target?.version ?? ''}?`}
				confirmLabel="Roll back"
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					A new version restores the state of v{target?.version}. Entitlement documents are re-signed within seconds.
				</p>
				<Input label="Reason" value={reason} maxLength={200} onChange={(e) => setReason(e.currentTarget.value)} required />
			</ConfirmDialog>
		</Card>
	);
}
