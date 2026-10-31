'use client';
/**
 * My account (PLAN 0.8.2; every admin, from the user menu), one page whose parts are addresses of their own: Profile
 * (the name; `/admin/account`), Sign-in (email and password), Two-step (on/off, recovery codes) and the admin's own
 * Activity as a table.
 * @module
 */
import { useState } from 'react';
import { Button, Form, FormError, Input, SettingsCard, fieldErrors, useToast } from '@ss/ui';
import { ADMIN, LOGIN, TWO_STEP } from '../../../texts/console.js';
import { apiFetch, useResource } from '../../client.js';
import { AccountPage } from '../../views/account.js';
import { EmailPanel, PasswordPanel, TwoStepPanel } from '../../views/login-settings.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, RoleBadge } from './shell.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** @param {{ admin: any, onSaved: () => void }} props */
function NameCard({ admin, onSaved }) {
	const toast = useToast();
	const [name, setName] = useState(admin.name ?? '');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const submit = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(adminApi.me(), { method: 'PATCH', body: { name: name.trim() } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: LOGIN.saved });
		onSaved();
	};
	return (
		<SettingsCard title={ADMIN.nameTitle} actions={<RoleBadge role={admin.role} />}>
			<Form onSubmit={submit} busy={busy} aria-label={ADMIN.nameTitle}>
				<Input
					label={ADMIN.nameTitle}
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					error={fieldErrors(problem).name}
					required
					maxLength={120}
				/>
				<FormError problem={problem} fields={['name']} />
				<Button type="submit" loading={busy}>
					{LOGIN.save}
				</Button>
			</Form>
		</SettingsCard>
	);
}

/**
 * @param {any} props loader result of `loadMyAccount` plus the `part` of the address
 */
export function MyAccountView(props) {
	const { data, reload } = useResource(props.ok ? adminApi.me() : null, props.me ?? null);
	if (!props.ok || !data) return <AdminProblem problem={props.problem} />;
	const admin = data.admin;
	const A = ADMIN.accountSections;
	const twoStepOn = Boolean(admin.twoStep.enabled);
	return (
		<AccountPage
			title={ADMIN.myAccountTitle}
			info={ADMIN.myAccountIntro}
			part={props.part ?? 'profile'}
			facts={[
				{
					label: TWO_STEP.title,
					value: twoStepOn ? TWO_STEP.on : TWO_STEP.off,
					...(twoStepOn ? { tone: /** @type {const} */ ('success') } : {}),
					href: adminRoutes.accountPart('two-step'),
				},
			]}
			parts={[
				{
					id: 'profile',
					label: A.profile,
					icon: 'user',
					href: adminRoutes.accountPart('profile'),
					body: <NameCard admin={admin} onSaved={() => void reload()} />,
				},
				{
					id: 'sign-in',
					label: A.signIn,
					icon: 'key',
					href: adminRoutes.accountPart('sign-in'),
					body: (
						<>
							<EmailPanel email={admin.email} twoStepOn={twoStepOn} />
							<PasswordPanel twoStepOn={twoStepOn} />
						</>
					),
				},
				{
					id: 'two-step',
					label: TWO_STEP.title,
					icon: 'shield',
					href: adminRoutes.accountPart('two-step'),
					body: <TwoStepPanel twoStep={admin.twoStep} onChange={() => void reload()} />,
				},
			]}
			activity={{ path: adminApi.myActivity(), href: adminRoutes.accountPart('activity'), initial: props.activity }}
		/>
	);
}
