import React, { useState } from 'react';
import {
	Code,
	Copy,
	CheckCircle2,
	Terminal,
	Globe,
	Sparkles,
	Layers,
	ExternalLink,
	ShieldCheck,
	Key,
	Zap,
	Building2,
} from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Badge } from '@saas/ui/badges/Badge';
import { useStorefront } from '../context/StorefrontContext';

export default function DirectApiConnect() {
	const { activeStore, stores } = useStorefront();
	const [activeTab, setActiveTab] = useState('nextjs');
	const [copiedKey, setCopiedKey] = useState(null);

	if (!activeStore || stores.length === 0) {
		return (
			<div className="space-y-6 antialiased text-slate-900">
				<PageHeader
					title="Direct API & SDK Integration Hub"
					subtitle="Connection guides, REST endpoints, and SDK snippets for your storefronts"
				/>
				<Card>
					<div className="py-16 px-4 text-center space-y-4 max-w-md mx-auto">
						<div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
							<Building2 size={28} />
						</div>
						<div className="space-y-1.5">
							<h3 className="font-extrabold text-base text-slate-900">No Merchant Storefront Registered</h3>
							<p className="text-xs text-slate-500 leading-relaxed">
								Register a merchant store in the Master Portal to generate an isolated Site ID and API Ingestion Key.
							</p>
						</div>
						<div className="pt-2">
							<a
								href="http://localhost:3000/tenants"
								className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs transition-all shadow-xs">
								<span>Go to Master Portal</span>
								<ExternalLink size={13} />
							</a>
						</div>
					</div>
				</Card>
			</div>
		);
	}

	const siteId = activeStore.id;
	const apiKey = activeStore.apiKey;
	const domain = activeStore.domain;

	const handleCopy = (text, key) => {
		navigator.clipboard.writeText(text);
		setCopiedKey(key);
		setTimeout(() => setCopiedKey(null), 2000);
	};

	const scriptTagCode = `<!-- SingleSolution Analytics Pro Telemetry Tag -->
<script
  defer
  src="http://localhost:5001/telemetry.js"
  data-site-id="${siteId}"
  data-api-key="${apiKey}"
></script>`;

	const nextJsCode = `// In your Next.js project: src/app/layout.tsx
import Script from 'next/script';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Analytics Pro Telemetry Stream */}
        <Script
          strategy="afterInteractive"
          src="http://localhost:5001/telemetry.js"
          data-site-id="${siteId}"
          data-api-key="${apiKey}"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}`;

	const restCurlCode = `curl -X POST http://localhost:5001/api/telemetry/event \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "siteId": "${siteId}",
    "eventType": "custom",
    "eventName": "order_completed",
    "path": "/checkout/success",
    "title": "Order #ORD-1049",
    "eventData": {
      "orderId": "ORD-1049",
      "total": "$1,199.00",
      "currency": "USD",
      "items": 1
    }
  }'`;

	const restFetchCode = `// Direct REST API Event Dispatch in JavaScript / TypeScript
async function trackStorefrontEvent(eventName, payload = {}) {
  await fetch('http://localhost:5001/api/telemetry/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ${apiKey}',
    },
    body: JSON.stringify({
      siteId: '${siteId}',
      eventType: 'custom',
      eventName: eventName,
      path: window.location.pathname,
      title: document.title,
      eventData: payload,
    }),
  });
}`;

	const reactHookCode = `// src/hooks/useTelemetry.js
export function useTelemetry() {
  const track = (eventName, data = {}) => {
    if (typeof window !== 'undefined' && window.__ss_analytics) {
      window.__ss_analytics.track(eventName, data);
    }
  };

  return { track };
}

// Usage in Component:
const { track } = useTelemetry();
track('add_to_cart', { sku: 'item-101', price: 120 });`;

	return (
		<div className="space-y-6 antialiased text-slate-900">
			<PageHeader
				title="Direct API & SDK Integration Hub"
				subtitle={`Connection guides, REST endpoints, and SDK snippets for ${activeStore.name} (${domain})`}
				actions={
					<div className="flex items-center gap-2">
						<Badge type="success">Active Site ID: {siteId}</Badge>
					</div>
				}
			/>

			{/* API Credentials Card */}
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
				<div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs flex items-center justify-between gap-3">
					<div className="space-y-1 min-w-0">
						<div className="flex items-center gap-1.5 text-slate-500 text-xs font-bold">
							<ShieldCheck size={14} className="text-indigo-600" />
							<span>Storefront Site ID</span>
						</div>
						<div className="font-mono font-black text-sm text-slate-900 truncate">{siteId}</div>
					</div>
					<button
						type="button"
						onClick={() => handleCopy(siteId, 'siteId')}
						className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer"
						title="Copy Site ID">
						{copiedKey === 'siteId' ? <CheckCircle2 size={15} className="text-emerald-600" /> : <Copy size={15} />}
					</button>
				</div>

				<div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs flex items-center justify-between gap-3">
					<div className="space-y-1 min-w-0">
						<div className="flex items-center gap-1.5 text-slate-500 text-xs font-bold">
							<Key size={14} className="text-amber-600" />
							<span>Publishable API Ingestion Key</span>
						</div>
						<div className="font-mono font-black text-sm text-slate-900 truncate">{apiKey}</div>
					</div>
					<button
						type="button"
						onClick={() => handleCopy(apiKey, 'apiKey')}
						className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer"
						title="Copy API Key">
						{copiedKey === 'apiKey' ? <CheckCircle2 size={15} className="text-emerald-600" /> : <Copy size={15} />}
					</button>
				</div>
			</div>

			{/* Integration Tabs */}
			<div className="flex items-center gap-1.5 pb-2 border-b border-slate-200 overflow-x-auto">
				<button
					type="button"
					onClick={() => setActiveTab('nextjs')}
					className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
						activeTab === 'nextjs'
							? 'bg-indigo-600 text-white shadow-xs'
							: 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200'
					}`}>
					<Zap size={13} />
					<span>Next.js App Router</span>
				</button>
				<button
					type="button"
					onClick={() => setActiveTab('html')}
					className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
						activeTab === 'html'
							? 'bg-indigo-600 text-white shadow-xs'
							: 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200'
					}`}>
					<Code size={13} />
					<span>1-Line HTML Tag</span>
				</button>
				<button
					type="button"
					onClick={() => setActiveTab('rest_api')}
					className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
						activeTab === 'rest_api'
							? 'bg-indigo-600 text-white shadow-xs'
							: 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200'
					}`}>
					<Terminal size={13} />
					<span>REST Ingestion API (cURL & Fetch)</span>
				</button>
				<button
					type="button"
					onClick={() => setActiveTab('react_hook')}
					className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
						activeTab === 'react_hook'
							? 'bg-indigo-600 text-white shadow-xs'
							: 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200'
					}`}>
					<Layers size={13} />
					<span>React Hook SDK</span>
				</button>
			</div>

			{/* Tab Content Panes */}
			{activeTab === 'nextjs' && (
				<Card
					title="Next.js App Router Integration Guide"
					subtitle={`Add telemetry to ${domain} with zero layout shift or blocking time`}
					action={
						<Button size="sm" onClick={() => handleCopy(nextJsCode, 'nextjs')}>
							{copiedKey === 'nextjs' ? <CheckCircle2 size={13} /> : <Copy size={13} />}
							<span>{copiedKey === 'nextjs' ? 'Copied' : 'Copy Next.js Snippet'}</span>
						</Button>
					}>
					<div className="space-y-4 pt-1 text-xs">
						<p className="text-slate-600 leading-relaxed">
							Open your store's{' '}
							<code className="px-1.5 py-0.5 rounded bg-slate-100 font-mono text-slate-800">src/app/layout.tsx</code> and
							add the <code className="px-1.5 py-0.5 rounded bg-slate-100 font-mono text-slate-800">&lt;Script /&gt;</code>{' '}
							component as shown:
						</p>
						<pre className="p-4 rounded-2xl bg-slate-900 text-indigo-300 font-mono text-xs overflow-x-auto leading-relaxed border border-slate-800">
							{nextJsCode}
						</pre>
					</div>
				</Card>
			)}

			{activeTab === 'html' && (
				<Card
					title="1-Line HTML Script Tag"
					subtitle="Compatible with Shopify, WordPress, Custom HTML, and Webflow"
					action={
						<Button size="sm" onClick={() => handleCopy(scriptTagCode, 'html')}>
							{copiedKey === 'html' ? <CheckCircle2 size={13} /> : <Copy size={13} />}
							<span>{copiedKey === 'html' ? 'Copied' : 'Copy Tag'}</span>
						</Button>
					}>
					<div className="space-y-4 pt-1 text-xs">
						<p className="text-slate-600 leading-relaxed">
							Paste this tag inside the{' '}
							<code className="px-1.5 py-0.5 rounded bg-slate-100 font-mono text-slate-800">&lt;head&gt;</code> section of
							your website.
						</p>
						<pre className="p-4 rounded-2xl bg-slate-900 text-indigo-300 font-mono text-xs overflow-x-auto leading-relaxed border border-slate-800">
							{scriptTagCode}
						</pre>
					</div>
				</Card>
			)}

			{activeTab === 'rest_api' && (
				<div className="space-y-6">
					<Card
						title="HTTP Ingestion API: cURL Example"
						subtitle="Send purchase, custom event, or offline conversion payloads from your backend server"
						action={
							<Button size="sm" onClick={() => handleCopy(restCurlCode, 'curl')}>
								{copiedKey === 'curl' ? <CheckCircle2 size={13} /> : <Copy size={13} />}
								<span>{copiedKey === 'curl' ? 'Copied' : 'Copy cURL'}</span>
							</Button>
						}>
						<pre className="p-4 rounded-2xl bg-slate-900 text-indigo-300 font-mono text-xs overflow-x-auto leading-relaxed border border-slate-800">
							{restCurlCode}
						</pre>
					</Card>

					<Card
						title="JavaScript / Node.js Fetch Function"
						subtitle="Server-side event dispatch handler"
						action={
							<Button size="sm" onClick={() => handleCopy(restFetchCode, 'fetch')}>
								{copiedKey === 'fetch' ? <CheckCircle2 size={13} /> : <Copy size={13} />}
								<span>{copiedKey === 'fetch' ? 'Copied' : 'Copy Function'}</span>
							</Button>
						}>
						<pre className="p-4 rounded-2xl bg-slate-900 text-indigo-300 font-mono text-xs overflow-x-auto leading-relaxed border border-slate-800">
							{restFetchCode}
						</pre>
					</Card>
				</div>
			)}

			{activeTab === 'react_hook' && (
				<Card
					title="Custom React / Vue Telemetry Hook"
					subtitle="Track client-side events, filter changes, and dynamic modal opens"
					action={
						<Button size="sm" onClick={() => handleCopy(reactHookCode, 'react')}>
							{copiedKey === 'react' ? <CheckCircle2 size={13} /> : <Copy size={13} />}
							<span>{copiedKey === 'react' ? 'Copied' : 'Copy Hook'}</span>
						</Button>
					}>
					<pre className="p-4 rounded-2xl bg-slate-900 text-indigo-300 font-mono text-xs overflow-x-auto leading-relaxed border border-slate-800">
						{reactHookCode}
					</pre>
				</Card>
			)}
		</div>
	);
}
