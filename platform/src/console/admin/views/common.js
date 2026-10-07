'use client';
/**
 * Building blocks shared by Admin Console views: page errors, permission checks (the infra rights table, pure),
 * id chips and signed credit parsing.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Breadcrumbs,
	ButtonLink,
	Callout,
	ErrorState,
	Icon,
	copyText,
	describeProblem,
	parseCredits,
	problemCode,
} from '@ss/ui';
import { can } from '../../../infra/rbac.js';
import { ADMIN } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { adminRoutes } from '../paths.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * Does the signed-in admin's role hold `permission` (PLAN 0.2 rights table; menus hide what a role cannot use)?
 * @param {any} admin `{ adminId, role }`
 * @param {string} permission
 */
export const adminCan = (admin, permission) =>
	Boolean(admin) && can({ type: 'admin', id: String(admin.adminId ?? 'admin'), role: admin.role ?? null }, permission);

/**
 * Page-level error of the Admin Console.
 * @param {{ problem: Problem | null | undefined, title?: string, back?: { href: string, label: string } }} props
 */
export function AdminProblem({ problem, title, back }) {
	const code = problemCode(problem);
	const action =
		code === 'unauthorized' ? (
			<ButtonLink as={Link} href={adminRoutes.login()} variant="primary">
				Sign in
			</ButtonLink>
		) : (
			<ButtonLink as={Link} href={back?.href ?? adminRoutes.merchants()} variant="secondary">
				{back?.label ?? 'Back to merchants'}
			</ButtonLink>
		);
	return (
		<ErrorState
			title={
				title ??
				(code === 'not_found' ? 'Not found' : code === 'forbidden' ? 'Not permitted' : 'This page could not be loaded')
			}
			message={
				code === 'forbidden'
					? `${describeProblem(problem)} Your role does not include this area; ask an Owner.`
					: describeProblem(problem)
			}
			action={action}
		/>
	);
}

/**
 * Monospace id with a copy button.
 * @param {{ id: string | null | undefined, label?: string }} props
 */
export function IdChip({ id, label }) {
	const [copied, setCopied] = useState(false);
	if (!id) return <span className="text-muted">—</span>;
	return (
		<span className="inline-flex max-w-full items-center gap-1">
			<span className="truncate font-mono text-xs" title={id}>
				{id}
			</span>
			<button
				type="button"
				aria-label={`Copy ${label ?? 'id'}`}
				title={copied ? 'Copied' : `Copy ${label ?? 'id'}`}
				onClick={async () => {
					setCopied(await copyText(id));
					setTimeout(() => setCopied(false), 1500);
				}}
				className="rounded p-0.5 text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
				<Icon name={copied ? 'check' : 'copy'} size={12} />
			</button>
		</span>
	);
}

/**
 * Credits typed by staff, optionally signed (`-12.5` for a negative adjustment) → integer millicredits.
 * @param {string} input
 * @param {{ allowNegative?: boolean }} [options]
 * @returns {{ ok: true, value: number } | { ok: false, message: string }}
 */
export const parseSignedCredits = (input, { allowNegative = false } = {}) => {
	const text = String(input ?? '').trim();
	const negative = text.startsWith('-');
	if (negative && !allowNegative) return { ok: false, message: 'Enter a positive amount.' };
	const parsed = parseCredits(negative ? text.slice(1) : text);
	if (!parsed.ok) return parsed;
	if (parsed.value === 0) return { ok: false, message: 'The amount cannot be 0.' };
	return { ok: true, value: negative ? -parsed.value : parsed.value };
};

/**
 * An admin's role badge.
 * @param {{ role: string | null | undefined }} props
 */
export function RoleBadge({ role }) {
	if (!role) return null;
	return <Badge tone={role === 'owner' ? 'primary' : 'neutral'}>{ADMIN.roles[/** @type {'owner'} */ (role)] ?? role}</Badge>;
}

/**
 * Who did something (audit / history actor).
 * @param {{ actor: any }} props
 */
export function ActorLabel({ actor }) {
	if (!actor) return <span className="text-muted">—</span>;
	return (
		<span className="inline-flex flex-wrap items-center gap-1">
			<Badge>{String(actor.type ?? 'unknown')}</Badge>
			<span className="text-xs">{actor.name ?? actor.id}</span>
		</span>
	);
}

/**
 * Inline API problem (actions on a page).
 * @param {{ problem: Problem | null | undefined }} props
 */
export function ActionProblem({ problem }) {
	if (!problem) return null;
	return <Callout tone="danger">{describeProblem(problem)}</Callout>;
}

/**
 * Breadcrumbs with router links.
 * @param {{ items: Array<{ label: import('react').ReactNode, href?: string }> }} props
 */
export function Crumbs({ items }) {
	return <Breadcrumbs linkAs={Link} items={items} />;
}

/**
 * A problem raised in the browser (input checks, endpoints not served yet): its `detail` is shown as is.
 * @param {string} title
 * @param {string} detail
 * @returns {Problem}
 */
export const localProblem = (title, detail) => ({ code: 'console_check', title, detail });
