'use client';
/**
 * Admins (PLAN 0.8.2; Owner only; layout contract 2026-10-17): the Admins page is a table of the admins (search, a
 * role filter; per row the name, email, role, a status pill — Invited gray —, two-step and the last sign-in) with
 * **Invite** (email + role in a drawer; the invite is emailed or its link copied). A row opens the admin's page: a
 * header (name, Active / Invited, the role; Resend invite and Copy invite link until the invite is accepted, Change
 * role and Turn off two-step, Correct invite email and Remove in the More menu) and its parts in the inner navigation,
 * each its own address: Details (the details and what the role can do) and Recent activity (the entries this admin
 * made, paged). The last Owner cannot be removed or demoted and no one removes themselves (the API refuses; the page
 * explains).
 * @module
 */
import { useId, useState } from 'react';
import {
	Button,
	Callout,
	Card,
	CodeBlock,
	ConfirmDialog,
	DataTable,
	Dialog,
	Drawer,
	EmptyState,
	Form,
	FormError,
	Icon,
	Input,
	KeyValueList,
	LocalTime,
	Page,
	Pagination,
	RadioGroup,
	Toolbar,
	describeProblem,
	fieldErrors,
	usePaged,
	useToast,
} from '@ss/ui';
import { ADMIN, MORE, TWO_STEP } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { useNavigation } from '../../navigation.js';
import { apiFetch, usePagedList, useResource } from '../../client.js';
import { ActivityTable } from '../../views/login-settings.js';
import { useListPages } from '../../views/paging.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** The parts of an admin's page, each its own address (Details is the admin's own address). */
export const ADMIN_PARTS = ['details', 'activity'];

const ROLE_OPTIONS = Object.freeze([
	{ value: 'owner', label: ADMIN.roles.owner },
	{ value: 'support', label: ADMIN.roles.support },
	{ value: 'finance', label: ADMIN.roles.finance },
]);

/** The roles as radio cards: the role and what it may do. */
const ROLE_CARDS = Object.freeze(
	ROLE_OPTIONS.map((option) => ({ ...option, description: ADMIN.roleHelp[/** @type {'owner'} */ (option.value)] })),
);

/**
 * The pill of an admin's status.
 * @param {{ status?: string }} admin
 * @returns {{ status: 'active' | 'off', label: string }}
 */
const statusPill = (admin) =>
	admin.status === 'invited' ? { status: 'off', label: ADMIN.invited } : { status: 'active', label: ADMIN.status.active };

/** @param {string} role */
const roleName = (role) => ADMIN.roles[/** @type {'owner'} */ (role)] ?? role;

/**
 * The invite link, shown once.
 * @param {{ link: string | null, onClose: () => void }} props
 */
function InviteLink({ link, onClose }) {
	return (
		<Dialog
			open={Boolean(link)}
			onClose={onClose}
			title={ADMIN.copyInvite}
			description={ADMIN.setupLinkCopy}
			placement="center">
			{link ? <CodeBlock code={link} label={ADMIN.copyInvite} secret wrap /> : null}
		</Dialog>
	);
}

/**
 * Invite an admin, in a drawer: the email and the role; Invite sends the invite, Copy invite link hands the link over.
 * @param {{ open: boolean, onClose: () => void, onInvited: (invite: any, copy: boolean) => void }} props
 */
function InviteDrawer({ open, onClose, onInvited }) {
	const [email, setEmail] = useState('');
	const [role, setRole] = useState('support');
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const formId = useId();
	/** @param {boolean} copy */
	const invite = async (copy) => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(adminApi.admins(), { method: 'POST', body: { email: email.trim(), role, copy } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setEmail('');
		setRole('support');
		onInvited(result.data?.invite, copy);
	};
	return (
		<Drawer
			open={open}
			onClose={onClose}
			title={ADMIN.inviteTitle}
			footer={
				<>
					<Button variant="secondary" onClick={() => void invite(true)} loading={busy}>
						{ADMIN.copyInvite}
					</Button>
					<Button type="submit" form={formId} loading={busy}>
						{ADMIN.invite}
					</Button>
				</>
			}>
			<Form id={formId} onSubmit={() => invite(false)} busy={busy} aria-label={ADMIN.inviteTitle}>
				<Input
					label="Email"
					type="email"
					value={email}
					onChange={(e) => setEmail(e.currentTarget.value)}
					error={fieldErrors(problem).email}
					required
				/>
				<RadioGroup legend={ADMIN.role} cards value={role} onChange={setRole} options={[...ROLE_CARDS]} />
				<FormError problem={problem} fields={['email', 'role']} />
			</Form>
		</Drawer>
	);
}

/**
 * The Admins list: a table with search and a role filter; Invite opens the invite drawer.
 * @param {{ props: any }} input
 */
function AdminsPage({ props }) {
	const toast = useToast();
	const nav = useNavigation();
	const { data, reload } = useResource(adminApi.admins(), { items: props.items });
	const [inviting, setInviting] = useState(false);
	const [link, setLink] = useState(/** @type {string | null} */ (null));
	const [role, setRole] = useState('');
	const me = props.me;
	const items = /** @type {any[]} */ (data.items ?? []);
	const paged = usePaged(role ? items.filter((a) => a.role === role) : items, {
		pageSize: 50,
		text: (a) => `${a.name ?? ''} ${a.email}`,
	});
	/** @param {any} invite @param {boolean} copy */
	const invited = async (invite, copy) => {
		setInviting(false);
		if (copy) setLink(invite?.link ?? null);
		else toast.show({ title: invite?.mailed ? ADMIN.inviteMailed : ADMIN.inviteNotMailed });
		await reload();
	};
	return (
		<>
			<Page
				flush
				linkAs={Link}
				crumbs={[{ label: ADMIN.adminsTitle }]}
				info={ADMIN.adminsInfo}
				actions={{ primary: { label: ADMIN.invite, icon: 'plus', onClick: () => setInviting(true) } }}
				toolbar={
					<Toolbar
						label={ADMIN.adminsTitle}
						search={{
							value: paged.query,
							label: ADMIN.searchAdmins,
							placeholder: ADMIN.searchAdmins,
							onSearch: paged.setQuery,
						}}
						filters={[
							{
								id: 'role',
								label: ADMIN.role,
								allLabel: MORE.allRoles,
								value: role,
								onChange: setRole,
								options: [...ROLE_OPTIONS],
							},
						]}
						range={MORE.count(paged.found.length)}
					/>
				}
				{...(paged.found.length > 0 ? { footer: <Pagination {...paged.pagination} /> } : {})}>
				<DataTable
					caption={ADMIN.adminsTitle}
					rows={paged.rows}
					rowKey={(a) => String(a.adminId)}
					rowLabel={(a) => a.name ?? a.email}
					onRowClick={(a) => nav.go(adminRoutes.admin(a.adminId))}
					empty={<EmptyState compact icon="shield" kind="admin" title={ADMIN.noAdmins} />}
					columns={[
						{
							key: 'name',
							header: ADMIN.adminColumns.name,
							rowHeader: true,
							render: (a) => (
								<Link href={adminRoutes.admin(a.adminId)} className="font-medium text-fg hover:underline">
									{a.adminId === me?.adminId ? `${a.name ?? a.email} (${ADMIN.you})` : (a.name ?? a.email)}
								</Link>
							),
						},
						{ key: 'email', header: ADMIN.adminColumns.email, render: (a) => a.email },
						{ key: 'role', header: ADMIN.adminColumns.role, render: (a) => roleName(a.role) },
						{ key: 'status', header: ADMIN.columns.status, kind: 'status', pill: (a) => statusPill(a) },
						{
							key: 'twoStep',
							header: ADMIN.twoStepColumn,
							low: true,
							render: (a) => (a.twoStep?.enabled ? MORE.twoStepOn(a.twoStep.recoveryCodesLeft ?? 0) : TWO_STEP.off),
						},
						{
							key: 'lastSignIn',
							header: ADMIN.columns.lastSignIn,
							kind: 'date',
							low: true,
							render: (a) => (a.lastSignInAt ? <LocalTime value={a.lastSignInAt} /> : MORE.never),
						},
					]}
				/>
			</Page>
			<InviteDrawer
				open={inviting}
				onClose={() => setInviting(false)}
				onInvited={(invite, copy) => void invited(invite, copy)}
			/>
			<InviteLink link={link} onClose={() => setLink(null)} />
		</>
	);
}

/**
 * An admin's page: the header and one part of it at a time, each part its own address.
 * @param {{ props: any, adminId: string, section: string }} input
 */
function AdminPage({ props, adminId, section }) {
	const toast = useToast();
	const nav = useNavigation();
	const { data, reload } = useResource(adminApi.admins(), { items: props.items });
	const [dialog, setDialog] = useState(/** @type {null | 'email' | 'role' | 'twoStep' | 'remove'} */ (null));
	const [email, setEmail] = useState('');
	const [role, setRole] = useState('support');
	const [link, setLink] = useState(/** @type {string | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const emailForm = useId();
	const roleForm = useId();
	const activity = usePagedList((cursor) => adminApi.activity({ adminId, cursor }), props.activity);
	const activityPages = useListPages(activity);
	const me = props.me;
	const items = /** @type {any[]} */ (data.items ?? []);
	const current = items.find((a) => a.adminId === adminId) ?? null;
	const part = ADMIN_PARTS.includes(section) ? section : 'details';
	const adminsCrumb = { label: ADMIN.adminsTitle, href: adminRoutes.admins() };
	if (!current)
		return (
			<Page linkAs={Link} crumbs={[adminsCrumb, { label: ADMIN.adminTitle }]} error={ADMIN.adminGone}>
				{null}
			</Page>
		);
	const title = current.name ?? current.email;

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
	const resend = async (copy) => {
		const result = await call(adminApi.adminInvite(adminId), 'POST', { copy });
		if (!result.ok) {
			toast.show({ tone: 'danger', title: describeProblem(result.problem) });
			return;
		}
		if (copy) setLink(result.data?.link ?? null);
		else toast.show({ title: result.data?.mailed ? ADMIN.inviteMailed : ADMIN.inviteNotMailed });
	};
	const save = async () => {
		if (!dialog) return;
		const result =
			dialog === 'email'
				? await call(adminApi.admin(adminId), 'PATCH', { email: email.trim() })
				: dialog === 'role'
					? await call(adminApi.admin(adminId), 'PATCH', { role })
					: dialog === 'twoStep'
						? await call(adminApi.adminTwoStepOff(adminId), 'POST', {})
						: await call(adminApi.admin(adminId), 'DELETE');
		if (!result.ok) return;
		const removed = dialog === 'remove';
		setDialog(null);
		if (removed) nav.go(adminRoutes.admins());
		else await reload();
	};
	/** @param {'email' | 'role' | 'twoStep' | 'remove'} kind */
	const open = (kind) => {
		setProblem(null);
		setEmail(kind === 'email' ? (current.email ?? '') : '');
		setRole(current.role ?? 'support');
		setDialog(kind);
	};

	const self = adminId === me?.adminId;
	/** @type {Array<{ label: string, onSelect: () => void, danger?: boolean }>} */
	const actionList = [
		...(current.status === 'invited'
			? [
					{ label: ADMIN.resendInvite, onSelect: () => void resend(false) },
					{ label: ADMIN.copyInvite, onSelect: () => void resend(true) },
					{ label: ADMIN.correctEmail, onSelect: () => open('email') },
				]
			: []),
		...(self
			? []
			: [
					{ label: ADMIN.changeRole, onSelect: () => open('role') },
					...(current.twoStep?.enabled ? [{ label: ADMIN.turnOffTwoStep, onSelect: () => open('twoStep') }] : []),
					{ label: ADMIN.remove, onSelect: () => open('remove'), danger: true },
				]),
	];
	// the first two actions are buttons; the rest (Remove always) sit in the More menu
	const buttons = actionList.filter((a) => !a.danger).slice(0, 2);
	const more = actionList.filter((a) => !buttons.includes(a));
	const bodies = {
		details: (
			<div className="space-y-4">
				<Card title={MORE.detailsTitle}>
					<KeyValueList
						columns={3}
						items={[
							{ label: ADMIN.adminColumns.email, value: self ? `${current.email} · ${ADMIN.you}` : current.email },
							{ label: ADMIN.adminColumns.role, value: roleName(current.role) },
							{
								label: ADMIN.twoStepColumn,
								value: current.twoStep?.enabled ? MORE.twoStepOn(current.twoStep.recoveryCodesLeft ?? 0) : TWO_STEP.off,
							},
							{
								label: ADMIN.columns.lastSignIn,
								value: current.lastSignInAt ? <LocalTime value={current.lastSignInAt} /> : MORE.never,
							},
							{ label: MORE.added, value: <LocalTime value={current.createdAt} /> },
						]}
					/>
				</Card>
				<Card title={MORE.rightsTitle} subtitle={roleName(current.role)}>
					<ul className="list-disc space-y-1.5 pl-5 text-sm text-fg marker:text-primary">
						{(MORE.rights[/** @type {'owner'} */ (current.role)] ?? []).map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</Card>
			</div>
		),
		activity: (
			<>
				{activity.problem ? (
					<div className="p-4">
						<Callout tone="danger">{describeProblem(activity.problem)}</Callout>
					</div>
				) : null}
				<ActivityTable
					items={activityPages.rows}
					caption={ADMIN.activityTitle}
					empty={MORE.noActivity}
					showMerchant
					details
					filterHref={(q) => adminRoutes.activity(q)}
				/>
			</>
		),
	};
	return (
		<>
			<Page
				linkAs={Link}
				flush={part === 'activity'}
				bodyKey={part}
				crumbs={[adminsCrumb, { label: title }]}
				status={[statusPill(current)]}
				facts={[{ label: ADMIN.adminColumns.role, value: roleName(current.role) }]}
				info={ADMIN.adminInfo}
				actions={{
					...(buttons.length > 0 ? { secondary: buttons.map((a) => ({ label: a.label, onClick: a.onSelect })) } : {}),
					more: [
						...more,
						...(part === 'activity'
							? [{ label: MORE.openInActivity, onSelect: () => nav.go(adminRoutes.activity({ adminId })) }]
							: []),
					],
				}}
				nav={{
					value: part,
					label: ADMIN.adminParts,
					items: [
						{ id: 'details', label: MORE.detailsTitle },
						{ id: 'activity', label: ADMIN.recentActivity },
					].map((item) => ({ ...item, href: adminRoutes.adminPart(adminId, item.id) })),
				}}
				{...(part === 'activity' && activityPages.pagination
					? { footer: <Pagination {...activityPages.pagination} /> }
					: {})}>
				{bodies[/** @type {keyof typeof bodies} */ (part)]}
			</Page>
			<Drawer
				open={dialog === 'email'}
				onClose={() => setDialog(null)}
				title={ADMIN.correctEmail}
				description={title}
				footer={
					<Button type="submit" form={emailForm} loading={busy}>
						{ADMIN.correctEmail}
					</Button>
				}>
				<Form id={emailForm} onSubmit={save} busy={busy} aria-label={ADMIN.correctEmail}>
					<Input
						label="Email"
						type="email"
						value={email}
						onChange={(e) => setEmail(e.currentTarget.value)}
						error={fieldErrors(problem).email}
						required
					/>
					<FormError problem={problem} fields={['email']} />
				</Form>
			</Drawer>
			<Drawer
				open={dialog === 'role'}
				onClose={() => setDialog(null)}
				title={ADMIN.changeRole}
				description={ADMIN.roleChangeHelp}
				footer={
					<Button type="submit" form={roleForm} loading={busy}>
						{ADMIN.changeRole}
					</Button>
				}>
				<Form id={roleForm} onSubmit={save} busy={busy} aria-label={ADMIN.changeRole}>
					<RadioGroup legend={ADMIN.role} cards value={role} onChange={setRole} options={[...ROLE_CARDS]} />
					<FormError problem={problem} fields={['role']} />
				</Form>
			</Drawer>
			<ConfirmDialog
				open={dialog === 'twoStep' || dialog === 'remove'}
				onClose={() => setDialog(null)}
				onConfirm={() => void save()}
				busy={busy}
				danger
				confirmLabel={dialog === 'twoStep' ? ADMIN.turnOffTwoStep : ADMIN.remove}
				title={title}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">{dialog === 'twoStep' ? ADMIN.turnOffTwoStepHelp : ADMIN.removeAdminHelp}</p>
			</ConfirmDialog>
			<InviteLink link={link} onClose={() => setLink(null)} />
		</>
	);
}

/**
 * The Admins pages: the list, or (with `selectedId`) one admin's page and its `section`.
 * @param {any} props loader result of `loadAdmins` (the list) or `loadAdmin` (an admin's page, with `activity` on the
 *   Activity part) plus `selectedId` and `section`
 */
export function AdminsView(props) {
	if (props.ok !== true) return <AdminProblem problem={props.problem} />;
	const selectedId = typeof props.selectedId === 'string' ? props.selectedId : null;
	if (selectedId) return <AdminPage key={selectedId} props={props} adminId={selectedId} section={props.section ?? 'details'} />;
	return <AdminsPage props={props} />;
}
