'use client';
/**
 * Admins (PLAN 0.8.2; Owner only; flat layout 2026-10-21): the Admins page is a ListColumn of rich rows beside the
 * selected admin's page (or the first admin on wide screens). All sections open on one page: Details (the details and
 * what the role can do) and Recent activity (timeline of entries with Show more paging).
 * @module
 */
import { useEffect, useId, useMemo, useState } from 'react';
import {
	Button,
	Callout,
	Card,
	CodeBlock,
	Dialog,
	Drawer,
	EmptyState,
	Form,
	FormError,
	Input,
	KeyValueList,
	ListColumn,
	LocalTime,
	Page,
	RadioGroup,
	Row,
	describeProblem,
	fieldErrors,
	useToast,
} from '@ss/ui';
import { ADMIN, MORE, TWO_STEP } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { useNavigation } from '../../navigation.js';
import { apiConfirm, apiFetch, useResource } from '../../client.js';
import { ConfirmChange, confirmationErrors } from '../../views/confirm-change.js';
import { ActivityTable } from '../../views/login-settings.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

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

/** True on phone viewports (< 768 px). */
function usePhone() {
	const [phone, setPhone] = useState(false);
	useEffect(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const mql = window.matchMedia('(max-width: 767px)');
		setPhone(mql.matches);
		const handler = (/** @type {MediaQueryListEvent} */ e) => setPhone(e.matches);
		mql.addEventListener('change', handler);
		return () => mql.removeEventListener('change', handler);
	}, []);
	return phone;
}

/**
 * Activity entries of an admin with cursor paging.
 * @param {{ items?: any[], nextCursor?: string | null } | undefined} initial
 * @param {string} adminId
 */
function useActivityList(initial, adminId) {
	const [items, setItems] = useState(/** @type {any[]} */ (initial?.items ?? []));
	const [cursor, setCursor] = useState(/** @type {string | null} */ (initial?.nextCursor ?? null));
	const [loading, setLoading] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));

	useEffect(() => {
		if (initial !== undefined) return;
		let cancelled = false;
		setLoading(true);
		setProblem(null);
		apiFetch(adminApi.activity({ adminId })).then((result) => {
			if (cancelled) return;
			setLoading(false);
			if (!result.ok) setProblem(result.problem);
			else {
				setItems(result.data?.items ?? []);
				setCursor(result.data?.nextCursor ?? null);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [adminId, initial]);

	const more = async () => {
		if (!cursor || loading) return;
		setLoading(true);
		setProblem(null);
		const result = await apiFetch(adminApi.activity({ adminId, cursor }));
		setLoading(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setItems((prev) => [...prev, ...(result.data?.items ?? [])]);
		setCursor(result.data?.nextCursor ?? null);
	};

	return { items, cursor, loading, problem, more };
}

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
 * @param {{ open: boolean, onClose: () => void, onInvited: (invite: any, copy: boolean) => void, twoStepOn?: boolean }} props
 */
function InviteDrawer({ open, onClose, onInvited, twoStepOn = false }) {
	const [email, setEmail] = useState('');
	const [role, setRole] = useState('support');
	const [asking, setAsking] = useState(/** @type {null | { copy: boolean }} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const formId = useId();

	/** @param {boolean} copy */
	const validateAndAsk = (copy) => {
		const val = email.trim();
		if (!val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
			setProblem({ status: 422, errors: [{ path: '/email', message: 'Enter a valid email address.' }] });
			return;
		}
		setProblem(null);
		setAsking({ copy });
	};

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
						<Button variant="secondary" onClick={() => validateAndAsk(true)}>
							{ADMIN.copyInvite}
						</Button>
						<Button type="submit" form={formId}>
							{ADMIN.invite}
						</Button>
					</>
				}>
				<Form
					id={formId}
					onSubmit={(e) => {
						e.preventDefault();
						validateAndAsk(false);
					}}
					aria-label={ADMIN.inviteTitle}>
					<Input
						label="Email"
						type="email"
						autoComplete="email"
						inputMode="email"
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
				twoStepOn={twoStepOn}
				send={send}
				onClose={() => setAsking(null)}
				onDone={() => setAsking(null)}
			/>
		</>
	);
}

/**
 * An admin's page: all sections open on one page beside the list of admins.
 * @param {{
 *   current: any,
 *   me: any,
 *   list?: any,
 *   activityInitial?: any,
 *   onReload: () => Promise<any>,
 *   onInvite?: () => void,
 * }} props
 */
function AdminPageView({ current, me, list, activityInitial, onReload, onInvite }) {
	const toast = useToast();
	const nav = useNavigation();
	const [dialog, setDialog] = useState(/** @type {null | 'email' | 'role' | 'twoStep' | 'remove' | 'copy'} */ (null));
	const [asking, setAsking] = useState(false);
	const [email, setEmail] = useState('');
	const [role, setRole] = useState('support');
	const [link, setLink] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const emailForm = useId();
	const roleForm = useId();

	const adminId = String(current.adminId);
	const activity = useActivityList(activityInitial, adminId);
	const title = current.name ?? current.email;
	const self = adminId === me?.adminId;
	const adminsCrumb = { label: ADMIN.adminsTitle, href: adminRoutes.admins() };

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
		else await onReload();
	};

	/** @param {'email' | 'role' | 'twoStep' | 'remove' | 'copy'} kind */
	const open = (kind) => {
		setProblem(null);
		setEmail(kind === 'email' ? (current.email ?? '') : '');
		setRole(current.role ?? 'support');
		setDialog(kind);
	};

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
	const buttons = actionList.filter((a) => !a.danger).slice(0, 2);
	const more = actionList.filter((a) => !buttons.includes(a));

	const sections = [
		{
			id: 'details',
			label: MORE.detailsTitle,
			body: (
				<div className="space-y-4">
					<Card title={MORE.detailsTitle}>
						<KeyValueList
							columns={3}
							items={[
								{ label: ADMIN.adminColumns.email, value: self ? `${current.email} · ${ADMIN.you}` : current.email },
								{ label: ADMIN.adminColumns.role, value: roleName(current.role) },
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
					<Card title={MORE.rightsTitle} subtitle={roleName(current.role)}>
						<ul className="list-disc space-y-1.5 pl-5 text-sm text-fg marker:text-primary">
							{(MORE.rights[/** @type {'owner'} */ (current.role)] ?? []).map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					</Card>
				</div>
			),
		},
		{
			id: 'activity',
			label: ADMIN.recentActivity,
			body: (
				<Card title={ADMIN.recentActivity}>
					{activity.problem ? (
						<div className="mb-4">
							<Callout tone="danger">{describeProblem(activity.problem)}</Callout>
						</div>
					) : null}
					<ActivityTable
						items={activity.items}
						caption={ADMIN.activityTitle}
						empty={MORE.noActivity}
						showMerchant
						details
						filterHref={(q) => adminRoutes.activity(q)}
					/>
					{activity.cursor ? (
						<div className="flex justify-center pt-3">
							<Button variant="secondary" size="sm" loading={activity.loading} onClick={() => void activity.more()}>
								{MORE.showMore}
							</Button>
						</div>
					) : null}
				</Card>
			),
		},
	];

	return (
		<>
			<Page
				flush
				linkAs={Link}
				list={list ?? undefined}
				crumbs={[adminsCrumb, { label: title }]}
				status={[statusPill(current)]}
				facts={[
					{ label: ADMIN.adminColumns.role, value: roleName(current.role) },
					...(current.lastSignInAt
						? [{ label: ADMIN.columns.lastSignIn, value: <LocalTime value={current.lastSignInAt} /> }]
						: []),
				]}
				info={ADMIN.adminInfo}
				actions={{
					...(onInvite ? { primary: { label: ADMIN.invite, icon: 'plus', onClick: onInvite } } : {}),
					...(buttons.length > 0 ? { secondary: buttons.map((a) => ({ label: a.label, onClick: a.onSelect })) } : {}),
					more: [...more, { label: MORE.openInActivity, onSelect: () => nav.go(adminRoutes.activity({ adminId })) }],
				}}
				sections={sections}
			/>
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
				<Form
					id={emailForm}
					onSubmit={(e) => {
						e.preventDefault();
						const val = email.trim();
						if (!val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
							setProblem({ status: 422, errors: [{ path: '/email', message: 'Enter a valid email address.' }] });
							return;
						}
						setProblem(null);
						setAsking(true);
					}}
					aria-label={ADMIN.correctEmail}>
					<Input
						label="Email"
						type="email"
						autoComplete="email"
						inputMode="email"
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
				twoStepOn={Boolean(me?.twoStep?.enabled)}
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
 * Admins screen: ListColumn on left, selected admin page on right.
 * @param {{
 *   items: any[],
 *   me: any,
 *   admin?: any,
 *   selectedId?: string | null,
 *   fromList?: boolean,
 *   activity?: any,
 *   reload: () => Promise<any>,
 * }} props
 */
function AdminsScreen({ items, me, admin, selectedId: explicitId, fromList, activity, reload }) {
	const toast = useToast();
	const nav = useNavigation();
	const phone = usePhone();
	const [inviting, setInviting] = useState(false);
	const [link, setLink] = useState(/** @type {string | null} */ (null));
	const [query, setQuery] = useState('');
	const [roleFilter, setRoleFilter] = useState('all');

	const canManage = adminCan(admin ?? me, 'admins.manage');
	const adminsCrumb = { label: ADMIN.adminsTitle, href: adminRoutes.admins() };

	const filteredItems = useMemo(() => {
		const q = query.trim().toLowerCase();
		return items.filter((a) => {
			if (roleFilter !== 'all' && a.role !== roleFilter) return false;
			if (!q) return true;
			const name = (a.name ?? '').toLowerCase();
			const email = (a.email ?? '').toLowerCase();
			return name.includes(q) || email.includes(q);
		});
	}, [items, query, roleFilter]);

	const selectedId = explicitId ?? (fromList ? (phone ? null : items[0]?.adminId ? String(items[0].adminId) : null) : null);
	const current = selectedId ? (items.find((a) => String(a.adminId) === String(selectedId)) ?? null) : null;

	const onInvited = async (/** @type {any} */ invite, /** @type {boolean} */ copy) => {
		setInviting(false);
		if (copy) setLink(invite?.link ?? null);
		else toast.show({ title: invite?.mailed ? ADMIN.inviteMailed : ADMIN.inviteNotMailed });
		await reload();
	};

	const listColumn = (
		<ListColumn
			label={ADMIN.adminsTitle}
			items={filteredItems}
			idOf={(a) => String(a.adminId)}
			selected={selectedId}
			onBack={() => nav.go(adminRoutes.admins())}
			search={{
				value: query,
				placeholder: ADMIN.searchAdmins,
				onChange: setQuery,
			}}
			filters={{
				value: roleFilter,
				onChange: setRoleFilter,
				options: [{ id: 'all', label: MORE.allRoles }, ...ROLE_OPTIONS.map((r) => ({ id: r.value, label: r.label }))],
			}}
			rowOf={(a) => ({
				lead: { avatar: a.name ?? a.email },
				title: a.adminId === me?.adminId ? `${a.name ?? a.email} (${ADMIN.you})` : (a.name ?? a.email),
				status:
					a.status === 'invited'
						? { tone: /** @type {const} */ ('accent'), label: ADMIN.invited }
						: a.twoStep?.enabled
							? {
									tone: /** @type {const} */ ('success'),
									label: `Two-step on · ${a.twoStep.recoveryCodesLeft ?? 0} codes`,
								}
							: { tone: /** @type {const} */ ('neutral'), label: 'Two-step off' },
				meta: [roleName(a.role)].filter(Boolean),
				time: a.lastSignInAt ? <LocalTime value={a.lastSignInAt} /> : null,
				href: adminRoutes.admin(a.adminId),
				linkAs: Link,
			})}
			empty={{
				icon: 'shield',
				kind: 'admin',
				title: ADMIN.noAdmins,
			}}
		/>
	);

	if (selectedId && !current) {
		return (
			<Page linkAs={Link} crumbs={[adminsCrumb, { label: ADMIN.adminTitle }]} error={ADMIN.adminGone}>
				{null}
			</Page>
		);
	}

	if (current) {
		return (
			<>
				<AdminPageView
					current={current}
					me={me}
					list={listColumn}
					activityInitial={activity}
					onReload={reload}
					onInvite={canManage ? () => setInviting(true) : undefined}
				/>
				<InviteDrawer
					open={inviting}
					onClose={() => setInviting(false)}
					onInvited={onInvited}
					twoStepOn={Boolean(me?.twoStep?.enabled)}
				/>
				<InviteLink link={link} onClose={() => setLink(null)} />
			</>
		);
	}

	return (
		<>
			<Page
				flush
				crumbs={[{ label: ADMIN.adminsTitle }]}
				info={ADMIN.adminsInfo}
				linkAs={Link}
				list={items.length > 0 ? listColumn : undefined}
				actions={canManage ? { primary: { label: ADMIN.invite, icon: 'plus', onClick: () => setInviting(true) } } : {}}>
				{items.length === 0 ? <EmptyState compact icon="shield" kind="admin" title={ADMIN.noAdmins} /> : <></>}
			</Page>
			<InviteDrawer
				open={inviting}
				onClose={() => setInviting(false)}
				onInvited={onInvited}
				twoStepOn={Boolean(me?.twoStep?.enabled)}
			/>
			<InviteLink link={link} onClose={() => setLink(null)} />
		</>
	);
}

/**
 * The Admins view: the list beside the selected admin's page.
 * @param {any} props loader result of `loadAdmins` or `loadAdmin`
 */
export function AdminsView(props) {
	if (props.ok === false) return <AdminProblem problem={props.problem} />;
	const { data, reload } = useResource(adminApi.admins(), { items: props.items ?? [] });
	const items = /** @type {any[]} */ (data.items ?? props.items ?? []);
	const me = props.me ?? props.admin;
	const selectedId =
		typeof props.selectedId === 'string'
			? props.selectedId
			: typeof props.detail?.adminId === 'string'
				? props.detail.adminId
				: null;

	return (
		<AdminsScreen
			items={items}
			me={me}
			admin={props.admin ?? me}
			selectedId={selectedId}
			fromList={Boolean(props.fromList)}
			activity={props.activity}
			reload={reload}
		/>
	);
}
