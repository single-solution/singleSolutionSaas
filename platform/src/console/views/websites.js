'use client';
/**
 * Websites list (read only for merchants) and the website overview (with the install code). The add-website form is
 * used by the admin console.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	ButtonLink,
	Callout,
	Card,
	CodeBlock,
	ConfirmDialog,
	Dialog,
	EmptyState,
	Form,
	FormError,
	Icon,
	Input,
	PageHeader,
	Stat,
	StatusBadge,
	Stepper,
	Table,
	fieldErrors,
	formatDate,
	humanize,
	useToast,
	formatCredits,
} from '@ss/ui';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { api, routes } from '../paths.js';
import { AUTH, BILLING, MERCHANT } from '../../texts/console.js';
import { ProductStatusBadge } from './billing.js';
import { PageProblem, WebsiteHeader, productName } from './common.js';
import { contactLine } from './sign-in.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** Resource kinds a website can connect (PLAN §1a), with what they are for. */
export const RESOURCE_KINDS = Object.freeze([
	{ kind: 'database', label: 'Database', help: 'Your own MongoDB for product data (required by products that store data).' },
	{ kind: 'storage', label: 'Object storage', help: 'Your S3/R2/GCS bucket for files and media.' },
	{ kind: 'ai', label: 'AI provider', help: 'Your own API key for AI features (you pay the provider directly).' },
	{ kind: 'messaging', label: 'Messaging', help: 'Your e-mail/SMS/WhatsApp account for messages to customers.' },
	{ kind: 'payments', label: 'Payments', help: 'Your payment gateway merchant account.' },
]);

/**
 * Add-website form (dialog body or onboarding step; the Admin Console passes `fetcher={adminFetch}`).
 * @param {{ merchantId: string, onAdded: (website: any) => void, autoFocus?: boolean, fetcher?: typeof apiFetch }} props
 */
export function AddWebsiteForm({ merchantId, onAdded, autoFocus = false, fetcher = apiFetch }) {
	const [domain, setDomain] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const submit = async () => {
		const value = domain.trim();
		if (!value) {
			setError('Enter the domain of your website, e.g. shop.example.com.');
			return;
		}
		setError(null);
		setBusy(true);
		setProblem(null);
		const result = await fetcher(api.websites(merchantId), { method: 'POST', body: { domain: value } });
		setBusy(false);
		if (result.ok) onAdded(result.data.website);
		else setProblem(result.problem);
	};
	return (
		<Form onSubmit={submit} busy={busy} aria-label="Add a website">
			<Input
				label="Domain"
				name="domain"
				placeholder="shop.example.com"
				autoComplete="url"
				inputMode="url"
				value={domain}
				onChange={(e) => setDomain(e.currentTarget.value)}
				help="Just the domain — no https:// or path. A test twin is created with it."
				error={error ?? fieldErrors(problem).domain}
				autoFocus={autoFocus}
				required
			/>
			<FormError problem={problem} fields={['domain']} />
			<Button type="submit" loading={busy}>
				Add website
			</Button>
		</Form>
	);
}

/**
 * The merchant's websites (read only: Owner and Support admins add and remove them, PLAN 0.2). With none yet, the
 * welcome with the support contact (PLAN 0.8.2 Sign-in).
 * @param {{ ok: boolean, problem?: Problem, merchantId?: string, websites?: any[], subscriptions?: any[],
 *   branding?: { support: { email: string | null, phone: string | null, whatsapp: string | null } } }} props
 */
export function WebsitesView(props) {
	if (!props.ok || !props.merchantId) return <PageProblem problem={props.problem} />;
	const all = /** @type {any[]} */ (props.websites ?? []);
	const live = all.filter((w) => w.env === 'live');
	const subs = props.subscriptions ?? [];
	/** @param {any} w */
	const subCount = (w) =>
		subs.filter((s) => (s.websiteId === w.websiteId || s.websiteId === w.twinId) && s.status !== 'cancelled').length;
	return (
		<div className="space-y-6">
			<PageHeader title={MERCHANT.menu.websites} />
			{live.length === 0 ? (
				<EmptyState
					icon="globe"
					title={AUTH.welcomeTitle}
					description={
						<>
							{AUTH.welcome} {AUTH.contactUs} {contactLine(props.branding?.support)}.
						</>
					}
				/>
			) : (
				<Table
					caption={MERCHANT.menu.websites}
					rowKey={(w) => w.websiteId}
					rows={live}
					defaultSort={{ key: 'domain', direction: 'asc' }}
					columns={[
						{
							key: 'domain',
							header: 'Domain',
							sortable: true,
							rowHeader: true,
							render: (w) => (
								<Link href={routes.website(w.websiteId)} className="font-semibold text-primary hover:underline">
									{w.domain}
								</Link>
							),
						},
						{
							key: 'subs',
							header: 'Products',
							align: 'right',
							sortable: true,
							sortValue: subCount,
							render: (w) => subCount(w),
						},
						{ key: 'createdAt', header: 'Added', sortable: true, render: (w) => formatDate(w.createdAt) },
					]}
				/>
			)}
		</div>
	);
}

/**
 * The request body of the website settings form (empty fields clear a setting), or null when nothing changed.
 * @param {{ timeZone: string, language: string, currency: string }} form
 * @param {Record<string, any>} website
 * @returns {Record<string, string | null> | null}
 */
export const settingsBody = (form, website) => {
	/** @type {Record<string, string | null>} */
	const body = {};
	for (const name of /** @type {const} */ (['timeZone', 'language', 'currency'])) {
		const value = form[name].trim() === '' ? null : form[name].trim();
		if (value !== (website[name] ?? null)) body[name] = value;
	}
	return Object.keys(body).length > 0 ? body : null;
};

/**
 * Website settings (F.16): time zone, default language and store currency. Products receive them in every
 * entitlement document (`website` section) and use them as defaults. Shared by the merchant and admin consoles.
 * @param {{ merchantId: string, website: Record<string, any>, onSaved?: (website: Record<string, any>) => void,
 *   fetcher?: typeof apiFetch }} props `fetcher`: the Admin Console passes its staff client
 */
export function WebsiteSettingsCard({ merchantId, website, onSaved, fetcher = apiFetch }) {
	const toast = useToast();
	const [current, setCurrent] = useState(website);
	const [form, setForm] = useState({
		timeZone: website.timeZone ?? '',
		language: website.language ?? '',
		currency: website.currency ?? '',
	});
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const errors = problem ? fieldErrors(problem) : {};
	/** @param {'timeZone' | 'language' | 'currency'} key */
	const set = (key) => (/** @type {{ currentTarget: { value: string } }} */ e) =>
		setForm({ ...form, [key]: e.currentTarget.value });
	const save = async () => {
		const body = settingsBody(form, current);
		if (!body) return;
		setBusy(true);
		setProblem(null);
		const result = await fetcher(api.website(merchantId, current.websiteId), { method: 'PATCH', body });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setCurrent(result.data);
		setForm({
			timeZone: result.data.timeZone ?? '',
			language: result.data.language ?? '',
			currency: result.data.currency ?? '',
		});
		onSaved?.(result.data);
		toast.show({ title: 'Website settings saved', description: 'Products receive them within minutes.' });
	};
	return (
		<Card
			title="Website settings"
			subtitle="Defaults every product on this website uses (they apply to the live site and its test twin).">
			<div className="space-y-4">
				<div className="grid gap-4 sm:grid-cols-3">
					<Input
						label="Time zone"
						value={form.timeZone}
						onChange={set('timeZone')}
						error={errors.timeZone}
						help="IANA name, e.g. Europe/Berlin (empty: UTC)"
					/>
					<Input
						label="Language"
						value={form.language}
						onChange={set('language')}
						error={errors.language}
						help="BCP 47 tag, e.g. en or de-CH"
					/>
					<Input
						label="Currency"
						value={form.currency}
						onChange={set('currency')}
						error={errors.currency}
						help="ISO 4217 code, e.g. EUR"
					/>
				</div>
				<FormError problem={problem} fields={['timeZone', 'language', 'currency']} />
				<Button size="sm" onClick={() => void save()} loading={busy} disabled={!settingsBody(form, current)}>
					Save settings
				</Button>
			</div>
		</Card>
	);
}

/**
 * The website's install code: the loader script tag (always the current version) to paste into every page.
 * @param {{ snippet: any }} props `snippet`: `GET …/delivery/snippet` (null until the website has a compiled bundle)
 */
export function InstallCodeCard({ snippet }) {
	const tag = typeof snippet?.alias?.tag === 'string' ? snippet.alias.tag : null;
	return (
		<Card title="Copy install code">
			{tag ? (
				<div className="space-y-2">
					<CodeBlock code={tag} label="Install code" />
					<p className="text-sm text-muted">
						Paste this before <code>{'</head>'}</code> on every page of your site.
					</p>
				</div>
			) : (
				<p className="text-sm text-muted">Your install code appears here once the website is loaded.</p>
			)}
		</Card>
	);
}

/**
 * @param {any} props loader result of `loadWebsiteOverview`
 */
export function WebsiteOverviewView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const { website, catalog, resources, billing, issuerRequest, snippet } = props;
	const subs = /** @type {any[]} */ (props.subscriptions ?? []).filter((s) => s.status !== 'cancelled');
	// products on this website with their status and daily cost (PLAN 0.5.4)
	const lines = /** @type {any[]} */ (billing?.products ?? []).filter((l) => l.websiteId === website.websiteId);
	const daily = lines.reduce((sum, l) => sum + (l.dailyCost ?? 0), 0);
	const connected = /** @type {any[]} */ (resources).filter((r) => r.status === 'connected').length;
	/** @param {string} appId */
	const lineOf = (appId) => lines.find((l) => l.appId === appId) ?? null;
	return (
		<div className="space-y-6">
			<WebsiteHeader website={website} active="overview" />
			{issuerRequest ? (
				<Callout
					tone="info"
					title={`${issuerRequest.product?.name ?? 'A product'} wants to become your identity issuer`}
					actions={
						<Link href={routes.identity(website.websiteId)} className="text-sm font-semibold underline">
							Review
						</Link>
					}>
					Approve or reject it on the Identity tab.
				</Callout>
			) : null}
			<div className="grid gap-4 sm:grid-cols-3">
				<Stat
					label="Products"
					value={subs.length}
					hint={`${subs.filter((s) => s.status === 'active').length} active`}
					icon="box"
				/>
				<Stat label={BILLING.dailyCost} value={formatCredits(daily)} hint="At today's prices" icon="activity" />
				<Stat label="Resources" value={`${connected}/${resources.length}`} hint="Connected" icon="plug" />
			</div>
			<InstallCodeCard snippet={snippet} />
			<Card
				title="Subscriptions"
				subtitle="Products on this website and what they cost per hour."
				padded={false}
				actions={
					<ButtonLink as={Link} href={routes.products(website.websiteId)} size="sm" variant="secondary">
						Browse products
					</ButtonLink>
				}>
				{subs.length === 0 ? (
					<div className="p-5">
						<EmptyState
							compact
							title="No products yet"
							description="Pick products from the catalog and switch their elements on."
							action={
								<ButtonLink as={Link} href={routes.products(website.websiteId)} variant="primary" size="sm">
									Browse products
								</ButtonLink>
							}
						/>
					</div>
				) : (
					<ul className="divide-y divide-line">
						{subs.map((s) => (
							<li key={s.subscriptionId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
								<div className="min-w-0">
									<Link
										href={routes.subscription(website.websiteId, s.subscriptionId)}
										className="font-semibold text-primary hover:underline">
										{productName(catalog, s.appId, s.productSlug)}
									</Link>
									<p className="text-xs text-muted">
										{s.planCode ? `Plan ${s.planCode}` : 'No plan'} · since {formatDate(s.startedAt)}
									</p>
								</div>
								<div className="flex items-center gap-3">
									<span className="text-sm tabular-nums text-muted">
										{formatCredits(lineOf(s.appId)?.dailyCost ?? 0)} / day
									</span>
									{lineOf(s.appId) ? (
										<ProductStatusBadge status={lineOf(s.appId).status} featuresOn={lineOf(s.appId).featuresOn} />
									) : (
										<StatusBadge status={s.status} />
									)}
								</div>
							</li>
						))}
					</ul>
				)}
			</Card>
			<Card
				title="Resources"
				subtitle="Your own database, storage and provider accounts used by products on this website."
				actions={
					<ButtonLink as={Link} href={routes.resources(website.websiteId)} size="sm" variant="secondary">
						Manage
					</ButtonLink>
				}>
				{resources.length === 0 ? (
					<p className="text-sm text-muted">Nothing connected yet. Products that store data need a database first.</p>
				) : (
					<ul className="flex flex-wrap gap-2">
						{resources.map((/** @type {any} */ r) => (
							<li key={`${r.kind}-${r.ref}`}>
								<StatusBadge status={r.status} label={`${humanize(r.kind)} · ${humanize(r.status)}`} />
							</li>
						))}
					</ul>
				)}
			</Card>
			<WebsiteSettingsCard merchantId={props.merchantId} website={website} />
		</div>
	);
}
