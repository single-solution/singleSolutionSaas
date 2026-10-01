'use client';
/**
 * Subscription configuration: per-element SchemaForm (plan bounds, locks, reset to inherited), preview diff,
 * save; scheduled changes; experiments.
 * @module
 */
import { useMemo, useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	ConfirmDialog,
	Dialog,
	EmptyState,
	Form,
	FormActions,
	FormError,
	Input,
	RadioGroup,
	SchemaForm,
	Select,
	StatusBadge,
	TextArea,
	changedNames,
	describeProblem,
	fieldErrors,
	fieldsOf,
	formatDateTime,
	lockLabel,
	useToast,
	validateValues,
} from '@ss/ui';
import { apiFetch } from '../client.js';
import { api } from '../paths.js';

/** @typedef {import('@ss/ui').Problem} Problem */
/** @typedef {import('@ss/ui').LockInfo} LockInfo */

/**
 * Elements of a product that have settings.
 * @param {any} product
 * @returns {any[]}
 */
export const configurableElements = (product) =>
	/** @type {any[]} */ (product?.elements ?? []).filter(
		(e) => e.features && Object.keys(e.features.properties ?? {}).length > 0,
	);

/**
 * Effective values of an element's features (the resolved entitlement preview), falling back to schema defaults.
 * @param {any} element
 * @param {any} effective preview document
 * @returns {Record<string, unknown>}
 */
export const effectiveValues = (element, effective) => {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const [name, node] of Object.entries(/** @type {Record<string, any>} */ (element.features?.properties ?? {}))) {
		const doc = effective?.features?.[`${element.key}.${name}`];
		const config = effective?.config?.[element.key];
		out[name] = doc ? doc.value : config && Object.hasOwn(config, name) ? config[name] : node.default;
	}
	return out;
};

/**
 * Locks of an element's features: locked in the resolved document by anyone but the website itself, or locked in
 * a higher layer (platform policy, admin, merchant defaults).
 * @param {any} element
 * @param {any} effective preview document
 * @param {any} layers configuration layers
 * @returns {Record<string, LockInfo>}
 */
export const featureLocks = (element, effective, layers) => {
	/** @type {Record<string, LockInfo>} */
	const locks = {};
	for (const name of Object.keys(element.features?.properties ?? {})) {
		const key = `${element.key}.${name}`;
		const doc = effective?.features?.[key];
		if (doc?.locked === true && doc.source !== 'website_override') {
			locks[name] = { label: lockLabel(doc.source) };
			continue;
		}
		for (const [level, source] of /** @type {const} */ ([
			['admin', 'admin_override'],
			['platform', 'platform_policy'],
			['merchant', 'merchant_default'],
		])) {
			if (layers?.[level]?.features?.[key]?.locked === true) {
				locks[name] = { label: lockLabel(source) };
				break;
			}
		}
	}
	return locks;
};

/**
 * One-line summary of a configuration diff entry.
 * @param {{ kind?: string, key?: string, op?: string, before?: any, after?: any }} d
 */
export const diffLine = (d) => {
	/** @param {any} v */
	const show = (v) => {
		if (v === undefined) return '—';
		const inner =
			v && typeof v === 'object' && !Array.isArray(v) && 'value' in v
				? v.value
				: v && typeof v === 'object' && 'enabled' in v
					? v.enabled
						? 'on'
						: 'off'
					: v;
		return inner === null ? 'unlimited' : typeof inner === 'object' ? JSON.stringify(inner) : String(inner);
	};
	const what = d.kind === 'elements' ? `Element ${d.key}` : (d.key ?? 'setting');
	if (d.op === 'added') return `${what} set to ${show(d.after)}`;
	if (d.op === 'removed') return `${what} reset (was ${show(d.before)})`;
	return `${what}: ${show(d.before)} → ${show(d.after)}`;
};

/**
 * @param {{ merchantId: string, website: any, subscription: any, product: any, overview: any, effective: any,
 *   onSaved: () => Promise<void> | void, readOnly?: boolean }} props
 */
export function ConfigurePanel({ merchantId, website, subscription, product, overview, effective, onSaved, readOnly = false }) {
	const toast = useToast();
	const elements = configurableElements(product);
	const [elementKey, setElementKey] = useState(elements[0]?.key ?? '');
	const element = elements.find((e) => e.key === elementKey) ?? elements[0];
	const baseline = useMemo(() => (element ? effectiveValues(element, effective) : {}), [element, effective]);
	const [drafts, setDrafts] = useState(/** @type {Record<string, Record<string, unknown>>} */ ({}));
	const values = element ? { ...baseline, ...(drafts[element.key] ?? {}) } : {};
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(/** @type {null | 'preview' | 'save' | 'reset'} */ (null));
	const [preview, setPreview] = useState(/** @type {any} */ (null));
	const configPath = api.config(merchantId, website.websiteId, subscription.subscriptionId);

	if (!element)
		return (
			<EmptyState title="Nothing to configure" description="The elements of this product have no settings." icon="sliders" />
		);

	const schema = element.features;
	const locks = featureLocks(element, effective, overview?.layers);
	const websiteLayer = overview?.layers?.website?.features ?? {};
	/** @type {Record<string, boolean>} */
	const overridden = Object.fromEntries(
		Object.keys(schema.properties).map((n) => [n, Object.hasOwn(websiteLayer, `${element.key}.${n}`)]),
	);
	const changed = changedNames(baseline, values).filter((n) => !locks[n]);
	const clamped = Object.keys(schema.properties).filter(
		(n) => effective?.features?.[`${element.key}.${n}`]?.reason === 'clamped',
	);
	const planCode = subscription.planCode ?? null;

	const change = () => ({
		features: Object.fromEntries(changed.map((n) => [`${element.key}.${n}`, { value: values[n] }])),
	});
	const validate = () => {
		const all = validateValues(schema, values, { plan: planCode, skip: Object.keys(locks) });
		const relevant = Object.fromEntries(Object.entries(all).filter(([n]) => changed.includes(n)));
		setErrors(relevant);
		return Object.keys(relevant).length === 0;
	};
	/** @param {Problem} p */
	const showProblem = (p) => {
		setProblem(p);
		const prefix = `${element.key}.`;
		setErrors(
			Object.fromEntries(
				Object.entries(fieldErrors(p, { base: '/features/' }))
					.filter(([k]) => k.startsWith(prefix))
					.map(([k, v]) => [k.slice(prefix.length).split('.')[0] ?? k, v]),
			),
		);
	};
	const runPreview = async () => {
		if (!validate()) return;
		setBusy('preview');
		setProblem(null);
		const result = await apiFetch(`${configPath}/preview`, { method: 'POST', body: { change: change() } });
		setBusy(null);
		if (result.ok) setPreview(result.data);
		else showProblem(result.problem);
	};
	const save = async () => {
		if (!validate()) return;
		setBusy('save');
		setProblem(null);
		const result = await apiFetch(configPath, {
			method: 'PATCH',
			body: { ...change(), ...(reason.trim() ? { reason: reason.trim() } : {}) },
		});
		setBusy(null);
		if (!result.ok) {
			showProblem(result.problem);
			return;
		}
		setPreview(null);
		setDrafts((d) => ({ ...d, [element.key]: {} }));
		setReason('');
		toast.show({ title: 'Configuration saved', description: `Version ${result.data?.version ?? ''} is live within seconds.` });
		await onSaved();
	};
	/** @param {string} name */
	const reset = async (name) => {
		setBusy('reset');
		setProblem(null);
		const result = await apiFetch(configPath, { method: 'PATCH', body: { features: { [`${element.key}.${name}`]: null } } });
		setBusy(null);
		if (!result.ok) {
			showProblem(result.problem);
			return;
		}
		setDrafts((d) => {
			const { [name]: _gone, ...rest } = d[element.key] ?? {};
			return { ...d, [element.key]: rest };
		});
		toast.show({ title: 'Setting reset', description: 'It now follows your plan and organisation defaults.' });
		await onSaved();
	};

	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
			<Card
				title={element.name}
				subtitle={planCode ? `Bounds of plan ${planCode} apply.` : 'Product bounds apply.'}
				actions={
					elements.length > 1 ? (
						<Select
							label="Element"
							hideLabel
							value={element.key}
							onChange={(e) => {
								setElementKey(e.currentTarget.value);
								setErrors({});
								setPreview(null);
								setProblem(null);
							}}
							options={elements.map((e) => ({ value: e.key, label: e.name }))}
						/>
					) : null
				}>
				<Form onSubmit={save} busy={busy !== null} aria-label={`${element.name} settings`}>
					{clamped.length > 0 ? (
						<Callout tone="warning" title="Some values are limited by your plan">
							{clamped.map((n) => schema.properties[n]?.title ?? n).join(', ')} {clamped.length === 1 ? 'is' : 'are'}{' '}
							capped at the plan maximum. Upgrade the plan to use a higher value.
						</Callout>
					) : null}
					<SchemaForm
						schema={schema}
						values={values}
						plan={planCode}
						locks={locks}
						errors={errors}
						overridden={overridden}
						disabled={readOnly || busy !== null}
						onReset={(name) => void reset(name)}
						onChange={(name, value) => {
							setDrafts((d) => ({ ...d, [element.key]: { ...(d[element.key] ?? {}), [name]: value } }));
							setPreview(null);
							setErrors((e) => {
								const { [name]: _x, ...rest } = e;
								return rest;
							});
						}}
					/>
					<Input
						label="Reason (optional)"
						value={reason}
						maxLength={200}
						onChange={(e) => setReason(e.currentTarget.value)}
						help="Shown in the history next to this version."
						disabled={readOnly}
					/>
					<FormError problem={problem} fields={Object.keys(schema.properties).map((n) => `${element.key}.${n}`)} />
					<FormActions>
						<span className="w-full text-xs text-muted sm:mr-auto sm:w-auto" aria-live="polite">
							{changed.length === 0
								? 'No unsaved changes.'
								: `${changed.length} unsaved change${changed.length === 1 ? '' : 's'}.`}
						</span>
						<Button
							variant="secondary"
							onClick={() => setDrafts((d) => ({ ...d, [element.key]: {} }))}
							disabled={changed.length === 0 || busy !== null}>
							Discard
						</Button>
						<Button
							variant="secondary"
							onClick={() => void runPreview()}
							loading={busy === 'preview'}
							disabled={changed.length === 0 || readOnly}>
							Preview
						</Button>
						<Button type="submit" loading={busy === 'save'} disabled={changed.length === 0 || readOnly}>
							Save
						</Button>
					</FormActions>
				</Form>
			</Card>
			<div className="space-y-4">
				<Card title="Preview" subtitle="What changes when you save.">
					{preview ? (
						<PreviewDiff preview={preview} element={element} />
					) : (
						<p className="text-sm text-muted">
							Edit settings, then choose Preview to see the effective result before saving.
						</p>
					)}
				</Card>
				<Card title="Legend">
					<ul className="space-y-2 text-xs text-muted">
						<li>
							<Badge tone="info">Plan max</Badge> the highest value your plan allows.
						</li>
						<li>Locked settings are set by the platform, an admin or your organisation and cannot be changed here.</li>
						<li>Reset removes this website's override so the setting follows defaults again.</li>
					</ul>
				</Card>
			</div>
		</div>
	);
}

/**
 * @param {{ preview: any, element: any }} props
 */
function PreviewDiff({ preview, element }) {
	const diff = /** @type {any[]} */ (preview.diff ?? []);
	const features = preview.preview?.features ?? {};
	if (diff.length === 0) return <p className="text-sm text-muted">No change compared with the current version.</p>;
	return (
		<div className="space-y-3">
			<ul className="space-y-1.5 text-sm">
				{diff.map((d, i) => (
					<li key={`${d.key}-${i}`} className="break-words font-mono text-xs text-fg">
						{diffLine(d)}
					</li>
				))}
			</ul>
			{diff
				.filter((d) => d.kind === 'features' && features[d.key]?.reason === 'clamped')
				.map((d) => (
					<Callout key={d.key} tone="warning" live={false}>
						{element.features.properties[String(d.key).slice(element.key.length + 1)]?.title ?? d.key} will be capped at{' '}
						{String(features[d.key].value)} by your plan.
					</Callout>
				))}
		</div>
	);
}

/**
 * Scheduled configuration changes.
 * @param {{ merchantId: string, website: any, subscription: any, product: any, schedules: any[],
 *   onChanged: () => Promise<void> | void }} props
 */
export function SchedulesPanel({ merchantId, website, subscription, product, schedules, onChanged }) {
	const toast = useToast();
	const base = `${api.config(merchantId, website.websiteId, subscription.subscriptionId)}/schedules`;
	const [open, setOpen] = useState(false);
	const [what, setWhat] = useState(/** @type {'feature' | 'element'} */ ('feature'));
	const elements = /** @type {any[]} */ (product?.elements ?? []);
	const features = elements.flatMap((e) =>
		fieldsOf(e.features).map((f) => ({ value: `${e.key}.${f.name}`, label: `${e.name} · ${f.title}`, node: f.node })),
	);
	const [featureKey, setFeatureKey] = useState(features[0]?.value ?? '');
	const [elementKey, setElementKey] = useState(elements[0]?.key ?? '');
	const [enabled, setEnabled] = useState('on');
	const [valueText, setValueText] = useState('');
	const [at, setAt] = useState('');
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [cancelling, setCancelling] = useState(/** @type {any} */ (null));

	const create = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		/** @type {unknown} */
		let value;
		if (what === 'feature') {
			const node = features.find((f) => f.value === featureKey)?.node;
			try {
				value = node?.type === 'string' && !/^".*"$/.test(valueText.trim()) ? valueText : JSON.parse(valueText);
			} catch {
				local.value = 'Enter a JSON value: a number, true/false, "text", [list] or {object}.';
			}
		}
		const when = at ? new Date(at) : null;
		if (!when || Number.isNaN(when.getTime())) local.at = 'Choose a date and time.';
		else if (when.getTime() <= Date.now()) local.at = 'Choose a time in the future.';
		setErrors(local);
		if (Object.keys(local).length > 0 || !when) return;
		setBusy(true);
		setProblem(null);
		const change =
			what === 'feature' ? { features: { [featureKey]: { value } } } : { elements: { [elementKey]: enabled === 'on' } };
		const result = await apiFetch(base, { method: 'POST', body: { change, at: when.toISOString() } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			const fe = fieldErrors(result.problem);
			setErrors({ ...(fe.at ? { at: fe.at } : {}) });
			return;
		}
		setOpen(false);
		setValueText('');
		setAt('');
		toast.show({ title: 'Change scheduled', description: `Applies at ${formatDateTime(when.toISOString())}.` });
		await onChanged();
	};
	const cancel = async () => {
		setBusy(true);
		const result = await apiFetch(`${base}/${encodeURIComponent(cancelling.scheduleId)}`, { method: 'DELETE' });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setCancelling(null);
		toast.show({ title: 'Scheduled change cancelled' });
		await onChanged();
	};

	return (
		<Card
			title="Scheduled changes"
			subtitle="Apply a setting or switch an element at a set time (validated again when it applies)."
			padded={false}
			actions={
				<Button size="sm" onClick={() => setOpen(true)}>
					Schedule a change
				</Button>
			}>
			{schedules.length === 0 ? (
				<div className="p-5">
					<EmptyState
						compact
						icon="clock"
						title="Nothing scheduled"
						description="Plan a promotion or a seasonal change ahead of time."
					/>
				</div>
			) : (
				<ul className="divide-y divide-line">
					{schedules.map((s) => (
						<li key={s.scheduleId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
							<div className="min-w-0 space-y-0.5">
								<p className="text-sm font-semibold text-fg">{formatDateTime(s.at)}</p>
								<p className="break-words font-mono text-xs text-muted">{scheduleSummary(s.change)}</p>
								{s.error ? (
									<p className="text-xs text-danger">
										{typeof s.error === 'string' ? s.error : (s.error.message ?? 'Failed')}
									</p>
								) : null}
							</div>
							<div className="flex items-center gap-2">
								<StatusBadge status={s.status} />
								{s.status === 'pending' ? (
									<Button variant="ghost" size="sm" onClick={() => setCancelling(s)}>
										Cancel
									</Button>
								) : null}
							</div>
						</li>
					))}
				</ul>
			)}
			<Dialog
				open={open}
				onClose={() => setOpen(false)}
				title="Schedule a change"
				footer={
					<>
						<Button variant="secondary" onClick={() => setOpen(false)}>
							Close
						</Button>
						<Button onClick={() => void create()} loading={busy}>
							Schedule
						</Button>
					</>
				}>
				<RadioGroup
					legend="What"
					inline
					value={what}
					onChange={(v) => setWhat(v === 'element' ? 'element' : 'feature')}
					options={[
						{ value: 'feature', label: 'Change a setting', disabled: features.length === 0 },
						{ value: 'element', label: 'Switch an element' },
					]}
				/>
				{what === 'feature' ? (
					<>
						<Select
							label="Setting"
							value={featureKey}
							onChange={(e) => setFeatureKey(e.currentTarget.value)}
							options={features}
						/>
						<TextArea
							label="New value"
							rows={2}
							className="font-mono"
							value={valueText}
							onChange={(e) => setValueText(e.currentTarget.value)}
							help="Text as is; numbers, true/false, lists and objects as JSON."
							error={errors.value}
						/>
					</>
				) : (
					<>
						<Select
							label="Element"
							value={elementKey}
							onChange={(e) => setElementKey(e.currentTarget.value)}
							options={elements.map((e) => ({ value: e.key, label: e.name }))}
						/>
						<RadioGroup
							legend="Switch"
							inline
							value={enabled}
							onChange={setEnabled}
							options={[
								{ value: 'on', label: 'On' },
								{ value: 'off', label: 'Off' },
							]}
						/>
					</>
				)}
				<Input
					label="When (your local time)"
					type="datetime-local"
					value={at}
					onChange={(e) => setAt(e.currentTarget.value)}
					error={errors.at}
					required
				/>
				<FormError problem={problem} fields={['at']} />
			</Dialog>
			<ConfirmDialog
				open={Boolean(cancelling)}
				onClose={() => setCancelling(null)}
				onConfirm={() => void cancel()}
				busy={busy}
				title="Cancel this scheduled change?"
				confirmLabel="Cancel change"
				cancelLabel="Keep it"
				danger
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">{cancelling ? scheduleSummary(cancelling.change) : null}</p>
			</ConfirmDialog>
		</Card>
	);
}

/** @param {any} change */
const scheduleSummary = (change) => {
	const parts = [];
	for (const [k, v] of Object.entries(change?.elements ?? {})) parts.push(`${k} ${v === true || v?.enabled ? 'on' : 'off'}`);
	for (const [k, v] of Object.entries(change?.features ?? {}))
		parts.push(`${k} = ${v === null ? 'reset' : JSON.stringify(/** @type {any} */ (v)?.value)}`);
	return parts.join(', ') || 'Change';
};

/**
 * Experiments (A/B variants of an element's experimentable settings).
 * @param {{ merchantId: string, website: any, subscription: any, product: any, experiments: any[],
 *   onChanged: () => Promise<void> | void }} props
 */
export function ExperimentsPanel({ merchantId, website, subscription, product, experiments, onChanged }) {
	const toast = useToast();
	const base = `${api.config(merchantId, website.websiteId, subscription.subscriptionId)}/experiments`;
	const candidates = /** @type {any[]} */ (product?.elements ?? []).filter((e) =>
		Object.values(/** @type {Record<string, any>} */ (e.features?.properties ?? {})).some((n) => n['x-experiment'] === true),
	);
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState({
		name: '',
		element: candidates[0]?.key ?? '',
		metric: 'order.placed@1',
		weightA: '50',
		weightB: '50',
		configA: '{}',
		configB: '{}',
	});
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(/** @type {string | null} */ (null));
	const [stopping, setStopping] = useState(/** @type {any} */ (null));
	const [winner, setWinner] = useState('');
	/** @param {keyof typeof form} key */
	const bind = (key) => ({
		value: form[key],
		onChange: (/** @type {import('react').ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>} */ e) => {
			const value = e.currentTarget.value;
			setForm((f) => ({ ...f, [key]: value }));
		},
		error: errors[key],
	});
	const experimentable = (/** @type {string} */ key) =>
		Object.entries(/** @type {Record<string, any>} */ (candidates.find((c) => c.key === key)?.features?.properties ?? {}))
			.filter(([, n]) => n['x-experiment'] === true)
			.map(([name]) => name);

	const create = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		/** @param {string} text @param {string} field */
		const parse = (text, field) => {
			try {
				const v = JSON.parse(text || '{}');
				if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('object');
				return v;
			} catch {
				local[field] = 'Enter a JSON object of setting values, e.g. {"allowStacking": true}.';
				return {};
			}
		};
		const configA = parse(form.configA, 'configA');
		const configB = parse(form.configB, 'configB');
		const weightA = Number(form.weightA);
		const weightB = Number(form.weightB);
		if (!Number.isInteger(weightA) || weightA < 1) local.weightA = 'Whole number of 1 or more.';
		if (!Number.isInteger(weightB) || weightB < 1) local.weightB = 'Whole number of 1 or more.';
		if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+(@[1-9][0-9]*)?$/.test(form.metric))
			local.metric = 'An event type such as order.placed@1.';
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy('create');
		setProblem(null);
		const result = await apiFetch(base, {
			method: 'POST',
			body: {
				...(form.name.trim() ? { name: form.name.trim() } : {}),
				element: form.element,
				metric: form.metric,
				variants: [
					{ key: 'a', weight: weightA, config: configA },
					{ key: 'b', weight: weightB, config: configB },
				],
			},
		});
		setBusy(null);
		if (!result.ok) {
			setProblem(result.problem);
			const fe = fieldErrors(result.problem);
			setErrors({
				...(fe.metric ? { metric: fe.metric } : {}),
				...(fe.name ? { name: fe.name } : {}),
				...(Object.keys(fe).find((k) => k.startsWith('variants.0'))
					? { configA: /** @type {string} */ (Object.entries(fe).find(([k]) => k.startsWith('variants.0'))?.[1]) }
					: {}),
				...(Object.keys(fe).find((k) => k.startsWith('variants.1'))
					? { configB: /** @type {string} */ (Object.entries(fe).find(([k]) => k.startsWith('variants.1'))?.[1]) }
					: {}),
			});
			return;
		}
		setOpen(false);
		toast.show({ title: 'Experiment created', description: 'Start it when you are ready.' });
		await onChanged();
	};
	/** @param {any} experiment @param {'start' | 'stop'} action @param {string} [applyVariant] */
	const transition = async (experiment, action, applyVariant) => {
		setBusy(experiment.experimentId);
		setProblem(null);
		const result = await apiFetch(`${base}/${encodeURIComponent(experiment.experimentId)}/${action}`, {
			method: 'POST',
			body: action === 'stop' && applyVariant ? { applyVariant } : {},
		});
		setBusy(null);
		if (!result.ok) {
			setProblem(result.problem);
			return false;
		}
		toast.show({ title: action === 'start' ? 'Experiment started' : 'Experiment stopped' });
		await onChanged();
		return true;
	};

	return (
		<Card
			title="Experiments"
			subtitle="Split visitors between variants of an element's settings and measure an event."
			padded={false}
			actions={
				<Button size="sm" onClick={() => setOpen(true)} disabled={candidates.length === 0}>
					New experiment
				</Button>
			}>
			{problem && !open && !stopping ? (
				<div className="px-5 pt-4">
					<FormError problem={problem} />
				</div>
			) : null}
			{experiments.length === 0 ? (
				<div className="p-5">
					<EmptyState
						compact
						icon="activity"
						title={candidates.length === 0 ? 'No element of this product supports experiments' : 'No experiments yet'}
						description={candidates.length === 0 ? undefined : 'Compare two variants and keep the winner.'}
					/>
				</div>
			) : (
				<ul className="divide-y divide-line">
					{experiments.map((x) => (
						<li key={x.experimentId} className="space-y-2 px-5 py-4">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<div className="min-w-0">
									<p className="text-sm font-semibold text-fg">{x.name ?? `${x.element} experiment`}</p>
									<p className="text-xs text-muted">
										Element {x.element} · metric <span className="font-mono">{x.metric}</span>
										{x.winner ? ` · winner ${x.winner}` : ''}
									</p>
								</div>
								<div className="flex items-center gap-2">
									<StatusBadge status={x.status} />
									{x.status === 'draft' ? (
										<Button size="sm" onClick={() => void transition(x, 'start')} loading={busy === x.experimentId}>
											Start
										</Button>
									) : null}
									{x.status === 'running' ? (
										<Button
											size="sm"
											variant="secondary"
											onClick={() => {
												setWinner('');
												setStopping(x);
											}}>
											Stop
										</Button>
									) : null}
								</div>
							</div>
							<ul className="flex flex-wrap gap-2">
								{
									/** @type {any[]} */ (x.variants ?? []).map((v) => (
										<li key={v.key}>
											<Badge tone="neutral">
												{v.key} · weight {v.weight}
												{Object.keys(v.config ?? {}).length > 0 ? ` · ${JSON.stringify(v.config)}` : ''}
											</Badge>
										</li>
									))
								}
							</ul>
						</li>
					))}
				</ul>
			)}
			<Dialog
				open={open}
				onClose={() => setOpen(false)}
				title="New experiment"
				description="Experiments start as drafts. Only settings marked as experimentable can vary."
				footer={
					<>
						<Button variant="secondary" onClick={() => setOpen(false)}>
							Close
						</Button>
						<Button onClick={() => void create()} loading={busy === 'create'}>
							Create draft
						</Button>
					</>
				}>
				<Input label="Name (optional)" maxLength={120} {...bind('name')} />
				<Select
					label="Element"
					options={candidates.map((c) => ({ value: c.key, label: c.name }))}
					{...bind('element')}
					help={`Experimentable settings: ${experimentable(form.element).join(', ') || 'none'}.`}
				/>
				<Input
					label="Success metric (event type)"
					className="font-mono"
					{...bind('metric')}
					help="For example order.placed@1."
				/>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-3">
						<Input label="Variant A weight" type="number" min={1} max={10000} {...bind('weightA')} />
						<TextArea label="Variant A settings" rows={3} className="font-mono text-xs" {...bind('configA')} />
					</div>
					<div className="space-y-3">
						<Input label="Variant B weight" type="number" min={1} max={10000} {...bind('weightB')} />
						<TextArea label="Variant B settings" rows={3} className="font-mono text-xs" {...bind('configB')} />
					</div>
				</div>
				<FormError problem={problem} fields={['name', 'metric', 'element']} />
			</Dialog>
			<ConfirmDialog
				open={Boolean(stopping)}
				onClose={() => setStopping(null)}
				onConfirm={async () => {
					if (await transition(stopping, 'stop', winner || undefined)) setStopping(null);
				}}
				busy={busy === stopping?.experimentId}
				title="Stop this experiment?"
				confirmLabel="Stop experiment"
				error={problem ? describeProblem(problem) : null}>
				<RadioGroup
					legend="Then"
					value={winner}
					onChange={setWinner}
					options={[
						{ value: '', label: 'Keep the current settings' },
						.../** @type {any[]} */ (stopping?.variants ?? []).map((v) => ({
							value: v.key,
							label: `Apply variant ${v.key} to everyone`,
						})),
					]}
				/>
			</ConfirmDialog>
		</Card>
	);
}
