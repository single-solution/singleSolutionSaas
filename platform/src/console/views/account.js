'use client';
/**
 * The merchant Account page (PLAN 0.8.2 Merchant), one page whose parts are addresses of their own: Details (business
 * name, owner name, phone, address, country; `/account`), Sign-in (the email, confirmed by email, and the password;
 * `/account/sign-in`), Two-step (on/off, recovery codes; `/account/two-step`) and the merchant's own Activity as a
 * table (`/account/activity`).
 * @module
 */
import { useEffect, useState } from 'react';
import { Button, Form, FormError, Input, Page, Select, SettingsCard, fieldErrors, useToast } from '@ss/ui';
import { COUNTRY_CHOICES } from '../../modules/identity/core/countries.js';
import { LOGIN, MERCHANT, MERCHANT_FIELDS, MORE, TWO_STEP } from '../../texts/console.js';
import { apiFetch, useResource } from '../client.js';
import { Link } from '../link.js';
import { api, routes } from '../paths.js';
import { PageProblem } from './common.js';
import { EmailPanel, PasswordPanel, TwoStepPanel, OwnActivityTimeline } from './login-settings.js';
import { FrameBilling } from './shell.js';

/** The id of the part that shows the person's own activity. */
export const ACTIVITY_PART = 'activity';

/**
 * @param {{ title: string, info: string, part?: string,
 *   parts: Array<{ id: string, label: string, icon: import('@ss/ui').IconName, href?: string, body?: import('react').ReactNode,
 *     dot?: 'success' | 'warning' | 'danger' | 'neutral', dotLabel?: string }>,
 *   activity: { path: string, href?: string, initial?: { items: any[], nextCursor?: string | null } },
 *   facts?: import('@ss/ui').PageFact[], status?: import('@ss/ui').PageStatus[], before?: import('react').ReactNode }} props
 *   `parts` lists the settings parts; the activity part (`ACTIVITY_PART`) is added at its end; `before` is drawn above
 *   the page (the frame's billing banner)
 */
export function AccountPage({ title, info, part, parts, activity, facts, status, before }) {
	useEffect(() => {
		if (part && part !== 'details' && part !== 'profile' && typeof window !== 'undefined' && !window.location.hash) {
			const el = document.getElementById(part);
			if (el) {
				el.scrollIntoView?.({ behavior: 'smooth' });
				window.history.replaceState?.(null, '', `#${part}`);
			}
		}
	}, [part]);

	const sections = [
		...parts.map(({ id, label, icon, body, dot, dotLabel }) => ({
			id,
			label,
			...(icon ? { icon } : {}),
			...(dot ? { dot, dotLabel: dotLabel ?? '' } : {}),
			body: body ?? null,
		})),
		...(activity
			? [
					{
						id: ACTIVITY_PART,
						label: LOGIN.activityTitle,
						icon: /** @type {const} */ ('activity'),
						body: (
							<SettingsCard
								title={LOGIN.activityTitle}
								description={MORE.activityIntro ?? 'Recent sign-ins and security actions on your account.'}>
								<OwnActivityTimeline path={activity.path} initial={activity.initial} />
							</SettingsCard>
						),
					},
				]
			: []),
	];

	return (
		<>
			{before ?? null}
			<Page
				linkAs={Link}
				crumbs={[{ label: title }]}
				info={info}
				sections={sections}
				{...(status ? { status } : {})}
				{...(facts ? { facts } : {})}
			/>
		</>
	);
}

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * Country options with a first "none" choice (stored as the ISO 3166-1 alpha-2 code).
 * @param {string} noneLabel
 */
export const countryOptions = (noneLabel) => [{ value: '', label: noneLabel }, ...COUNTRY_CHOICES];

/**
 * The merchant fields form (Account and the admin Details tab).
 * @param {{ merchant: Record<string, any>, path: string, method?: string, withEmail?: boolean, emailLocked?: boolean,
 *   emailLockedHelp?: string, readOnly?: boolean, onSaved?: (merchant: any) => void }} props
 */
export function MerchantFieldsForm({
	merchant,
	path,
	method = 'PATCH',
	withEmail = false,
	emailLocked = true,
	emailLockedHelp,
	readOnly = false,
	onSaved,
}) {
	const toast = useToast();
	const [form, setForm] = useState({
		name: merchant.name ?? '',
		ownerName: merchant.ownerName ?? '',
		email: merchant.email ?? '',
		phone: merchant.phone ?? '',
		address: merchant.address ?? '',
		country: merchant.country ?? '',
	});
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	/** @param {keyof typeof form} key @param {string} value */
	const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
	const submit = async () => {
		setBusy(true);
		setProblem(null);
		/** @type {Record<string, string | null>} */
		const body = {};
		for (const key of /** @type {const} */ (['name', 'ownerName', 'phone', 'address', 'country'])) {
			const value = form[key].trim() === '' ? null : form[key].trim();
			if (value !== (merchant[key] ?? null)) body[key] = value;
		}
		if (withEmail && !emailLocked && form.email.trim() !== merchant.email) body.email = form.email.trim();
		if (Object.keys(body).length === 0) {
			setBusy(false);
			return;
		}
		const result = await apiFetch(path, { method, body });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: MERCHANT.detailsSaved });
		onSaved?.(result.data);
	};
	const errors = fieldErrors(problem);
	return (
		<Form onSubmit={submit} busy={busy} aria-label={MERCHANT.detailsTitle}>
			<Input
				label={MERCHANT_FIELDS.name}
				autoComplete="organization"
				value={form.name}
				onChange={(e) => set('name', e.currentTarget.value)}
				error={errors.name}
				required
				readOnly={readOnly}
				maxLength={120}
			/>
			<Input
				label={MERCHANT_FIELDS.ownerName}
				autoComplete="name"
				value={form.ownerName}
				onChange={(e) => set('ownerName', e.currentTarget.value)}
				error={errors.ownerName}
				required
				readOnly={readOnly}
				maxLength={120}
			/>
			{withEmail ? (
				<Input
					label={MERCHANT_FIELDS.email}
					type="email"
					autoComplete="email"
					inputMode="email"
					value={form.email}
					onChange={(e) => set('email', e.currentTarget.value)}
					error={errors.email}
					readOnly={readOnly || emailLocked}
					{...(emailLocked && emailLockedHelp ? { help: emailLockedHelp } : {})}
				/>
			) : null}
			<Input
				label={MERCHANT_FIELDS.phone}
				type="tel"
				inputMode="tel"
				autoComplete="tel"
				help={MERCHANT_FIELDS.phoneHelp}
				value={form.phone}
				onChange={(e) => set('phone', e.currentTarget.value)}
				error={errors.phone}
				readOnly={readOnly}
				maxLength={40}
			/>
			<Select
				label={MERCHANT_FIELDS.country}
				value={form.country}
				onChange={(e) => set('country', e.currentTarget.value)}
				error={errors.country}
				disabled={readOnly}
				options={countryOptions(MERCHANT_FIELDS.countryNone)}
			/>
			<Input
				label={MERCHANT_FIELDS.address}
				autoComplete="street-address"
				value={form.address}
				onChange={(e) => set('address', e.currentTarget.value)}
				error={errors.address}
				readOnly={readOnly}
				maxLength={300}
				wide
			/>
			<FormError problem={problem} fields={['name', 'ownerName', 'email', 'phone', 'address', 'country']} />
			{readOnly ? null : (
				<Button type="submit" loading={busy}>
					{LOGIN.save}
				</Button>
			)}
		</Form>
	);
}

/**
 * @param {any} props loader result of `loadAccount` plus the `part` of the address
 */
export function AccountView(props) {
	const { data, reload } = useResource(props.ok ? '/v1/me' : null, props.me ?? null);
	if (!props.ok || !data) return <PageProblem problem={props.problem} />;
	const merchant = data.merchant;
	const twoStepOn = Boolean(merchant.twoStep.enabled);
	return (
		<AccountPage
			before={<FrameBilling billing={props.billing} />}
			title={MERCHANT.accountTitle}
			info={MERCHANT.accountIntro}
			part={props.part ?? 'details'}
			facts={[
				{
					label: TWO_STEP.title,
					value: twoStepOn ? TWO_STEP.on : TWO_STEP.off,
					...(twoStepOn ? { tone: /** @type {const} */ ('success') } : {}),
					href: routes.accountPart('two-step'),
				},
			]}
			parts={[
				{
					id: 'details',
					label: MERCHANT.detailsTitle,
					icon: 'user',
					href: routes.accountPart('details'),
					body: (
						<SettingsCard title={MERCHANT.detailsTitle} description={MERCHANT.detailsIntro}>
							<MerchantFieldsForm merchant={merchant} path="/v1/me" onSaved={() => void reload()} />
						</SettingsCard>
					),
				},
				{
					id: 'sign-in',
					label: MERCHANT.signInTitle,
					icon: 'key',
					href: routes.accountPart('sign-in'),
					body: (
						<>
							<EmailPanel email={merchant.email} twoStepOn={twoStepOn} />
							<PasswordPanel twoStepOn={twoStepOn} />
						</>
					),
				},
				{
					id: 'two-step',
					label: TWO_STEP.title,
					icon: 'shield',
					href: routes.accountPart('two-step'),
					body: <TwoStepPanel twoStep={merchant.twoStep} onChange={() => void reload()} />,
				},
			]}
			activity={{ path: api.activity(props.merchantId), href: routes.accountPart('activity'), initial: props.activity }}
		/>
	);
}
