'use client';
/**
 * Settings (PLAN 0.8.2; Owner only): E-mail sending (SMTP host, port, user, password, sender name and address; Send
 * test e-mail to the signed-in admin), Branding (name, accent, logo), Support contact (e-mail, phone, optional WhatsApp)
 * Security (Session length, Require two-step for admins) and Billing rules (grace days, low-balance threshold). Every
 * change is written to
 * Activity and reaches every Portal instance within seconds.
 * @module
 */
import { useState } from 'react';
import {
	Button,
	Callout,
	Card,
	Checkbox,
	Form,
	FormError,
	Input,
	PageHeader,
	Switch,
	Tabs,
	describeProblem,
	fieldErrors,
	useToast,
} from '@ss/ui';
import { ADMIN, LOGIN } from '../../../texts/console.js';
import { adminFetch } from '../client.js';
import { adminApi } from '../paths.js';
import { AdminProblem } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

const LOGO_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
const LOGO_MAX_BYTES = 200 * 1024;

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
		const result = await adminFetch(path, { method, ...(body === undefined ? {} : { body }) });
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
function MailTab({ settings, onSaved }) {
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
		const result = await adminFetch(adminApi.settingsMailTest(), { method: 'POST' });
		setTesting(false);
		if (result.ok) toast.show({ title: ADMIN.mail.testSent(result.data?.sentTo ?? '') });
		else setTestProblem(result.problem);
	};
	const errors = fieldErrors(problem);
	return (
		<Card>
			<Form onSubmit={submit} busy={busy} aria-label={ADMIN.settingsTabs.mail}>
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
				<Checkbox label={ADMIN.mail.secure} checked={form.secure} onChange={(e) => set('secure', e.currentTarget.checked)} />
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
						<Button variant="ghost" onClick={() => void save(adminApi.settingsMail(), 'PUT', { mail: null })}>
							{ADMIN.mail.remove}
						</Button>
					) : null}
				</div>
				{testProblem ? <Callout tone="danger">{describeProblem(testProblem)}</Callout> : null}
			</Form>
		</Card>
	);
}

/** @param {{ settings: any, onSaved: (s: any) => void }} props */
function BrandingTab({ settings, onSaved }) {
	const [name, setName] = useState(settings.branding?.name ?? '');
	const [accent, setAccent] = useState(settings.branding?.accent ?? '#4f46e5');
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
		<Card>
			<Form
				onSubmit={() => save(adminApi.settingsBranding(), 'PUT', { name: name.trim(), accent })}
				busy={busy}
				aria-label={ADMIN.settingsTabs.branding}>
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
					value={accent}
					onChange={(e) => setAccent(e.currentTarget.value)}
					error={errors.accent}
				/>
				<div className="space-y-2">
					<p className="text-sm font-semibold text-fg">{ADMIN.branding.logo}</p>
					<p className="text-sm text-muted">{ADMIN.branding.logoHelp}</p>
					{settings.branding?.hasLogo ? (
						<img
							src={`/branding/logo?v=${settings.branding.logoVersion}`}
							alt=""
							className="size-16 rounded-xl bg-surface-2 object-contain"
						/>
					) : null}
					<input
						type="file"
						accept={LOGO_TYPES.join(',')}
						aria-label={ADMIN.branding.logo}
						onChange={(e) => {
							const file = e.currentTarget.files?.[0];
							if (file) void upload(file);
						}}
						className="block text-sm"
					/>
					{logoError ? <Callout tone="danger">{logoError}</Callout> : null}
					{settings.branding?.hasLogo ? (
						<Button variant="ghost" size="sm" onClick={() => void save(adminApi.settingsLogo(), 'DELETE')}>
							{ADMIN.branding.logoRemove}
						</Button>
					) : null}
				</div>
				<FormError problem={problem} fields={['name', 'accent', 'type', 'data']} />
				<Button type="submit" loading={busy}>
					{LOGIN.save}
				</Button>
			</Form>
		</Card>
	);
}

/** @param {{ settings: any, onSaved: (s: any) => void }} props */
function SupportTab({ settings, onSaved }) {
	const [form, setForm] = useState({
		email: settings.support?.email ?? '',
		phone: settings.support?.phone ?? '',
		whatsapp: settings.support?.whatsapp ?? '',
	});
	const { busy, problem, save } = useSave(onSaved);
	/** @param {keyof typeof form} key @param {string} value */
	const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
	const errors = fieldErrors(problem);
	return (
		<Card>
			<Form onSubmit={() => save(adminApi.settingsSupport(), 'PUT', form)} busy={busy} aria-label={ADMIN.settingsTabs.support}>
				<p className="text-sm text-muted">{ADMIN.support.help}</p>
				<Input
					label={ADMIN.support.email}
					type="email"
					value={form.email}
					onChange={(e) => set('email', e.currentTarget.value)}
					error={errors.email}
				/>
				<Input
					label={ADMIN.support.phone}
					value={form.phone}
					onChange={(e) => set('phone', e.currentTarget.value)}
					error={errors.phone}
				/>
				<Input
					label={ADMIN.support.whatsapp}
					value={form.whatsapp}
					onChange={(e) => set('whatsapp', e.currentTarget.value)}
					error={errors.whatsapp}
				/>
				<FormError problem={problem} fields={['email', 'phone', 'whatsapp']} />
				<Button type="submit" loading={busy}>
					{LOGIN.save}
				</Button>
			</Form>
		</Card>
	);
}

/** @param {{ settings: any, onSaved: (s: any) => void }} props */
function SecurityTab({ settings, onSaved }) {
	const bounds = settings.bounds?.sessionHours ?? { min: 1, max: 336 };
	const [hours, setHours] = useState(String(settings.security?.sessionHours ?? 12));
	const [required, setRequired] = useState(Boolean(settings.security?.requireTwoStepForAdmins));
	const { busy, problem, save } = useSave(onSaved);
	return (
		<Card>
			<Form
				onSubmit={() =>
					save(adminApi.settingsSecurity(), 'PUT', { sessionHours: Number(hours), requireTwoStepForAdmins: required })
				}
				busy={busy}
				aria-label={ADMIN.settingsTabs.security}>
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
		</Card>
	);
}

/** @param {{ settings: any, onSaved: (s: any) => void }} props */
function BillingRulesTab({ settings, onSaved }) {
	const grace = settings.bounds?.graceDays ?? { min: 0, max: 30 };
	const low = settings.bounds?.lowBalanceDays ?? { min: 1, max: 30 };
	const [graceDays, setGraceDays] = useState(String(settings.billing?.graceDays ?? 3));
	const [lowBalanceDays, setLowBalanceDays] = useState(String(settings.billing?.lowBalanceDays ?? 3));
	const { busy, problem, save } = useSave(onSaved);
	const errors = fieldErrors(problem);
	return (
		<Card>
			<Form
				onSubmit={() =>
					save(adminApi.settingsBilling(), 'PUT', { graceDays: Number(graceDays), lowBalanceDays: Number(lowBalanceDays) })
				}
				busy={busy}
				aria-label={ADMIN.settingsTabs.billing}>
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
		</Card>
	);
}

/**
 * @param {any} props loader result of `loadSettings`
 */
export function SettingsView(props) {
	const [settings, setSettings] = useState(props.ok ? props.settings : null);
	if (!props.ok || !settings) return <AdminProblem problem={props.problem} />;
	return (
		<div className="space-y-8">
			<PageHeader title={ADMIN.settingsTitle} subtitle={ADMIN.settingsIntro} />
			<Tabs
				label={ADMIN.settingsTitle}
				tabs={[
					{ id: 'mail', label: ADMIN.settingsTabs.mail, content: <MailTab settings={settings} onSaved={setSettings} /> },
					{
						id: 'branding',
						label: ADMIN.settingsTabs.branding,
						content: <BrandingTab settings={settings} onSaved={setSettings} />,
					},
					{
						id: 'support',
						label: ADMIN.settingsTabs.support,
						content: <SupportTab settings={settings} onSaved={setSettings} />,
					},
					{
						id: 'security',
						label: ADMIN.settingsTabs.security,
						content: <SecurityTab settings={settings} onSaved={setSettings} />,
					},
					{
						id: 'billing',
						label: ADMIN.settingsTabs.billing,
						content: <BillingRulesTab settings={settings} onSaved={setSettings} />,
					},
				]}
			/>
		</div>
	);
}
