'use client';
/**
 * Account settings of the signed-in staff member: name and e-mail, password, and Security (optional two-factor
 * sign-in). Everything is optional and can be added at any time.
 * @module
 */
import { useState } from 'react';
import { Badge, Button, Card, Form, FormActions, FormError, Input, PageHeader, fieldErrors, useToast } from '@ss/ui';
import { adminFetch } from '../client.js';
import { adminApi } from '../paths.js';
import { StaffMfaEnrol } from './auth.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * @param {{ staff: any }} props the `/v1/me` staff object
 */
export function AccountView({ staff }) {
	const toast = useToast();
	const reload = () => window.location.reload();
	return (
		<div className="space-y-6">
			<PageHeader title="Account settings" subtitle={staff?.email ?? staff?.login ?? ''} />
			<ProfileCard staff={staff} onSaved={() => toast.show({ title: 'Profile saved' })} />
			<PasswordCard onSaved={() => toast.show({ title: 'Password changed' })} />
			<Card title="Security" subtitle="Two-factor sign-in (optional): an authenticator app code at every sign-in.">
				{staff?.mfa?.enabled ? (
					<p className="flex items-center gap-2 text-sm">
						Two-factor sign-in <Badge tone="success">On</Badge>
					</p>
				) : (
					<StaffMfaEnrol onDone={reload} onRestart={reload} />
				)}
			</Card>
		</div>
	);
}

/**
 * @param {{ staff: any, onSaved: () => unknown }} props
 */
function ProfileCard({ staff, onSaved }) {
	const [name, setName] = useState(staff?.name ?? '');
	const [email, setEmail] = useState(staff?.email ?? '');
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setBusy(true);
		setProblem(null);
		const body = { ...(name.trim() ? { name: name.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}) };
		const result = await adminFetch(adminApi.me(), { method: 'PATCH', body });
		setBusy(false);
		if (!result.ok) return setProblem(result.problem);
		await onSaved();
	};
	const errors = fieldErrors(problem);
	return (
		<Card title="Profile" subtitle="Optional. An e-mail lets you sign in with it and reset a lost password.">
			<Form onSubmit={save} busy={busy} aria-label="Profile">
				<div className="grid gap-4 sm:grid-cols-2">
					<Input label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} error={errors.name} />
					<Input
						label="E-mail"
						type="email"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						error={errors.email}
					/>
				</div>
				<FormError problem={problem} fields={['name', 'email']} />
				<FormActions>
					<Button type="submit" variant="secondary" loading={busy}>
						Save profile
					</Button>
				</FormActions>
			</Form>
		</Card>
	);
}

/**
 * @param {{ onSaved: () => unknown }} props
 */
function PasswordCard({ onSaved }) {
	const [currentPassword, setCurrent] = useState('');
	const [newPassword, setNext] = useState('');
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.mePassword(), { method: 'POST', body: { currentPassword, newPassword } });
		setBusy(false);
		if (!result.ok) return setProblem(result.problem);
		setCurrent('');
		setNext('');
		await onSaved();
	};
	const errors = fieldErrors(problem);
	return (
		<Card title="Password" subtitle="Other sessions are signed out.">
			<Form onSubmit={save} busy={busy} aria-label="Password">
				<div className="grid gap-4 sm:grid-cols-2">
					<Input
						label="Current password"
						type="password"
						autoComplete="current-password"
						value={currentPassword}
						onChange={(e) => setCurrent(e.currentTarget.value)}
						error={errors.currentPassword}
						required
					/>
					<Input
						label="New password"
						type="password"
						autoComplete="new-password"
						value={newPassword}
						onChange={(e) => setNext(e.currentTarget.value)}
						error={errors.newPassword}
						help="At least 12 characters."
						required
					/>
				</div>
				<FormError problem={problem} fields={['currentPassword', 'newPassword']} />
				<FormActions>
					<Button type="submit" variant="secondary" loading={busy}>
						Change password
					</Button>
				</FormActions>
			</Form>
		</Card>
	);
}
