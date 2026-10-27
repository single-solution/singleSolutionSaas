'use client';
/**
 * Public Docs Hub index view (PLAN §10 B1): lists all active catalog products with guides,
 * OpenAPI links, and quickstart for developers and AI agents. No login required.
 * @module
 */
import { ButtonLink, Icon, ToastProvider } from '@ss/ui';
import { DOCS_HUB } from '../../texts/console.js';
import { Link } from '../link.js';
import { routes } from '../paths.js';

/**
 * @typedef {object} DocCatalogProduct
 * @property {string} productId
 * @property {string} name
 * @property {string} version
 * @property {string} description
 * @property {'active'} status
 * @property {Array<{ key: string, name: string, description?: string }>} features
 * @property {{ database?: boolean, storage?: 'none' | 'optional' | 'required' }} needs
 * @property {{ offers: any[], needs: any[] }} links
 * @property {string | null} widgetScriptUrl
 * @property {'async' | 'blocking'} widgetScriptLoading
 * @property {string} docsUrl
 * @property {string} openapiUrl
 */

/**
 * @param {{ branding: { name: string, accent?: string, logoUrl?: string | null }, items: DocCatalogProduct[] }} props
 */
export function DocsHubView({ branding, items = [] }) {
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
							<Link href="/" className="text-sm text-muted transition-colors hover:text-fg">
								{DOCS_HUB.marketing}
							</Link>
							<a
								href={routes.docsOpenapi()}
								className="text-sm text-muted transition-colors hover:text-fg"
								target="_blank"
								rel="noopener noreferrer">
								{DOCS_HUB.catalogOpenapi}
							</a>
							<ButtonLink href={routes.login()} variant="secondary" size="sm">
								{DOCS_HUB.signIn}
							</ButtonLink>
						</div>
					</div>
				</header>

				<main className="mx-auto max-w-6xl space-y-10 px-4 py-10 sm:px-6 lg:px-8">
					<div className="space-y-3">
						<h1 className="font-display text-2xl font-bold tracking-tight text-fg sm:text-3xl">{DOCS_HUB.hubTitle}</h1>
						<p className="max-w-3xl text-base text-muted">{DOCS_HUB.hubIntro}</p>
					</div>

					<div className="space-y-4 rounded-card border border-line bg-surface p-6">
						<h2 className="flex items-center gap-2 text-base font-semibold text-fg">
							<Icon name="sparkle" className="size-4 text-accent" />
							{DOCS_HUB.quickstart}
						</h2>
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
							<div className="space-y-1 rounded-control border border-line-soft bg-surface/50 p-3">
								<p className="text-sm font-semibold text-fg">{DOCS_HUB.quickstartDevPackTitle}</p>
								<p className="text-xs text-muted">{DOCS_HUB.quickstartDevPackDesc}</p>
							</div>
							<div className="space-y-1 rounded-control border border-line-soft bg-surface/50 p-3">
								<p className="text-sm font-semibold text-fg">{DOCS_HUB.quickstartWidgetsTitle}</p>
								<p className="text-xs text-muted">{DOCS_HUB.quickstartWidgetsDesc}</p>
							</div>
							<div className="space-y-1 rounded-control border border-line-soft bg-surface/50 p-3">
								<p className="text-sm font-semibold text-fg">{DOCS_HUB.quickstartApisTitle}</p>
								<p className="text-xs text-muted">{DOCS_HUB.quickstartApisDesc}</p>
							</div>
							<div className="space-y-1 rounded-control border border-line-soft bg-surface/50 p-3">
								<p className="text-sm font-semibold text-fg">{DOCS_HUB.quickstartOpenapiTitle}</p>
								<p className="text-xs text-muted">{DOCS_HUB.quickstartOpenapiDesc}</p>
							</div>
						</div>
					</div>

					<div className="space-y-4">
						<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
							<div>
								<h2 className="text-lg font-bold text-fg">
									{DOCS_HUB.activeProducts} ({items.length})
								</h2>
								<p className="text-sm text-muted">{DOCS_HUB.activeProductsDesc}</p>
							</div>
							<a
								href={routes.docsOpenapi()}
								className="inline-flex items-center text-sm font-medium text-accent hover:underline"
								target="_blank"
								rel="noopener noreferrer">
								<Icon name="layers" className="mr-1.5 size-4" />
								{DOCS_HUB.catalogOpenapi}
							</a>
						</div>

						<div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
							{items.map((p) => (
								<div
									key={p.productId}
									className="flex flex-col justify-between rounded-card border border-line bg-surface p-5 transition-colors hover:border-line-strong">
									<div className="space-y-3">
										<div className="flex items-center justify-between">
											<h3 className="font-display text-base font-semibold text-fg">{p.name}</h3>
											<span className="rounded-control bg-line-soft px-2 py-0.5 font-mono text-micro text-muted">
												{`v${p.version}`}
											</span>
										</div>
										<p className="line-clamp-2 text-sm text-muted">{p.description}</p>
										{p.features?.length > 0 ? (
											<div className="flex flex-wrap gap-1.5 pt-1">
												{p.features.slice(0, 4).map((f) => (
													<span
														key={f.key}
														className="rounded-control border border-line-soft bg-surface px-2 py-0.5 text-micro text-muted">
														{f.name}
													</span>
												))}
												{p.features.length > 4 ? (
													<span className="rounded-control px-1.5 py-0.5 text-micro text-muted">
														+{p.features.length - 4}
													</span>
												) : null}
											</div>
										) : null}
										<div className="flex items-center gap-4 border-t border-line-soft pt-2 text-xs text-muted">
											<span>
												{DOCS_HUB.database}:{' '}
												<strong className="text-fg">{p.needs?.database ? DOCS_HUB.required : DOCS_HUB.none}</strong>
											</span>
											<span>
												{DOCS_HUB.storage}:{' '}
												<strong className="text-fg">
													{p.needs?.storage === 'required'
														? DOCS_HUB.required
														: p.needs?.storage === 'optional'
															? DOCS_HUB.optional
															: DOCS_HUB.none}
												</strong>
											</span>
										</div>
									</div>
									<div className="mt-5 flex items-center justify-between gap-2 border-t border-line-soft pt-3">
										<ButtonLink
											href={routes.docsProduct(p.productId)}
											variant="primary"
											size="sm"
											className="flex-1 justify-center">
											{DOCS_HUB.readGuide}
										</ButtonLink>
										<a
											href={routes.docsProductOpenapi(p.productId)}
											className="inline-flex items-center justify-center rounded-control border border-line px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-surface-muted"
											target="_blank"
											rel="noopener noreferrer">
											{DOCS_HUB.openapiSpec}
										</a>
									</div>
								</div>
							))}
						</div>
					</div>
				</main>

				<footer className="mt-16 space-y-2 border-t border-line py-8 text-center text-xs text-muted">
					<p>
						{branding?.name ?? 'Single Solution'} · {DOCS_HUB.hubTitle}
					</p>
					<p>
						Stable developer endpoints: <code className="font-mono text-micro">/v1/docs</code> ·{' '}
						<code className="font-mono text-micro">/docs/openapi.json</code> ·{' '}
						<code className="font-mono text-micro">/docs/:productId/openapi.json</code>
					</p>
				</footer>
			</div>
		</ToastProvider>
	);
}
