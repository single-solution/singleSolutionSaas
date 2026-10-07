'use client';
/**
 * Team: members with roles and website-scoped grants, pending invites, invite / edit / remove.
 * Owners are managed by ownership transfer, never by role edits.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Card,
	CheckboxGroup,
	ConfirmDialog,
	Dialog,
	EmptyState,
	FormError,
	Icon,
	Input,
	PageHeader,
	RadioGroup,
	StatusBadge,
	Table,
	describeProblem,
	fieldErrors,
	formatDate,
	humanize,
	useToast,
} from '@ss/ui';
import { apiFetch, useResource } from '../client.js';
import { api } from '../paths.js';
import { PageProblem, websiteLabel } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** Roles an owner/admin can assign (owner is transferred, not assigned). */
export const ROLES = Object.freeze([
	{ value: 'admin', label: 'Admin — everything except ownership' },
	{ value: 'billing', label: 'Billing — credits, statements, spend cap' },
	{ value: 'developer', label: 'Developer — keys, resources, configuration' },
	{ value: 'editor', label: 'Editor — element settings and content' },
]);

/**
 * Access editor: organisation-wide roles or website-scoped grants.
 * @param {{ scope: 'all' | 'websites', setScope: (s: 'all' | 'websites') => void, roles: string[], setRoles: (r: string[]) => void,
 *   grants: Record<string, string[]>, setGrants: (g: Record<string, string[]>) => void, websites: any[], error?: string }} props
 */
function AccessEditor({ scope, setScope, roles, setRoles, grants, setGrants, websites, error }) {
	const live = websites.filter((w) => w.env === 'live');
	return (
		<div className="space-y-4">
			<RadioGroup
				legend="Access"
				value={scope}
				onChange={(v) => setScope(v === 'websites' ? 'websites' : 'all')}
				options={[
					{ value: 'all', label: 'All websites' },
					{ value: 'websites', label: 'Only some websites' },
				]}
			/>
			{scope === 'all' ? (
				<CheckboxGroup
					legend="Roles"
					value={roles}
					onChange={setRoles}
					options={ROLES.map((r) => ({ value: r.value, label: r.label }))}
					error={error}
				/>
			) : (
				<div className="space-y-4">
					{live.length === 0 ? <p className="text-sm text-muted">Add a website first.</p> : null}
					{live.map((w) => (
						<CheckboxGroup
							key={w.websiteId}
							legend={websiteLabel(w)}
							value={grants[w.websiteId] ?? []}
							onChange={(next) => setGrants({ ...grants, [w.websiteId]: next })}
							options={ROLES.map((r) => ({ value: r.value, label: humanize(r.value) }))}
							help="Includes its test twin."
						/>
					))}
					{error ? (
						<p role="alert" className="text-xs font-medium text-danger">
							{error}
						</p>
					) : null}
				</div>
			)}
		</div>
	);
}

/**
 * @param {any} props loader result of `loadTeam`
 */
export function TeamView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const { data, reload } = useResource(ok ? api.team(props.merchantId) : null, {
		members: ok ? props.members : [],
		invites: ok ? props.invites : [],
	});
	const [dialog, setDialog] = useState(/** @type {null | { mode: 'invite' } | { mode: 'edit', member: any }} */ (null));
	const [email, setEmail] = useState('');
	const [scope, setScope] = useState(/** @type {'all' | 'websites'} */ ('all'));
	const [roles, setRoles] = useState(/** @type {string[]} */ (['editor']));
	const [grants, setGrants] = useState(/** @type {Record<string, string[]>} */ ({}));
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [confirm, setConfirm] = useState(
		/** @type {null | { kind: 'member', member: any } | { kind: 'invite', invite: any }} */ (null),
	);
	if (!ok) return <PageProblem problem={props.problem} />;
	const { merchantId, me, websites } = props;
	const members = /** @type {any[]} */ (data.members ?? []);
	const invites = /** @type {any[]} */ ((data.invites ?? []).filter((/** @type {any} */ i) => i.status === 'pending'));
	const myRoles = /** @type {string[]} */ (
		(me?.memberships ?? []).find((/** @type {any} */ m) => m.merchantId === merchantId)?.roles ?? []
	);
	const canManage = myRoles.includes('owner') || myRoles.includes('admin');
	/** @param {string} id */
	const site = (id) => websites.find((/** @type {any} */ w) => w.websiteId === id);

	const openInvite = () => {
		setEmail('');
		setScope('all');
		setRoles(['editor']);
		setGrants({});
		setErrors({});
		setProblem(null);
		setDialog({ mode: 'invite' });
	};
	/** @param {any} member */
	const openEdit = (member) => {
		const scoped = (member.grants ?? []).length > 0;
		setScope(scoped ? 'websites' : 'all');
		setRoles(member.roles.filter((/** @type {string} */ r) => r !== 'owner'));
		setGrants(Object.fromEntries((member.grants ?? []).map((/** @type {any} */ g) => [g.websiteId, g.roles])));
		setErrors({});
		setProblem(null);
		setDialog({ mode: 'edit', member });
	};
	const access = () =>
		scope === 'all'
			? { roles, grants: [] }
			: {
					roles: [],
					grants: Object.entries(grants)
						.filter(([, r]) => r.length > 0)
						.map(([websiteId, r]) => ({ websiteId, roles: r })),
				};
	const save = async () => {
		/** @type {Record<string, string>} */
		const local = {};
		const a = access();
		if (dialog?.mode === 'invite' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) local.email = 'Enter an e-mail address.';
		if (a.roles.length === 0 && a.grants.length === 0) local.access = 'Give at least one role.';
		setErrors(local);
		if (Object.keys(local).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result =
			dialog?.mode === 'edit'
				? await apiFetch(`${api.team(merchantId)}/members/${encodeURIComponent(dialog.member.userId)}`, {
						method: 'PATCH',
						body: a,
					})
				: await apiFetch(`${api.team(merchantId)}/invites`, { method: 'POST', body: { email: email.trim(), ...a } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			const fe = fieldErrors(result.problem);
			setErrors({
				...(fe.email ? { email: fe.email } : {}),
				...(fe.roles || fe.grants ? { access: fe.roles ?? fe.grants ?? '' } : {}),
			});
			return;
		}
		toast.show({ title: dialog?.mode === 'edit' ? 'Access updated' : `Invitation sent to ${email.trim()}` });
		setDialog(null);
		await reload();
	};
	const runConfirm = async () => {
		if (!confirm) return;
		setBusy(true);
		setProblem(null);
		const path =
			confirm.kind === 'member'
				? `${api.team(merchantId)}/members/${encodeURIComponent(confirm.member.userId)}`
				: `${api.team(merchantId)}/invites/${encodeURIComponent(confirm.invite.inviteId)}`;
		const result = await apiFetch(path, { method: 'DELETE' });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		toast.show({ title: confirm.kind === 'member' ? 'Member removed' : 'Invitation revoked' });
		setConfirm(null);
		await reload();
	};
	/** @param {any} m */
	const accessLabel = (m) =>
		(m.grants ?? []).length > 0
			? (m.grants ?? [])
					.map((/** @type {any} */ g) => `${site(g.websiteId)?.domain ?? g.websiteId}: ${g.roles.join(', ')}`)
					.join(' · ')
			: 'All websites';

	return (
		<div className="space-y-6">
			<PageHeader
				title="Team"
				subtitle="Who can work on your websites, and where."
				actions={
					canManage ? (
						<Button onClick={openInvite} icon={<Icon name="plus" size={14} />}>
							Invite
						</Button>
					) : null
				}
			/>
			{problem && !dialog && !confirm ? <FormError problem={problem} /> : null}
			<Table
				caption="Members"
				rows={members}
				rowKey={(m) => m.userId}
				defaultSort={{ key: 'email', direction: 'asc' }}
				columns={[
					{
						key: 'email',
						header: 'Member',
						sortable: true,
						rowHeader: true,
						render: (m) => (
							<span className="space-y-0.5">
								<span className="block font-semibold">{m.name ?? m.email}</span>
								{m.name ? <span className="block text-xs text-muted">{m.email}</span> : null}
								{m.userId === me?.user?.userId ? <Badge tone="info">You</Badge> : null}
							</span>
						),
					},
					{
						key: 'roles',
						header: 'Roles',
						render: (m) => (
							<span className="flex flex-wrap gap-1">
								{m.roles.length === 0 && (m.grants ?? []).length > 0 ? <Badge>Website roles</Badge> : null}
								{m.roles.map((/** @type {string} */ r) => (
									<Badge key={r} tone={r === 'owner' ? 'primary' : 'neutral'}>
										{humanize(r)}
									</Badge>
								))}
							</span>
						),
					},
					{ key: 'access', header: 'Websites', render: accessLabel },
					{ key: 'status', header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
					{ key: 'createdAt', header: 'Joined', sortable: true, render: (m) => formatDate(m.createdAt) },
					{
						key: 'actions',
						header: <span className="sr-only">Actions</span>,
						align: 'right',
						render: (m) =>
							canManage && !m.roles.includes('owner') && m.userId !== me?.user?.userId ? (
								<span className="inline-flex gap-1">
									<Button size="sm" variant="ghost" onClick={() => openEdit(m)}>
										Edit
									</Button>
									<Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'member', member: m })}>
										Remove
									</Button>
								</span>
							) : null,
					},
				]}
			/>
			<Card title="Pending invitations" padded={false}>
				{invites.length === 0 ? (
					<div className="p-5">
						<EmptyState compact icon="users" title="No pending invitations" />
					</div>
				) : (
					<ul className="divide-y divide-line">
						{invites.map((i) => (
							<li key={i.inviteId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
								<div className="min-w-0">
									<p className="text-sm font-semibold text-fg">{i.email}</p>
									<p className="text-xs text-muted">
										{accessLabel(i) === 'All websites' ? i.roles.map(humanize).join(', ') || 'No role' : accessLabel(i)}{' '}
										· expires {formatDate(i.expiresAt)}
									</p>
								</div>
								{canManage ? (
									<Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'invite', invite: i })}>
										Revoke
									</Button>
								) : null}
							</li>
						))}
					</ul>
				)}
			</Card>
			<Dialog
				open={Boolean(dialog)}
				onClose={() => setDialog(null)}
				title={dialog?.mode === 'edit' ? `Access of ${dialog.member.email}` : 'Invite a team member'}
				footer={
					<>
						<Button variant="secondary" onClick={() => setDialog(null)}>
							Cancel
						</Button>
						<Button onClick={() => void save()} loading={busy}>
							{dialog?.mode === 'edit' ? 'Save' : 'Send invitation'}
						</Button>
					</>
				}>
				{dialog?.mode === 'invite' ? (
					<Input
						label="E-mail"
						type="email"
						autoComplete="off"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						error={errors.email}
						required
					/>
				) : null}
				<AccessEditor
					scope={scope}
					setScope={setScope}
					roles={roles}
					setRoles={setRoles}
					grants={grants}
					setGrants={setGrants}
					websites={websites}
					error={errors.access}
				/>
				<FormError problem={problem} fields={['email', 'roles', 'grants']} />
			</Dialog>
			<ConfirmDialog
				open={Boolean(confirm)}
				onClose={() => setConfirm(null)}
				onConfirm={() => void runConfirm()}
				busy={busy}
				danger
				title={confirm?.kind === 'member' ? `Remove ${confirm.member.email}?` : 'Revoke this invitation?'}
				confirmLabel={confirm?.kind === 'member' ? 'Remove member' : 'Revoke invitation'}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					{confirm?.kind === 'member'
						? 'Their sessions for this organisation end and they lose access at once.'
						: 'The link in the e-mail stops working.'}
				</p>
			</ConfirmDialog>
		</div>
	);
}
