'use client';
/**
 * Websites in both consoles (PLAN 0.6, 0.8.2): the websites table with product chips, Add website, and the website page
 * — header (domain, merchant) and the tabs Products (cards with status, daily cost and Open; Add product, Remove and
 * Remove website for Owner and Support), Install and tokens (one block per product: widget script tag, browser token,
 * server token reveal / copy / regenerate, docs; never for Finance) and Usage (30-day chart and the table by product
 * and feature). The consoles pass the rights, the API client and the links; the Portal checks every right again.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	CodeBlock,
	Dialog,
	EmptyState,
	Form,
	FormError,
	Icon,
	Input,
	PageHeader,
	Table,
	Tabs,
	TypedConfirmDialog,
	copyText,
	describeProblem,
	fieldErrors,
	formatCredits,
	formatDate,
	problemCode,
	useToast,
} from '@ss/ui';
import { BILLING, WEBSITE } from '../../texts/console.js';
import { Link } from '../link.js';
import { WEBSITE_TABS, api } from '../paths.js';
import { productStatusLabel, productTone, ProductStatusBadge, UsageView } from './billing.js';
import { ActionMenu, BackLink, InnerList, openDashboard } from './common.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/** @typedef {import('./common.js').Fetcher} Fetcher */
/** @typedef {import('../paths.js').WebsiteTab} WebsiteTab */
/**
 * A product on a website (card).
 * @typedef {{ productId: string, name: string, status: string, featuresOn: string[], dailyCost: number }} ProductCard
 */
/**
 * One product's install block.
 * @typedef {{ productId: string, name: string, widgetScriptUrl: string | null, docsUrl: string | null,
 *   browserToken: string, serverToken: { canShow: boolean } }} TokenEntry
 */

/**
 * The widget script tag of a product with widgets (PLAN 0.4.10), with the browser token filled in.
 * @param {string} widgetScriptUrl
 * @param {string} browserToken
 */
export const scriptTag = (widgetScriptUrl, browserToken) =>
	`<script src="${widgetScriptUrl}" data-token="${browserToken}" async></script>`;

/**
 * Daily cost of a website: the sum over its products.
 * @param {readonly ProductCard[]} cards
 */
export const dailyCostOf = (cards) => cards.reduce((sum, card) => sum + (card.dailyCost ?? 0), 0);

/**
 * Product chips with their status colour (removed products have none).
 * @param {{ cards: readonly ProductCard[] }} props
 */
export function ProductChips({ cards }) {
	if (cards.length === 0) return <span className="text-muted">—</span>;
	return (
		<span className="flex flex-wrap gap-1">
			{cards.map((card) => (
				<Badge key={card.productId} tone={productTone(card)} dot title={productStatusLabel(card)}>
					{card.name}
					<span className="sr-only"> ({productStatusLabel(card)})</span>
				</Badge>
			))}
		</span>
	);
}

/**
 * The websites of a merchant: domain, product chips and daily cost (PLAN 0.8.2).
 * @param {{ rows: Array<{ website: any, cards: ProductCard[] }>, hrefOf: (websiteId: string) => string,
 *   empty: import('react').ReactNode }} props
 */
export function WebsitesTable({ rows, hrefOf, empty }) {
	return (
		<Table
			caption={WEBSITE.columns.domain}
			captionHidden
			rows={rows}
			rowKey={(r) => r.website.websiteId}
			empty={empty}
			defaultSort={{ key: 'domain', direction: 'asc' }}
			columns={[
				{
					key: 'domain',
					header: WEBSITE.columns.domain,
					rowHeader: true,
					sortable: true,
					sortValue: (r) => r.website.domain,
					render: (r) => (
						<Link href={hrefOf(r.website.websiteId)} className="font-semibold text-primary hover:underline">
							{r.website.domain}
						</Link>
					),
				},
				{ key: 'products', header: WEBSITE.columns.products, render: (r) => <ProductChips cards={r.cards} /> },
				{
					key: 'dailyCost',
					header: WEBSITE.columns.dailyCost,
					align: 'right',
					sortable: true,
					sortValue: (r) => dailyCostOf(r.cards),
					render: (r) => formatCredits(dailyCostOf(r.cards)),
				},
				{
					key: 'added',
					header: WEBSITE.columns.added,
					sortable: true,
					sortValue: (r) => r.website.createdAt,
					render: (r) => formatDate(r.website.createdAt),
				},
			]}
		/>
	);
}

/**
 * Add website (Owner, Support): the exact domain.
 * @param {{ open: boolean, merchantId: string, fetcher: Fetcher, onClose: () => void, onAdded: (website: any) => void }} props
 */
export function AddWebsiteDialog({ open, merchantId, fetcher, onClose, onAdded }) {
	const [domain, setDomain] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const submit = async () => {
		const value = domain.trim();
		setError(value ? null : WEBSITE.domainMissing);
		if (!value) return;
		setBusy(true);
		setProblem(null);
		const result = await fetcher(api.websites(merchantId), { method: 'POST', body: { domain: value } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setDomain('');
		onAdded(result.data.website);
	};
	return (
		<Dialog open={open} onClose={onClose} title={WEBSITE.addWebsite} description={WEBSITE.domainHelp}>
			<Form onSubmit={submit} busy={busy} aria-label={WEBSITE.addWebsite}>
				<Input
					label={WEBSITE.domain}
					placeholder="shop.com"
					autoComplete="off"
					inputMode="url"
					value={domain}
					onChange={(e) => setDomain(e.currentTarget.value)}
					error={error ?? fieldErrors(problem).domain}
					required
				/>
				<FormError problem={problem} fields={['domain']} />
				<Button type="submit" loading={busy}>
					{WEBSITE.addWebsite}
				</Button>
			</Form>
		</Dialog>
	);
}

/**
 * @typedef {object} WebsitePageProps
 * @property {any} website
 * @property {string} merchantName
 * @property {Array<{ websiteId: string, domain: string }>} siblings the merchant's websites (inner sidebar)
 * @property {ProductCard[]} cards
 * @property {TokenEntry[] | null} tokens null when the viewer may not see them
 * @property {Problem | null} [tokensProblem]
 * @property {any} usage
 * @property {Problem | null} [usageProblem]
 * @property {WebsiteTab} tab
 * @property {{ manage: boolean, removeWebsite: boolean, tokens: boolean, open: boolean }} can
 * @property {Fetcher} fetcher
 * @property {{ website: (websiteId: string) => string, back: { href: string, label: string } }} links
 * @property {(productId: string) => { path: string, body?: unknown }} launch the Open route of a product
 * @property {Array<{ productId: string, name: string }> | null} [addable] active connected products (Add product)
 * @property {import('react').ReactNode} [breadcrumbs]
 */

/**
 * The website page.
 * @param {WebsitePageProps} props
 */
export function WebsitePage(props) {
	const toast = useToast();
	const { website, can, fetcher } = props;
	const merchantId = String(website.merchantId);
	const websiteId = String(website.websiteId);
	const [cards, setCards] = useState(props.cards);
	const [tokens, setTokens] = useState(props.tokens);
	const [tab, setTab] = useState(/** @type {string} */ (props.tab));
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState(/** @type {ProductCard | null} */ (null));
	const [removingWebsite, setRemovingWebsite] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [opening, setOpening] = useState(/** @type {string | null} */ (null));

	const reloadTokens = async () => {
		if (!can.tokens) return;
		const result = await fetcher(api.tokens(merchantId, websiteId));
		if (result.ok) setTokens(result.data?.items ?? []);
	};
	/** @param {ProductCard} card */
	const open = async (card) => {
		setOpening(card.productId);
		const { path, body } = props.launch(card.productId);
		const result = await openDashboard(fetcher, path, body);
		setOpening(null);
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
	};
	const removeProduct = async () => {
		if (!removing) return;
		setBusy(true);
		setProblem(null);
		const result = await fetcher(api.websiteProduct(merchantId, websiteId, removing.productId), { method: 'DELETE' });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setCards((list) => list.filter((c) => c.productId !== removing.productId));
		setTokens((list) => (list ? list.filter((t) => t.productId !== removing.productId) : list));
		toast.show({ title: WEBSITE.productRemoved(removing.name) });
		setRemoving(null);
	};
	const removeWebsite = async () => {
		setBusy(true);
		setProblem(null);
		const result = await fetcher(api.website(merchantId, websiteId), { method: 'DELETE', body: { confirm: website.domain } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		window.location.assign(props.links.back.href);
	};

	const productsTab = (
		<div className="space-y-4">
			{can.manage ? (
				<div className="flex justify-end">
					<Button onClick={() => setAdding(true)} icon={<Icon name="plus" size={14} />}>
						{WEBSITE.addProduct}
					</Button>
				</div>
			) : null}
			{cards.length === 0 ? (
				<EmptyState icon="box" title={WEBSITE.noProducts} description={can.manage ? undefined : WEBSITE.noProductsMerchant} />
			) : (
				<ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
					{cards.map((card) => (
						<li key={card.productId}>
							<Card
								title={card.name}
								actions={
									can.manage ? (
										<ActionMenu
											label={WEBSITE.productActions(card.name)}
											items={[
												{
													label: WEBSITE.remove,
													danger: true,
													onSelect: () => {
														setProblem(null);
														setRemoving(card);
													},
												},
											]}
										/>
									) : null
								}>
								<div className="space-y-3">
									<div className="flex flex-wrap items-center gap-2">
										<ProductStatusBadge status={card.status} featuresOn={card.featuresOn} />
										{card.featuresOn.length > 0 ? (
											<span className="text-xs text-muted">{WEBSITE.featuresOn(card.featuresOn.length)}</span>
										) : null}
									</div>
									<p className="text-sm">
										<span className="text-muted">{BILLING.dailyCost}: </span>
										<span className="font-semibold tabular-nums text-fg">{formatCredits(card.dailyCost)}</span>
									</p>
									{can.open ? (
										<Button
											variant="secondary"
											size="sm"
											loading={opening === card.productId}
											aria-label={WEBSITE.openLabel(card.name)}
											title={WEBSITE.openHelp}
											onClick={() => void open(card)}
											icon={<Icon name="external" size={14} />}>
											{WEBSITE.open}
										</Button>
									) : null}
								</div>
							</Card>
						</li>
					))}
				</ul>
			)}
		</div>
	);

	const installTab = (
		<div className="space-y-4">
			{props.tokensProblem ? <Callout tone="danger">{describeProblem(props.tokensProblem)}</Callout> : null}
			{(tokens ?? []).length === 0 ? (
				<EmptyState icon="key" title={WEBSITE.noTokens} />
			) : (
				(tokens ?? []).map((entry) => (
					<InstallBlock
						key={entry.productId}
						entry={entry}
						domain={website.domain}
						merchantId={merchantId}
						websiteId={websiteId}
						fetcher={fetcher}
					/>
				))
			)}
		</div>
	);

	const usageTab = props.usageProblem ? (
		<Callout tone="danger">{describeProblem(props.usageProblem)}</Callout>
	) : (
		<UsageView usage={props.usage} showWebsite={false} chartTitle={BILLING.usageChart} />
	);

	/** @type {Record<WebsiteTab, import('react').ReactNode>} */
	const contents = { products: productsTab, install: installTab, usage: usageTab };
	const tabs = WEBSITE_TABS.filter((t) => t !== 'install' || can.tokens).map((t) => ({
		id: t,
		label: WEBSITE.tabs[t],
		content: contents[t],
	}));

	return (
		<div className="flex gap-6 lg:gap-8">
			<InnerList
				label={props.links.back.label}
				search={WEBSITE.search}
				currentId={websiteId}
				entries={props.siblings.map((w) => ({ id: w.websiteId, label: w.domain, href: props.links.website(w.websiteId) }))}
			/>
			<div className="min-w-0 flex-1 space-y-8">
				<BackLink href={props.links.back.href} label={WEBSITE.back(props.links.back.label)} />
				<PageHeader
					breadcrumbs={props.breadcrumbs}
					title={<span className="break-all">{website.domain}</span>}
					subtitle={
						<>
							<span className="sr-only">{WEBSITE.merchant}: </span>
							{props.merchantName}
						</>
					}
					actions={
						can.removeWebsite ? (
							<ActionMenu
								label={WEBSITE.websiteActions}
								items={[
									{
										label: WEBSITE.removeWebsite,
										danger: true,
										disabled: cards.length > 0,
										...(cards.length > 0 ? { hint: WEBSITE.removeProductsFirst } : {}),
										onSelect: () => {
											setProblem(null);
											setRemovingWebsite(true);
										},
									},
								]}
							/>
						) : null
					}
				/>
				<Tabs
					label={website.domain}
					value={tabs.some((t) => t.id === tab) ? tab : 'products'}
					onChange={setTab}
					tabs={tabs}
				/>
			</div>
			{adding ? (
				<AddProductDialog
					merchantId={merchantId}
					websiteId={websiteId}
					fetcher={fetcher}
					products={(props.addable ?? []).filter((p) => !cards.some((c) => c.productId === p.productId))}
					onClose={() => setAdding(false)}
					onAdded={(card) => {
						setCards((list) => [...list, card].sort((a, b) => a.productId.localeCompare(b.productId)));
						setAdding(false);
						toast.show({ title: WEBSITE.productAdded(card.name) });
						void reloadTokens();
					}}
				/>
			) : null}
			<TypedConfirmDialog
				open={Boolean(removing)}
				onClose={() => setRemoving(null)}
				onConfirm={() => void removeProduct()}
				expected={removing?.name ?? ''}
				busy={busy}
				danger
				confirmLabel={WEBSITE.remove}
				title={WEBSITE.removeTitle(removing?.name ?? '')}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">{WEBSITE.removeHelp}</p>
			</TypedConfirmDialog>
			<TypedConfirmDialog
				open={removingWebsite}
				onClose={() => setRemovingWebsite(false)}
				onConfirm={() => void removeWebsite()}
				expected={website.domain}
				busy={busy}
				danger
				confirmLabel={WEBSITE.removeWebsite}
				title={WEBSITE.removeWebsiteTitle(website.domain)}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">{WEBSITE.removeWebsiteHelp}</p>
			</TypedConfirmDialog>
		</div>
	);
}

/**
 * Add product (PLAN 0.5.9): the active connected products not yet on the website.
 * @param {{ merchantId: string, websiteId: string, fetcher: Fetcher, products: Array<{ productId: string, name: string }>,
 *   onClose: () => void, onAdded: (card: ProductCard) => void }} props
 */
function AddProductDialog({ merchantId, websiteId, fetcher, products, onClose, onAdded }) {
	const [busy, setBusy] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	/** @param {string} productId */
	const add = async (productId) => {
		setBusy(productId);
		setProblem(null);
		const result = await fetcher(api.websiteProducts(merchantId, websiteId), { method: 'POST', body: { productId } });
		setBusy(null);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		onAdded(result.data.product);
	};
	return (
		<Dialog open onClose={onClose} title={WEBSITE.addProduct} description={WEBSITE.addProductHelp}>
			{products.length === 0 ? (
				<p className="text-sm text-muted">{WEBSITE.noneToAdd}</p>
			) : (
				<ul className="divide-y divide-line-soft rounded-2xl bg-surface-2/60">
					{products.map((p) => (
						<li key={p.productId} className="flex items-center justify-between gap-3 px-4 py-3">
							<span className="min-w-0 truncate text-sm font-semibold text-fg">{p.name}</span>
							<Button
								size="sm"
								loading={busy === p.productId}
								disabled={busy !== null}
								aria-label={`${WEBSITE.add} ${p.name}`}
								onClick={() => void add(p.productId)}>
								{WEBSITE.add}
							</Button>
						</li>
					))}
				</ul>
			)}
			<FormError problem={problem} />
		</Dialog>
	);
}

/**
 * One product's install block: the widget script tag (products with widgets), the browser token, the server token
 * (reveal / copy / regenerate with a typed confirmation of the product name) and the docs link (PLAN 0.4.4, 0.8.2).
 * @param {{ entry: TokenEntry, domain: string, merchantId: string, websiteId: string, fetcher: Fetcher }} props
 */
export function InstallBlock({ entry, domain, merchantId, websiteId, fetcher }) {
	const toast = useToast();
	const [value, setValue] = useState(/** @type {string | null} */ (null));
	const [shown, setShown] = useState(false);
	const [cannot, setCannot] = useState(entry.serverToken?.canShow === false);
	const [busy, setBusy] = useState(false);
	const [regenerating, setRegenerating] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));

	/** @returns {Promise<string | null>} */
	const reveal = async () => {
		if (value) return value;
		setBusy(true);
		setProblem(null);
		const result = await fetcher(api.reveal(merchantId, websiteId, entry.productId), { method: 'POST' });
		setBusy(false);
		if (!result.ok) {
			if (problemCode(result.problem) === 'conflict' || result.status === 409) setCannot(true);
			else setProblem(result.problem);
			return null;
		}
		setValue(result.data.serverToken);
		return result.data.serverToken;
	};
	const show = async () => {
		if (shown) {
			setShown(false);
			return;
		}
		if (await reveal()) setShown(true);
	};
	const copy = async () => {
		const token = await reveal();
		if (!token) return;
		const ok = await copyText(token);
		toast.show(ok ? { title: WEBSITE.copied } : { tone: 'danger', title: WEBSITE.copyFailed });
	};
	const regenerate = async () => {
		setBusy(true);
		setProblem(null);
		const result = await fetcher(api.regenerate(merchantId, websiteId, entry.productId), {
			method: 'POST',
			body: { kind: 'server' },
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setValue(result.data.token);
		setShown(true);
		setCannot(false);
		setRegenerating(false);
		toast.show({ title: WEBSITE.regenerated });
	};

	return (
		<Card
			title={entry.name}
			actions={
				entry.docsUrl ? (
					<a
						href={entry.docsUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
						{WEBSITE.docs}
						<Icon name="external" size={13} />
					</a>
				) : null
			}>
			<div className="space-y-5">
				{entry.widgetScriptUrl ? (
					<div className="space-y-1">
						<CodeBlock label={WEBSITE.scriptTag} code={scriptTag(entry.widgetScriptUrl, entry.browserToken)} />
						<p className="text-xs text-muted">{WEBSITE.scriptTagHelp}</p>
					</div>
				) : null}
				<div className="space-y-1">
					<CodeBlock label={WEBSITE.browserToken} code={entry.browserToken} />
					<p className="text-xs text-muted">{WEBSITE.browserTokenHelp(domain)}</p>
				</div>
				<div className="space-y-2">
					<p className="text-xs font-semibold uppercase tracking-wider text-muted">{WEBSITE.serverToken}</p>
					{cannot ? (
						<Callout tone="warning">{WEBSITE.cannotShow}</Callout>
					) : shown && value ? (
						<CodeBlock code={value} label={WEBSITE.serverToken} />
					) : (
						<p className="rounded-2xl bg-surface-2 p-3.5 font-mono text-xs text-muted">
							<span aria-hidden="true">••••••••••••••••••••</span>
							<span className="sr-only">{WEBSITE.hidden}</span>
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						{cannot ? null : (
							<>
								<Button variant="secondary" size="sm" onClick={() => void show()} loading={busy && !regenerating}>
									{shown ? WEBSITE.hide : WEBSITE.reveal}
								</Button>
								<Button variant="secondary" size="sm" onClick={() => void copy()} disabled={busy}>
									{WEBSITE.copy}
								</Button>
							</>
						)}
						<Button
							variant="secondary"
							size="sm"
							disabled={busy}
							onClick={() => {
								setProblem(null);
								setRegenerating(true);
							}}>
							{WEBSITE.regenerate}
						</Button>
					</div>
					<p className="text-xs text-muted">{WEBSITE.serverTokenHelp}</p>
					{problem && !regenerating ? <Callout tone="danger">{describeProblem(problem)}</Callout> : null}
				</div>
			</div>
			<TypedConfirmDialog
				open={regenerating}
				onClose={() => setRegenerating(false)}
				onConfirm={() => void regenerate()}
				expected={entry.name}
				busy={busy}
				danger
				confirmLabel={WEBSITE.regenerate}
				title={WEBSITE.regenerateTitle(entry.name)}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">{WEBSITE.regenerateHelp}</p>
			</TypedConfirmDialog>
		</Card>
	);
}
