'use client';
/**
 * Settings (PLAN 0.8.2; Owner only; layout contract 2026-10-17): one Page whose sections are the parts of its inner
 * navigation, each its own address (`/admin/settings/:part`; Branding is `/admin/settings`): Branding (name, accent,
 * logo), Support contact (a list of channels), Email sending (SMTP host, port, user, password, sender name and
 * address; Send test email and Turn email sending off in the card's header), Security (session length, require
 * two-step for admins; Advanced: Re-seal the stored secrets after a key change) and Billing rules (grace days,
 * low-balance threshold). The floating save bar is the only save control: it appears when a section has changes and
 * offers Save changes and Discard. Every change is written to Activity and reaches every Portal instance within
 * seconds. The page's description is behind its (i).
 * @module
 */
import { useState } from 'react';
import {
	Button,
	Callout,
	Disclosure,
	Form,
	FormError,
	Input,
	ListEditor,
	Page,
	SaveBar,
	Select,
	SettingRow,
	SettingsCard,
	Switch,
	describeProblem,
	fieldErrors,
	useToast,
} from '@ss/ui';
import { SUPPORT_CHANNELS_MAX, SUPPORT_CHANNEL_TYPES, supportChannelValue } from '@ss/contracts/text';
import { LOGO_MAX_BYTES, LOGO_TYPES } from '../../../infra/branding.js';
import { ADMIN, LOGIN } from '../../../texts/console.js';
import { apiFetch } from '../../client.js';
import { Link } from '../../link.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** The parts of the Settings page, in the order of the inner navigation (Branding is the page's own address). */
export const SETTINGS_PARTS = ['branding', 'support', 'mail', 'security', 'billing'];

/**
 * Save a settings group and report the outcome.
 * @param {(settings: any, keepForm?: boolean) => void} onSaved `keepForm`: the save was a side action (the logo), so
 *   the section keeps what the person typed
 */
const useSave = (onSaved) => {
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	/**
	 * @param {string} path
	 * @param {string} method
	 * @param {unknown} [body]
	 * @param {boolean} [keepForm]
	 */
	const save = async (path, method, body, keepForm = false) => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(path, { method, ...(body === undefined ? {} : { body }) });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return null;
		}
		toast.show({ title: LOGIN.saved });
		onSaved(result.data, keepForm);
		return result.data;
	};
	return { busy, problem, save };
};

/**
 * What a section is editing: the values, whether they differ from the ones it opened with, and a way back to them.
 * A saved section is opened again with the new values (the page changes its key), so "opened with" is what was saved.
 * @template {Record<string, any>} T
 * @param {T} initial
 */
const useDraft = (initial) => {
	const [saved] = useState(initial);
	const [values, setValues] = useState(initial);
	return {
		values,
		/** @param {keyof T} key @param {any} value */
		set: (key, value) => setValues((v) => ({ ...v, [key]: value })),
		dirty: JSON.stringify(values) !== JSON.stringify(saved),
		discard: () => setValues(saved),
	};
};

/** @param {{ settings: any, onSaved: (s: any, keepForm?: boolean) => void }} props */
function MailCard({ settings, onSaved }) {
	const toast = useToast();
	const mail = settings.mail;
	const {
		values: form,
		set,
		dirty,
		discard,
	} = useDraft({
		host: mail?.host ?? '',
		port: String(mail?.port ?? 587),
		secure: mail?.secure ?? false,
		user: mail?.user ?? '',
		password: '',
		senderName: mail?.senderName ?? '',
		senderAddress: mail?.senderAddress ?? '',
	});
	const { busy, problem, save } = useSave(onSaved);
	const [testing, setTesting] = useState(false);
	const [testProblem, setTestProblem] = useState(/** @type {Problem | null} */ (null));
	const submit = () =>
		save(adminApi.settingsMail(), 'PUT', {
			mail: {
				host: form.host.trim(),
				port: Number(form.port),
				secure: form.secure,
				user: form.user.trim() || null,
				...(form.password ? { password: form.password } : {}),
				senderName: form.senderName.trim() || null,
				senderAddress: form.senderAddress.trim(),
			},
		});
	const test = async () => {
		setTesting(true);
		setTestProblem(null);
		const result = await apiFetch(adminApi.settingsMailTest(), { method: 'POST' });
		setTesting(false);
		if (result.ok) toast.show({ title: ADMIN.mail.testSent(result.data?.sentTo ?? '') });
		else setTestProblem(result.problem);
	};
	const errors = fieldErrors(problem);
	return (
		<>
			<SettingsCard
				title={ADMIN.settingsSections.mail.title}
				description={ADMIN.settingsSections.mail.help}
				actions={
					mail ? (
						<>
							<Button size="sm" variant="secondary" onClick={() => void test()} loading={testing}>
								{ADMIN.mail.test}
							</Button>
							<Button size="sm" variant="ghost" onClick={() => save(adminApi.settingsMail(), 'PUT', { mail: null })}>
								{ADMIN.mail.remove}
							</Button>
						</>
					) : null
				}>
				<Form onSubmit={submit} busy={busy} aria-label={ADMIN.settingsSections.mail.title}>
					<Input
						label={ADMIN.mail.host}
						value={form.host}
						onChange={(e) => set('host', e.currentTarget.value)}
						error={errors.host}
						required
					/>
					<Input
						label={ADMIN.mail.port}
						inputMode="numeric"
						value={form.port}
						onChange={(e) => set('port', e.currentTarget.value)}
						error={errors.port}
						required
					/>
					<Input
						label={ADMIN.mail.user}
						value={form.user}
						onChange={(e) => set('user', e.currentTarget.value)}
						error={errors.user}
					/>
					<Input
						label={ADMIN.mail.password}
						type="password"
						autoComplete="new-password"
						value={form.password}
						onChange={(e) => set('password', e.currentTarget.value)}
						error={errors.password}
						help={
							mail?.passwordUnreadable
								? ADMIN.mail.passwordUnreadable
								: mail?.hasPassword
									? ADMIN.mail.passwordKept
									: undefined
						}
					/>
					<Input
						label={ADMIN.mail.senderName}
						value={form.senderName}
						onChange={(e) => set('senderName', e.currentTarget.value)}
						error={errors.senderName}
					/>
					<Input
						label={ADMIN.mail.senderAddress}
						type="email"
						value={form.senderAddress}
						onChange={(e) => set('senderAddress', e.currentTarget.value)}
						error={errors.senderAddress}
						required
					/>
					<Disclosure title={ADMIN.advanced}>
						<Switch
							label={ADMIN.mail.secure}
							description={ADMIN.mail.secureHelp}
							checked={form.secure}
							onChange={(next) => set('secure', next)}
						/>
					</Disclosure>
					<FormError problem={problem} fields={['host', 'port', 'user', 'password', 'senderName', 'senderAddress']} />
					{testProblem ? <Callout tone="danger">{describeProblem(testProblem)}</Callout> : null}
				</Form>
			</SettingsCard>
			<SaveBar show={dirty} onSave={submit} onDiscard={discard} saving={busy} />
		</>
	);
}

/** @param {{ settings: any, onSaved: (s: any, keepForm?: boolean) => void }} props */
function BrandingCard({ settings, onSaved }) {
	const { values, set, dirty, discard } = useDraft({ name: settings.branding.name, accent: settings.branding.accent });
	const [logoError, setLogoError] = useState(/** @type {string | null} */ (null));
	const { busy, problem, save } = useSave(onSaved);
	/** @param {File} file */
	const upload = async (file) => {
		setLogoError(null);
		if (!LOGO_TYPES.includes(file.type)) return setLogoError(ADMIN.branding.logoType);
		if (file.size > LOGO_MAX_BYTES) return setLogoError(ADMIN.branding.logoTooBig);
		const bytes = new Uint8Array(await file.arrayBuffer());
		let binary = '';
		for (const byte of bytes) binary += String.fromCharCode(byte);
		await save(adminApi.settingsLogo(), 'PUT', { type: file.type, data: btoa(binary) }, true);
		return undefined;
	};
	const submit = () => save(adminApi.settingsBranding(), 'PUT', { name: values.name.trim(), accent: values.accent });
	const errors = fieldErrors(problem);
	return (
		<>
			<SettingsCard title={ADMIN.settingsSections.branding.title} description={ADMIN.settingsSections.branding.help}>
				<Form onSubmit={submit} busy={busy} aria-label={ADMIN.settingsSections.branding.title}>
					<Input
						label={ADMIN.branding.name}
						value={values.name}
						onChange={(e) => set('name', e.currentTarget.value)}
						error={errors.name}
						required
						maxLength={60}
					/>
					<Input
						label={ADMIN.branding.accent}
						type="color"
						className="w-20!"
						value={values.accent}
						onChange={(e) => set('accent', e.currentTarget.value)}
						error={errors.accent}
					/>
					<SettingRow label={ADMIN.branding.logo} description={ADMIN.branding.logoHelp}>
						{settings.branding.hasLogo ? (
							<img
								src={`/branding/logo?v=${settings.branding.logoVersion}`}
								alt=""
								className="size-16 rounded-xl bg-surface-2 object-contain"
							/>
						) : null}
						<Input
							type="file"
							hideLabel
							label={ADMIN.branding.logo}
							accept={LOGO_TYPES.join(',')}
							onChange={(e) => {
								const file = e.currentTarget.files?.[0];
								if (file) void upload(file);
							}}
						/>
						{logoError ? <Callout tone="danger">{logoError}</Callout> : null}
						{settings.branding.hasLogo ? (
							<Button variant="ghost" size="sm" onClick={() => save(adminApi.settingsLogo(), 'DELETE', undefined, true)}>
								{ADMIN.branding.logoRemove}
							</Button>
						) : null}
					</SettingRow>
					<FormError problem={problem} fields={['name', 'accent', 'type', 'data']} />
				</Form>
			</SettingsCard>
			<SaveBar show={dirty} onSave={submit} onDiscard={discard} saving={busy} />
		</>
	);
}

/** @typedef {'email' | 'phone' | 'link'} ChannelType */
/** A channel as the form edits it: its kind, label and what people read (the address, number or link). */
/** @typedef {{ type: ChannelType, label: string, value: string }} ChannelRow */

/**
 * The support contact (fixed-choices audit K10): a list of channels the Owner adds, labels, reorders and removes.
 * @param {{ settings: any, onSaved: (s: any, keepForm?: boolean) => void }} props
 */
function SupportCard({ settings, onSaved }) {
	const S = ADMIN.support;
	const {
		values: { rows },
		set,
		dirty,
		discard,
	} = useDraft({
		rows: /** @type {ChannelRow[]} */ (
			settings.support.channels.map((/** @type {import('@ss/contracts/text').SupportChannel} */ channel) => ({
				type: channel.type,
				label: channel.label,
				value: supportChannelValue(channel),
			}))
		),
	});
	const { busy, problem, save } = useSave(onSaved);
	const errors = fieldErrors(problem);
	const submit = () =>
		save(adminApi.settingsSupport(), 'PUT', {
			channels: rows.map((row) => ({ type: row.type, label: row.label, url: row.value })),
		});
	return (
		<>
			<SettingsCard wide title={ADMIN.settingsSections.support.title} description={ADMIN.settingsSections.support.help}>
				<Form onSubmit={submit} busy={busy} aria-label={ADMIN.settingsSections.support.title}>
					<ListEditor
						legend={S.channels}
						help={S.channelsHelp}
						items={rows}
						onChange={(next) => set('rows', next)}
						max={SUPPORT_CHANNELS_MAX}
						newItem={() => /** @type {ChannelRow} */ ({ type: 'email', label: '', value: '' })}
						nameOf={(row, index) => row.label || S.channel(index + 1)}
						texts={{ add: S.add }}
						error={errors.channels}
						renderItem={(row, index, update) => (
							<>
								<Select
									label={S.type}
									value={row.type}
									options={SUPPORT_CHANNEL_TYPES.map((type) => ({ value: type, label: S.types[type] }))}
									onChange={(e) => update({ ...row, type: /** @type {ChannelType} */ (e.currentTarget.value) })}
								/>
								<Input
									label={S.label}
									placeholder={S.labelPlaceholder}
									value={row.label}
									onChange={(e) => update({ ...row, label: e.currentTarget.value })}
								/>
								<Input
									label={S.value[row.type]}
									placeholder={S.valuePlaceholder[row.type]}
									value={row.value}
									onChange={(e) => update({ ...row, value: e.currentTarget.value })}
									error={errors[`channels.${index}`]}
								/>
							</>
						)}
					/>
					<FormError problem={problem} fields={['channels']} />
				</Form>
			</SettingsCard>
			<SaveBar show={dirty} onSave={submit} onDiscard={discard} saving={busy} />
		</>
	);
}

/** @param {{ settings: any, onSaved: (s: any, keepForm?: boolean) => void }} props */
function SecurityCard({ settings, onSaved }) {
	const bounds = settings.bounds.sessionHours;
	const { values, set, dirty, discard } = useDraft({
		hours: String(settings.security.sessionHours),
		required: Boolean(settings.security.requireTwoStepForAdmins),
	});
	const { busy, problem, save } = useSave(onSaved);
	const submit = () =>
		save(adminApi.settingsSecurity(), 'PUT', {
			sessionHours: Number(values.hours),
			requireTwoStepForAdmins: values.required,
		});
	return (
		<>
			<SettingsCard title={ADMIN.settingsSections.security.title} description={ADMIN.settingsSections.security.help}>
				<Form onSubmit={submit} busy={busy} aria-label={ADMIN.settingsSections.security.title}>
					<Input
						label={ADMIN.security.sessionHours}
						inputMode="numeric"
						value={values.hours}
						onChange={(e) => set('hours', e.currentTarget.value)}
						help={ADMIN.security.sessionHelp(bounds.min, bounds.max)}
						error={fieldErrors(problem).sessionHours}
						required
					/>
					<Switch
						label={ADMIN.security.requireTwoStep}
						description={ADMIN.security.requireTwoStepHelp}
						checked={values.required}
						onChange={(next) => set('required', next)}
					/>
					<FormError problem={problem} fields={['sessionHours', 'requireTwoStepForAdmins']} />
				</Form>
			</SettingsCard>
			<SaveBar show={dirty} onSave={submit} onDiscard={discard} saving={busy} />
		</>
	);
}

/** @param {{ settings: any, onSaved: (s: any, keepForm?: boolean) => void }} props */
function BillingRulesCard({ settings, onSaved }) {
	const grace = settings.bounds.graceDays;
	const low = settings.bounds.lowBalanceDays;
	const { values, set, dirty, discard } = useDraft({
		graceDays: String(settings.billing.graceDays),
		lowBalanceDays: String(settings.billing.lowBalanceDays),
	});
	const { busy, problem, save } = useSave(onSaved);
	const errors = fieldErrors(problem);
	const submit = () =>
		save(adminApi.settingsBilling(), 'PUT', {
			graceDays: Number(values.graceDays),
			lowBalanceDays: Number(values.lowBalanceDays),
		});
	return (
		<>
			<SettingsCard title={ADMIN.settingsSections.billing.title} description={ADMIN.settingsSections.billing.help}>
				<Form onSubmit={submit} busy={busy} aria-label={ADMIN.settingsSections.billing.title}>
					<Input
						label={ADMIN.billingRules.graceDays}
						inputMode="numeric"
						min={grace.min}
						max={grace.max}
						value={values.graceDays}
						onChange={(e) => set('graceDays', e.currentTarget.value)}
						help={ADMIN.billingRules.graceHelp}
						error={errors.graceDays}
						required
					/>
					<Input
						label={ADMIN.billingRules.lowBalanceDays}
						inputMode="numeric"
						min={low.min}
						max={low.max}
						value={values.lowBalanceDays}
						onChange={(e) => set('lowBalanceDays', e.currentTarget.value)}
						help={ADMIN.billingRules.lowBalanceHelp}
						error={errors.lowBalanceDays}
						required
					/>
					<FormError problem={problem} fields={['graceDays', 'lowBalanceDays']} />
				</Form>
			</SettingsCard>
			<SaveBar show={dirty} onSave={submit} onDiscard={discard} saving={busy} />
		</>
	);
}

/**
 * Encryption key (PLAN 0.4.8): Re-seal every stored secret with the current `ENCRYPTION_KEY` after a key change. It is
 * needed once in a long while, so it sits under Advanced on the Security page.
 */
function EncryptionBlock() {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [counts, setCounts] = useState(
		/** @type {{ resealed: number, current: number, unreadable: number, unreadableIn: Record<string, number> } | null} */ (
			null
		),
	);
	return (
		<Disclosure title={ADMIN.advanced} description={ADMIN.settingsSections.encryption.title}>
			<p className="text-sm text-muted">{ADMIN.settingsSections.encryption.help}</p>
			<div className="space-y-4">
				<Button
					loading={busy}
					onClick={async () => {
						setBusy(true);
						setProblem(null);
						const result = await apiFetch(adminApi.settingsReseal(), { method: 'POST', body: {} });
						setBusy(false);
						if (result.ok) setCounts(result.data);
						else setProblem(result.problem);
					}}>
					{ADMIN.encryption.reseal}
				</Button>
				{counts ? (
					<Callout tone={counts.unreadable === 0 ? 'success' : 'warning'}>{ADMIN.encryption.result(counts)}</Callout>
				) : null}
				<FormError problem={problem} fields={[]} />
			</div>
		</Disclosure>
	);
}

/**
 * @param {any} props loader result of `loadSettings`, plus `part` (one of {@link SETTINGS_PARTS}; Branding when
 *   missing)
 */
export function SettingsView(props) {
	const [settings, setSettings] = useState(props.ok ? props.settings : null);
	// a saved section opens again with what was saved: a new key makes it start over from the new settings
	const [version, setVersion] = useState(0);
	if (!props.ok || !settings) return <AdminProblem problem={props.problem} />;
	const S = ADMIN.settingsSections;
	const part = SETTINGS_PARTS.includes(props.part) ? props.part : 'branding';
	/** @param {any} next @param {boolean} [keepForm] */
	const onSaved = (next, keepForm = false) => {
		setSettings(next);
		if (!keepForm) setVersion((v) => v + 1);
	};
	/** @type {Record<string, import('react').ReactNode>} */
	const bodies = {
		branding: <BrandingCard key={version} settings={settings} onSaved={onSaved} />,
		support: <SupportCard key={version} settings={settings} onSaved={onSaved} />,
		mail: <MailCard key={version} settings={settings} onSaved={onSaved} />,
		security: (
			<>
				<SecurityCard key={version} settings={settings} onSaved={onSaved} />
				<EncryptionBlock />
			</>
		),
		billing: <BillingRulesCard key={version} settings={settings} onSaved={onSaved} />,
	};
	/** @param {string} id @param {import('@ss/ui').IconName} icon */
	const item = (id, icon) => ({
		id,
		label: S[/** @type {keyof typeof S} */ (id)].title,
		icon,
		href: adminRoutes.settingsPart(id),
	});
	return (
		<Page
			linkAs={Link}
			bodyKey={part}
			crumbs={[{ label: ADMIN.settingsTitle }]}
			info={ADMIN.settingsIntro}
			nav={{
				value: part,
				label: ADMIN.settingsTitle,
				groups: [
					{
						label: ADMIN.settingsGroups.portal,
						items: [item('branding', 'palette'), item('support', 'help'), item('mail', 'mail')],
					},
					{ label: ADMIN.settingsGroups.safety, items: [item('security', 'shield'), item('billing', 'wallet')] },
				],
			}}>
			{bodies[part]}
		</Page>
	);
}
