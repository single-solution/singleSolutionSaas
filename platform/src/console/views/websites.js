'use client';
/**
 * Websites list, website overview and onboarding (add the first website → connect resources).
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	ButtonLink,
	Card,
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
	describeProblem,
	fieldErrors,
	formatCreditsPerHour,
	formatDate,
	formatDateTime,
	humanize,
	useToast,
} from '@ss/ui';
import { apiFetch, useResource } from '../client.js';
import { Link } from '../link.js';
import { api, routes } from '../paths.js';
import { PageProblem, WebsiteHeader, productName } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/** Resource kinds a website can connect (PLAN §1a), with what they are for. */
export const RESOURCE_KINDS = Object.freeze([
	{ kind: 'database', label: 'Database', help: 'Your own MongoDB for product data (required by products that store data).' },
	{ kind: 'storage', label: 'Object storage', help: 'Your S3/R2/GCS bucket for files and media.' },
	{ kind: 'ai', label: 'AI provider', help: 'Your own API key for AI features (you pay the provider directly).' },
	{ kind: 'messaging', label: 'Messaging', help: 'Your e-mail/SMS/WhatsApp account for messages to customers.' },
	{ kind: 'payments', label: 'Payments', help: 'Your payment gateway merchant account.' },
	{ kind: 'analytics', label: 'Analytics', help: 'Your analytics and tag account ids.' },
]);

/**
 * Add-website form (dialog body or onboarding step).
 * @param {{ merchantId: string, onAdded: (website: any) => void, autoFocus?: boolean }} props
 */
export function AddWebsiteForm({ merchantId, onAdded, autoFocus = false }) {
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
		const result = await apiFetch(api.websites(merchantId), { method: 'POST', body: { domain: value } });
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
 * @param {{ ok: boolean, problem?: Problem, merchantId?: string, websites?: any[], subscriptions?: any[] }} props
 */
export function WebsitesView(props) {
	const toast = useToast();
	const { data, reload } = useResource(props.merchantId ? api.websites(props.merchantId) : null, {
		items: props.websites ?? [],
	});
	const [adding, setAdding] = useState(false);
	const [deleting, setDeleting] = useState(/** @type {any} */ (null));
	const [confirmText, setConfirmText] = useState('');
	const [busy, setBusy] = useState(false);
	const [deleteProblem, setDeleteProblem] = useState(/** @type {Problem | null} */ (null));
	if (!props.ok || !props.merchantId) return <PageProblem problem={props.problem} />;
	const merchantId = props.merchantId;
	const all = /** @type {any[]} */ (data.items ?? []);
	const live = all.filter((w) => w.env === 'live');
	const subs = props.subscriptions ?? [];
	/** @param {any} w */
	const subCount = (w) =>
		subs.filter((s) => (s.websiteId === w.websiteId || s.websiteId === w.twinId) && s.status !== 'cancelled').length;
	const remove = async () => {
		if (!deleting) return;
		setBusy(true);
		const result = await apiFetch(api.website(merchantId, deleting.websiteId), { method: 'DELETE' });
		setBusy(false);
		if (!result.ok) {
			setDeleteProblem(result.problem);
			return;
		}
		toast.show({
			title: `${deleting.domain} deleted`,
			description: result.data?.domainReleaseAt
				? `The domain can be added again after ${formatDateTime(result.data.domainReleaseAt)}.`
				: undefined,
		});
		setDeleting(null);
		setConfirmText('');
		await reload();
	};
	return (
		<div className="space-y-6">
			<PageHeader
				title="Websites"
				subtitle="Each website has its own elements, keys, resources and a test twin."
				actions={
					<Button onClick={() => setAdding(true)} icon={<Icon name="plus" size={14} />}>
						Add website
					</Button>
				}
			/>
			{live.length === 0 ? (
				<EmptyState
					icon="globe"
					title="Add your first website"
					description="Type its domain; you can preview and switch on elements without touching its code."
					action={
						<ButtonLink as={Link} href={routes.onboarding()} variant="primary">
							Get started
						</ButtonLink>
					}
				/>
			) : (
				<Table
					caption="Websites"
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
							key: 'twin',
							header: 'Test twin',
							render: (w) =>
								w.twinId ? (
									<Link href={routes.website(w.twinId)} className="text-sm text-fg hover:underline">
										Open test
									</Link>
								) : (
									'—'
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
						{ key: 'status', header: 'Status', render: (w) => <StatusBadge status={w.status} /> },
						{ key: 'createdAt', header: 'Added', sortable: true, render: (w) => formatDate(w.createdAt) },
						{
							key: 'actions',
							header: <span className="sr-only">Actions</span>,
							align: 'right',
							render: (w) => (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										setDeleteProblem(null);
										setConfirmText('');
										setDeleting(w);
									}}
									aria-label={`Delete ${w.domain}`}>
									<Icon name="trash" size={14} />
									<span className="hidden sm:inline">Delete</span>
								</Button>
							),
						},
					]}
				/>
			)}
			<Dialog
				open={adding}
				onClose={() => setAdding(false)}
				title="Add a website"
				description="We verify nothing on your site yet.">
				<AddWebsiteForm
					merchantId={merchantId}
					autoFocus
					onAdded={(w) => {
						setAdding(false);
						window.location.assign(routes.onboarding(w.websiteId));
					}}
				/>
			</Dialog>
			<ConfirmDialog
				open={Boolean(deleting)}
				onClose={() => setDeleting(null)}
				onConfirm={() => {
					if (confirmText.trim() === deleting?.domain) void remove();
					else setDeleteProblem({ title: 'Type the domain to confirm', detail: `Type ${deleting?.domain} to confirm.` });
				}}
				danger
				busy={busy}
				confirmLabel="Delete website"
				title={`Delete ${deleting?.domain ?? 'website'}?`}
				error={deleteProblem ? describeProblem(deleteProblem) : null}>
				<p className="text-sm text-muted">
					The website, its test twin, keys and subscriptions stop working immediately. Data in your own resources is not
					touched.
				</p>
				<Input
					label={`Type ${deleting?.domain ?? ''} to confirm`}
					value={confirmText}
					onChange={(e) => setConfirmText(e.currentTarget.value)}
					autoComplete="off"
				/>
			</ConfirmDialog>
		</div>
	);
}

/**
 * @param {any} props loader result of `loadWebsiteOverview`
 */
export function WebsiteOverviewView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const { website, catalog, resources, meter } = props;
	const subs = /** @type {any[]} */ (props.subscriptions ?? []).filter((s) => s.status !== 'cancelled');
	const lines = /** @type {any[]} */ (meter?.subscriptions ?? []).filter((l) => l.websiteId === website.websiteId);
	const burn = lines.reduce((sum, l) => sum + (l.burnRatePerHour ?? 0), 0);
	const connected = /** @type {any[]} */ (resources).filter((r) => r.status === 'connected').length;
	/** @param {string} id */
	const burnOf = (id) => lines.find((l) => l.subscriptionId === id)?.burnRatePerHour ?? 0;
	return (
		<div className="space-y-6">
			<WebsiteHeader website={website} active="overview" />
			<div className="grid gap-4 sm:grid-cols-3">
				<Stat
					label="Products"
					value={subs.length}
					hint={`${subs.filter((s) => s.status === 'active').length} active`}
					icon="box"
				/>
				<Stat
					label="Spend now"
					value={formatCreditsPerHour(burn)}
					hint="Across this website's subscriptions"
					icon="activity"
				/>
				<Stat label="Resources" value={`${connected}/${resources.length}`} hint="Connected" icon="plug" />
			</div>
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
										{formatCreditsPerHour(burnOf(s.subscriptionId))}
									</span>
									<StatusBadge status={s.status} />
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
		</div>
	);
}

/**
 * @param {any} props loader result of `loadOnboarding`
 */
export function OnboardingView(props) {
	if (!props.ok) return <PageProblem problem={props.problem} />;
	const { merchantId, website, resources, websites } = props;
	const step = website ? 'resources' : 'website';
	const steps = [
		{ id: 'website', label: 'Add your website', description: 'By domain' },
		{ id: 'resources', label: 'Connect resources', description: 'Your database, storage, keys' },
		{ id: 'products', label: 'Choose products', description: 'Switch elements on' },
	];
	const byKind = new Map(/** @type {any[]} */ (resources).map((r) => [r.kind, r]));
	return (
		<div className="mx-auto max-w-3xl space-y-6">
			<PageHeader title="Welcome" subtitle="Three steps to your first element on your site." />
			<Card>
				<Stepper steps={steps} current={step} />
			</Card>
			{step === 'website' ? (
				<Card title="Add your website" subtitle="The site can be built with anything — we integrate by script, edge or API.">
					{(websites ?? []).length > 0 ? (
						<p className="mb-4 text-sm text-muted">
							You already have websites.{' '}
							<Link href={routes.websites()} className="font-semibold text-primary hover:underline">
								Go to your websites
							</Link>{' '}
							or add another one below.
						</p>
					) : null}
					<AddWebsiteForm
						merchantId={merchantId}
						autoFocus
						onAdded={(w) => window.location.assign(routes.onboarding(w.websiteId))}
					/>
				</Card>
			) : (
				<Card
					title={`Connect resources for ${website.domain}`}
					subtitle="Single Solution never hosts your data: products use your own resources with your own credentials.">
					<ul className="divide-y divide-line">
						{RESOURCE_KINDS.map((k) => {
							const r = byKind.get(k.kind);
							return (
								<li key={k.kind} className="flex flex-wrap items-center justify-between gap-3 py-3">
									<div className="min-w-0">
										<p className="text-sm font-semibold text-fg">{k.label}</p>
										<p className="text-xs text-muted">{k.help}</p>
									</div>
									{r ? <StatusBadge status={r.status} /> : <Badge>Not connected</Badge>}
								</li>
							);
						})}
					</ul>
					<div className="mt-5 flex flex-wrap gap-2">
						<ButtonLink as={Link} href={routes.resources(website.websiteId)} variant="primary">
							Connect resources
						</ButtonLink>
						<ButtonLink as={Link} href={routes.products(website.websiteId)} variant="secondary">
							Skip for now — browse products
						</ButtonLink>
					</div>
				</Card>
			)}
		</div>
	);
}
