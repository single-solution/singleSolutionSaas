'use client';
/**
 * Building blocks shared by Admin Console views: the page error, the rights check (the infra rights table, pure) and
 * the role badge.
 * @module
 */
import { Badge } from '@ss/ui';
import { ADMIN, CONSOLE } from '../../../texts/console.js';
import { PageProblem } from '../../views/common.js';
import { adminRoutes } from '../paths.js';

/** @typedef {import('@ss/ui').Problem} Problem */

export { adminCan } from '../../../infra/rbac.js';

/**
 * Page-level error of the Admin Console (back to Merchants unless `back` says otherwise).
 * @param {{ problem: Problem | null | undefined, title?: string, back?: { href: string, label: string } }} props
 */
export function AdminProblem({ problem, title, back }) {
	return (
		<PageProblem
			problem={problem}
			{...(title ? { title } : {})}
			back={back ?? { href: adminRoutes.merchants(), label: CONSOLE.backToMerchants }}
			admin
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
