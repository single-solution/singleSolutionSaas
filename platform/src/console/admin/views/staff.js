'use client';
/**
 * Staff users: invite (a 24 h setup link is e-mailed; the account has no password until it is used, and MFA is
 * mandatory at the first sign-in), change roles, reset an authenticator (lost device), deactivate / reactivate.
 * The last active superadmin cannot be demoted or disabled, and nobody disables or resets themselves (server rules).
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	CheckboxGroup,
	Dialog,
	FormError,
	Icon,
	Input,
	PageHeader,
	StatusBadge,
	Table,
	TypedConfirmDialog,
	describeProblem,
	fieldErrors,
	formatDate,
	useToast,
} from '@ss/ui';
import { adminFetch, useAdminResource } from '../client.js';
import { adminApi } from '../paths.js';
import { AdminProblem, Roles } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** Staff roles and what they can do (infra RBAC bundles). */
export const STAFF_ROLES = Object.freeze([
	{ value: 'superadmin', label: 'Superadmin — everything, including staff management' },
	{ value: 'admin', label: 'Admin — every platform and merchant operation except staff' },
	{ value: 'support', label: 'Support — read-only, admin launches per merchant' },
	{ value: 'finance', label: 'Finance — credits, ledgers, reconciliation' },
]);

/**
 * @param {any} props loader result of `loadStaff`
 */
export function StaffView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const { data, reload } = useAdminResource(ok ? adminApi.staffList() : null, { items: ok ? props.items : [] });
	const [inviting, setInviting] = useState(false);
	const [email, setEmail] = useState('');
	const [name, setName] = useState('');
	const [roles, setRoles] = useState(/** @type {string[]} */ (['support']));
	const [editing, setEditing] = useState(/** @type {any} */ (null));
	const [editRoles, setEditRoles] = useState(/** @type {string[]} */ ([]));
	const [confirm, setConfirm] = useState(/** @type {null | { kind: 'mfa' | 'disable' | 'enable', staff: any }} */ (null));
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	if (!ok) return <AdminProblem problem={props.problem} />;
	const me = props.me;
	const items = /** @type {any[]} */ (data.items ?? []);

	const invite = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) local.email = 'Enter an e-mail address.';
		if (roles.length === 0) local.roles = 'Choose at least one role.';
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.staffList(), {
			method: 'POST',
			body: { email: email.trim(), roles, ...(name.trim() ? { name: name.trim() } : {}) },
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
			return;
		}
		toast.show({ title: `Invitation sent to ${email.trim()}`, description: 'The setup link is valid for 24 hours.' });
		setInviting(false);
		setEmail('');
		setName('');
		setRoles(['support']);
		await reload();
	};
	const saveRoles = async () => {
		if (editRoles.length === 0) {
			setErrors({ roles: 'Choose at least one role.' });
			return;
		}
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.staffMember(editing.staffId), { method: 'PATCH', body: { roles: editRoles } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: `Roles of ${editing.email} updated` });
		setEditing(null);
		await reload();
	};
	const runConfirm = async (/** @type {{ reason: string }} */ { reason }) => {
		if (!confirm) return;
		setBusy(true);
		setProblem(null);
		const result =
			confirm.kind === 'mfa'
				? await adminFetch(adminApi.staffMfaReset(confirm.staff.staffId), { method: 'POST', body: { reason } })
				: await adminFetch(adminApi.staffMember(confirm.staff.staffId), {
						method: 'PATCH',
						body: { status: confirm.kind === 'disable' ? 'disabled' : 'active' },
					});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({
			title:
				confirm.kind === 'mfa'
					? `Authenticator of ${confirm.staff.email} reset`
					: confirm.kind === 'disable'
						? `${confirm.staff.email} deactivated`
						: `${confirm.staff.email} reactivated`,
			description: confirm.kind === 'enable' ? undefined : 'Their sessions were signed out.',
		});
		setConfirm(null);
		await reload();
	};
	return (
		<div className="space-y-6">
			<PageHeader
				title="Staff"
				subtitle="Platform operators. Two-factor authentication is mandatory for everyone."
				actions={
					<Button
						onClick={() => {
							setErrors({});
							setProblem(null);
							setInviting(true);
						}}
						icon={<Icon name="plus" size={14} />}>
						Invite staff
					</Button>
				}
			/>
			<Table
				caption="Staff users"
				rows={items}
				rowKey={(s) => s.staffId}
				empty="No staff users."
				columns={[
					{
						key: 'email',
						header: 'Staff',
						rowHeader: true,
						sortable: true,
						render: (s) => (
							<span className="space-y-0.5">
								<span className="block font-semibold">
									{s.email} {s.staffId === me?.staffId ? <Badge tone="info">You</Badge> : null}
								</span>
								{s.name ? <span className="block text-xs text-muted">{s.name}</span> : null}
							</span>
						),
					},
					{ key: 'roles', header: 'Roles', render: (s) => <Roles roles={s.roles} /> },
					{
						key: 'security',
						header: 'Security',
						render: (s) => (
							<span className="flex flex-wrap gap-1">
								{s.passwordSet ? null : <Badge tone="warning">Invite pending</Badge>}
								{s.mfa.enabled ? <Badge tone="success">MFA on</Badge> : <Badge tone="warning">MFA not set up</Badge>}
								{s.mfa.enabled && s.mfa.recoveryCodesLeft <= 3 ? (
									<Badge tone="warning">{s.mfa.recoveryCodesLeft} recovery codes</Badge>
								) : null}
							</span>
						),
					},
					{ key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
					{ key: 'createdAt', header: 'Since', sortable: true, render: (s) => formatDate(s.createdAt) },
					{
						key: 'actions',
						header: <span className="sr-only">Actions</span>,
						align: 'right',
						render: (s) =>
							s.staffId === me?.staffId ? null : (
								<span className="inline-flex flex-wrap justify-end gap-1">
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											setErrors({});
											setProblem(null);
											setEditRoles([...s.roles]);
											setEditing(s);
										}}>
										Roles
									</Button>
									{s.mfa.enabled ? (
										<Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'mfa', staff: s })}>
											Reset MFA
										</Button>
									) : null}
									{s.status === 'active' ? (
										<Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'disable', staff: s })}>
											Deactivate
										</Button>
									) : (
										<Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'enable', staff: s })}>
											Reactivate
										</Button>
									)}
								</span>
							),
					},
				]}
			/>
			<Dialog
				open={inviting}
				onClose={() => setInviting(false)}
				title="Invite a staff member"
				description="They get a setup link by e-mail, choose a password and enrol an authenticator."
				footer={
					<>
						<Button variant="secondary" onClick={() => setInviting(false)}>
							Cancel
						</Button>
						<Button onClick={() => void invite()} loading={busy}>
							Send invitation
						</Button>
					</>
				}>
				<Input
					label="E-mail"
					type="email"
					value={email}
					onChange={(e) => setEmail(e.currentTarget.value)}
					error={errors.email}
					required
				/>
				<Input
					label="Name (optional)"
					value={name}
					maxLength={120}
					onChange={(e) => setName(e.currentTarget.value)}
					error={errors.name}
				/>
				<CheckboxGroup legend="Roles" value={roles} onChange={setRoles} options={[...STAFF_ROLES]} error={errors.roles} />
				<FormError problem={problem} fields={['email', 'name', 'roles']} />
			</Dialog>
			<Dialog
				open={Boolean(editing)}
				onClose={() => setEditing(null)}
				title={`Roles of ${editing?.email ?? ''}`}
				description="Their sessions keep working; new permissions apply on the next request."
				footer={
					<>
						<Button variant="secondary" onClick={() => setEditing(null)}>
							Cancel
						</Button>
						<Button onClick={() => void saveRoles()} loading={busy}>
							Save roles
						</Button>
					</>
				}>
				<CheckboxGroup
					legend="Roles"
					value={editRoles}
					onChange={setEditRoles}
					options={[...STAFF_ROLES]}
					error={errors.roles}
				/>
				{editRoles.includes('superadmin') && !editing?.roles.includes('superadmin') ? (
					<Callout tone="warning" live={false}>
						Superadmins can manage staff, including you.
					</Callout>
				) : null}
				<FormError problem={problem} fields={['roles']} />
			</Dialog>
			<TypedConfirmDialog
				open={confirm !== null}
				onClose={() => setConfirm(null)}
				onConfirm={(input) => void runConfirm(input)}
				busy={busy}
				danger={confirm?.kind !== 'enable'}
				title={
					confirm?.kind === 'mfa'
						? `Reset the authenticator of ${confirm.staff.email}?`
						: confirm?.kind === 'disable'
							? `Deactivate ${confirm?.staff.email}?`
							: `Reactivate ${confirm?.staff.email ?? ''}?`
				}
				expected={confirm?.staff.email ?? ''}
				confirmLabel={
					confirm?.kind === 'mfa' ? 'Reset authenticator' : confirm?.kind === 'disable' ? 'Deactivate' : 'Reactivate'
				}
				reason={confirm?.kind === 'mfa' ? { required: true, label: 'Reason (audited)' } : false}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					{confirm?.kind === 'mfa'
						? 'Their authenticator and recovery codes are removed and every session is signed out. They must enrol again at the next sign-in. Verify their identity out of band first.'
						: confirm?.kind === 'disable'
							? 'They are signed out everywhere and can no longer sign in.'
							: 'They can sign in again with their password and authenticator.'}
				</p>
			</TypedConfirmDialog>
		</div>
	);
}
