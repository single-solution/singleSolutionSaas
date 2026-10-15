'use client';
/**
 * Admins (PLAN 0.8.2; Owner only): one list-and-detail screen. The list (count; search; role filter; per row the name,
 * email, a status dot — invited gray — and the role) with **Invite** (email + role) sits beside the selected admin — on
 * wide screens the first one until another is picked: its details (status, role, two-step with recovery codes left,
 * last sign-in, added), what its role can do and its recent activity, with the actions Resend invite or
 * Copy invite link and Correct invite email (until accepted), Change role, Turn off two-step and Remove, as dialogs —
 * the first two as buttons, the rest in the header's More menu with Remove last. The last Owner cannot be removed or
 * demoted and no one removes themselves (the API refuses; the screen explains).
 * @module
 */
import { useEffect, useState } from 'react';
import {
	Badge,
	Button,
	Callout,
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
	LocalTime,
	Masonry,
	PageHeader,
	Select,
	describeProblem,
	fieldErrors,
	useToast,
} from '@ss/ui';
import { ADMIN, MORE, TWO_STEP } from '../../../texts/console.js';
import { useNavigation } from '../../navigation.js';
import { apiFetch, useResource } from '../../client.js';
import { HeaderActions, ListDetail, ListPane, ListRow, ListSearch } from '../../views/common.js';
import { ActivityTable } from '../../views/login-settings.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, RoleBadge } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

const ROLE_OPTIONS = Object.freeze([
	{ value: 'owner', label: ADMIN.roles.owner },
	{ value: 'support', label: ADMIN.roles.support },
	{ value: 'finance', label: ADMIN.roles.finance },
]);

/**
 * The latest entries an admin made (the Activity page filtered by them), with a link to all of them.
 * @param {{ adminId: string }} props
 */
function AdminActivity({ adminId }) {
	const nav = useNavigation();
	const [result, setResult] = useState(/** @type {import('../../api.js').ApiResult<any> | null} */ (null));
	useEffect(() => {
		let live = true;
		void apiFetch(`${adminApi.activity({ adminId })}&limit=10`).then((r) => {
			if (live) setResult(r);
		});
		return () => {
			live = false;
		};
	}, [adminId]);
	return (
		<Card
			title={ADMIN.recentActivity}
			subtitle={MORE.adminActivityIntro}
			actions={
				<Button variant="secondary" size="sm" onClick={() => nav.go(adminRoutes.activity({ adminId }))}>
					{MORE.openInActivity}
				</Button>
			}>
			{result && !result.ok ? <Callout tone="danger">{describeProblem(result.problem)}</Callout> : null}
			<ActivityTable
				items={result?.ok ? (result.data?.items ?? []) : []}
				empty={MORE.noActivity}
				showMerchant
				filterHref={(q) => adminRoutes.activity(q)}
			/>
		</Card>
	);
}

/**
 * @param {any} props loader result of `loadAdmins` plus `selectedId` (an admin selected)
 */
export function AdminsView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const { data, reload } = useResource(ok ? adminApi.admins() : null, { items: ok ? props.items : [] });
	const [dialog, setDialog] = useState(
		/** @type {null | { kind: 'invite' | 'email' | 'role' | 'twoStep' | 'remove', admin?: any }} */ (null),
	);
	const [email, setEmail] = useState('');
	const [role, setRole] = useState('support');
	const [link, setLink] = useState(/** @type {string | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const nav = useNavigation();
	const [q, setQ] = useState('');
	const [roleFilter, setRoleFilter] = useState('');
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
		const result = await apiFetch(path, { method, ...(body ? { body } : {}) });
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
		if (dialog.kind === 'remove') nav.go(adminRoutes.admins());
	};
	/** @param {'invite' | 'email' | 'role' | 'twoStep' | 'remove'} kind @param {any} [admin] */
	const open = (kind, admin) => {
		setProblem(null);
		setEmail(kind === 'email' ? (admin?.email ?? '') : '');
		setRole(admin?.role ?? 'support');
		setDialog({ kind, ...(admin ? { admin } : {}) });
	};

	const needle = q.trim().toLowerCase();
	const shown = items.filter(
		(a) => (!needle || `${a.name ?? ''} ${a.email}`.toLowerCase().includes(needle)) && (!roleFilter || a.role === roleFilter),
	);
	const auto = selectedId === null;
	const current = auto ? (items[0] ?? null) : (items.find((a) => a.adminId === selectedId) ?? null);
	/** @type {Array<{ label: string, onSelect: () => void, danger?: boolean }>} */
	const actionList = current
		? [
				...(current.status === 'invited'
					? [
							{ label: ADMIN.resendInvite, onSelect: () => void resend(current, false) },
							{ label: ADMIN.copyInvite, onSelect: () => void resend(current, true) },
							{ label: ADMIN.correctEmail, onSelect: () => open('email', current) },
						]
					: []),
				...(current.adminId !== me?.adminId
					? [
							{ label: ADMIN.changeRole, onSelect: () => open('role', current) },
							...(current.twoStep?.enabled
								? [{ label: ADMIN.turnOffTwoStep, onSelect: () => open('twoStep', current) }]
								: []),
							{ label: ADMIN.remove, onSelect: () => open('remove', current), danger: true },
						]
					: []),
			]
		: [];
	// the first two actions are buttons; the rest (Remove always) sit in the More menu
	const shownActions = actionList.filter((a) => !a.danger).slice(0, 2);
	const actions = current ? (
		<HeaderActions
			label={ADMIN.moreActions(current.name ?? current.email)}
			more={actionList.filter((a) => !shownActions.includes(a))}>
			{shownActions.map((a) => (
				<Button key={a.label} variant="secondary" onClick={a.onSelect}>
					{a.label}
				</Button>
			))}
		</HeaderActions>
	) : null;

	return (
		<>
			<ListDetail
				section="admin/admins"
				label={ADMIN.adminsTitle}
				back={{ href: adminRoutes.admins(), label: ADMIN.adminsTitle }}
				list={
					<ListPane
						title={ADMIN.adminsTitle}
						count={MORE.count(items.length)}
						action={
							<Button size="sm" onClick={() => open('invite')} icon={<Icon name="plus" size={14} />}>
								{ADMIN.invite}
							</Button>
						}
						tools={
							<ListSearch label={ADMIN.searchAdmins} value={q} onChange={setQ}>
								<Select
									label={ADMIN.role}
									hideLabel
									fieldClassName="min-w-0 flex-1"
									value={roleFilter}
									onChange={(e) => setRoleFilter(e.currentTarget.value)}
									options={[{ value: '', label: MORE.allRoles }, ...ROLE_OPTIONS]}
								/>
							</ListSearch>
						}>
						{shown.map((a) => (
							<ListRow
								key={a.adminId}
								href={adminRoutes.admin(a.adminId)}
								current={a.adminId === current?.adminId ? (auto ? 'wide' : true) : false}
								label={a.adminId === me?.adminId ? `${a.name ?? a.email} (${ADMIN.you})` : (a.name ?? a.email)}
								sublabel={a.email}
								dot={a.status === 'invited' ? 'neutral' : 'success'}
								dotLabel={a.status === 'invited' ? ADMIN.invited : ADMIN.status.active}
								meta={ADMIN.roles[/** @type {'owner'} */ (a.role)] ?? a.role}
							/>
						))}
					</ListPane>
				}
				auto={auto}
				empty={<EmptyState icon="shield" kind="admin" title={ADMIN.noAdmins} />}
				detail={
					current ? (
						<>
							<PageHeader
								level={2}
								title={current.name ?? current.email}
								badge={
									<span className="inline-flex flex-wrap gap-1">
										<RoleBadge role={current.role} />
										{current.status === 'invited' ? <Badge tone="neutral">{ADMIN.invited}</Badge> : null}
									</span>
								}
								subtitle={current.adminId === me?.adminId ? `${current.email} · ${ADMIN.you}` : current.email}
								actions={actions}
							/>
							<Masonry columns={2}>
								<Card title={MORE.detailsTitle}>
									<KeyValueList
										items={[
											{
												label: MORE.statusLabel,
												value: current.status === 'invited' ? ADMIN.invited : ADMIN.status.active,
											},
											{ label: ADMIN.role, value: ADMIN.roles[/** @type {'owner'} */ (current.role)] ?? current.role },
											{
												label: ADMIN.twoStepColumn,
												value: current.twoStep?.enabled
													? MORE.twoStepOn(current.twoStep.recoveryCodesLeft ?? 0)
													: TWO_STEP.off,
											},
											{
												label: ADMIN.columns.lastSignIn,
												value: current.lastSignInAt ? <LocalTime value={current.lastSignInAt} /> : MORE.never,
											},
											{ label: MORE.added, value: <LocalTime value={current.createdAt} /> },
										]}
									/>
								</Card>
								<Card title={MORE.rightsTitle} subtitle={ADMIN.roles[/** @type {'owner'} */ (current.role)]}>
									<ul className="list-disc space-y-1.5 pl-5 text-sm text-fg marker:text-primary">
										{(MORE.rights[/** @type {'owner'} */ (current.role)] ?? []).map((line) => (
											<li key={line}>{line}</li>
										))}
									</ul>
								</Card>
							</Masonry>
							<AdminActivity key={current.adminId} adminId={current.adminId} />
						</>
					) : auto ? null : (
						<EmptyState icon="shield" kind="admin" title={ADMIN.adminGone} />
					)
				}
			/>
			<Dialog open={dialog?.kind === 'invite'} onClose={() => setDialog(null)} title={ADMIN.inviteTitle}>
				<Form onSubmit={() => invite(false)} busy={busy} aria-label={ADMIN.inviteTitle}>
					<Input
						label="Email"
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
					<Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} required />
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
