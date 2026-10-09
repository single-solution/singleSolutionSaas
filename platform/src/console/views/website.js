'use client';
/**
 * Websites in both consoles (PLAN 0.6, 0.8.2): the website card — its domain and daily cost, its products (status,
 * features on, daily cost, Open) and, launched from the card as dialogs, everything the old website page did: **Add
 * product** and **Remove** a product (Owner, Support), **Install and tokens** (one block per product: widget script
 * tag, browser token, server token reveal / copy / regenerate, docs; never for Finance), **Usage** (30-day chart and
 * the table by product and feature) and **Remove website** (Owner, Support). The admin's merchant page shows one card
 * per website; the merchant console shows the selected website's card as the detail of its Websites screen. The
 * consoles pass the rights, the API client and the Open route; the Portal checks every right again.
 * @module
 */
import { useEffect, useState } from 'react';
import {
	Button,
	Callout,
	Card,
	CodeBlock,
	Dialog,
	EmptyState,
	Form,
	FormError,
	Icon,
	IconBadge,
	Input,
	Skeleton,
	TypedConfirmDialog,
	copyText,
	cx,
	describeProblem,
	fieldErrors,
	formatCredits,
	problemCode,
	useToast,
} from '@ss/ui';
import { BILLING, WEBSITE } from '../../texts/console.js';
import { api } from '../paths.js';
import { productTone, ProductStatusBadge, UsageView } from './billing.js';
import { ActionMenu, openDashboard } from './common.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/** @typedef {import('./common.js').Fetcher} Fetcher */
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
 * What the viewer may do on a website card.
 * @typedef {{ manage: boolean, removeWebsite: boolean, tokens: boolean, open: boolean }} WebsiteRights
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
 * Status dot of a website in a list: the worst status of its products (stopped or suspended red, in grace amber,
 * active green), grey without products or with no features on.
 * @param {readonly ProductCard[]} cards
 * @returns {'success' | 'warning' | 'danger' | 'neutral'}
 */
export const websiteDot = (cards) => {
	const tones = cards.map((card) => productTone(card));
	if (tones.includes('danger')) return 'danger';
	if (tones.includes('warning')) return 'warning';
	if (tones.includes('success')) return 'success';
	return 'neutral';
};

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
					wide
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
 * @typedef {object} WebsiteCardProps
 * @property {any} website
 * @property {ProductCard[]} cards
 * @property {WebsiteRights} can
 * @property {Fetcher} fetcher
 * @property {(productId: string) => { path: string, body?: unknown }} launch the Open route of a product
 * @property {Array<{ productId: string, name: string }> | null} [addable] active connected products (Add product)
 * @property {(cards: ProductCard[]) => void} [onCardsChange] after a product was added or removed
 * @property {() => void} [onRemoved] after the website was removed
 * @property {boolean} [headline] the card is the page's detail (larger heading, products as tiles)
 */

/**
 * A website card: domain, daily cost, products, and the dialogs launched from it.
 * @param {WebsiteCardProps} props
 */
export function WebsiteCard({ website, cards: initial, can, fetcher, launch, addable, onCardsChange, onRemoved, headline }) {
	const toast = useToast();
	const merchantId = String(website.merchantId);
	const websiteId = String(website.websiteId);
	const [cards, setCardsState] = useState(initial);
	const [dialog, setDialog] = useState(/** @type {null | 'add' | 'tokens' | 'usage' | 'removeWebsite'} */ (null));
	const [removing, setRemoving] = useState(/** @type {ProductCard | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [opening, setOpening] = useState(/** @type {string | null} */ (null));
	useEffect(() => setCardsState(initial), [initial]);

	/** @param {ProductCard[]} next */
	const setCards = (next) => {
		setCardsState(next);
		onCardsChange?.(next);
	};
	/** @param {ProductCard} card */
	const open = async (card) => {
		setOpening(card.productId);
		const { path, body } = launch(card.productId);
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
		setCards(cards.filter((c) => c.productId !== removing.productId));
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
		setDialog(null);
		toast.show({ title: WEBSITE.websiteRemoved(website.domain) });
		onRemoved?.();
	};

	const menu = can.removeWebsite ? (
		<ActionMenu
			label={WEBSITE.websiteActionsOf(website.domain)}
			items={[
				{
					label: WEBSITE.removeWebsite,
					danger: true,
					disabled: cards.length > 0,
					...(cards.length > 0 ? { hint: WEBSITE.removeProductsFirst } : {}),
					onSelect: () => {
						setProblem(null);
						setDialog('removeWebsite');
					},
				},
			]}
		/>
	) : null;

	const DomainHeading = headline ? 'h2' : 'h3';
	return (
		<Card as="article" id={`website-${websiteId}`} className="h-full scroll-mt-24">
			<header className="mb-4 flex items-start justify-between gap-3">
				<span className="flex min-w-0 items-center gap-3">
					<IconBadge icon="globe" kind="website" size={headline ? 'md' : 'sm'} />
					<span className="min-w-0">
						<DomainHeading
							className={cx(
								'break-all font-bold tracking-tight text-fg',
								headline ? 'text-2xl font-extrabold' : 'text-base',
							)}>
							{website.domain}
						</DomainHeading>
						<span className="block text-sm text-muted">{WEBSITE.perDay(formatCredits(dailyCostOf(cards)))}</span>
					</span>
				</span>
				{menu}
			</header>
			<div className="space-y-4">
				{cards.length === 0 ? (
					<p className="rounded-2xl bg-surface-2/60 px-4 py-3 text-sm text-muted">
						{can.manage ? WEBSITE.noProducts : WEBSITE.noProductsMerchant}
					</p>
				) : (
					<ul
						className={headline ? 'grid gap-3 sm:grid-cols-2 2xl:grid-cols-3' : 'space-y-2'}
						aria-label={WEBSITE.productsOf(website.domain)}>
						{cards.map((card) => (
							<li
								key={card.productId}
								className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-2xl bg-surface-2/60 px-4 py-3">
								<span className="flex min-w-0 items-center gap-3">
									<IconBadge icon="box" kind="product" size="sm" />
									<span className="min-w-0 space-y-1">
										<span className="flex flex-wrap items-center gap-2">
											<span className="truncate text-sm font-semibold text-fg">{card.name}</span>
											<ProductStatusBadge status={card.status} featuresOn={card.featuresOn} />
										</span>
										<span className="block text-xs text-muted">
											{card.featuresOn.length > 0 ? `${WEBSITE.featuresOn(card.featuresOn.length)} · ` : ''}
											{BILLING.dailyCost}:{' '}
											<span className="font-semibold tabular-nums text-fg">{formatCredits(card.dailyCost)}</span>
										</span>
									</span>
								</span>
								<span className="flex items-center gap-1.5">
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
									{can.manage ? (
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
									) : null}
								</span>
							</li>
						))}
					</ul>
				)}
				<div className="flex flex-wrap gap-2">
					{can.manage ? (
						<Button
							size="sm"
							onClick={() => setDialog('add')}
							aria-label={WEBSITE.addProductTo(website.domain)}
							icon={<Icon name="plus" size={14} />}>
							{WEBSITE.addProduct}
						</Button>
					) : null}
					{can.tokens ? (
						<Button
							size="sm"
							variant="secondary"
							onClick={() => setDialog('tokens')}
							aria-label={WEBSITE.tokensOf(website.domain)}
							icon={<Icon name="key" size={14} />}>
							{WEBSITE.tokens}
						</Button>
					) : null}
					<Button
						size="sm"
						variant="secondary"
						onClick={() => setDialog('usage')}
						aria-label={WEBSITE.usageOf(website.domain)}
						icon={<Icon name="trendingUp" size={14} />}>
						{WEBSITE.usage}
					</Button>
				</div>
			</div>
			{dialog === 'add' ? (
				<AddProductDialog
					merchantId={merchantId}
					website={website}
					fetcher={fetcher}
					products={(addable ?? []).filter((p) => !cards.some((c) => c.productId === p.productId))}
					onClose={() => setDialog(null)}
					onAdded={(card) => {
						setCards([...cards, card].sort((a, b) => a.productId.localeCompare(b.productId)));
						setDialog(null);
						toast.show({ title: WEBSITE.productAdded(card.name) });
					}}
				/>
			) : null}
			{dialog === 'tokens' ? (
				<TokensDialog merchantId={merchantId} website={website} fetcher={fetcher} onClose={() => setDialog(null)} />
			) : null}
			{dialog === 'usage' ? (
				<UsageDialog merchantId={merchantId} website={website} fetcher={fetcher} onClose={() => setDialog(null)} />
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
				open={dialog === 'removeWebsite'}
				onClose={() => setDialog(null)}
				onConfirm={() => void removeWebsite()}
				expected={website.domain}
				busy={busy}
				danger
				confirmLabel={WEBSITE.removeWebsite}
				title={WEBSITE.removeWebsiteTitle(website.domain)}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">{WEBSITE.removeWebsiteHelp}</p>
			</TypedConfirmDialog>
		</Card>
	);
}

/**
 * Add product (PLAN 0.5.9): the active connected products not yet on the website.
 * @param {{ merchantId: string, website: any, fetcher: Fetcher, products: Array<{ productId: string, name: string }>,
 *   onClose: () => void, onAdded: (card: ProductCard) => void }} props
 */
function AddProductDialog({ merchantId, website, fetcher, products, onClose, onAdded }) {
	const [busy, setBusy] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	/** @param {string} productId */
	const add = async (productId) => {
		setBusy(productId);
		setProblem(null);
		const result = await fetcher(api.websiteProducts(merchantId, String(website.websiteId)), {
			method: 'POST',
			body: { productId },
		});
		setBusy(null);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		onAdded(result.data.product);
	};
	return (
		<Dialog open onClose={onClose} title={WEBSITE.addProductTo(website.domain)} description={WEBSITE.addProductHelp}>
			{products.length === 0 ? (
				<p className="text-sm text-muted">{WEBSITE.noneToAdd}</p>
			) : (
				<ul className="divide-y divide-line-soft rounded-2xl bg-surface-2/60">
					{products.map((p) => (
						<li key={p.productId} className="flex items-center justify-between gap-3 px-4 py-3">
							<span className="flex min-w-0 items-center gap-3">
								<IconBadge icon="box" kind="product" size="sm" />
								<span className="truncate text-sm font-semibold text-fg">{p.name}</span>
							</span>
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
 * Loads a website's resource once when its dialog opens.
 * @param {Fetcher} fetcher
 * @param {string} path
 */
const useOnce = (fetcher, path) => {
	const [result, setResult] = useState(/** @type {import('./common.js').ApiResult | null} */ (null));
	useEffect(() => {
		let live = true;
		void fetcher(path).then((r) => {
			if (live) setResult(r);
		});
		return () => {
			live = false;
		};
	}, [fetcher, path]);
	return result;
};

/**
 * Install and tokens of a website, as a dialog: one install block per product.
 * @param {{ merchantId: string, website: any, fetcher: Fetcher, onClose: () => void }} props
 */
function TokensDialog({ merchantId, website, fetcher, onClose }) {
	const websiteId = String(website.websiteId);
	const result = useOnce(fetcher, api.tokens(merchantId, websiteId));
	const tokens = /** @type {TokenEntry[]} */ (result?.ok ? (result.data?.items ?? []) : []);
	return (
		<Dialog open onClose={onClose} size="lg" title={WEBSITE.tokensOf(website.domain)}>
			{!result ? (
				<Skeleton lines={4} />
			) : !result.ok ? (
				<Callout tone="danger">{describeProblem(result.problem)}</Callout>
			) : tokens.length === 0 ? (
				<EmptyState compact icon="key" title={WEBSITE.noTokens} />
			) : (
				<div className="space-y-4">
					{tokens.map((entry) => (
						<InstallBlock
							key={entry.productId}
							entry={entry}
							domain={website.domain}
							merchantId={merchantId}
							websiteId={websiteId}
							fetcher={fetcher}
						/>
					))}
				</div>
			)}
		</Dialog>
	);
}

/**
 * Usage of a website, as a dialog: the last 30 UTC days by product and feature.
 * @param {{ merchantId: string, website: any, fetcher: Fetcher, onClose: () => void }} props
 */
function UsageDialog({ merchantId, website, fetcher, onClose }) {
	const result = useOnce(fetcher, api.usage(merchantId, { websiteId: String(website.websiteId) }));
	return (
		<Dialog open onClose={onClose} size="lg" title={WEBSITE.usageOf(website.domain)}>
			{!result ? (
				<Skeleton lines={4} />
			) : !result.ok ? (
				<Callout tone="danger">{describeProblem(result.problem)}</Callout>
			) : (
				<UsageView usage={result.data} showWebsite={false} chartTitle={BILLING.usageChart} />
			)}
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
		<section aria-label={entry.name} className="space-y-4 rounded-2xl bg-surface-2/60 p-4 sm:p-5">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="flex items-center gap-2 text-sm font-bold text-fg">
					<IconBadge icon="box" kind="product" size="sm" />
					{entry.name}
				</h3>
				{entry.docsUrl ? (
					<a
						href={entry.docsUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
						{WEBSITE.docs}
						<Icon name="external" size={13} />
					</a>
				) : null}
			</div>
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
					<p className="rounded-2xl bg-surface p-3.5 font-mono text-xs text-muted">
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
		</section>
	);
}
