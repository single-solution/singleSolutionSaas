'use client';
/**
 * Subscription configuration: per-element SchemaForm (plan bounds, locks, reset to inherited), preview diff,
 * save.
 * @module
 */
import { useMemo, useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	EmptyState,
	Form,
	FormActions,
	FormError,
	Input,
	SchemaForm,
	Select,
	changedNames,
	fieldErrors,
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
 * a higher layer (platform policy, admin).
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
		toast.show({ title: 'Setting reset', description: 'It now follows your plan defaults.' });
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
						<li>Locked settings are set by the platform or an admin and cannot be changed here.</li>
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
