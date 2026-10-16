'use client';
/**
 * My account (PLAN 0.8.2; every admin, from the user menu): name, sign-in email, password, two-step (on/off,
 * recovery codes) and the admin's own activity.
 * @module
 */
import { useState } from 'react';
import { Badge, Button, Form, FormError, Input, PageHeader, SectionLayout, SettingsCard, fieldErrors, useToast } from '@ss/ui';
import { ADMIN, LOGIN, TWO_STEP } from '../../../texts/console.js';
import { apiFetch, useResource } from '../../client.js';
import { EmailPanel, OwnActivity, PasswordPanel, TwoStepPanel } from '../../views/login-settings.js';
import { adminApi } from '../paths.js';
import { AdminProblem, RoleBadge } from './common.js';

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
 * @param {any} props loader result of `loadMyAccount`
 */
export function MyAccountView(props) {
	const { data, reload } = useResource(props.ok ? adminApi.me() : null, props.me ?? null);
	if (!props.ok || !data) return <AdminProblem problem={props.problem} />;
	const admin = data.admin;
	const A = ADMIN.accountSections;
	return (
		<div className="space-y-6">
			<PageHeader title={ADMIN.myAccountTitle} subtitle={ADMIN.myAccountIntro} />
			<SectionLayout
				label={ADMIN.myAccountTitle}
				sections={[
					{
						id: 'profile',
						label: A.profile,
						icon: 'user',
						group: A.account,
						content: <NameCard admin={admin} onSaved={() => void reload()} />,
					},
					{
						id: 'sign-in',
						label: A.signIn,
						icon: 'key',
						group: A.security,
						content: (
							<>
								<EmailPanel email={admin.email} twoStepOn={admin.twoStep.enabled} />
								<PasswordPanel twoStepOn={admin.twoStep.enabled} />
							</>
						),
					},
					{
						id: 'two-step',
						label: TWO_STEP.title,
						icon: 'shield',
						group: A.security,
						badge: (
							<Badge tone={admin.twoStep.enabled ? 'success' : 'neutral'}>
								{admin.twoStep.enabled ? TWO_STEP.on : TWO_STEP.off}
							</Badge>
						),
						content: <TwoStepPanel twoStep={admin.twoStep} onChange={() => void reload()} />,
					},
					{
						id: 'activity',
						label: LOGIN.activityTitle,
						icon: 'activity',
						group: A.history,
						content: <OwnActivity path={adminApi.myActivity()} initial={props.activity} />,
					},
				]}
			/>
		</div>
	);
}
