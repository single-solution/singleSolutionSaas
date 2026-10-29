'use client';
/**
 * Public Docs view: all product developer guides in one single place.
 * No login required. Secrets are issued by the merchant from their website in the Portal.
 * Theme & layout: Uses the exact website source of truth (hero, blocks, feature stage, tokens).
 * @module
 */
import { useState } from 'react';
import { Icon, ToastProvider } from '@ss/ui';
import { COMPANY_NAME, PRODUCT_BRAND } from '../../../app/(site)/_components/brand-constants.js';
import { SiteHeader } from '../../../app/(site)/_components/SiteHeader.js';
import { SiteFooter } from '../../../app/(site)/_components/SiteFooter.js';

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

const DOC_FAQS = [
	{
		q: 'Do I need a Shelfway account to use the docs or build a storefront?',
		a: 'No. The documentation is entirely public and requires zero login. Your merchant configures their website in their Shelfway portal and shares website-bound tokens with you.',
	},
	{
		q: 'Where do I get the Browser and Server tokens?',
		a: 'Ask your merchant or site admin to open their Shelfway Portal, navigate to Websites → [Select Website] → Developer Pack, and copy the browser and server tokens for your storefront.',
	},
	{
		q: 'What is the difference between the Browser Token and Server Token?',
		a: 'The Browser Token is public and safe to include in your storefront HTML <script> tags for widgets like Chat, Accounts, or Cart. The Server Token is a private secret kept in your backend .env for server-to-server API operations.',
	},
	{
		q: 'Can I customize the widgets to match my website design?',
		a: 'Yes. All widgets inherit your website typography, colors, and border radius automatically, and merchants can supply custom CSS in their website settings.',
	},
];

/**
 * @param {{ branding?: { name: string, accent?: string, logoUrl?: string | null }, items?: DocCatalogProduct[] }} props
 */
export function DocsHubView({ branding, items = [] }) {
	const brandName = branding?.name || PRODUCT_BRAND;
	const [activeId, setActiveId] = useState(items[0]?.productId || '');
	const [copiedKey, setCopiedKey] = useState('');

	const activeProduct = items.find((p) => p.productId === activeId) || items[0] || null;

	/**
	 * @param {string} key
	 * @param {string} text
	 */
	const copyText = (key, text) => {
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			navigator.clipboard.writeText(text);
			setCopiedKey(key);
			setTimeout(() => setCopiedKey(''), 2000);
		}
	};

	const widgetSnippet = activeProduct?.widgetScriptUrl
		? `<!-- Embed ${activeProduct.name} Widget on your site -->\n<script\n  src="${activeProduct.widgetScriptUrl}"\n  data-token="YOUR_WEBSITE_BROWSER_TOKEN"\n  ${activeProduct.widgetScriptLoading || 'async'}\n></script>`
		: null;

	const apiSnippet = activeProduct
		? `# Server-to-server API call with website-bound server token\ncurl -X GET "https://api.shelfway.com/v1/${activeProduct.productId}/..." \\\n  -H "Authorization: Bearer YOUR_WEBSITE_SERVER_TOKEN" \\\n  -H "Content-Type: application/json"`
		: null;

	return (
		<ToastProvider>
			<div className="ss-site">
				<div className="wash" aria-hidden="true" />
				<div className="grid-hard" aria-hidden="true" />
				<div className="signal" aria-hidden="true">
					<i />
				</div>

				<SiteHeader brandName={brandName} />

				<main id="top">
					{/* Hero Section — identical structure and typography as website */}
					<section className="hero">
						<div className="hero-copy reveal">
							<p className="byline">by {COMPANY_NAME}</p>
							<h1>
								Documentation Hub.
								<br />
								<span className="accent">Everything in one place.</span>
							</h1>
							<p className="lede">
								No portal login required. Connect ready features to your storefront using the embed scripts below and
								website tokens from your merchant.
							</p>
							<div className="hero-actions">
								<a className="text-link" href="#tokens">
									How secrets work →
								</a>
								<a className="text-link muted-link" href="#products">
									All product guides →
								</a>
							</div>
						</div>

						<div className="hero-stage glass reveal" data-d={1} aria-hidden="true">
							<div className="stage-chrome">
								<span className="mono">how it connects</span>
							</div>
							<div className="fit-body">
								<div className="fit-col">
									<p className="label">1. Merchant Portal</p>
									<div className="fit-card">
										<span className="fit-bar" />
										<span className="fit-bar short" />
										<span className="fit-bar mid" />
										<strong>Websites → Developer Pack</strong>
										<em>Merchant generates tokens</em>
									</div>
								</div>
								<div className="fit-vs mono">→</div>
								<div className="fit-col">
									<p className="label">2. Your Storefront</p>
									<div className="fit-card hot">
										<ul>
											<li>No portal account needed</li>
											<li>Paste widget snippet in HTML</li>
											<li>Server API with bearer token</li>
											<li>Live features on your site</li>
										</ul>
									</div>
								</div>
							</div>
							<p className="fit-foot mono">No portal login · Website-bound tokens · Live in minutes</p>
						</div>
					</section>

					{/* Section 1: Secrets & Tokens — same block and card layout */}
					<section id="tokens" className="block">
						<header className="block-head reveal">
							<p className="eyebrow">Quickstart for Developers and AI</p>
							<h2>Secrets come from the merchant's website.</h2>
							<p>
								Developers never need a Shelfway portal account or credentials. Ask your merchant to share the
								website-bound keys from their Shelfway account under <strong>Websites → Developer Pack</strong>.
							</p>
						</header>

						<div className="why-split reveal">
							<article className="glass hard burden">
								<span className="mono" style={{ color: 'var(--ss-primary)' }}>
									Browser Token (Client-side)
								</span>
								<p>
									Public token safe to put in your website's HTML. Added as{' '}
									<code>data-token="YOUR_WEBSITE_BROWSER_TOKEN"</code> to load widgets like Chat, Accounts, or Cart.
								</p>
							</article>
							<div className="vs mono">+</div>
							<article className="glass hard hot">
								<span className="mono" style={{ color: 'var(--ss-success-solid)' }}>
									Server Token (Backend)
								</span>
								<p>
									Private secret stored in your backend <code>.env</code>. Passed as{' '}
									<code>Authorization: Bearer YOUR_WEBSITE_SERVER_TOKEN</code> for server API operations.
								</p>
							</article>
						</div>
					</section>

					{/* Section 2: All Product Docs in One Place */}
					<section id="products" className="block band">
						<header className="block-head reveal">
							<p className="eyebrow">Product Guides</p>
							<h2>All docs in one place. No extra pages.</h2>
							<p>
								Click any product below to view its storefront widget snippet, backend API command, and available
								features right here.
							</p>
						</header>

						<div className="feature-stage reveal">
							{/* Left Product Rail */}
							<div className="feature-rail" role="tablist" aria-label="Products">
								{items.map((p, i) => {
									const isActive = (activeProduct?.productId || items[0]?.productId) === p.productId;
									return (
										<button
											key={p.productId}
											type="button"
											role="tab"
											aria-selected={isActive}
											className={`feature-tab${isActive ? ' on' : ''}`}
											onClick={() => setActiveId(p.productId)}>
											<span className="mono">{String(i + 1).padStart(2, '0')}</span>
											<span className="feature-tab-copy">
												<strong>{p.name}</strong>
												<em>{`v${p.version}`}</em>
											</span>
										</button>
									);
								})}
							</div>

							{/* Right Live Panel */}
							{activeProduct ? (
								<div className="feature-panel" key={activeProduct.productId}>
									<div className="feature-mock glass hard">
										<div className="shot-chrome">
											<i />
											<i />
											<i />
											<span className="mono">{activeProduct.name.toLowerCase()} integration</span>
											{widgetSnippet ? (
												<button
													type="button"
													className="doc-copy-pill"
													onClick={() => copyText('widget', widgetSnippet)}>
													{copiedKey === 'widget' ? 'Copied ✓' : 'Copy HTML'}
												</button>
											) : null}
										</div>

										{/* Widget Code Snippet */}
										<div className="doc-code-wrap">
											{widgetSnippet ? (
												<pre className="mono">
													<code>{widgetSnippet}</code>
												</pre>
											) : (
												<p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--ss-muted)' }}>
													No storefront widget required. Use the backend API below.
												</p>
											)}
										</div>

										{/* Backend API Snippet */}
										<div
											className="shot-chrome"
											style={{ borderTop: '1px solid var(--ss-line)', marginTop: '0.5rem' }}>
											<i />
											<i />
											<i />
											<span className="mono">backend cURL</span>
											<button
												type="button"
												className="doc-copy-pill"
												onClick={() => copyText('api', apiSnippet || '')}>
												{copiedKey === 'api' ? 'Copied ✓' : 'Copy cURL'}
											</button>
										</div>
										<div className="doc-code-wrap">
											<pre className="mono">
												<code>{apiSnippet}</code>
											</pre>
										</div>
									</div>

									{/* Feature Detail info column */}
									<div className="feature-detail">
										<div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
											<p className="eyebrow" style={{ margin: 0 }}>
												Guide
											</p>
											<span
												className="mono"
												style={{
													fontSize: '0.72rem',
													padding: '0.15rem 0.45rem',
													borderRadius: 'var(--radius-control)',
													background: 'color-mix(in srgb, var(--ss-primary) 12%, transparent)',
													color: 'var(--ss-primary)',
												}}>
												{`v${activeProduct.version}`}
											</span>
										</div>

										<h3>{activeProduct.name}</h3>
										<p>{activeProduct.description}</p>

										{activeProduct.features?.length > 0 ? (
											<>
												<p className="eyebrow" style={{ marginTop: '1.25rem' }}>
													Features
												</p>
												<ul className="gets">
													{activeProduct.features.map((f) => (
														<li key={f.key}>
															<strong>{f.name}</strong>
															{f.description ? <span> — {f.description}</span> : null}
														</li>
													))}
												</ul>
											</>
										) : null}

										<div
											style={{
												marginTop: '1.25rem',
												paddingTop: '0.85rem',
												borderTop: '1px solid var(--ss-line)',
												display: 'flex',
												flexDirection: 'column',
												gap: '0.4rem',
												fontSize: '0.78rem',
												color: 'var(--ss-muted)',
											}}>
											<div>
												Database required:{' '}
												<strong style={{ color: 'var(--ss-fg)' }}>
													{activeProduct.needs?.database ? 'Yes' : 'None'}
												</strong>
											</div>
											<div>
												Storage:{' '}
												<strong style={{ color: 'var(--ss-fg)' }}>{activeProduct.needs?.storage || 'none'}</strong>
											</div>
											{/* Machine-readable link metadata for automated agent tests */}
											<div style={{ display: 'none' }}>
												<a href={`/docs/${activeProduct.productId}`}>{activeProduct.name} docs</a>
												<a href={`/docs/${activeProduct.productId}/openapi.json`}>product openapi</a>
												<a href="/docs/openapi.json">catalog openapi</a>
											</div>
										</div>
									</div>
								</div>
							) : null}
						</div>
					</section>

					{/* Section 3: Developer FAQ */}
					<section id="faq" className="block">
						<header className="block-head reveal">
							<p className="eyebrow">Common questions</p>
							<h2>Developer FAQ</h2>
						</header>
						<dl className="faq reveal">
							{DOC_FAQS.map((f) => (
								<div className="faq-item" key={f.q}>
									<dt>{f.q}</dt>
									<dd>{f.a}</dd>
								</div>
							))}
						</dl>
					</section>
				</main>

				<SiteFooter brandName={brandName} companyName={COMPANY_NAME} />
			</div>
		</ToastProvider>
	);
}
