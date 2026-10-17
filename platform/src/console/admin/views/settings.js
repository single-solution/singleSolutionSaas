'use client';
/**
 * Settings (PLAN 0.8.2; Owner only): one page with an inner sidebar (premium layout 2026-10-16) — a section per card,
 * all of them in the page and each saved on its own: Email sending
 * (SMTP host, port, user, password, sender name and address; Send test email to the signed-in admin), Branding (name,
 * accent, logo), Support contact (email, phone, optional WhatsApp), Security (Session length, Require two-step for
 * admins), Billing rules (grace days, low-balance threshold) and Encryption key (Re-seal after a key change). Every
 * change is written to Activity and reaches every Portal instance within seconds.
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
	PageHeader,
	SectionLayout,
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
import { adminApi } from '../paths.js';
import { AdminProblem } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * Save a settings group and report the outcome.
 * @param {(settings: any) => void} onSaved
 */
const useSave = (onSaved) => {
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	/**
	 * @param {string} path
	 * @param {string} method
	 * @param {unknown} [body]
	 */
	const save = async (path, method, body) => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(path, { method, ...(body === undefined ? {} : { body }) });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return null;
		}
		toast.show({ title: LOGIN.saved });
		onSaved(result.data);
		return result.data;
	};
	return { busy, problem, save };
};

/** @param {{ settings: any, onSaved: (s: any) => void }} props */
function MailCard({ settings, onSaved }) {
	const toast = useToast();
	const mail = settings.mail;
	const [form, setForm] = useState({
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
	/** @param {keyof typeof form} key @param {any} value */
	const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
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
		<SettingsCard title={ADMIN.settingsSections.mail.title} description={ADMIN.settingsSections.mail.help}>
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
				<div className="flex flex-wrap gap-2">
					<Button type="submit" loading={busy}>
						{LOGIN.save}
					</Button>
					{mail ? (
						<Button variant="secondary" onClick={() => void test()} loading={testing}>
							{ADMIN.mail.test}
						</Button>
					) : null}
					{mail ? (
						<Button variant="ghost" onClick={() => save(adminApi.settingsMail(), 'PUT', { mail: null })}>
							{ADMIN.mail.remove}
						</Button>
					) : null}
				</div>
				{testProblem ? <Callout tone="danger">{describeProblem(testProblem)}</Callout> : null}
			</Form>
		</SettingsCard>
	);
}

/** @param {{ settings: any, onSaved: (s: any) => void }} props */
function BrandingCard({ settings, onSaved }) {
	const [name, setName] = useState(settings.branding.name);
	const [accent, setAccent] = useState(settings.branding.accent);
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
		await save(adminApi.settingsLogo(), 'PUT', { type: file.type, data: btoa(binary) });
		return undefined;
	};
	const errors = fieldErrors(problem);
	return (
		<SettingsCard title={ADMIN.settingsSections.branding.title} description={ADMIN.settingsSections.branding.help}>
			<Form
				onSubmit={() => save(adminApi.settingsBranding(), 'PUT', { name: name.trim(), accent })}
				busy={busy}
				aria-label={ADMIN.settingsSections.branding.title}>
				<Input
					label={ADMIN.branding.name}
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					error={errors.name}
					required
					maxLength={60}
				/>
				<Input
					label={ADMIN.branding.accent}
					type="color"
					className="w-20!"
					value={accent}
					onChange={(e) => setAccent(e.currentTarget.value)}
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
						<Button variant="ghost" size="sm" onClick={() => save(adminApi.settingsLogo(), 'DELETE')}>
							{ADMIN.branding.logoRemove}
						</Button>
					) : null}
				</SettingRow>
				<FormError problem={problem} fields={['name', 'accent', 'type', 'data']} />
				<Button type="submit" loading={busy}>
					{LOGIN.save}
				</Button>
			</Form>
		</SettingsCard>
	);
}

/** @typedef {'email' | 'phone' | 'link'} ChannelType */
/** A channel as the form edits it: its kind, label and what people read (the address, number or link). */
/** @typedef {{ type: ChannelType, label: string, value: string }} ChannelRow */

/**
 * The support contact (fixed-choices audit K10): a list of channels the Owner adds, labels, reorders and removes.
 * @param {{ settings: any, onSaved: (s: any) => void }} props
 */
function SupportCard({ settings, onSaved }) {
	const S = ADMIN.support;
	const [rows, setRows] = useState(
		/** @type {ChannelRow[]} */ (
			settings.support.channels.map((/** @type {import('@ss/contracts/text').SupportChannel} */ channel) => ({
				type: channel.type,
				label: channel.label,
				value: supportChannelValue(channel),
			}))
		),
	);
	const { busy, problem, save } = useSave(onSaved);
	const errors = fieldErrors(problem);
	return (
		<SettingsCard title={ADMIN.settingsSections.support.title} description={ADMIN.settingsSections.support.help}>
			<Form
				onSubmit={() =>
					save(adminApi.settingsSupport(), 'PUT', {
						channels: rows.map((row) => ({ type: row.type, label: row.label, url: row.value })),
					})
				}
				busy={busy}
				aria-label={ADMIN.settingsSections.support.title}>
				<ListEditor
					legend={S.channels}
					help={S.channelsHelp}
					items={rows}
					onChange={setRows}
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
				<Button type="submit" loading={busy}>
					{LOGIN.save}
				</Button>
			</Form>
		</SettingsCard>
	);
}

/** @param {{ settings: any, onSaved: (s: any) => void }} props */
function SecurityCard({ settings, onSaved }) {
	const bounds = settings.bounds.sessionHours;
	const [hours, setHours] = useState(String(settings.security.sessionHours));
	const [required, setRequired] = useState(settings.security.requireTwoStepForAdmins);
	const { busy, problem, save } = useSave(onSaved);
	return (
		<SettingsCard title={ADMIN.settingsSections.security.title} description={ADMIN.settingsSections.security.help}>
			<Form
				onSubmit={() =>
					save(adminApi.settingsSecurity(), 'PUT', { sessionHours: Number(hours), requireTwoStepForAdmins: required })
				}
				busy={busy}
				aria-label={ADMIN.settingsSections.security.title}>
				<Input
					label={ADMIN.security.sessionHours}
					inputMode="numeric"
					value={hours}
					onChange={(e) => setHours(e.currentTarget.value)}
					help={ADMIN.security.sessionHelp(bounds.min, bounds.max)}
					error={fieldErrors(problem).sessionHours}
					required
				/>
				<Switch
					label={ADMIN.security.requireTwoStep}
					description={ADMIN.security.requireTwoStepHelp}
					checked={required}
					onChange={setRequired}
				/>
				<FormError problem={problem} fields={['sessionHours', 'requireTwoStepForAdmins']} />
				<Button type="submit" loading={busy}>
					{LOGIN.save}
				</Button>
			</Form>
		</SettingsCard>
	);
}

/** @param {{ settings: any, onSaved: (s: any) => void }} props */
function BillingRulesCard({ settings, onSaved }) {
	const grace = settings.bounds.graceDays;
	const low = settings.bounds.lowBalanceDays;
	const [graceDays, setGraceDays] = useState(String(settings.billing.graceDays));
	const [lowBalanceDays, setLowBalanceDays] = useState(String(settings.billing.lowBalanceDays));
	const { busy, problem, save } = useSave(onSaved);
	const errors = fieldErrors(problem);
	return (
		<SettingsCard title={ADMIN.settingsSections.billing.title} description={ADMIN.settingsSections.billing.help}>
			<Form
				onSubmit={() =>
					save(adminApi.settingsBilling(), 'PUT', { graceDays: Number(graceDays), lowBalanceDays: Number(lowBalanceDays) })
				}
				busy={busy}
				aria-label={ADMIN.settingsSections.billing.title}>
				<Input
					label={ADMIN.billingRules.graceDays}
					inputMode="numeric"
					min={grace.min}
					max={grace.max}
					value={graceDays}
					onChange={(e) => setGraceDays(e.currentTarget.value)}
					help={ADMIN.billingRules.graceHelp}
					error={errors.graceDays}
					required
				/>
				<Input
					label={ADMIN.billingRules.lowBalanceDays}
					inputMode="numeric"
					min={low.min}
					max={low.max}
					value={lowBalanceDays}
					onChange={(e) => setLowBalanceDays(e.currentTarget.value)}
					help={ADMIN.billingRules.lowBalanceHelp}
					error={errors.lowBalanceDays}
					required
				/>
				<FormError problem={problem} fields={['graceDays', 'lowBalanceDays']} />
				<Button type="submit" loading={busy}>
					{LOGIN.save}
				</Button>
			</Form>
		</SettingsCard>
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
 * @param {any} props loader result of `loadSettings`
 */
export function SettingsView(props) {
	const [settings, setSettings] = useState(props.ok ? props.settings : null);
	if (!props.ok || !settings) return <AdminProblem problem={props.problem} />;
	const S = ADMIN.settingsSections;
	return (
		<div className="space-y-6">
			<PageHeader title={ADMIN.settingsTitle} subtitle={ADMIN.settingsIntro} />
			<SectionLayout
				label={ADMIN.settingsTitle}
				sections={[
					{
						id: 'branding',
						label: S.branding.title,
						icon: 'palette',
						group: ADMIN.settingsGroups.portal,
						content: <BrandingCard settings={settings} onSaved={setSettings} />,
					},
					{
						id: 'support',
						label: S.support.title,
						icon: 'help',
						group: ADMIN.settingsGroups.portal,
						content: <SupportCard settings={settings} onSaved={setSettings} />,
					},
					{
						id: 'mail',
						label: S.mail.title,
						icon: 'mail',
						group: ADMIN.settingsGroups.portal,
						content: <MailCard settings={settings} onSaved={setSettings} />,
					},
					{
						id: 'security',
						label: S.security.title,
						icon: 'shield',
						group: ADMIN.settingsGroups.safety,
						content: (
							<>
								<SecurityCard settings={settings} onSaved={setSettings} />
								<EncryptionBlock />
							</>
						),
					},
					{
						id: 'billing',
						label: S.billing.title,
						icon: 'wallet',
						group: ADMIN.settingsGroups.safety,
						content: <BillingRulesCard settings={settings} onSaved={setSettings} />,
					},
				]}
			/>
		</div>
	);
}
