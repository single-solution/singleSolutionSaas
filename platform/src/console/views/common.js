'use client';
/**
 * Building blocks shared by console views: the page error (drawn as a Page, layout contract R2) and the two helpers
 * of product dashboards and two-step forms. The list-and-detail layout, its rows and the detail tabs that stood here
 * are gone: lists are rich rows and the parts of a page are sections or `InnerNav` items with their own addresses.
 * @module
 */
import { ButtonLink, Page, describeProblem, problemCode } from '@ss/ui';
import { CONSOLE } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { routes } from '../paths.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * @template [T=any]
 * @typedef {import('../client.js').ApiResult<T>} ApiResult
 */

/**
 * Page-level error, drawn as a page: the heading in the header (with the `back` page as its parent crumb, a link), the
 * problem in the body and, when the person has to sign in again, the button for it.
 * @param {{ problem: Problem | null | undefined, title?: string, back?: { href: string, label: string }, admin?: boolean }} props
 *   `admin`: an Admin Console page (a refusal says the role does not include the area)
 */
export function PageProblem({ problem, title, back, admin = false }) {
	const code = problemCode(problem);
	const forbidden = code === 'forbidden';
	const heading =
		title ??
		(code === 'not_found'
			? CONSOLE.notFound
			: forbidden
				? admin
					? CONSOLE.notPermitted
					: CONSOLE.noAccess
				: CONSOLE.loadFailed);
	return (
		<Page
			linkAs={Link}
			crumbs={[...(back ? [{ label: back.label, href: back.href }] : []), { label: heading }]}
			error={{
				message: forbidden && admin ? CONSOLE.forbiddenHint(describeProblem(problem)) : describeProblem(problem),
				...(code === 'unauthorized'
					? {
							action: (
								<ButtonLink as={Link} href={routes.login()} variant="primary">
									{CONSOLE.signIn}
								</ButtonLink>
							),
						}
					: {}),
			}}
		/>
	);
}

/**
 * Open a product dashboard: make the single-use launch, then open its URL in a new tab.
 * @param {string} path the launch route
 * @param {unknown} [body]
 * @returns {Promise<ApiResult>}
 */
export const openDashboard = async (path, body) => {
	const result = await apiFetch(path, { method: 'POST', ...(body === undefined ? {} : { body }) });
	if (result.ok && typeof result.data?.url === 'string') window.open(result.data.url, '_blank', 'noopener,noreferrer');
	return result;
};

/**
 * A two-step or recovery code field value → the API members.
 * @param {string} value
 */
export const factorOf = (value) => {
	const v = value.trim();
	if (!v) return {};
	return /^\d{6}$/.test(v) ? { code: v } : { recoveryCode: v };
};
