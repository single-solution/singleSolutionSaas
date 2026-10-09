'use client';
/**
 * The merchant Account page (PLAN 0.8.2 Merchant): business details (business name, owner name, phone, address,
 * country), the sign-in e-mail (confirmed by e-mail), the password, two-step sign-in (on/off, recovery codes) and the
 * merchant's own activity.
 * @module
 */
import { useState } from 'react';
import { Button, Card, Form, FormError, Input, Masonry, PageHeader, Select, fieldErrors, useToast } from '@ss/ui';
import { COUNTRY_CODES } from '../../modules/identity/core/countries.js';
import { LOGIN, MERCHANT, MERCHANT_FIELDS } from '../../texts/console.js';
import { apiFetch, useResource } from '../client.js';
import { api } from '../paths.js';
import { PageProblem } from './common.js';
import { EmailPanel, OwnActivity, PasswordPanel, TwoStepPanel } from './login-settings.js';
import { FrameBilling } from './frame-billing.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * Country options, shown by name in the viewer's language and stored as the ISO 3166-1 alpha-2 code.
 * @param {string} noneLabel
 */
export const countryOptions = (noneLabel) => {
	/** @type {Intl.DisplayNames | null} */
	let names = null;
	try {
		names = new Intl.DisplayNames(['en'], { type: 'region' });
	} catch {
		names = null;
	}
	return [
		{ value: '', label: noneLabel },
		...COUNTRY_CODES.map((code) => ({ value: code, label: names?.of(code) ?? code })).sort((a, b) =>
			String(a.label).localeCompare(String(b.label)),
		),
	];
};

/**
 * The merchant fields form (Account and the admin Details tab).
 * @param {{ merchant: Record<string, any>, path: string, method?: string, withEmail?: boolean, emailLocked?: boolean,
 *   emailLockedHelp?: string, readOnly?: boolean, onSaved?: (merchant: any) => void, fetcher?: typeof apiFetch }} props
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
	fetcher = apiFetch,
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
		const result = await fetcher(path, { method, body });
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
				value={form.name}
				onChange={(e) => set('name', e.currentTarget.value)}
				error={errors.name}
				required
				readOnly={readOnly}
				maxLength={120}
			/>
			<Input
				label={MERCHANT_FIELDS.ownerName}
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
					value={form.email}
					onChange={(e) => set('email', e.currentTarget.value)}
					error={errors.email}
					readOnly={readOnly || emailLocked}
					{...(emailLocked && emailLockedHelp ? { help: emailLockedHelp } : {})}
				/>
			) : null}
			<Input
				label={MERCHANT_FIELDS.phone}
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
 * @param {any} props loader result of `loadAccount`
 */
export function AccountView(props) {
	const { data, reload } = useResource(props.ok ? '/v1/me' : null, props.me ?? null);
	if (!props.ok || !data) return <PageProblem problem={props.problem} />;
	const merchant = data.merchant;
	return (
		<div className="space-y-8">
			<FrameBilling billing={props.billing} />
			<PageHeader title={MERCHANT.accountTitle} subtitle={MERCHANT.accountIntro} />
			<Masonry columns={2}>
				<Card title={MERCHANT.detailsTitle} subtitle={MERCHANT.detailsIntro}>
					<MerchantFieldsForm merchant={merchant} path="/v1/me" onSaved={() => void reload()} />
				</Card>
				<EmailPanel email={merchant.email} twoStepOn={merchant.twoStep.enabled} />
				<PasswordPanel twoStepOn={merchant.twoStep.enabled} />
				<TwoStepPanel twoStep={merchant.twoStep} onChange={() => void reload()} />
			</Masonry>
			<OwnActivity path={api.activity(props.merchantId)} initial={props.activity} />
		</div>
	);
}
