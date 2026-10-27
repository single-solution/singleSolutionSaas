'use client';
/**
 * Public Docs product detail view (PLAN §10 B2): guides, features, widget integration,
 * connections prerequisites, and OpenAPI operations reference. No login required.
 * @module
 */
import { CodeBlock, Icon, ToastProvider } from '@ss/ui';
import { DOCS_HUB } from '../../texts/console.js';
import { Link } from '../link.js';
import { routes } from '../paths.js';

/**
 * @typedef {object} ProductDocsDetail
 * @property {string} productId
 * @property {string} name
 * @property {string} version
 * @property {string} description
 * @property {'active'} status
 * @property {string} baseUrl
 * @property {Array<{ key: string, name: string, description?: string, dependsOn?: string[] }>} features
 * @property {{ database?: boolean, storage?: 'none' | 'optional' | 'required' }} needs
 * @property {{ offers: Array<{ scope: string, name: string, description?: string }>, needs: Array<{ scope: string, name: string }> }} links
 * @property {string | null} widgetScriptUrl
 * @property {'async' | 'blocking'} widgetScriptLoading
 * @property {string} docsUrl
 * @property {string} openapiUrl
 * @property {{ title?: string, intro?: string, localhost?: string, install?: string, features?: Record<string, string[]>, build?: Record<string, string> } | null} guide
 * @property {Array<{ method: string, path: string, summary: string, auth: string, permission: string, feature: string, description: string }>} operations
 */

/**
 * @param {{ branding: { name: string, accent?: string, logoUrl?: string | null }, product: ProductDocsDetail }} props
 */
export function DocsProductView({ branding, product }) {
	const widgetSnippet = product.widgetScriptUrl
		? `<!-- Embed ${product.name} Widget -->\n<script\n  src="${product.widgetScriptUrl}"\n  data-token="YOUR_WEBSITE_BROWSER_TOKEN"\n  ${product.widgetScriptLoading}\n></script>`
		: null;

	const apiSnippet = `# Server-to-server API call with website-bound server token\ncurl -X GET "${product.baseUrl}/v1/..." \\\n  -H "Authorization: Bearer YOUR_WEBSITE_SERVER_TOKEN" \\\n  -H "Content-Type: application/json"`;

	return (
		<ToastProvider>
			<div className="min-h-screen bg-canvas text-fg">
				<header className="sticky top-0 z-10 border-b border-line bg-surface/80 backdrop-blur">
					<div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
						<div className="flex items-center gap-3">
							<Link
								href="/"
								className="font-display text-title font-semibold tracking-[-0.02em] text-fg transition-opacity hover:opacity-80">
								{branding?.name ?? 'Single Solution'}
							</Link>
							<span className="rounded-control bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
								{DOCS_HUB.title}
							</span>
						</div>
						<div className="flex items-center gap-4">
							<Link href={routes.docs()} className="text-sm text-muted transition-colors hover:text-fg">
								{DOCS_HUB.backToHub}
							</Link>
							<a
								href={routes.docsProductOpenapi(product.productId)}
								className="inline-flex items-center rounded-control border border-line px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-surface-muted"
								target="_blank"
								rel="noopener noreferrer">
								<Icon name="layers" className="mr-1.5 size-3.5" />
								{DOCS_HUB.openapiSpec}
							</a>
						</div>
					</div>
				</header>

				<main className="mx-auto max-w-6xl space-y-10 px-4 py-10 sm:px-6 lg:px-8">
					<nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-muted">
						<Link href={routes.docs()} className="transition-colors hover:text-fg">
							{DOCS_HUB.title}
						</Link>
						<span aria-hidden="true">/</span>
						<span className="font-medium text-fg">{product.name}</span>
					</nav>

					<div className="space-y-3">
						<div className="flex flex-wrap items-center gap-3">
							<h1 className="font-display text-3xl font-bold tracking-tight text-fg">{product.name}</h1>
							<span className="rounded-control bg-line-soft px-2.5 py-0.5 font-mono text-xs text-muted">
								{`v${product.version}`}
							</span>
							<span className="rounded-control bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">Active</span>
						</div>
						<p className="max-w-3xl text-base text-muted">{product.guide?.intro || product.description}</p>
					</div>

					{widgetSnippet ? (
						<section className="space-y-4 rounded-card border border-line bg-surface p-6">
							<h2 className="text-base font-semibold text-fg flex items-center gap-2">
								<Icon name="code" className="size-4 text-accent" />
								{DOCS_HUB.widgetIntegration}
							</h2>
							<p className="text-sm text-muted">
								Embed the widget script on your storefront using your website-bound browser token (available in the
								Developer Pack).
							</p>
							<CodeBlock code={widgetSnippet} label="HTML" />
						</section>
					) : null}

					<section className="space-y-4 rounded-card border border-line bg-surface p-6">
						<h2 className="text-base font-semibold text-fg flex items-center gap-2">
							<Icon name="code" className="size-4 text-accent" />
							Backend API Integration
						</h2>
						<p className="text-sm text-muted">
							Server-to-server calls require your website-bound server token passed in the Authorization header.
						</p>
						<CodeBlock code={apiSnippet} label="cURL" />
					</section>

					<section className="space-y-4">
						<h2 className="text-lg font-bold text-fg">{DOCS_HUB.features}</h2>
						{product.features?.length > 0 ? (
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
								{product.features.map((f) => (
									<div key={f.key} className="space-y-2 rounded-card border border-line bg-surface p-4">
										<div className="flex items-center justify-between">
											<h3 className="font-medium text-fg">{f.name}</h3>
											<code className="rounded-control bg-line-soft px-1.5 py-0.5 font-mono text-micro text-muted">
												{f.key}
											</code>
										</div>
										{f.description ? <p className="text-sm text-muted">{f.description}</p> : null}
										{f.dependsOn?.length ? (
											<p className="text-xs text-muted">
												Depends on: <strong className="text-fg">{f.dependsOn.join(', ')}</strong>
											</p>
										) : null}
									</div>
								))}
							</div>
						) : (
							<p className="text-sm text-muted">{DOCS_HUB.noFeatures}</p>
						)}
					</section>

					<section className="space-y-4 rounded-card border border-line bg-surface p-6">
						<h2 className="text-base font-semibold text-fg">{DOCS_HUB.prerequisites}</h2>
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<div className="space-y-1">
								<p className="text-xs text-muted">{DOCS_HUB.database}</p>
								<p className="text-sm font-semibold text-fg">
									{product.needs?.database ? DOCS_HUB.required : DOCS_HUB.none}
								</p>
							</div>
							<div className="space-y-1">
								<p className="text-xs text-muted">{DOCS_HUB.storage}</p>
								<p className="text-sm font-semibold text-fg">
									{product.needs?.storage === 'required'
										? DOCS_HUB.required
										: product.needs?.storage === 'optional'
											? DOCS_HUB.optional
											: DOCS_HUB.none}
								</p>
							</div>
						</div>
					</section>

					<section className="space-y-4">
						<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
							<div>
								<h2 className="text-lg font-bold text-fg">
									{DOCS_HUB.apiReference} ({product.operations?.length ?? 0})
								</h2>
								<p className="text-sm text-muted">Documented endpoints from the OpenAPI 3.0 specification.</p>
							</div>
							<a
								href={routes.docsProductOpenapi(product.productId)}
								className="inline-flex items-center text-sm font-medium text-accent hover:underline"
								target="_blank"
								rel="noopener noreferrer">
								<Icon name="layers" className="mr-1.5 size-4" />
								{DOCS_HUB.openapiSpec}
							</a>
						</div>

						{product.operations?.length > 0 ? (
							<div className="overflow-x-auto rounded-card border border-line bg-surface">
								<div className="grid grid-cols-12 border-b border-line bg-surface-muted px-4 py-3 text-xs font-semibold text-muted">
									<div className="col-span-5 sm:col-span-4">Route</div>
									<div className="col-span-4 sm:col-span-4">Summary</div>
									<div className="col-span-3 sm:col-span-2">Auth</div>
									<div className="hidden sm:col-span-2 sm:block">Feature</div>
								</div>
								<div className="divide-y divide-line-soft">
									{product.operations.map((op, idx) => (
										<div
											key={`${op.method}-${op.path}-${idx}`}
											className="grid grid-cols-12 items-center px-4 py-2.5 text-xs transition-colors hover:bg-surface-muted/50">
											<div className="col-span-5 truncate font-mono sm:col-span-4">
												<span
													className={`mr-2 inline-block rounded-control px-1.5 py-0.5 text-micro font-bold uppercase ${
														op.method === 'GET'
															? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
															: op.method === 'POST'
																? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
																: op.method === 'PUT'
																	? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
																	: 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
													}`}>
													{op.method}
												</span>
												<span className="text-fg">{op.path}</span>
											</div>
											<div className="col-span-4 truncate text-muted sm:col-span-4">{op.summary || '—'}</div>
											<div className="col-span-3 truncate text-muted sm:col-span-2">
												{op.auth || 'none'}
												{op.permission ? ` (${op.permission})` : ''}
											</div>
											<div className="hidden truncate text-muted sm:col-span-2 sm:block">
												<code className="font-mono text-micro">{op.feature}</code>
											</div>
										</div>
									))}
								</div>
							</div>
						) : (
							<p className="text-sm text-muted">{DOCS_HUB.noOperations}</p>
						)}
					</section>
				</main>

				<footer className="mt-16 space-y-2 border-t border-line py-8 text-center text-xs text-muted">
					<p>
						{branding?.name ?? 'Single Solution'} · {DOCS_HUB.hubTitle}
					</p>
					<p>
						OpenAPI spec URL:{' '}
						<a
							href={routes.docsProductOpenapi(product.productId)}
							className="font-mono text-micro text-accent hover:underline"
							target="_blank"
							rel="noopener noreferrer">
							{routes.docsProductOpenapi(product.productId)}
						</a>
					</p>
				</footer>
			</div>
		</ToastProvider>
	);
}
