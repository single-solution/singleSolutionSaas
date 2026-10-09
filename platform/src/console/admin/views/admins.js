'use client';
/**
 * Admins (PLAN 0.8.2; Owner only): one list-and-detail screen. The list (search; per row the name, e-mail, a status dot
 * — invited grey — and the role) with **Invite** (e-mail + role) sits beside the selected admin: e-mail, role, two-step
 * on/off and last sign-in, with the actions Resend invite or Copy invite link and Correct invite e-mail (until
 * accepted), Change role, Turn off two-step and Remove, as dialogs. The last Owner cannot be removed or demoted and no
 * one removes themselves (the API refuses; the screen explains).
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Card,
	CodeBlock,
	ConfirmDialog,
	Dialog,
	EmptyState,
	Form,
	FormError,
	Icon,
	Input,
	KeyValueList,
	PageHeader,
	Select,
	describeProblem,
	fieldErrors,
	formatDateTime,
	useToast,
} from '@ss/ui';
import { ADMIN, TWO_STEP } from '../../../texts/console.js';
import { adminFetch, useAdminResource } from '../client.js';
import { ListDetail, ListPane, ListRow, ListSearch } from '../../views/common.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, RoleBadge } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

const ROLE_OPTIONS = Object.freeze([
	{ value: 'owner', label: ADMIN.roles.owner },
	{ value: 'support', label: ADMIN.roles.support },
	{ value: 'finance', label: ADMIN.roles.finance },
]);

/**
 * @param {any} props loader result of `loadAdmins` plus `selectedId` (an admin selected)
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
	const [q, setQ] = useState('');
	if (!ok) return <AdminProblem problem={props.problem} />;
	const selectedId = typeof props.selectedId === 'string' ? props.selectedId : null;
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
		if (dialog.kind === 'remove') window.location.assign(adminRoutes.admins());
		else await reload();
	};
	/** @param {'invite' | 'email' | 'role' | 'twoStep' | 'remove'} kind @param {any} [admin] */
	const open = (kind, admin) => {
		setProblem(null);
		setEmail(kind === 'email' ? (admin?.email ?? '') : '');
		setRole(admin?.role ?? 'support');
		setDialog({ kind, ...(admin ? { admin } : {}) });
	};

	const needle = q.trim().toLowerCase();
	const shown = items.filter((a) => !needle || `${a.name ?? ''} ${a.email}`.toLowerCase().includes(needle));
	const current = selectedId ? (items.find((a) => a.adminId === selectedId) ?? null) : null;
	const actions = current ? (
		<div className="flex flex-wrap gap-2">
			{current.status === 'invited' ? (
				<>
					<Button variant="secondary" onClick={() => void resend(current, false)}>
						{ADMIN.resendInvite}
					</Button>
					<Button variant="secondary" onClick={() => void resend(current, true)}>
						{ADMIN.copyInvite}
					</Button>
					<Button variant="secondary" onClick={() => open('email', current)}>
						{ADMIN.correctEmail}
					</Button>
				</>
			) : null}
			{current.adminId !== me?.adminId ? (
				<>
					<Button variant="secondary" onClick={() => open('role', current)}>
						{ADMIN.changeRole}
					</Button>
					{current.twoStep?.enabled ? (
						<Button variant="secondary" onClick={() => open('twoStep', current)}>
							{ADMIN.turnOffTwoStep}
						</Button>
					) : null}
					<Button variant="danger" onClick={() => open('remove', current)}>
						{ADMIN.remove}
					</Button>
				</>
			) : null}
		</div>
	) : null;

	return (
		<>
			<ListDetail
				label={ADMIN.adminsTitle}
				back={{ href: adminRoutes.admins(), label: ADMIN.adminsTitle }}
				list={
					<ListPane
						title={ADMIN.adminsTitle}
						action={
							<Button size="sm" onClick={() => open('invite')} icon={<Icon name="plus" size={14} />}>
								{ADMIN.invite}
							</Button>
						}
						tools={<ListSearch label={ADMIN.searchAdmins} value={q} onChange={setQ} />}>
						{shown.map((a) => (
							<ListRow
								key={a.adminId}
								href={adminRoutes.admin(a.adminId)}
								current={a.adminId === selectedId}
								label={a.adminId === me?.adminId ? `${a.name ?? a.email} (${ADMIN.you})` : (a.name ?? a.email)}
								sublabel={a.email}
								dot={a.status === 'invited' ? 'neutral' : 'success'}
								dotLabel={a.status === 'invited' ? ADMIN.invited : ADMIN.status.active}
								meta={ADMIN.roles[/** @type {'owner'} */ (a.role)] ?? a.role}
							/>
						))}
					</ListPane>
				}
				empty={<EmptyState icon="key" kind="admin" title={ADMIN.selectAdminTitle} description={ADMIN.adminsIntro} />}
				detail={
					selectedId === null ? null : current ? (
						<>
							<PageHeader
								level={2}
								title={current.name ?? current.email}
								badge={
									<span className="inline-flex flex-wrap gap-1">
										<RoleBadge role={current.role} />
										{current.status === 'invited' ? <Badge tone="info">{ADMIN.invited}</Badge> : null}
									</span>
								}
								subtitle={current.adminId === me?.adminId ? `${current.email} · ${ADMIN.you}` : current.email}
								actions={actions}
							/>
							<Card>
								<KeyValueList
									columns={3}
									items={[
										{ label: 'E-mail', value: current.email },
										{ label: ADMIN.role, value: ADMIN.roles[/** @type {'owner'} */ (current.role)] ?? current.role },
										{ label: ADMIN.twoStepColumn, value: current.twoStep?.enabled ? TWO_STEP.on : TWO_STEP.off },
										{ label: ADMIN.columns.lastSignIn, value: formatDateTime(current.lastSignInAt) },
									]}
								/>
							</Card>
						</>
					) : (
						<EmptyState icon="key" title={ADMIN.adminGone} />
					)
				}
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
		</>
	);
}
