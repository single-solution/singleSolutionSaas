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
import { apiConfirm, apiFetch, usePagedList, useResource } from '../../client.js';
import { ConfirmChange, confirmationErrors } from '../../views/confirm-change.js';
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
 * Both ask for the Owner's password first (an invite can make an Owner).
 * @param {{ open: boolean, onClose: () => void, onInvited: (invite: any, copy: boolean) => void }} props
 */
function InviteDrawer({ open, onClose, onInvited }) {
	const [email, setEmail] = useState('');
	const [role, setRole] = useState('support');
	const [asking, setAsking] = useState(/** @type {null | { copy: boolean }} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const formId = useId();
	/** @param {{ password: string, code?: string, recoveryCode?: string }} confirmation */
	const send = async (confirmation) => {
		const copy = asking?.copy ?? false;
		setProblem(null);
		const result = await apiConfirm(adminApi.admins(), {
			method: 'POST',
			body: { email: email.trim(), role, copy, ...confirmation },
		});
		if (result.ok) {
			setEmail('');
			setRole('support');
			onInvited(result.data?.invite, copy);
		} else if (result.status === 422) {
			const found = confirmationErrors(result.problem);
			if (!found.password && !found.code) setProblem(result.problem);
		}
		return result;
	};
	return (
		<>
			<Drawer
				open={open}
				onClose={onClose}
				title={ADMIN.inviteTitle}
				footer={
					<>
						<Button variant="secondary" onClick={() => setAsking({ copy: true })}>
							{ADMIN.copyInvite}
						</Button>
						<Button type="submit" form={formId}>
							{ADMIN.invite}
						</Button>
					</>
				}>
				<Form id={formId} onSubmit={() => setAsking({ copy: false })} aria-label={ADMIN.inviteTitle}>
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
			<ConfirmChange
				open={asking !== null}
				title={ADMIN.inviteTitle}
				help={ADMIN.confirmInviteHelp}
				confirmLabel={asking?.copy ? ADMIN.copyInvite : ADMIN.invite}
				send={send}
				onClose={() => setAsking(null)}
				onDone={() => setAsking(null)}
			/>
		</>
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
	const [dialog, setDialog] = useState(/** @type {null | 'email' | 'role' | 'twoStep' | 'remove' | 'copy'} */ (null));
	// the password dialog over the email or role drawer (the other changes open it straight away)
	const [asking, setAsking] = useState(false);
	const [email, setEmail] = useState('');
	const [role, setRole] = useState('support');
	const [link, setLink] = useState(/** @type {string | null} */ (null));
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

	// mailing the invite again needs no password (the link is not shown); copying it, and every other change here, does
	const resend = async () => {
		const result = await apiFetch(adminApi.adminInvite(adminId), { method: 'POST', body: { copy: false } });
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
		else toast.show({ title: result.data?.mailed ? ADMIN.inviteMailed : ADMIN.inviteNotMailed });
	};
	/** @param {{ password: string, code?: string, recoveryCode?: string }} confirmation */
	const send = async (confirmation) => {
		setProblem(null);
		const withIt = (/** @type {Record<string, unknown>} */ body) => ({ ...body, ...confirmation });
		const result =
			dialog === 'copy'
				? await apiConfirm(adminApi.adminInvite(adminId), { method: 'POST', body: withIt({ copy: true }) })
				: dialog === 'email'
					? await apiConfirm(adminApi.admin(adminId), { method: 'PATCH', body: withIt({ email: email.trim() }) })
					: dialog === 'role'
						? await apiConfirm(adminApi.admin(adminId), { method: 'PATCH', body: withIt({ role }) })
						: dialog === 'twoStep'
							? await apiConfirm(adminApi.adminTwoStepOff(adminId), { method: 'POST', body: withIt({}) })
							: await apiConfirm(adminApi.admin(adminId), { method: 'DELETE', body: withIt({}) });
		if (result.ok) {
			if (dialog === 'copy') setLink(result.data?.link ?? null);
		} else if (result.status === 422) {
			const found = confirmationErrors(result.problem);
			if (!found.password && !found.code) setProblem(result.problem);
		}
		return result;
	};
	const done = async () => {
		const removed = dialog === 'remove';
		setAsking(false);
		setDialog(null);
		if (removed) nav.go(adminRoutes.admins());
		else await reload();
	};
	/** @param {'email' | 'role' | 'twoStep' | 'remove' | 'copy'} kind */
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
					{ label: ADMIN.resendInvite, onSelect: () => void resend() },
					{ label: ADMIN.copyInvite, onSelect: () => open('copy') },
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
					<Button type="submit" form={emailForm}>
						{ADMIN.correctEmail}
					</Button>
				}>
				<Form id={emailForm} onSubmit={() => setAsking(true)} aria-label={ADMIN.correctEmail}>
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
					<Button type="submit" form={roleForm}>
						{ADMIN.changeRole}
					</Button>
				}>
				<Form id={roleForm} onSubmit={() => setAsking(true)} aria-label={ADMIN.changeRole}>
					<RadioGroup legend={ADMIN.role} cards value={role} onChange={setRole} options={[...ROLE_CARDS]} />
					<FormError problem={problem} fields={['role']} />
				</Form>
			</Drawer>
			<ConfirmChange
				open={asking || dialog === 'twoStep' || dialog === 'remove' || dialog === 'copy'}
				title={
					dialog === 'copy'
						? ADMIN.copyInvite
						: dialog === 'twoStep'
							? ADMIN.turnOffTwoStep
							: dialog === 'remove'
								? ADMIN.remove
								: title
				}
				help={
					dialog === 'twoStep'
						? ADMIN.turnOffTwoStepHelp
						: dialog === 'remove'
							? ADMIN.removeAdminHelp
							: dialog === 'copy'
								? ADMIN.copyInviteHelp
								: ADMIN.confirmChangeHelp
				}
				confirmLabel={
					dialog === 'twoStep'
						? ADMIN.turnOffTwoStep
						: dialog === 'remove'
							? ADMIN.remove
							: dialog === 'copy'
								? ADMIN.copyInvite
								: dialog === 'email'
									? ADMIN.correctEmail
									: ADMIN.changeRole
				}
				danger={dialog === 'twoStep' || dialog === 'remove'}
				send={send}
				onClose={() => {
					setAsking(false);
					if (dialog === 'twoStep' || dialog === 'remove' || dialog === 'copy') setDialog(null);
				}}
				onDone={() => void done()}
			/>
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
