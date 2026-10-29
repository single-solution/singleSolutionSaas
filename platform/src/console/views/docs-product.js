'use client';
/**
 * Public Docs product detail view (PLAN §10 B2): guides, features, widget integration,
 * connections prerequisites, and OpenAPI operations reference. No login required.
 * Theme pack: Unite (Shelfway) — matches the marketing site shell and design tokens.
 * @module
 */
import { ButtonLink, CodeBlock, Icon, ToastProvider } from '@ss/ui';
import { DOCS_HUB } from '../../texts/console.js';
import { COMPANY_NAME, PRODUCT_BRAND } from '../../../app/(site)/_components/brand-constants.js';
import { SiteHeader } from '../../../app/(site)/_components/SiteHeader.js';
import { SiteFooter } from '../../../app/(site)/_components/SiteFooter.js';
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
	const brandName = branding?.name || PRODUCT_BRAND;

	const widgetSnippet = product.widgetScriptUrl
		? `<!-- Embed ${product.name} Widget -->\n<script\n  src="${product.widgetScriptUrl}"\n  data-token="YOUR_WEBSITE_BROWSER_TOKEN"\n  ${product.widgetScriptLoading}\n></script>`
		: null;

	const apiSnippet = `# Server-to-server API call with website-bound server token\ncurl -X GET "${product.baseUrl}/v1/..." \\\n  -H "Authorization: Bearer YOUR_WEBSITE_SERVER_TOKEN" \\\n  -H "Content-Type: application/json"`;

	return (
		<ToastProvider>
			<div className="ss-site">
				<div className="wash" aria-hidden="true" />
				<div className="grid-hard" aria-hidden="true" />
				<div className="signal" aria-hidden="true">
					<i />
				</div>

				<SiteHeader brandName={brandName} />

				<main className="docs-main">
					<nav aria-label="Breadcrumb" className="docs-breadcrumb">
						<Link href={routes.docs()}>{DOCS_HUB.title}</Link>
						<span aria-hidden="true">/</span>
						<span className="current">{product.name}</span>
					</nav>

					<div className="docs-head">
						<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
							<h1>{product.name}</h1>
							<span
								className="mono"
								style={{
									fontSize: '0.75rem',
									padding: '0.2rem 0.55rem',
									borderRadius: 'var(--radius-control)',
									background: 'color-mix(in srgb, var(--ss-fg) 8%, transparent)',
									color: 'var(--ss-muted)',
								}}>
								{`v${product.version}`}
							</span>
							<span
								className="mono"
								style={{
									fontSize: '0.72rem',
									padding: '0.2rem 0.55rem',
									borderRadius: 'var(--radius-control)',
									background: 'color-mix(in srgb, var(--ss-primary) 12%, transparent)',
									color: 'var(--ss-primary)',
									border: '1px solid color-mix(in srgb, var(--ss-primary) 28%, transparent)',
								}}>
								Active
							</span>
							<a
								href={routes.docsProductOpenapi(product.productId)}
								target="_blank"
								rel="noopener noreferrer"
								className="mono"
								style={{
									fontSize: '0.72rem',
									padding: '0.2rem 0.55rem',
									borderRadius: 'var(--radius-control)',
									background: 'var(--ss-surface)',
									color: 'var(--ss-primary)',
									border: '1px solid var(--ss-line-strong)',
									textDecoration: 'none',
									display: 'inline-flex',
									alignItems: 'center',
									gap: '0.25rem',
								}}>
								<Icon name="layers" className="size-3" />
								{DOCS_HUB.openapiSpec} ↗
							</a>
						</div>
						<p>{product.guide?.intro || product.description}</p>
					</div>

					{widgetSnippet ? (
						<section className="docs-quickstart glass hard">
							<h2>
								<Icon name="code" className="size-4 text-primary" />
								{DOCS_HUB.widgetIntegration}
							</h2>
							<p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--ss-muted)' }}>
								Embed the widget script on your storefront using your website-bound browser token (available in the
								Developer Pack).
							</p>
							<CodeBlock code={widgetSnippet} label="HTML" />
						</section>
					) : null}

					<section className="docs-quickstart glass hard">
						<h2>
							<Icon name="code" className="size-4 text-primary" />
							Backend API Integration
						</h2>
						<p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--ss-muted)' }}>
							Server-to-server calls require your website-bound server token passed in the Authorization header.
						</p>
						<CodeBlock code={apiSnippet} label="cURL" />
					</section>

					<section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
						<h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: '1.35rem', fontWeight: 800 }}>
							{DOCS_HUB.features}
						</h2>
						{product.features?.length > 0 ? (
							<div
								style={{
									display: 'grid',
									gridTemplateColumns: 'repeat(auto-fill, minmax(18rem, 1fr))',
									gap: '0.85rem',
								}}>
								{product.features.map((f) => (
									<div
										key={f.key}
										className="docs-card glass hard"
										style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
										<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
											<h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 700 }}>
												{f.name}
											</h3>
											<code
												className="mono"
												style={{
													fontSize: '0.68rem',
													padding: '0.15rem 0.45rem',
													borderRadius: 'var(--radius-control)',
													background: 'color-mix(in srgb, var(--ss-fg) 8%, transparent)',
													color: 'var(--ss-muted)',
												}}>
												{f.key}
											</code>
										</div>
										{f.description ? (
											<p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--ss-muted)', lineHeight: 1.4 }}>
												{f.description}
											</p>
										) : null}
										{f.dependsOn?.length ? (
											<p
												className="mono"
												style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: 'var(--ss-muted)' }}>
												Depends on: <strong style={{ color: 'var(--ss-fg)' }}>{f.dependsOn.join(', ')}</strong>
											</p>
										) : null}
									</div>
								))}
							</div>
						) : (
							<p style={{ margin: 0, color: 'var(--ss-muted)' }}>{DOCS_HUB.noFeatures}</p>
						)}
					</section>

					<section className="docs-quickstart glass hard">
						<h2>{DOCS_HUB.prerequisites}</h2>
						<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
							<div className="docs-qs-item">
								<span className="mono" style={{ fontSize: '0.68rem', color: 'var(--ss-muted)', textTransform: 'uppercase' }}>
									{DOCS_HUB.database}
								</span>
								<strong>{product.needs?.database ? DOCS_HUB.required : DOCS_HUB.none}</strong>
							</div>
							<div className="docs-qs-item">
								<span className="mono" style={{ fontSize: '0.68rem', color: 'var(--ss-muted)', textTransform: 'uppercase' }}>
									{DOCS_HUB.storage}
								</span>
								<strong>
									{product.needs?.storage === 'required'
										? DOCS_HUB.required
										: product.needs?.storage === 'optional'
											? DOCS_HUB.optional
											: DOCS_HUB.none}
								</strong>
							</div>
						</div>
					</section>

					<section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
						<div className="docs-products-head">
							<div>
								<h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: '1.35rem', fontWeight: 800 }}>
									{DOCS_HUB.apiReference} ({product.operations?.length ?? 0})
								</h2>
								<p>Documented endpoints from the OpenAPI 3.0 specification.</p>
							</div>
							<a
								href={routes.docsProductOpenapi(product.productId)}
								className="inline-flex items-center text-sm font-semibold hover:underline"
								style={{ color: 'var(--ss-primary)' }}
								target="_blank"
								rel="noopener noreferrer">
								<Icon name="layers" className="mr-1.5 size-4" />
								{DOCS_HUB.openapiSpec} ↗
							</a>
						</div>

						{product.operations?.length > 0 ? (
							<div
								className="glass hard"
								style={{ overflowX: 'auto', borderRadius: 'var(--radius-control)', border: '1px solid var(--ss-line)' }}>
								<div
									style={{
										display: 'grid',
										gridTemplateColumns:
											'minmax(220px, 2fr) minmax(180px, 2fr) minmax(120px, 1.2fr) minmax(100px, 1fr)',
										gap: '0.75rem',
										padding: '0.75rem 1rem',
										borderBottom: '1px solid var(--ss-line)',
										background: 'color-mix(in srgb, var(--ss-fg) 4%, transparent)',
										color: 'var(--ss-muted)',
										fontFamily: 'var(--font-mono)',
										fontSize: '0.7rem',
										textTransform: 'uppercase',
									}}>
									<div>Route</div>
									<div>Summary</div>
									<div>Auth</div>
									<div>Feature</div>
								</div>
								<div>
									{product.operations.map((op, idx) => (
										<div
											key={`${op.method}-${op.path}-${idx}`}
											style={{
												display: 'grid',
												gridTemplateColumns:
													'minmax(220px, 2fr) minmax(180px, 2fr) minmax(120px, 1.2fr) minmax(100px, 1fr)',
												gap: '0.75rem',
												padding: '0.65rem 1rem',
												borderBottom: idx === product.operations.length - 1 ? 'none' : '1px solid var(--ss-line)',
												fontSize: '0.82rem',
												alignItems: 'center',
											}}>
											<div style={{ fontFamily: 'var(--font-mono)' }}>
												<span
													className={`method-badge method-${op.method.toLowerCase()}`}
													style={{ marginRight: '0.55rem' }}>
													{op.method}
												</span>
												<strong style={{ color: 'var(--ss-fg)' }}>{op.path}</strong>
											</div>
											<div style={{ color: 'var(--ss-muted)' }}>{op.summary || '—'}</div>
											<div
												style={{
													color: 'var(--ss-muted)',
													fontFamily: 'var(--font-mono)',
													fontSize: '0.75rem',
												}}>
												{op.auth || 'none'}
												{op.permission ? ` (${op.permission})` : ''}
											</div>
											<div>
												<code
													className="mono"
													style={{
														fontSize: '0.7rem',
														color: 'var(--ss-muted)',
														padding: '0.15rem 0.4rem',
														borderRadius: 'var(--radius-control)',
														background: 'color-mix(in srgb, var(--ss-fg) 6%, transparent)',
													}}>
													{op.feature}
												</code>
											</div>
										</div>
									))}
								</div>
							</div>
						) : (
							<p style={{ margin: 0, color: 'var(--ss-muted)' }}>{DOCS_HUB.noOperations}</p>
						)}
					</section>
				</main>

				<SiteFooter brandName={brandName} companyName={COMPANY_NAME} />
			</div>
		</ToastProvider>
	);
}
