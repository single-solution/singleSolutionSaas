'use client';
/**
 * Product catalog of a website: products with their elements and prices in credits/hour, plan comparison,
 * and subscribing (product, plan, elements) with an hourly estimate (no minimum balance, PLAN 0.5.8).
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	ButtonLink,
	Callout,
	Card,
	CheckboxGroup,
	Dialog,
	EmptyState,
	FormError,
	RadioGroup,
	Select,
	formatCredits,
	formatCreditsPerHour,
	formatUnitPrice,
	humanize,
} from '@ss/ui';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { api, routes } from '../paths.js';
import { MERCHANT } from '../../texts/console.js';
import { PageProblem, WebsiteHeader } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * Hourly estimate of subscribing with a plan (null = no plan: every element at its price).
 * @param {any} product
 * @param {string | null} planCode
 */
export const hourlyEstimate = (product, planCode) => {
	if (planCode) return product.plans.find((/** @type {any} */ p) => p.code === planCode)?.includedHourlyMillicredits ?? 0;
	return product.price?.allElementsHourlyMillicredits ?? 0;
};

/**
 * Plan comparison table: elements × plans.
 * @param {{ product: any }} props
 */
export function PlanComparison({ product }) {
	const plans = /** @type {any[]} */ (product.plans ?? []);
	return (
		<div className="overflow-x-auto rounded-xl border border-line">
			<table className="w-full min-w-[28rem] text-sm">
				<caption className="sr-only">Plans of {product.name}</caption>
				<thead className="bg-surface-2">
					<tr>
						<th scope="col" className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted">
							Element
						</th>
						<th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-muted">
							Price
						</th>
						{plans.map((p) => (
							<th
								key={p.code}
								scope="col"
								className="px-3 py-2 text-center text-xs font-semibold uppercase tracking-wider text-muted">
								{p.name ?? p.code}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{product.elements.map((/** @type {any} */ el) => (
						<tr key={el.key} className="border-t border-line">
							<th scope="row" className="px-3 py-2 text-left font-medium text-fg">
								{el.name}
							</th>
							<td className="px-3 py-2 text-right tabular-nums text-muted">
								{formatCreditsPerHour(el.price.hourlyMillicredits)}
							</td>
							{plans.map((p) => {
								const included = p.elements.includes(el.key);
								const addon = p.addons.includes(el.key);
								return (
									<td key={p.code} className="px-3 py-2 text-center">
										{included ? (
											<Badge tone="success">Included</Badge>
										) : addon ? (
											<Badge tone="info">Add-on</Badge>
										) : (
											<span className="text-muted">—</span>
										)}
									</td>
								);
							})}
						</tr>
					))}
					<tr className="border-t border-line bg-surface-2">
						<th scope="row" className="px-3 py-2 text-left font-semibold text-fg">
							Per hour
						</th>
						<td />
						{plans.map((p) => (
							<td key={p.code} className="px-3 py-2 text-center text-xs tabular-nums text-fg">
								<span className="font-semibold">{formatCreditsPerHour(p.includedHourlyMillicredits)}</span>
								{p.maxHourlyMillicredits > p.includedHourlyMillicredits ? (
									<span className="block text-muted">up to {formatCreditsPerHour(p.maxHourlyMillicredits)}</span>
								) : null}
							</td>
						))}
					</tr>
				</tbody>
			</table>
		</div>
	);
}

/**
 * Elements a plan makes available (included and add-ons; every element without a plan) and those on by default.
 * @param {any} product
 * @param {string} planCode
 */
export const planElements = (product, planCode) => {
	const plan = product.plans.find((/** @type {any} */ p) => p.code === planCode);
	const keys = /** @type {any[]} */ (product.elements).map((el) => el.key);
	return plan
		? { available: keys.filter((k) => plan.elements.includes(k) || plan.addons.includes(k)), on: [...plan.elements] }
		: { available: keys, on: keys };
};

/**
 * Subscribe a website to a product: product (when several are offered), plan and elements, with the hourly estimate.
 * Elements chosen differently from the plan's defaults are switched right after subscribing. Used by the Admin Console
 * (merchant page, `fetcher={adminFetch}`).
 * @param {{ merchantId: string, website: any, products: any[], onClose: () => void,
 *   onSubscribed: (subscription: any) => void, fetcher?: typeof apiFetch }} props
 */
export function SubscribeDialog({ merchantId, website, products, onClose, onSubscribed, fetcher = apiFetch }) {
	const [appId, setAppId] = useState(/** @type {string} */ (products[0]?.appId ?? ''));
	const subscribing = products.find((p) => p.appId === appId) ?? null;
	const [plan, setPlan] = useState(/** @type {string} */ (products[0]?.plans[0]?.code ?? ''));
	const [elements, setElements] = useState(/** @type {string[]} */ (products[0] ? planElements(products[0], plan).on : []));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	/** @param {any} product @param {string} code */
	const choose = (product, code) => {
		setAppId(product?.appId ?? '');
		setPlan(code);
		setElements(product ? planElements(product, code).on : []);
	};
	const estimate = subscribing ? hourlyEstimate(subscribing, plan || null) : 0;
	const subscribe = async () => {
		if (!subscribing) return;
		setBusy(true);
		setProblem(null);
		const result = await fetcher(api.subscribe(merchantId, website.websiteId), {
			method: 'POST',
			body: { appId: subscribing.appId, ...(plan ? { planCode: plan } : {}) },
		});
		if (!result.ok) {
			setBusy(false);
			setProblem(result.problem);
			return;
		}
		const subscription = result.data.subscription;
		const { available, on } = planElements(subscribing, plan);
		for (const key of available) {
			const enabled = elements.includes(key);
			if (enabled === on.includes(key)) continue;
			await fetcher(`${api.subscription(merchantId, subscription.subscriptionId)}/elements/${encodeURIComponent(key)}`, {
				method: 'PUT',
				body: { enabled },
			});
		}
		setBusy(false);
		onSubscribed(subscription);
	};
	const available = subscribing ? planElements(subscribing, plan).available : [];
	return (
		<Dialog
			open
			onClose={onClose}
			title={subscribing && products.length === 1 ? `Subscribe to ${subscribing.name}` : 'Subscribe'}
			description={`On ${website.domain}${website.env === 'test' ? ' (test)' : ''}. Billed per started hour; pause or cancel any time.`}
			footer={
				<>
					<Button variant="secondary" onClick={onClose}>
						Cancel
					</Button>
					<Button onClick={() => void subscribe()} loading={busy} disabled={!subscribing}>
						Subscribe
					</Button>
				</>
			}>
			{products.length === 0 ? (
				<EmptyState compact title="No products yet" description="Products appear here once they are listed and active." />
			) : null}
			{products.length > 1 ? (
				<Select
					label="Product"
					value={appId}
					onChange={(e) => {
						const next = products.find((p) => p.appId === e.currentTarget.value);
						choose(next, next?.plans[0]?.code ?? '');
					}}
					options={products.map((p) => ({ value: p.appId, label: p.name }))}
				/>
			) : null}
			{subscribing ? (
				<>
					{subscribing.plans.length > 0 ? (
						<RadioGroup
							legend="Plan"
							value={plan}
							onChange={(code) => choose(subscribing, code)}
							options={subscribing.plans.map((/** @type {any} */ p) => ({
								value: p.code,
								label: `${p.name ?? p.code} — ${formatCreditsPerHour(p.includedHourlyMillicredits)}`,
							}))}
						/>
					) : (
						<p className="text-sm text-muted">This product has no plans: every element is available at its own price.</p>
					)}
					{available.length > 0 ? (
						<CheckboxGroup
							legend="Elements"
							value={elements}
							onChange={setElements}
							options={available.map((key) => ({
								value: key,
								label: subscribing.elements.find((/** @type {any} */ el) => el.key === key)?.name ?? key,
							}))}
						/>
					) : null}
					<div className="grid gap-3 rounded-xl border border-line bg-surface-2 p-4 sm:grid-cols-2">
						<div>
							<p className="text-xs font-semibold uppercase tracking-wider text-muted">Estimate</p>
							<p className="text-base font-bold tabular-nums text-fg">{formatCreditsPerHour(estimate)}</p>
						</div>
						<div>
							<p className="text-xs font-semibold uppercase tracking-wider text-muted">Per 30 days</p>
							<p className="text-base font-bold tabular-nums text-fg">{formatCredits(estimate * 24 * 30)}</p>
						</div>
					</div>
					{subscribing.price.metered ? (
						<p className="text-xs text-muted">
							Metered usage (per unit, above the plan's included quantities) is billed on top.
						</p>
					) : null}
					<FormError problem={problem} />
				</>
			) : null}
		</Dialog>
	);
}

/**
 * @param {any} props loader result of `loadProducts`
 */
export function ProductsView(props) {
	const [comparing, setComparing] = useState(/** @type {any} */ (null));
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const { website, catalog, subscriptions, resources } = props;
	const connected = new Set(/** @type {any[]} */ (resources).filter((r) => r.status === 'connected').map((r) => r.kind));
	/** @param {string} appId */
	const subscriptionOf = (appId) =>
		/** @type {any[]} */ (subscriptions).find((s) => s.appId === appId && s.status !== 'cancelled');

	return (
		<div className="space-y-6">
			<WebsiteHeader website={website} active="products" />
			{catalog.length === 0 ? (
				<EmptyState
					title="No products are listed yet"
					description="Products appear here once they are certified and listed."
				/>
			) : (
				<div className="grid gap-4 lg:grid-cols-2">
					{catalog.map((/** @type {any} */ product) => {
						const sub = subscriptionOf(product.appId);
						const missing = /** @type {string[]} */ (product.requires).filter((k) => !connected.has(k));
						return (
							<Card key={product.appId} as="article" className="flex flex-col" bodyClassName="flex flex-1 flex-col gap-4">
								<div className="flex flex-wrap items-start justify-between gap-3">
									<div className="min-w-0 flex-1 space-y-1">
										<h2 className="text-base font-bold text-fg">{product.name}</h2>
										<div className="flex flex-wrap gap-1.5">
											<Badge>{humanize(product.category)}</Badge>
											<Badge tone="info">{product.kind === 'pack' ? 'Element pack' : 'Service'}</Badge>
											{sub ? (
												<Badge tone="success" dot>
													Subscribed
												</Badge>
											) : null}
										</div>
									</div>
									<div className="text-right">
										<p className="text-xs font-semibold uppercase tracking-wider text-muted">
											{product.price.free ? 'Price' : 'From'}
										</p>
										<p className="text-lg font-extrabold tabular-nums text-fg">
											{product.price.free ? 'Free' : formatCreditsPerHour(product.price.fromHourlyMillicredits)}
										</p>
									</div>
								</div>
								{product.description ? <p className="text-sm text-muted">{product.description}</p> : null}
								<ul className="space-y-1.5 text-sm">
									{product.elements.map((/** @type {any} */ el) => (
										<li key={el.key} className="flex flex-wrap items-baseline justify-between gap-2">
											<span className="font-medium text-fg">{el.name}</span>
											<span className="text-xs tabular-nums text-muted">
												{formatCreditsPerHour(el.price.hourlyMillicredits)}
												{el.price.metered
													.map(
														(/** @type {any} */ m) => ` + ${formatUnitPrice(m.perUnitMillicredits, m.per, m.unit)}`,
													)
													.join('')}
											</span>
										</li>
									))}
								</ul>
								{missing.length > 0 ? (
									<Callout tone="warning" live={false}>
										Needs your {missing.map(humanize).join(', ').toLowerCase()} connected —{' '}
										<Link href={routes.resources(website.websiteId)} className="font-semibold underline">
											connect resources
										</Link>
										.
									</Callout>
								) : null}
								<div className="mt-auto flex flex-wrap gap-2 pt-2">
									{sub ? (
										<ButtonLink
											as={Link}
											href={routes.subscription(website.websiteId, sub.subscriptionId)}
											variant="primary">
											Manage
										</ButtonLink>
									) : (
										<span className="text-sm text-muted">{MERCHANT.productsByAdmin}</span>
									)}
									{product.plans.length > 0 ? (
										<Button variant="secondary" onClick={() => setComparing(product)}>
											Compare plans
										</Button>
									) : null}
								</div>
							</Card>
						);
					})}
				</div>
			)}
			<Dialog
				open={Boolean(comparing)}
				onClose={() => setComparing(null)}
				size="lg"
				title={comparing ? `${comparing.name} plans` : 'Plans'}
				description="Included elements are on by default; add-ons can be switched on at their hourly price.">
				{comparing ? <PlanComparison product={comparing} /> : null}
			</Dialog>
		</div>
	);
}
