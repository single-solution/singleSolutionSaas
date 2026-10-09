'use client';
/**
 * Building blocks shared by Admin Console views: the page error, the rights check (the infra rights table, pure) and
 * the role badge.
 * @module
 */
import { Badge, ButtonLink, ErrorState, describeProblem, problemCode } from '@ss/ui';
import { ADMIN, CONSOLE } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { adminRoutes } from '../paths.js';

/** @typedef {import('@ss/ui').Problem} Problem */

export { adminCan } from '../rights.js';

/**
 * Page-level error of the Admin Console.
 * @param {{ problem: Problem | null | undefined, title?: string, back?: { href: string, label: string } }} props
 */
export function AdminProblem({ problem, title, back }) {
	const code = problemCode(problem);
	const action =
		code === 'unauthorized' ? (
			<ButtonLink as={Link} href={adminRoutes.login()} variant="primary">
				{CONSOLE.signIn}
			</ButtonLink>
		) : (
			<ButtonLink as={Link} href={back?.href ?? adminRoutes.merchants()} variant="secondary">
				{back?.label ?? CONSOLE.backToMerchants}
			</ButtonLink>
		);
	return (
		<ErrorState
			title={
				title ?? (code === 'not_found' ? CONSOLE.notFound : code === 'forbidden' ? CONSOLE.notPermitted : CONSOLE.loadFailed)
			}
			message={code === 'forbidden' ? CONSOLE.forbiddenHint(describeProblem(problem)) : describeProblem(problem)}
			action={action}
		/>
	);
}

/**
 * An admin's role badge.
 * @param {{ role: string | null | undefined }} props
 */
export function RoleBadge({ role }) {
	if (!role) return null;
	return <Badge kind="admin">{ADMIN.roles[/** @type {'owner'} */ (role)] ?? role}</Badge>;
}
