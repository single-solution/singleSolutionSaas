import React, { useState } from 'react';
import {
	Code,
	Copy,
	CheckCircle2,
	Terminal,
	Layers,
	ExternalLink,
	ShieldCheck,
	Key,
	Zap,
	Building2,
	Globe,
	Database,
} from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Badge } from '@saas/ui/badges/Badge';
import { useStorefront } from '../context/StorefrontContext';

export default function DirectApiConnect() {
	const { portalUrl, session, activeStore, stores } = useStorefront();
	const [activeTab, setActiveTab] = useState('ingest_api');
	const [copiedKey, setCopiedKey] = useState(null);

	const portalLink = portalUrl ? `${portalUrl}/${session?.role === 'merchant' ? 'merchant/home' : 'admin/tenants'}` : '#';

	if (!activeStore || stores.length === 0) {
		return (
			<div className="space-y-6 antialiased text-slate-900 max-w-4xl">
				<PageHeader
					title="Direct API & Headless Integration Hub"
					subtitle="REST endpoints, Ingestion pipelines, and Query APIs for custom client designs"
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
								href={portalLink}
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
	const analyticsUrl = typeof window !== 'undefined' ? window.location.origin : process.env.NEXT_PUBLIC_APP_URL || '';

	const handleCopy = (text, key) => {
		navigator.clipboard.writeText(text);
		setCopiedKey(key);
		setTimeout(() => setCopiedKey(null), 2000);
	};

	const scriptTagCode = `<!-- Plug & Play 1-Line Telemetry Tag -->
<script
  defer
  src="${analyticsUrl}/telemetry.js"
  data-site-id="${siteId}"
  data-api-key="${apiKey}"
></script>`;

	const ingestApiCurl = `# Send Live Page View or Custom E-Commerce Event
curl -X POST ${analyticsUrl}/api/events \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "siteId": "${siteId}",
    "eventType": "purchase",
    "eventName": "order_completed",
    "path": "/checkout/success",
    "title": "Order Confirmation",
    "eventData": {
      "orderId": "ORD-9821",
      "total": 450.00,
      "currency": "PKR",
      "items": 2
    }
  }'`;

	const ingestApiFetch = `// Direct Ingestion API in Custom Frontend / Backend
async function sendStoreEvent(eventType, eventName, payload = {}) {
  const response = await fetch('${analyticsUrl}/api/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ${apiKey}',
    },
    body: JSON.stringify({
      siteId: '${siteId}',
      eventType: eventType, // 'page_view' | 'add_to_cart' | 'purchase' | 'search'
      eventName: eventName,
      path: window.location.pathname,
      title: document.title,
      eventData: payload,
    }),
  });
  return response.json();
}`;

	const queryApiCurl = `# Query Real-Time Stats & KPIs for Custom Client UI / Dashboard
curl -X GET "${analyticsUrl}/api/events/summary?siteId=${siteId}" \\
  -H "Authorization: Bearer ${apiKey}"`;

	const queryApiFetch = `// Fetch Live Analytics Summary JSON for Custom Dashboard / Admin
async function getStoreAnalyticsSummary() {
  const res = await fetch('${analyticsUrl}/api/events/summary?siteId=${siteId}', {
    headers: {
      'Authorization': 'Bearer ${apiKey}',
      'X-Site-ID': '${siteId}',
    },
  });
  const data = await res.json();
  console.log('Live Visitors:', data.realtime.activeLiveVisitors);
  console.log('Total Revenue:', data.kpis.totalRevenue);
  console.log('Top Searches:', data.topSearches);
  return data;
}`;

	const nodeSdkCode = `// SingleSolution Client SDK for Node.js / Custom Server
const axios = require('axios');

class SingleSolutionAnalytics {
  constructor({ siteId, apiKey, baseUrl = '${analyticsUrl}' }) {
    this.siteId = siteId;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async trackOrder({ orderId, total, items, currency = 'USD' }) {
    return axios.post(\`\${this.baseUrl}/api/events\`, {
      siteId: this.siteId,
      eventType: 'purchase',
      eventName: 'order_completed',
      eventData: { orderId, total, items, currency },
    }, {
      headers: { Authorization: \`Bearer \${this.apiKey}\` }
    });
  }

  async getSummary() {
    const { data } = await axios.get(\`\${this.baseUrl}/api/events/summary?siteId=\${this.siteId}\`, {
      headers: { Authorization: \`Bearer \${this.apiKey}\` }
    });
    return data;
  }
}`;

	return (
		<div className="space-y-6 antialiased text-slate-900">
			<PageHeader
				title="Direct API & Headless Integration Hub"
				subtitle={`REST Ingestion & Headless Query APIs for custom merchant storefronts · ${activeStore.name} (${domain})`}
				actions={
					<div className="flex items-center gap-2">
						<Badge type="success">Active Site ID: {siteId}</Badge>
					</div>
				}
			/>

			{/* API Credentials Card */}
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
				<Card>
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<Key size={16} className="text-indigo-600" />
								<span className="font-bold text-xs text-slate-900">Site ID (Store Identifier)</span>
							</div>
							<button
								onClick={() => handleCopy(siteId, 'siteId')}
								className="text-xs text-indigo-600 font-bold hover:underline flex items-center gap-1 cursor-pointer">
								{copiedKey === 'siteId' ? <CheckCircle2 size={12} className="text-emerald-600" /> : <Copy size={12} />}
								<span>{copiedKey === 'siteId' ? 'Copied' : 'Copy'}</span>
							</button>
						</div>
						<div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 font-mono text-xs text-slate-800 break-all select-all font-semibold">
							{siteId}
						</div>
						<p className="text-[11px] text-slate-400">Pass this in request bodies (`siteId`) or headers (`X-Site-ID`).</p>
					</div>
				</Card>

				<Card>
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<ShieldCheck size={16} className="text-emerald-600" />
								<span className="font-bold text-xs text-slate-900">API Ingestion Key</span>
							</div>
							<button
								onClick={() => handleCopy(apiKey, 'apiKey')}
								className="text-xs text-indigo-600 font-bold hover:underline flex items-center gap-1 cursor-pointer">
								{copiedKey === 'apiKey' ? <CheckCircle2 size={12} className="text-emerald-600" /> : <Copy size={12} />}
								<span>{copiedKey === 'apiKey' ? 'Copied' : 'Copy'}</span>
							</button>
						</div>
						<div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 font-mono text-xs text-slate-800 break-all select-all font-semibold">
							{apiKey}
						</div>
						<p className="text-[11px] text-slate-400">
							Use as Bearer token in the `Authorization` header for server requests.
						</p>
					</div>
				</Card>
			</div>

			{/* API Tabs */}
			<div className="space-y-4">
				<div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-3">
					{[
						{ id: 'ingest_api', label: '1. Ingestion REST API (Custom Front/Back)', icon: Zap },
						{ id: 'query_api', label: '2. Query REST API (Headless Data JSON)', icon: Database },
						{ id: 'sdk', label: '3. Node.js / Server SDK', icon: Code },
						{ id: 'script', label: '4. Plug & Play Script Tag', icon: Globe },
					].map((tab) => {
						const Icon = tab.icon;
						const isActive = activeTab === tab.id;
						return (
							<button
								key={tab.id}
								onClick={() => setActiveTab(tab.id)}
								className={`px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer ${
									isActive
										? 'bg-indigo-600 text-white shadow-xs'
										: 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
								}`}>
								<Icon size={14} />
								<span>{tab.label}</span>
							</button>
						);
					})}
				</div>

				{/* Ingestion API Tab */}
				{activeTab === 'ingest_api' && (
					<Card>
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<div>
									<h3 className="font-bold text-sm text-slate-900">Direct Event Ingestion API (`POST /api/events`)</h3>
									<p className="text-xs text-slate-500">
										If your client has their own custom frontend/design, dispatch events directly from their code.
									</p>
								</div>
								<button
									onClick={() => handleCopy(ingestApiFetch, 'ingestFetch')}
									className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer">
									{copiedKey === 'ingestFetch' ? (
										<CheckCircle2 size={13} className="text-emerald-600" />
									) : (
										<Copy size={13} />
									)}
									<span>{copiedKey === 'ingestFetch' ? 'Copied' : 'Copy JS Code'}</span>
								</button>
							</div>

							<div className="space-y-3">
								<div className="p-3.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs overflow-x-auto">
									<pre>{ingestApiCurl}</pre>
								</div>

								<div className="p-3.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs overflow-x-auto">
									<pre>{ingestApiFetch}</pre>
								</div>
							</div>
						</div>
					</Card>
				)}

				{/* Query API Tab */}
				{activeTab === 'query_api' && (
					<Card>
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<div>
									<h3 className="font-bold text-sm text-slate-900">
										Headless Analytics Query API (`GET /api/events/summary`)
									</h3>
									<p className="text-xs text-slate-500">
										Fetch aggregated real-time metrics, revenue KPIs, and top searches in pure JSON to render in custom
										client dashboards.
									</p>
								</div>
								<button
									onClick={() => handleCopy(queryApiFetch, 'queryFetch')}
									className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer">
									{copiedKey === 'queryFetch' ? (
										<CheckCircle2 size={13} className="text-emerald-600" />
									) : (
										<Copy size={13} />
									)}
									<span>{copiedKey === 'queryFetch' ? 'Copied' : 'Copy Query Code'}</span>
								</button>
							</div>

							<div className="space-y-3">
								<div className="p-3.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs overflow-x-auto">
									<pre>{queryApiCurl}</pre>
								</div>

								<div className="p-3.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs overflow-x-auto">
									<pre>{queryApiFetch}</pre>
								</div>
							</div>
						</div>
					</Card>
				)}

				{/* Server SDK Tab */}
				{activeTab === 'sdk' && (
					<Card>
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<div>
									<h3 className="font-bold text-sm text-slate-900">
										Server-Side Integration Class (Node.js / Express / Next.js)
									</h3>
									<p className="text-xs text-slate-500">
										Integrate tracking directly into order checkout webhooks and backend services.
									</p>
								</div>
								<button
									onClick={() => handleCopy(nodeSdkCode, 'nodeSdk')}
									className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer">
									{copiedKey === 'nodeSdk' ? (
										<CheckCircle2 size={13} className="text-emerald-600" />
									) : (
										<Copy size={13} />
									)}
									<span>{copiedKey === 'nodeSdk' ? 'Copied' : 'Copy SDK'}</span>
								</button>
							</div>

							<div className="p-3.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs overflow-x-auto">
								<pre>{nodeSdkCode}</pre>
							</div>
						</div>
					</Card>
				)}

				{/* Script Tag Tab */}
				{activeTab === 'script' && (
					<Card>
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<div>
									<h3 className="font-bold text-sm text-slate-900">Plug & Play Telemetry Script</h3>
									<p className="text-xs text-slate-500">
										Paste in &lt;head&gt; for zero-code automatic pageview & Web Vitals tracking.
									</p>
								</div>
								<button
									onClick={() => handleCopy(scriptTagCode, 'scriptTag')}
									className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5 cursor-pointer">
									{copiedKey === 'scriptTag' ? (
										<CheckCircle2 size={13} className="text-emerald-600" />
									) : (
										<Copy size={13} />
									)}
									<span>{copiedKey === 'scriptTag' ? 'Copied' : 'Copy Script Tag'}</span>
								</button>
							</div>

							<div className="p-3.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs overflow-x-auto">
								<pre>{scriptTagCode}</pre>
							</div>
						</div>
					</Card>
				)}
			</div>
		</div>
	);
}
