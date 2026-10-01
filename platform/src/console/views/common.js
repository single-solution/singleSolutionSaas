'use client';
/**
 * Building blocks shared by console views.
 * @module
 */
import { Badge, ButtonLink, ErrorState, PageHeader, TabNav, describeProblem, problemCode } from '@ss/ui';
import { Link } from '../link.js';
import { WEBSITE_TABS, routes } from '../paths.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */

/**
 * Page-level error: a friendly message, and a way forward (sign in again, go back).
 * @param {{ problem: Problem | null | undefined, title?: string }} props
 */
export function PageProblem({ problem, title }) {
	const code = problemCode(problem);
	const action =
		code === 'unauthorized' ? (
			<ButtonLink as={Link} href={routes.login()} variant="primary">
				Sign in
			</ButtonLink>
		) : (
			<ButtonLink as={Link} href={routes.websites()} variant="secondary">
				Back to websites
			</ButtonLink>
		);
	return (
		<ErrorState
			title={
				title ?? (code === 'not_found' ? 'Not found' : code === 'forbidden' ? 'No access' : 'This page could not be loaded')
			}
			message={
				code === 'forbidden'
					? `${describeProblem(problem)} Ask an owner or admin of your organisation for access.`
					: describeProblem(problem)
			}
			action={action}
		/>
	);
}

/**
 * Product name of an app id (catalog lookup), falling back to the slug/id.
 * @param {any[]} catalog
 * @param {string} appId
 * @param {string} [fallback]
 */
export const productName = (catalog, appId, fallback) => catalog.find((p) => p.appId === appId)?.name ?? fallback ?? appId;

/**
 * Header of every website page: domain, environment (live/test twin switch) and the website tabs.
 * @param {{ website: any, active: string, title?: string, subtitle?: import('react').ReactNode,
 *   actions?: import('react').ReactNode, breadcrumbs?: import('react').ReactNode }} props
 */
export function WebsiteHeader({ website, active, title, subtitle, actions, breadcrumbs }) {
	const isTest = website.env === 'test';
	const tab = WEBSITE_TABS.find((t) => t.key === active) ?? WEBSITE_TABS[0];
	const twinHref = website.twinId ? (tab?.href ?? routes.website)(website.twinId) : null;
	return (
		<div className="space-y-4">
			<PageHeader
				breadcrumbs={breadcrumbs}
				title={title ?? website.domain}
				badge={
					<Badge tone={isTest ? 'warning' : 'success'} dot>
						{isTest ? 'Test' : 'Live'}
					</Badge>
				}
				subtitle={subtitle ?? (title ? website.domain : null)}
				actions={
					<>
						{twinHref ? (
							<div role="group" aria-label="Environment" className="flex rounded-xl border border-line bg-surface-2 p-1">
								<EnvLink href={isTest ? twinHref : null} label="Live" />
								<EnvLink href={isTest ? null : twinHref} label="Test" />
							</div>
						) : null}
						{actions}
					</>
				}
			/>
			{isTest ? (
				<p className="rounded-xl bg-warning-soft px-4 py-2 text-sm text-on-warning-soft">
					You are working on the <strong>test twin</strong> of {website.domain}: test keys, subscriptions and deliveries are
					separate from live.
				</p>
			) : null}
			<TabNav
				label="Website sections"
				linkAs={Link}
				current={(tab?.href ?? routes.website)(website.websiteId)}
				items={WEBSITE_TABS.map((t) => ({ href: t.href(website.websiteId), label: t.label }))}
			/>
		</div>
	);
}

/**
 * @param {{ href: string | null, label: string }} props `href` null = current environment
 */
function EnvLink({ href, label }) {
	const base = 'rounded-lg px-3 py-1 text-xs font-semibold';
	if (!href)
		return (
			<span aria-current="true" className={`${base} bg-surface text-fg shadow-card`}>
				{label}
			</span>
		);
	return (
		<Link href={href} className={`${base} text-muted hover:text-fg`}>
			{label}
		</Link>
	);
}

/**
 * Website label for selects (`shop.example.com` / `shop.example.com (test)`).
 * @param {any} website
 */
export const websiteLabel = (website) => `${website.domain}${website.env === 'test' ? ' (test)' : ''}`;
