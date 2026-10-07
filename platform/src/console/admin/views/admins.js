'use client';
/**
 * Admins (PLAN 0.8.2; Owner only): name, e-mail, role, two-step on/off and last sign-in; Invite (e-mail + role),
 * Resend invite or Copy invite link and Correct invite e-mail (until accepted), Change role, Turn off two-step, Remove.
 * The last Owner cannot be removed or demoted and no one removes themselves (the API refuses; the screen explains).
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	CodeBlock,
	ConfirmDialog,
	Dialog,
	Form,
	FormError,
	Icon,
	Input,
	PageHeader,
	Select,
	Table,
	describeProblem,
	fieldErrors,
	formatDateTime,
	useToast,
} from '@ss/ui';
import { ADMIN, TWO_STEP } from '../../../texts/console.js';
import { adminFetch, useAdminResource } from '../client.js';
import { adminApi } from '../paths.js';
import { AdminProblem, RoleBadge } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

const ROLE_OPTIONS = Object.freeze([
	{ value: 'owner', label: ADMIN.roles.owner },
	{ value: 'support', label: ADMIN.roles.support },
	{ value: 'finance', label: ADMIN.roles.finance },
]);

/**
 * @param {any} props loader result of `loadAdmins`
 */
export function AdminsView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const { data, reload } = useAdminResource(ok ? adminApi.admins() : null, { items: ok ? props.items : [] });
	const [dialog, setDialog] = useState(
		/** @type {null | { kind: 'invite' | 'email' | 'role' | 'twoStep' | 'remove', admin?: any }} */ (null),
	);
	const [email, setEmail] = useState('');
	const [role, setRole] = useState('support');
	const [link, setLink] = useState(/** @type {string | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	if (!ok) return <AdminProblem problem={props.problem} />;
	const me = props.me;
	const items = /** @type {any[]} */ (data.items ?? []);

	/**
	 * @param {string} path
	 * @param {string} method
	 * @param {Record<string, unknown>} [body]
	 */
	const call = async (path, method, body) => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(path, { method, ...(body ? { body } : {}) });
		setBusy(false);
		if (!result.ok) setProblem(result.problem);
		return result;
	};
	/** @param {boolean} copy */
	const invite = async (copy) => {
		const result = await call(adminApi.admins(), 'POST', { email: email.trim(), role, copy });
		if (!result.ok) return;
		setDialog(null);
		setEmail('');
		if (copy) setLink(result.data?.invite?.link ?? null);
		else toast.show({ title: result.data?.invite?.mailed ? ADMIN.inviteMailed : ADMIN.inviteNotMailed });
		await reload();
	};
	/** @param {any} admin @param {boolean} copy */
	const resend = async (admin, copy) => {
		const result = await call(adminApi.adminInvite(admin.adminId), 'POST', { copy });
		if (!result.ok) {
			toast.show({ tone: 'danger', title: describeProblem(result.problem) });
			return;
		}
		if (copy) setLink(result.data?.link ?? null);
		else toast.show({ title: result.data?.mailed ? ADMIN.inviteMailed : ADMIN.inviteNotMailed });
	};
	const save = async () => {
		if (!dialog?.admin) return;
		const id = dialog.admin.adminId;
		const result =
			dialog.kind === 'email'
				? await call(adminApi.admin(id), 'PATCH', { email: email.trim() })
				: dialog.kind === 'role'
					? await call(adminApi.admin(id), 'PATCH', { role })
					: dialog.kind === 'twoStep'
						? await call(adminApi.adminTwoStepOff(id), 'POST', {})
						: await call(adminApi.admin(id), 'DELETE');
		if (!result.ok) return;
		setDialog(null);
		await reload();
	};
	/** @param {'invite' | 'email' | 'role' | 'twoStep' | 'remove'} kind @param {any} [admin] */
	const open = (kind, admin) => {
		setProblem(null);
		setEmail(kind === 'email' ? (admin?.email ?? '') : '');
		setRole(admin?.role ?? 'support');
		setDialog({ kind, ...(admin ? { admin } : {}) });
	};

	return (
		<div className="space-y-6">
			<PageHeader
				title={ADMIN.adminsTitle}
				actions={
					<Button onClick={() => open('invite')} icon={<Icon name="plus" size={14} />}>
						{ADMIN.invite}
					</Button>
				}
			/>
			<Table
				caption={ADMIN.adminsTitle}
				captionHidden
				rows={items}
				rowKey={(a) => a.adminId}
				columns={[
					{
						key: 'name',
						header: ADMIN.columns.name,
						rowHeader: true,
						render: (a) => (
							<span className="block min-w-0">
								<span className="font-semibold">{a.name ?? '—'}</span>
								{a.adminId === me?.adminId ? <span className="ml-1 text-xs text-muted">({ADMIN.you})</span> : null}
								<span className="block truncate text-xs text-muted">{a.email}</span>
							</span>
						),
					},
					{
						key: 'role',
						header: ADMIN.role,
						render: (a) => (
							<span className="inline-flex flex-wrap gap-1">
								<RoleBadge role={a.role} />
								{a.status === 'invited' ? <Badge tone="info">{ADMIN.invited}</Badge> : null}
							</span>
						),
					},
					{ key: 'twoStep', header: ADMIN.twoStepColumn, render: (a) => (a.twoStep?.enabled ? TWO_STEP.on : TWO_STEP.off) },
					{ key: 'lastSignInAt', header: ADMIN.columns.lastSignIn, render: (a) => formatDateTime(a.lastSignInAt) },
					{
						key: 'actions',
						header: <span className="sr-only">Actions</span>,
						align: 'right',
						render: (a) => (
							<span className="flex flex-wrap justify-end gap-1">
								{a.status === 'invited' ? (
									<>
										<Button size="sm" variant="ghost" onClick={() => void resend(a, false)}>
											{ADMIN.resendInvite}
										</Button>
										<Button size="sm" variant="ghost" onClick={() => void resend(a, true)}>
											{ADMIN.copyInvite}
										</Button>
										<Button size="sm" variant="ghost" onClick={() => open('email', a)}>
											{ADMIN.correctEmail}
										</Button>
									</>
								) : null}
								{a.adminId !== me?.adminId ? (
									<>
										<Button size="sm" variant="ghost" onClick={() => open('role', a)}>
											{ADMIN.changeRole}
										</Button>
										{a.twoStep?.enabled ? (
											<Button size="sm" variant="ghost" onClick={() => open('twoStep', a)}>
												{ADMIN.turnOffTwoStep}
											</Button>
										) : null}
										<Button size="sm" variant="ghost" onClick={() => open('remove', a)}>
											{ADMIN.remove}
										</Button>
									</>
								) : null}
							</span>
						),
					},
				]}
			/>
			<Dialog open={dialog?.kind === 'invite'} onClose={() => setDialog(null)} title={ADMIN.inviteTitle}>
				<Form onSubmit={() => invite(false)} busy={busy} aria-label={ADMIN.inviteTitle}>
					<Input
						label="E-mail"
						type="email"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						error={fieldErrors(problem).email}
						required
					/>
					<Select
						label={ADMIN.role}
						value={role}
						onChange={(e) => setRole(e.currentTarget.value)}
						options={[...ROLE_OPTIONS]}
					/>
					<FormError problem={problem} fields={['email', 'role']} />
					<div className="flex flex-wrap gap-2">
						<Button type="submit" loading={busy}>
							{ADMIN.invite}
						</Button>
						<Button variant="secondary" onClick={() => void invite(true)} loading={busy}>
							{ADMIN.copyInvite}
						</Button>
					</div>
				</Form>
			</Dialog>
			<ConfirmDialog
				open={dialog !== null && dialog.kind !== 'invite'}
				onClose={() => setDialog(null)}
				onConfirm={() => void save()}
				busy={busy}
				danger={dialog?.kind === 'remove' || dialog?.kind === 'twoStep'}
				confirmLabel={
					dialog?.kind === 'email'
						? ADMIN.correctEmail
						: dialog?.kind === 'role'
							? ADMIN.changeRole
							: dialog?.kind === 'twoStep'
								? ADMIN.turnOffTwoStep
								: ADMIN.remove
				}
				title={`${dialog?.admin?.name ?? dialog?.admin?.email ?? ''}`}
				error={problem ? describeProblem(problem) : null}>
				{dialog?.kind === 'email' ? (
					<Input label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} required />
				) : dialog?.kind === 'role' ? (
					<div className="space-y-3">
						<p className="text-sm text-muted">{ADMIN.roleChangeHelp}</p>
						<Select
							label={ADMIN.role}
							value={role}
							onChange={(e) => setRole(e.currentTarget.value)}
							options={[...ROLE_OPTIONS]}
						/>
					</div>
				) : dialog?.kind === 'twoStep' ? (
					<p className="text-sm text-muted">{ADMIN.turnOffTwoStepHelp}</p>
				) : (
					<p className="text-sm text-muted">{ADMIN.removeAdminHelp}</p>
				)}
			</ConfirmDialog>
			<Dialog open={Boolean(link)} onClose={() => setLink(null)} title={ADMIN.copyInvite} description={ADMIN.setupLinkCopy}>
				{link ? <CodeBlock code={link} label={ADMIN.copyInvite} secret wrap /> : null}
			</Dialog>
		</div>
	);
}
