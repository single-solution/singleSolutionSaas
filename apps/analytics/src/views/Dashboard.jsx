import React, { useState } from 'react';
import {
	Activity,
	ArrowDownRight,
	ExternalLink,
	Eye,
	Search,
	ShoppingBag,
	Sparkles,
	Zap,
	AlertTriangle,
	ArrowRight,
	Code,
	CheckCircle2,
	Copy,
	Building2,
} from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { StatCard } from '@saas/ui/cards/StatCard';
import { Card } from '@saas/ui/cards/Card';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { Modal } from '@saas/ui/modals/Modal';
import { useStorefront } from '../context/StorefrontContext';
import Link from 'next/link';

const PERIOD_OPTIONS = [
	{ label: 'Today (24h)', value: '24h' },
	{ label: 'Last 7 Days', value: '7d' },
	{ label: 'Last 30 Days', value: '30d' },
	{ label: 'Last 90 Days', value: '90d' },
];

export default function Dashboard() {
	const { portalUrl, session, activeStore, stores, analyticsData, storeEvents, recordStoreEvent } = useStorefront();
	const [period, setPeriod] = useState('7d');
	const [selectedSession, setSelectedSession] = useState(null);
	const [copied, setCopied] = useState(false);

	// Case 1: No merchants registered anywhere
	const portalLink = portalUrl ? `${portalUrl}/${session?.role === 'merchant' ? 'merchant/home' : 'admin/tenants'}` : '#';

	if (!activeStore || stores.length === 0) {
		return (
			<div className="space-y-6 antialiased text-slate-900">
				<PageHeader
					title="Analytics Pro Intelligence"
					subtitle="Storefront telemetry, real-device speed insights, and e-commerce conversion forensics"
				/>

				<Card>
					<div className="py-16 px-4 text-center space-y-4 max-w-md mx-auto">
						<div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
							<Building2 size={28} />
						</div>
						<div className="space-y-1.5">
							<h3 className="font-extrabold text-base text-slate-900">No Merchant Storefronts Registered</h3>
							<p className="text-xs text-slate-500 leading-relaxed">
								There are currently no merchant accounts or websites registered in the platform database.
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
	const domain = activeStore.domain;
	const hasEvents = analyticsData.totalPageViews > 0;
	const analyticsUrl = typeof window !== 'undefined' ? window.location.origin : process.env.NEXT_PUBLIC_APP_URL || '';

	const embedScriptCode = `<!-- SingleSolution Analytics Pro Telemetry -->
<script
  defer
  src="${analyticsUrl}/telemetry.js"
  data-site-id="${siteId}"
></script>`;

	const handleCopyScript = () => {
		navigator.clipboard.writeText(embedScriptCode);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const handleFireQuickEvent = () => {
		recordStoreEvent({
			eventType: 'page_view',
			path: '/products/flagship-device',
			title: 'Store Product Page',
			referrer: 'google.com',
			city: 'Karachi, Sindh',
			device: 'Mobile Phone',
			browser: 'Mobile Safari',
			os: 'iOS 18.0',
		});
	};

	const sessionEvents = selectedSession ? storeEvents.filter((e) => e.sessionId === selectedSession.sessionId) : [];

	return (
		<div className="space-y-6 antialiased text-slate-900">
			{/* Header & Controls */}
			<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
				<div>
					<div className="flex items-center gap-2">
						<span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100">
							Storefront Telemetry
						</span>
						<span className="text-xs text-slate-500 font-bold">{activeStore.name}</span>
						<span className="text-xs text-slate-400 font-mono">({domain})</span>
					</div>
					<h1 className="text-2xl font-black text-slate-900 tracking-tight mt-1">Analytics & Speed Intelligence</h1>
					<p className="text-xs text-slate-500 mt-0.5">
						Real-time shopper sessions, conversion funnel, search intent, and real-device Core Web Vitals.
					</p>
				</div>

				<div className="flex flex-wrap items-center gap-3">
					{/* Live Online Badge */}
					<div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-xs font-bold text-emerald-800 shadow-2xs">
						<span className="relative flex h-2 w-2">
							<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
							<span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
						</span>
						<span>{analyticsData.liveVisitors} Online Now</span>
					</div>

					{/* Period Selector Tabs */}
					<div className="flex rounded-xl border border-slate-200 bg-slate-100/80 p-1 shadow-2xs">
						{PERIOD_OPTIONS.map((opt) => (
							<button
								key={opt.value}
								type="button"
								onClick={() => setPeriod(opt.value)}
								className={`px-3 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
									period === opt.value ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
								}`}>
								{opt.label}
							</button>
						))}
					</div>
				</div>
			</div>

			{/* Clean Zero-State Setup Banner (Awaiting Store Events) */}
			{!hasEvents && (
				<div className="p-6 rounded-3xl bg-white border border-slate-200 shadow-xs space-y-4">
					<div className="flex items-center gap-3">
						<div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
							<Activity size={20} />
						</div>
						<div>
							<h3 className="font-extrabold text-slate-900 text-sm">Awaiting Ingested Telemetry for {activeStore.name}</h3>
							<p className="text-xs text-slate-500">
								No events received yet for <strong className="text-slate-700">{domain}</strong>. Add the script tag to
								your store or trigger a test event.
							</p>
						</div>
					</div>

					<div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 rounded-2xl bg-slate-900 text-indigo-300 font-mono text-xs border border-slate-800">
						<span className="truncate">{embedScriptCode.split('\n')[1]}</span>
						<div className="flex items-center gap-2 shrink-0">
							<button
								type="button"
								onClick={handleCopyScript}
								className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-sans font-bold text-xs flex items-center gap-1.5 transition-all cursor-pointer">
								{copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
								<span>{copied ? 'Copied' : 'Copy Script Tag'}</span>
							</button>
							<button
								type="button"
								onClick={handleFireQuickEvent}
								className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white font-sans font-semibold text-xs flex items-center gap-1.5 transition-all cursor-pointer">
								<Sparkles size={13} />
								<span>Fire Test Event</span>
							</button>
							<Link
								href="/connect"
								className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white font-sans font-semibold text-xs flex items-center gap-1.5 transition-all cursor-pointer">
								<Code size={13} />
								<span>API & Next.js Docs</span>
							</Link>
						</div>
					</div>
				</div>
			)}

			{/* KPI Stat Cards */}
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<StatCard
					label="Total Pageviews"
					value={analyticsData.totalPageViews.toLocaleString()}
					change={hasEvents ? 'Active stream' : '0 events received'}
				/>
				<StatCard
					label="Unique Shoppers"
					value={analyticsData.uniqueVisitors.toLocaleString()}
					change={hasEvents ? 'Distinct visitors' : '0 visitors'}
				/>
				<StatCard label="Average Session Duration" value={`${analyticsData.avgDurationSeconds}s`} change="Live duration" />
				<StatCard label="Storefront Bounce Rate" value={`${analyticsData.bounceRate}%`} change="Exit rate" />
			</div>

			{/* Traffic Trends Chart & Speed Vitals Banner */}
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				{/* Traffic Volume Trendline */}
				<div className="lg:col-span-2 space-y-4">
					<Card
						title="Traffic & Session Velocity"
						subtitle={`Daily distribution for ${domain}`}
						action={
							<div className="flex items-center gap-3 text-xs">
								<span className="flex items-center gap-1.5 text-slate-600 font-medium">
									<span className="w-2.5 h-2.5 rounded-full bg-indigo-600 inline-block" /> Pageviews
								</span>
								<span className="flex items-center gap-1.5 text-slate-600 font-medium">
									<span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" /> Sessions
								</span>
							</div>
						}>
						<div className="pt-4 pb-2">
							<div className="grid grid-cols-7 gap-3 items-end h-44 px-2">
								{analyticsData.timeline.map((item, idx) => {
									const maxViews = Math.max(analyticsData.totalPageViews, 10);
									const heightPercent = item.views > 0 ? Math.min(100, Math.round((item.views / maxViews) * 100)) : 4;
									const sessionHeightPercent =
										item.sessions > 0 ? Math.min(100, Math.round((item.sessions / maxViews) * 100)) : 4;

									return (
										<div key={idx} className="flex flex-col items-center gap-2 h-full justify-end group">
											<div className="text-[10px] font-bold text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity font-mono">
												{item.views}
											</div>
											<div className="w-full max-w-[36px] flex items-end justify-center gap-1 h-32 bg-slate-50 rounded-xl p-1 border border-slate-100">
												<div
													style={{ height: `${heightPercent}%` }}
													className="w-1/2 bg-indigo-600 rounded-md transition-all duration-300 group-hover:bg-indigo-700"
												/>
												<div
													style={{ height: `${sessionHeightPercent}%` }}
													className="w-1/2 bg-emerald-400 rounded-md transition-all duration-300 group-hover:bg-emerald-500"
												/>
											</div>
											<span className="text-[11px] font-bold text-slate-600">{item.label}</span>
										</div>
									);
								})}
							</div>
						</div>
					</Card>
				</div>

				{/* Core Web Vitals Speed Score */}
				<div className="space-y-4">
					<Card
						title="Real-Device Speed Score"
						subtitle="Core Web Vitals measured on buyer mobile devices"
						action={
							<Link
								href="/speed"
								className="text-xs text-indigo-600 hover:text-indigo-800 font-bold flex items-center gap-1">
								Speed Report <ArrowRight size={12} />
							</Link>
						}>
						<div className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-4">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-black text-xl border border-emerald-200 shadow-2xs">
										{analyticsData.speedScore}
									</div>
									<div>
										<h4 className="font-bold text-slate-900 text-sm">Store Health Score</h4>
										<p className="text-[11px] text-slate-500">{analyticsData.uniqueVisitors} devices monitored</p>
									</div>
								</div>
								<Badge type="success">HEALTHY</Badge>
							</div>

							<div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-200/60">
								{Object.entries(analyticsData.vitals)
									.slice(0, 3)
									.map(([key, item]) => (
										<Link
											key={key}
											href="/speed"
											className="p-2.5 rounded-xl bg-white border border-slate-200 text-left hover:border-indigo-300 transition-all block">
											<div className="text-[10px] font-bold text-slate-400">{item.metric}</div>
											<div className="text-xs font-black text-slate-900 mt-0.5">
												{item.p75}
												{item.unit}
											</div>
											<div className="text-[10px] font-semibold text-emerald-600 mt-0.5">{item.goodPercent}% Good</div>
										</Link>
									))}
							</div>
						</div>
					</Card>
				</div>
			</div>

			{/* E-Commerce Conversion Funnel Forensics */}
			<Card
				title="E-Commerce Conversion Funnel"
				subtitle={`Step-by-step buyer drop-off forensics (${analyticsData.funnel.overallConversionRate}% overall conversion rate)`}
				action={
					<Link href="/funnel" className="text-xs text-indigo-600 hover:text-indigo-800 font-bold flex items-center gap-1">
						Full Funnel Forensics <ArrowRight size={12} />
					</Link>
				}>
				<div className="space-y-4 pt-2">
					<div className="grid grid-cols-1 md:grid-cols-5 gap-3">
						{analyticsData.funnel.stages.map((stage, idx) => (
							<div key={idx} className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-2 relative">
								<div className="flex justify-between items-center text-xs">
									<span className="text-[11px] font-bold text-slate-500">Step 0{idx + 1}</span>
									<span className="font-mono font-bold text-indigo-700">{stage.conversionRate}%</span>
								</div>
								<div className="text-xs font-bold text-slate-900">{stage.name}</div>
								<div className="text-lg font-black text-slate-900">{stage.count.toLocaleString()}</div>
								{stage.dropoffRate > 0 && (
									<div className="text-[10px] text-rose-600 font-semibold flex items-center gap-1">
										<ArrowDownRight size={12} /> {stage.dropoffRate}% drop-off
									</div>
								)}
							</div>
						))}
					</div>
				</div>
			</Card>

			{/* Top Store Pages & Merchandising Performance */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{/* Top Store Pages */}
				<Card title="Top Storefront Pages" subtitle="Highest traffic destination URLs and engagement depth">
					{analyticsData.topPages.length === 0 ? (
						<div className="py-8 text-center text-xs text-slate-400">
							No pageviews recorded yet for {domain}. Events will appear here once visitors browse your store.
						</div>
					) : (
						<div className="divide-y divide-slate-100 text-xs">
							{analyticsData.topPages.slice(0, 5).map((page, idx) => (
								<div key={idx} className="py-3 flex items-center justify-between gap-3">
									<div className="min-w-0">
										<strong className="text-slate-900 block truncate">{page.title}</strong>
										<span className="font-mono text-[11px] text-slate-400 truncate block">{page.path}</span>
									</div>
									<div className="flex items-center gap-4 shrink-0 text-right">
										<div>
											<span className="font-bold text-slate-900">{page.views.toLocaleString()}</span>
											<span className="text-[10px] text-slate-400 block">views</span>
										</div>
									</div>
								</div>
							))}
						</div>
					)}
				</Card>

				{/* Product Merchandising Velocity */}
				<Card title="Product Merchandising Performance" subtitle="Views to order conversion rate per product">
					{analyticsData.productMerch.length === 0 ? (
						<div className="py-8 text-center text-xs text-slate-400">No product visits recorded yet for {domain}.</div>
					) : (
						<div className="divide-y divide-slate-100 text-xs">
							{analyticsData.productMerch.map((prod, idx) => (
								<div key={idx} className="py-3 flex items-center justify-between gap-3">
									<div className="min-w-0">
										<strong className="text-slate-900 truncate block">{prod.title}</strong>
										<span className="text-[11px] text-slate-500">
											{prod.views.toLocaleString()} views • {prod.orders} orders
										</span>
									</div>
									<div className="text-right shrink-0">
										<span className="font-black text-emerald-700">{prod.conversionRate}%</span>
										<span className="text-[10px] text-slate-400 block">${prod.revenue.toLocaleString()} GMV</span>
									</div>
								</div>
							))}
						</div>
					)}
				</Card>
			</div>

			{/* Real-Time Event Feed with Session Inspector */}
			<Card
				title="Live Ingested Telemetry Feed"
				subtitle={`Chronological stream of events for ${activeStore.name}`}
				action={
					<Link href="/events" className="text-xs text-indigo-600 hover:text-indigo-800 font-bold flex items-center gap-1">
						Live Stream View <ArrowRight size={12} />
					</Link>
				}>
				{storeEvents.length === 0 ? (
					<div className="py-10 text-center space-y-2 text-xs text-slate-400">
						<Activity size={24} className="mx-auto text-slate-300" />
						<p className="font-bold text-slate-700">No events in stream</p>
						<p>Use the Sandbox or embed tag to stream real telemetry data.</p>
					</div>
				) : (
					<div className="divide-y divide-slate-100 text-xs">
						{storeEvents.slice(0, 6).map((ev) => (
							<div
								key={ev.id}
								onClick={() => setSelectedSession(ev)}
								className="py-3 flex items-center justify-between gap-3 hover:bg-slate-50 px-2 rounded-xl transition-colors cursor-pointer group">
								<div className="flex items-center gap-3 min-w-0">
									<div className="p-2 rounded-xl bg-slate-100 text-slate-700 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-colors">
										{ev.eventType === 'page_view' ? (
											<Eye size={15} />
										) : ev.eventType === 'search' ? (
											<Search size={15} />
										) : ev.eventType === 'web_vital' ? (
											<Zap size={15} />
										) : ev.eventType === 'error_404' ? (
											<AlertTriangle size={15} className="text-amber-500" />
										) : (
											<ShoppingBag size={15} className="text-emerald-600" />
										)}
									</div>
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<strong className="text-slate-900 truncate">{ev.title}</strong>
											<span className="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-slate-100 text-slate-600 border border-slate-200">
												{ev.eventType}
											</span>
										</div>
										<div className="text-[11px] text-slate-400 font-mono truncate">
											{ev.city} • {ev.device} ({ev.browser}) • {ev.sessionId}
										</div>
									</div>
								</div>

								<div className="text-right shrink-0">
									<span className="font-mono text-xs text-slate-600">{ev.timestamp}</span>
									<span className="text-[11px] text-indigo-600 block font-semibold group-hover:underline">
										Inspect Journey →
									</span>
								</div>
							</div>
						))}
					</div>
				)}
			</Card>

			{/* Session Journey Inspector Modal */}
			<Modal
				title={`Shopper Session Journey: ${selectedSession?.sessionId || ''}`}
				isOpen={!!selectedSession}
				onClose={() => setSelectedSession(null)}
				footer={<Button onClick={() => setSelectedSession(null)}>Close Inspector</Button>}>
				{selectedSession && (
					<div className="space-y-4 text-xs">
						<div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2">
							<div className="grid grid-cols-2 gap-2">
								<div>
									<span className="text-slate-500 block text-[11px]">Visitor ID:</span>
									<span className="font-mono font-bold text-slate-900">{selectedSession.visitorId}</span>
								</div>
								<div>
									<span className="text-slate-500 block text-[11px]">Location:</span>
									<span className="font-bold text-slate-900">{selectedSession.city}</span>
								</div>
								<div>
									<span className="text-slate-500 block text-[11px]">Device & OS:</span>
									<span className="font-semibold text-slate-800">
										{selectedSession.device} ({selectedSession.os})
									</span>
								</div>
								<div>
									<span className="text-slate-500 block text-[11px]">Browser:</span>
									<span className="font-semibold text-slate-800">{selectedSession.browser}</span>
								</div>
							</div>
						</div>

						<div className="space-y-2">
							<div className="font-bold text-slate-900 text-xs">Session Clickstream:</div>
							<div className="relative pl-6 border-l-2 border-indigo-200 space-y-4 py-2">
								{sessionEvents.length > 0 ? (
									sessionEvents.map((ev, i) => (
										<div key={i} className="relative">
											<span className="absolute -left-[31px] top-1 w-3.5 h-3.5 rounded-full bg-indigo-600 border-2 border-white shadow-2xs" />
											<div className="font-bold text-slate-900 text-xs">{ev.title}</div>
											<div className="text-[11px] text-slate-500 font-mono">
												{ev.path} • {ev.eventType} • {ev.timestamp}
											</div>
										</div>
									))
								) : (
									<div className="relative">
										<span className="absolute -left-[31px] top-1 w-3.5 h-3.5 rounded-full bg-indigo-600 border-2 border-white" />
										<div className="font-bold text-slate-900 text-xs">{selectedSession.title}</div>
										<div className="text-[11px] text-slate-500 font-mono">
											{selectedSession.path} • {selectedSession.eventType} • {selectedSession.timestamp}
										</div>
									</div>
								)}
							</div>
						</div>
					</div>
				)}
			</Modal>
		</div>
	);
}
