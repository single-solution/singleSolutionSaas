'use client';
/**
 * Pieces of a website in both consoles (PLAN 0.6, 0.8.2) that the website page (`website-page.js`) and the merchant
 * pages use: the daily cost and status dot of a website, **Add website** and **Add product** (drawers), the usage of
 * all a merchant's websites (a drawer), and the **install block** of a product (widget script tag, browser token,
 * server token reveal / copy / regenerate, docs; never for Finance). The Portal checks every right again.
 * @module
 */
import { useEffect, useState } from 'react';
import {
	Button,
	Callout,
	CodeBlock,
	Drawer,
	Form,
	FormError,
	IconBadge,
	Input,
	PasswordConfirmDialog,
	Row,
	Skeleton,
	TextLink,
	copyText,
	describeProblem,
	fieldErrors,
	problemCode,
	useToast,
} from '@ss/ui';
import { widgetScriptTag } from '@ss/contracts/text';
import { BILLING, WEBSITE } from '../../texts/console.js';
import { apiConfirm, apiFetch } from '../client.js';
import { api } from '../paths.js';
import { productTone, UsageView } from './billing.js';
import { factorOf } from './common.js';
import { confirmationErrors } from './confirm-change.js';

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
		<Drawer open onClose={onClose} size="lg" title={title}>
			{!result ? (
				<Skeleton lines={4} />
			) : !result.ok ? (
				<Callout tone="danger">{describeProblem(result.problem)}</Callout>
			) : (
				<UsageView usage={result.data} chartTitle={BILLING.usageChart} />
			)}
		</Drawer>
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
		<Drawer open={open} onClose={onClose} title={WEBSITE.addWebsite} description={WEBSITE.domainHelp}>
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
		</Drawer>
	);
}

/**
 * Add product (PLAN 0.5.9), in a drawer: the active connected products not yet on the website, a row each with Add.
 * @param {{ open: boolean, merchantId: string, website: { websiteId: string, domain: string },
 *   products: Array<{ productId: string, name: string }>, onClose: () => void, onAdded: (card: ProductCard) => void }} props
 */
export function AddProductDrawer({ open, merchantId, website, products, onClose, onAdded }) {
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
		<Drawer open={open} onClose={onClose} title={WEBSITE.addProductTo(website.domain)} description={WEBSITE.addProductHelp}>
			{products.length === 0 ? (
				<p className="text-sm text-muted">{WEBSITE.noneToAdd}</p>
			) : (
				<div role="list" aria-label={WEBSITE.addProduct} className="-mx-2.5">
					{products.map((p) => (
						<div key={p.productId} role="listitem">
							<Row
								lead={<IconBadge product={p.productId} size="sm" />}
								title={p.name}
								trailing={
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
						</div>
					))}
				</div>
			)}
			<FormError problem={problem} />
		</Drawer>
	);
}

/**
 * Loads a website's resource once when its dialog or page opens (and again when the path changes; `null`: not asked).
 * @param {string | null} path
 */
export const useOnce = (path) => {
	const [result, setResult] = useState(/** @type {import('./common.js').ApiResult | null} */ (null));
	useEffect(() => {
		if (path === null) return undefined;
		let live = true;
		setResult(null);
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
 * Whether the signed-in person has two-step on, from `GET /v1/me` (`{ kind, <kind>: { twoStep }, … }`) or an actor object.
 * @param {import('./common.js').ApiResult | any | null} me
 */
export const twoStepOnOf = (me) => {
	if (!me) return false;
	const obj = me?.ok === true ? me.data : me;
	if (!obj) return false;
	const kind = obj.kind;
	if (kind && obj[kind]?.twoStep?.enabled !== undefined) return Boolean(obj[kind].twoStep.enabled);
	if (obj.twoStep?.enabled !== undefined) return Boolean(obj.twoStep.enabled);
	return false;
};

/**
 * One product's install block, the body of the product's card on the website page: the widget script tag (products
 * with widgets), the browser token, the server token (reveal / copy / regenerate, each after the person's password in a
 * dialog; regenerate also with a typed confirmation of the product name) and the docs link (PLAN 0.4.4, 0.8.2).
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
	const confirm = async (/** @type {{ password?: string, code: string }} */ { password, code }) => {
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
		<div className="space-y-4">
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
					<p className="rounded-control border border-line bg-surface-2 px-3 py-2.5 font-mono text-xs text-muted">
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
			{entry.docsUrl ? (
				<TextLink href={entry.docsUrl} external className="text-label font-medium">
					{WEBSITE.docs}
				</TextLink>
			) : null}
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
		</div>
	);
}
