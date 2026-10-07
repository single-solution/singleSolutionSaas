'use client';
/**
 * Merchant Overview, Websites and the website page (PLAN 0.8.2 Merchant): the balance and days left at the current
 * spend, the 30-day spend chart and the websites with product chips and Open buttons; the websites list (inner sidebar
 * on the website page); the website page without admin actions. With no websites yet, the welcome with the support
 * contact (PLAN 0.8.2 Sign-in).
 * @module
 */
import { useState } from 'react';
import { BarChart, Button, Card, EmptyState, Icon, PageHeader, formatCredits, describeProblem, useToast } from '@ss/ui';
import { AUTH, MERCHANT, WEBSITE } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { api, routes } from '../paths.js';
import { BillingStats, ProductStatusBadge } from './billing.js';
import { PageProblem, openDashboard } from './common.js';
import { contactLine } from './sign-in.js';
import { WebsitePage, WebsitesTable, dailyCostOf } from './website.js';

/** @typedef {import('./website.js').ProductCard} ProductCard */
/** @typedef {{ support?: { email: string | null, phone: string | null, whatsapp: string | null } | null }} BrandingSupport */

/**
 * The welcome of a merchant with no websites yet.
 * @param {{ branding?: BrandingSupport }} props
 */
function Welcome({ branding }) {
	return (
		<EmptyState
			icon="globe"
			title={AUTH.welcomeTitle}
			description={
				<>
					{AUTH.welcome} {AUTH.contactUs} {contactLine(branding?.support)}.
				</>
			}
		/>
	);
}

/**
 * The merchant's Overview.
 * @param {any} props loader result of `loadOverview` plus `branding`
 */
export function OverviewView(props) {
	const toast = useToast();
	const [opening, setOpening] = useState(/** @type {string | null} */ (null));
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const rows = /** @type {Array<{ website: any, cards: ProductCard[] }>} */ (props.rows);
	/** @param {any} website @param {ProductCard} card */
	const open = async (website, card) => {
		const key = `${website.websiteId}:${card.productId}`;
		setOpening(key);
		const result = await openDashboard(apiFetch, api.launch(props.merchantId, website.websiteId, card.productId));
		setOpening(null);
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
	};
	return (
		<div className="space-y-6">
			<PageHeader title={MERCHANT.overviewTitle} />
			{props.billing ? <BillingStats summary={props.billing} /> : null}
			<Card title={MERCHANT.spendChart} subtitle={props.usage ? formatCredits(props.usage.total ?? 0) : undefined}>
				<BarChart
					label={MERCHANT.spendChart}
					data={(props.usage?.days ?? []).map((/** @type {{ day: string, amount: number }} */ d) => ({
						label: d.day.slice(5),
						value: d.amount / 1000,
						hint: d.day,
					}))}
					format={(v) => formatCredits(Math.round(v * 1000))}
				/>
			</Card>
			<section className="space-y-3" aria-labelledby="overview-websites">
				<h2 id="overview-websites" className="text-base font-bold text-fg">
					{MERCHANT.websitesTitle}
				</h2>
				{rows.length === 0 ? (
					<Welcome branding={props.branding} />
				) : (
					<ul className="grid gap-4 lg:grid-cols-2">
						{rows.map(({ website, cards }) => (
							<li key={website.websiteId}>
								<Card
									title={
										<Link href={routes.website(website.websiteId)} className="break-all text-primary hover:underline">
											{website.domain}
										</Link>
									}
									subtitle={WEBSITE.perDay(formatCredits(dailyCostOf(cards)))}>
									{cards.length === 0 ? (
										<p className="text-sm text-muted">{WEBSITE.noProductsMerchant}</p>
									) : (
										<ul className="divide-y divide-line">
											{cards.map((card) => (
												<li key={card.productId} className="flex flex-wrap items-center justify-between gap-2 py-2">
													<span className="flex min-w-0 flex-wrap items-center gap-2">
														<span className="truncate text-sm font-semibold text-fg">{card.name}</span>
														<ProductStatusBadge status={card.status} featuresOn={card.featuresOn} />
													</span>
													<Button
														size="sm"
														variant="secondary"
														loading={opening === `${website.websiteId}:${card.productId}`}
														aria-label={`${WEBSITE.openLabel(card.name)} · ${website.domain}`}
														onClick={() => void open(website, card)}
														icon={<Icon name="external" size={14} />}>
														{WEBSITE.open}
													</Button>
												</li>
											))}
										</ul>
									)}
								</Card>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}

/**
 * The merchant's websites (Owner and Support admins add and remove them, PLAN 0.2).
 * @param {any} props loader result of `loadWebsites` plus `branding`
 */
export function WebsitesView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	return (
		<div className="space-y-6">
			<PageHeader title={MERCHANT.websitesTitle} />
			{props.rows.length === 0 ? (
				<Welcome branding={props.branding} />
			) : (
				<WebsitesTable rows={props.rows} hrefOf={(id) => routes.website(id)} empty={WEBSITE.none} />
			)}
		</div>
	);
}

/**
 * The merchant's website page: Products (Open), Install and tokens, Usage.
 * @param {any} props loader result of `loadWebsite`
 */
export function WebsiteView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const merchantId = String(props.website.merchantId);
	const websiteId = String(props.website.websiteId);
	return (
		<WebsitePage
			website={props.website}
			merchantName={props.merchantName}
			siblings={props.websites}
			cards={props.cards}
			tokens={props.tokens}
			tokensProblem={props.tokensProblem}
			usage={props.usage}
			usageProblem={props.usageProblem}
			tab={props.tab}
			can={{ manage: false, removeWebsite: false, tokens: true, open: true }}
			fetcher={apiFetch}
			links={{
				website: (id) => routes.website(id),
				back: { href: routes.websites(), label: MERCHANT.websitesTitle },
			}}
			launch={(productId) => ({ path: api.launch(merchantId, websiteId, productId) })}
		/>
	);
}
