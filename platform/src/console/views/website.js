'use client';
/**
 * Websites in both consoles (PLAN 0.6, 0.8.2): the website card — its domain and daily cost, its products (status,
 * features on, daily cost, Open) and, launched from the card as dialogs: **Add product** and **Remove** a product
 * (Owner, Support), **Setup** (the website's Setup page; never for Finance), **Install and tokens** (one block per
 * product: widget script tag, browser token, server token reveal / copy / regenerate, docs; never for Finance), **Usage** (30-day chart and the table by product and feature),
 * and in the card's menu **Visit website**, **Copy domain** and **Remove website** (Remove: Owner, Support). The admin's merchant page shows one card per website; the merchant console shows the
 * selected website's card as the detail of its Websites screen. The consoles pass the rights, the API client and the
 * Open route; the Portal checks every right again.
 * @module
 */
import { useEffect, useState } from 'react';
import {
	ActionMenu,
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
	ListRow,
	RowList,
	Skeleton,
	SoftBreaks,
	TypedConfirmDialog,
	copyText,
	cx,
	describeProblem,
	fieldErrors,
	formatCredits,
	problemCode,
	useToast,
	TextLink,
	PasswordConfirmDialog,
} from '@ss/ui';
import { widgetScriptTag } from '@ss/contracts/text';
import { BILLING, MORE, WEBSITE } from '../../texts/console.js';
import { apiConfirm, apiFetch } from '../client.js';
import { useNavigation } from '../navigation.js';
import { api } from '../paths.js';
import { productTone, ProductStatusBadge, UsageView } from './billing.js';
import { factorOf, openDashboard } from './common.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * A product on a website (card).
 * @typedef {{ productId: string, name: string, status: string, featuresOn: string[], dailyCost: number }} ProductCard
 */
/**
 * Usage of all a merchant's websites, as a dialog: the last 30 UTC days by website, product and feature.
 * @param {{ merchantId: string, title: string, onClose: () => void }} props
 */
export function MerchantUsageDialog({ merchantId, title, onClose }) {
	const result = useOnce(api.usage(merchantId));
	return (
		<Dialog open onClose={onClose} size="lg" title={title}>
			{!result ? (
				<Skeleton lines={4} />
			) : !result.ok ? (
				<Callout tone="danger">{describeProblem(result.problem)}</Callout>
			) : (
				<UsageView usage={result.data} chartTitle={BILLING.usageChart} />
			)}
		</Dialog>
	);
}

/**
 * One product's install block.
 * @typedef {{ productId: string, name: string, widgetScriptUrl: string | null,
 *   widgetScriptLoading: 'async' | 'blocking', docsUrl: string | null, browserToken: string,
 *   serverToken: { canShow: boolean } }} TokenEntry
 */
/**
 * What the viewer may do on a website card.
 * @typedef {{ manage: boolean, removeWebsite: boolean, tokens: boolean, open: boolean }} WebsiteRights
 */

/**
 * Daily cost of a website: the sum over its products.
 * @param {readonly ProductCard[]} cards
 */
export const dailyCostOf = (cards) => cards.reduce((sum, card) => sum + (card.dailyCost ?? 0), 0);

/**
 * Status dot of a website in a list: the worst status of its products (stopped or suspended red, in grace amber,
 * active green), gray without products or with no features on.
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
 * @param {{ open: boolean, merchantId: string, onClose: () => void, onAdded: (website: any) => void }} props
 */
export function AddWebsiteDialog({ open, merchantId, onClose, onAdded }) {
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
		const result = await apiFetch(api.websites(merchantId), { method: 'POST', body: { domain: value } });
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
 * @property {(productId: string) => { path: string, body?: unknown }} launch the Open route of a product
 * @property {Array<{ productId: string, name: string }> | null} [addable] active connected products (Add product)
 * @property {(cards: ProductCard[]) => void} [onCardsChange] after a product was added or removed
 * @property {() => void} [onRemoved] after the website was removed
 * @property {boolean} [headline] the card is the page's detail (larger heading, products as tiles)
 * @property {string} [setupHref] the website's Setup page (shown to those who see Install and tokens)
 */

/**
 * A website card: domain, daily cost, products, and the dialogs launched from it.
 * @param {WebsiteCardProps} props
 */
export function WebsiteCard({ website, cards: initial, can, launch, addable, onCardsChange, onRemoved, headline, setupHref }) {
	const toast = useToast();
	const nav = useNavigation();
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
		const result = await openDashboard(path, body);
		setOpening(null);
		if (!result.ok) toast.show({ tone: 'danger', title: describeProblem(result.problem) });
	};
	const removeProduct = async () => {
		if (!removing) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(api.websiteProduct(merchantId, websiteId, removing.productId), { method: 'DELETE' });
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
		const result = await apiFetch(api.website(merchantId, websiteId), { method: 'DELETE', body: { confirm: website.domain } });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setDialog(null);
		toast.show({ title: WEBSITE.websiteRemoved(website.domain) });
		onRemoved?.();
	};

	const copyDomain = async () => {
		const copied = await copyText(website.domain);
		toast.show(copied ? { title: MORE.copied } : { tone: 'danger', title: website.domain });
	};
	// the header keeps Add product; the More menu holds Setup, Install and tokens and Usage, then Visit and Copy
	// domain, and Remove website last (danger) for those who remove websites
	/** @type {import('@ss/ui').MenuItem[]} */
	const more = [
		...(can.tokens && setupHref
			? [{ label: WEBSITE.setup, icon: /** @type {const} */ ('layers'), onSelect: () => nav.go(setupHref) }]
			: []),
		...(can.tokens ? [{ label: WEBSITE.tokens, icon: /** @type {const} */ ('key'), onSelect: () => setDialog('tokens') }] : []),
		{ label: WEBSITE.usage, icon: 'trendingUp', onSelect: () => setDialog('usage') },
		{
			label: MORE.visitWebsite,
			icon: 'external',
			divider: true,
			onSelect: () => void window.open(`https://${website.domain}`, '_blank', 'noopener,noreferrer'),
		},
		{ label: MORE.copyDomain, icon: 'copy', onSelect: () => void copyDomain() },
		...(can.removeWebsite
			? [
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
				]
			: []),
	];

	const DomainHeading = headline ? 'h2' : 'h3';
	return (
		<Card
			as="article"
			flow={!headline}
			padded={false}
			id={`website-${websiteId}`}
			className="@container scroll-mt-6"
			title={
				<span className="flex min-w-0 items-center gap-3">
					<IconBadge icon="globe" kind="website" size="sm" />
					<span className="min-w-0">
						<DomainHeading
							title={website.domain}
							className={cx('line-clamp-2 break-words text-title font-semibold text-fg', headline && '@md:text-lead')}>
							<SoftBreaks text={website.domain} />
						</DomainHeading>
						<span className="block text-help font-normal text-muted">
							{WEBSITE.perDay(formatCredits(dailyCostOf(cards)))}
						</span>
					</span>
				</span>
			}
			actions={
				<>
					{can.manage ? (
						<Button
							size="sm"
							onClick={() => setDialog('add')}
							aria-label={WEBSITE.addProductTo(website.domain)}
							icon={<Icon name="plus" size={14} />}>
							{WEBSITE.addProduct}
						</Button>
					) : null}
					<ActionMenu label={WEBSITE.websiteActionsOf(website.domain)} items={more} />
				</>
			}>
			{cards.length === 0 ? (
				<EmptyState compact icon="box" title={can.manage ? WEBSITE.noProducts : WEBSITE.noProductsMerchant} />
			) : (
				<RowList inset label={WEBSITE.productsOf(website.domain)}>
					{cards.map((card) => (
						<ListRow
							key={card.productId}
							product={card.productId}
							title={card.name}
							status={<ProductStatusBadge status={card.status} featuresOn={card.featuresOn} />}
							meta={
								<>
									{card.featuresOn.length > 0 ? `${WEBSITE.featuresOn(card.featuresOn.length)} · ` : ''}
									{BILLING.dailyCost}:{' '}
									<span className="font-medium tabular-nums text-fg">{formatCredits(card.dailyCost)}</span>
								</>
							}
							action={
								can.open ? (
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
								) : null
							}
							moreLabel={WEBSITE.productActions(card.name)}
							{...(can.manage
								? {
										more: [
											{
												label: WEBSITE.remove,
												danger: true,
												onSelect: () => {
													setProblem(null);
													setRemoving(card);
												},
											},
										],
									}
								: {})}
						/>
					))}
				</RowList>
			)}
			{dialog === 'add' ? (
				<AddProductDialog
					merchantId={merchantId}
					website={website}
					products={(addable ?? []).filter((p) => !cards.some((c) => c.productId === p.productId))}
					onClose={() => setDialog(null)}
					onAdded={(card) => {
						setCards([...cards, card].sort((a, b) => a.productId.localeCompare(b.productId)));
						setDialog(null);
						toast.show({ title: WEBSITE.productAdded(card.name) });
					}}
				/>
			) : null}
			{dialog === 'tokens' ? <TokensDialog merchantId={merchantId} website={website} onClose={() => setDialog(null)} /> : null}
			{dialog === 'usage' ? <UsageDialog merchantId={merchantId} website={website} onClose={() => setDialog(null)} /> : null}
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
 * @param {{ merchantId: string, website: any, products: Array<{ productId: string, name: string }>,
 *   onClose: () => void, onAdded: (card: ProductCard) => void }} props
 */
function AddProductDialog({ merchantId, website, products, onClose, onAdded }) {
	const [busy, setBusy] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	/** @param {string} productId */
	const add = async (productId) => {
		setBusy(productId);
		setProblem(null);
		const result = await apiFetch(api.websiteProducts(merchantId, String(website.websiteId)), {
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
				<RowList>
					{products.map((p) => (
						<ListRow
							key={p.productId}
							product={p.productId}
							title={p.name}
							action={
								<Button
									size="sm"
									loading={busy === p.productId}
									disabled={busy !== null}
									aria-label={`${WEBSITE.add} ${p.name}`}
									onClick={() => void add(p.productId)}>
									{WEBSITE.add}
								</Button>
							}
						/>
					))}
				</RowList>
			)}
			<FormError problem={problem} />
		</Dialog>
	);
}

/**
 * Loads a website's resource once when its dialog opens.
 * @param {string} path
 */
const useOnce = (path) => {
	const [result, setResult] = useState(/** @type {import('./common.js').ApiResult | null} */ (null));
	useEffect(() => {
		let live = true;
		void apiFetch(path).then((r) => {
			if (live) setResult(r);
		});
		return () => {
			live = false;
		};
	}, [path]);
	return result;
};

/**
 * Whether the signed-in person has two-step on, from `GET /v1/me` (`{ kind, <kind>: { twoStep }, … }`).
 * @param {import('./common.js').ApiResult | null} me
 */
export const twoStepOnOf = (me) => me?.ok === true && me.data?.[me.data?.kind]?.twoStep?.enabled === true;

/**
 * Install and tokens of a website, as a dialog: one install block per product.
 * @param {{ merchantId: string, website: any, onClose: () => void }} props
 */
function TokensDialog({ merchantId, website, onClose }) {
	const websiteId = String(website.websiteId);
	const result = useOnce(api.tokens(merchantId, websiteId));
	// two-step on: the confirmation of a server token asks for the code at once
	const twoStepOn = twoStepOnOf(useOnce('/v1/me'));
	const tokens = /** @type {TokenEntry[]} */ (result?.ok ? (result.data?.items ?? []) : []);
	return (
		<Dialog open onClose={onClose} size="lg" title={WEBSITE.tokensOf(website.domain)}>
			{!result ? (
				<Skeleton lines={4} />
			) : !result.ok ? (
				<Callout tone="danger">{describeProblem(result.problem)}</Callout>
			) : tokens.length === 0 ? (
				<EmptyState compact icon="key" kind="developer" title={WEBSITE.noTokens} />
			) : (
				<div className="space-y-4">
					{tokens.map((entry) => (
						<InstallBlock
							key={entry.productId}
							entry={entry}
							domain={website.domain}
							merchantId={merchantId}
							websiteId={websiteId}
							twoStepOn={twoStepOn}
						/>
					))}
				</div>
			)}
		</Dialog>
	);
}

/**
 * Usage of a website, as a dialog: the last 30 UTC days by product and feature.
 * @param {{ merchantId: string, website: any, onClose: () => void }} props
 */
function UsageDialog({ merchantId, website, onClose }) {
	const result = useOnce(api.usage(merchantId, { websiteId: String(website.websiteId) }));
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
 * What the Portal said to a refused confirmation, as words for the field it belongs to: a wrong password under the
 * password, a missing or wrong code under the code; anything else (too many tries, a server problem) under the fields.
 * @param {Problem | null} problem
 * @returns {{ password?: string, code?: string, form?: string }}
 */
const confirmationErrors = (problem) => {
	if (!problem) return {};
	const fields = fieldErrors(problem);
	if (fields.code || fields.recoveryCode) return { code: WEBSITE.needsCode };
	if (problemCode(problem) === 'invalid_credentials')
		return /code/i.test(String(problem.detail ?? '')) ? { code: WEBSITE.wrongCode } : { password: WEBSITE.wrongPassword };
	if (fields.password) return { password: WEBSITE.wrongPassword };
	return { form: describeProblem(problem) };
};

/**
 * One product's install block: the widget script tag (products with widgets), the browser token, the server token
 * (reveal / copy / regenerate, each after the person's password in a dialog; regenerate also with a typed confirmation
 * of the product name) and the docs link (PLAN 0.4.4, 0.8.2).
 * @param {{ entry: TokenEntry, domain: string, merchantId: string, websiteId: string, twoStepOn?: boolean }} props
 */
export function InstallBlock({ entry, domain, merchantId, websiteId, twoStepOn = false }) {
	const toast = useToast();
	const [value, setValue] = useState(/** @type {string | null} */ (null));
	const [shown, setShown] = useState(false);
	const [cannot, setCannot] = useState(entry.serverToken?.canShow === false);
	const [busy, setBusy] = useState(false);
	// the action waiting for the person's password: showing the token, copying it, or making a new one
	const [asking, setAsking] = useState(/** @type {null | 'show' | 'copy' | 'regenerate'} */ (null));
	const [errors, setErrors] = useState(/** @type {{ password?: string, code?: string, form?: string }} */ ({}));
	// the code field shows at once while two-step is on, and when the Portal asks for a code
	const [wantsCode, setWantsCode] = useState(false);

	/** @param {'show' | 'copy' | 'regenerate'} action */
	const ask = (action) => {
		setErrors({});
		setAsking(action);
	};
	const show = () => {
		if (shown) setShown(false);
		else if (value) setShown(true);
		else ask('show');
	};
	const copy = async () => {
		if (!value) return ask('copy');
		const ok = await copyText(value);
		toast.show(ok ? { title: WEBSITE.copied } : { tone: 'danger', title: WEBSITE.copyFailed });
	};
	/** Send the confirmation with the action; the dialog stays open, with the reason under its field, when refused. */
	const confirm = async (/** @type {{ password: string, code: string }} */ { password, code }) => {
		const action = asking;
		if (!action) return;
		setBusy(true);
		setErrors({});
		const body = { password, ...factorOf(code) };
		const result =
			action === 'regenerate'
				? await apiConfirm(api.regenerate(merchantId, websiteId, entry.productId), {
						method: 'POST',
						body: { kind: 'server', ...body },
					})
				: await apiConfirm(api.reveal(merchantId, websiteId, entry.productId), { method: 'POST', body });
		setBusy(false);
		if (!result.ok) {
			if (action !== 'regenerate' && (problemCode(result.problem) === 'conflict' || result.status === 409)) {
				setCannot(true);
				setAsking(null);
				return;
			}
			const found = confirmationErrors(result.problem);
			if (found.code) setWantsCode(true);
			setErrors(found);
			return;
		}
		setAsking(null);
		if (action === 'regenerate') {
			setValue(result.data.token);
			setShown(true);
			setCannot(false);
			toast.show({ title: WEBSITE.regenerated });
			return;
		}
		setValue(result.data.serverToken);
		if (action === 'show') setShown(true);
		else {
			const ok = await copyText(result.data.serverToken);
			toast.show(ok ? { title: WEBSITE.copied } : { tone: 'danger', title: WEBSITE.copyFailed });
		}
	};

	return (
		<Card
			title={
				<span className="flex items-center gap-2.5">
					<IconBadge product={entry.productId} size="sm" />
					{entry.name}
				</span>
			}
			{...(entry.docsUrl
				? {
						actions: (
							<TextLink href={entry.docsUrl} external className="text-label font-medium">
								{WEBSITE.docs}
							</TextLink>
						),
					}
				: {})}
			bodyClassName="space-y-4">
			{entry.widgetScriptUrl ? (
				<div className="space-y-1">
					<CodeBlock
						label={WEBSITE.scriptTag}
						code={widgetScriptTag({
							src: entry.widgetScriptUrl,
							token: entry.browserToken,
							loading: entry.widgetScriptLoading,
						})}
					/>
					<p className="text-help text-muted">{WEBSITE.scriptTagHelp}</p>
				</div>
			) : null}
			<div className="space-y-1">
				<CodeBlock label={WEBSITE.browserToken} code={entry.browserToken} />
				<p className="text-help text-muted">{WEBSITE.browserTokenHelp(domain)}</p>
			</div>
			<div className="space-y-2">
				<p className="text-label font-medium text-fg">{WEBSITE.serverToken}</p>
				{cannot ? (
					<Callout tone="warning">{WEBSITE.cannotShow}</Callout>
				) : shown && value ? (
					<CodeBlock code={value} label={WEBSITE.serverToken} />
				) : (
					<p className="rounded-control border border-line-soft bg-surface-2 px-3 py-2.5 font-mono text-xs text-muted">
						<span aria-hidden="true">••••••••••••••••••••</span>
						<span className="sr-only">{WEBSITE.hidden}</span>
					</p>
				)}
				<div className="flex flex-wrap gap-2">
					{cannot ? null : (
						<>
							<Button variant="secondary" size="sm" onClick={show}>
								{shown ? WEBSITE.hide : WEBSITE.reveal}
							</Button>
							<Button variant="secondary" size="sm" onClick={() => void copy()} disabled={busy}>
								{WEBSITE.copy}
							</Button>
						</>
					)}
					<Button variant="secondary" size="sm" disabled={busy} onClick={() => ask('regenerate')}>
						{WEBSITE.regenerate}
					</Button>
				</div>
				<p className="text-xs text-muted">{WEBSITE.serverTokenHelp}</p>
			</div>
			<PasswordConfirmDialog
				open={asking !== null}
				onClose={() => setAsking(null)}
				onConfirm={(input) => void confirm(input)}
				busy={busy}
				danger={asking === 'regenerate'}
				showCode={twoStepOn || wantsCode}
				{...(asking === 'regenerate' ? { expected: entry.name } : {})}
				confirmLabel={asking === 'regenerate' ? WEBSITE.regenerate : WEBSITE.showConfirm}
				title={asking === 'regenerate' ? WEBSITE.regenerateTitle(entry.name) : WEBSITE.showTitle(entry.name)}
				errors={errors}
				texts={{
					password: WEBSITE.password,
					passwordHelp: WEBSITE.passwordHelp,
					code: WEBSITE.code,
					codeHelp: WEBSITE.codeHelp,
				}}>
				<p className="text-sm text-muted">{asking === 'regenerate' ? WEBSITE.regenerateHelp : WEBSITE.showHelp}</p>
			</PasswordConfirmDialog>
		</Card>
	);
}
