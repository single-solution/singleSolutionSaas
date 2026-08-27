import React, { useState } from 'react';
import {
	Activity,
	Eye,
	Search,
	Zap,
	ShoppingBag,
	AlertTriangle,
	Filter,
	Sparkles,
	Laptop,
	Smartphone,
	Tablet,
	ExternalLink,
	RefreshCw,
} from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { Modal } from '@saas/ui/modals/Modal';
import { useStorefront } from '../context/StorefrontContext';
import { Link } from 'react-router-dom';

export default function EventsList() {
	const { activeStore, storeEvents, recordStoreEvent } = useStorefront();
	const [activeFilter, setActiveFilter] = useState('ALL');
	const [searchQuery, setSearchQuery] = useState('');
	const [selectedSession, setSelectedSession] = useState(null);

	const eventTypes = ['ALL', 'page_view', 'custom', 'search', 'web_vital', 'error_404'];

	const filteredEvents = storeEvents.filter((ev) => {
		const matchesType = activeFilter === 'ALL' || ev.eventType === activeFilter;
		const matchesSearch =
			ev.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
			ev.path.toLowerCase().includes(searchQuery.toLowerCase()) ||
			ev.sessionId.toLowerCase().includes(searchQuery.toLowerCase()) ||
			ev.city.toLowerCase().includes(searchQuery.toLowerCase());
		return matchesType && matchesSearch;
	});

	const sessionEvents = selectedSession ? storeEvents.filter((e) => e.sessionId === selectedSession.sessionId) : [];

	const handleSimulateLiveEvent = () => {
		recordStoreEvent({
			eventType: 'custom',
			eventName: 'product_viewed',
			path: '/products/iphone-16-pro-max',
			title: 'iPhone 16 Pro Max (Desert Titanium)',
			referrer: 'instagram.com/reel',
			city: 'Lahore, Punjab',
			device: 'Mobile Phone',
			browser: 'Mobile Safari',
			os: 'iOS 18.1',
			durationMs: 14200,
			eventData: { sku: 'iphone-16-pm-256', color: 'Desert Titanium' },
		});
	};

	return (
		<div className="space-y-6 antialiased text-slate-900">
			<PageHeader
				title="Real-Time Shopper Stream"
				subtitle={`Chronological feed of telemetry events for ${activeStore?.name} (${activeStore?.domain})`}
				actions={
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={handleSimulateLiveEvent}>
							<Sparkles size={13} /> Fire Live Event
						</Button>
						<Link to="/sandbox">
							<Button size="sm" variant="secondary">
								Event Sandbox
							</Button>
						</Link>
					</div>
				}
			/>

			{/* Filter and Search Bar */}
			<div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-white border border-slate-200 shadow-xs">
				<div className="relative flex-1 min-w-[280px]">
					<Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={15} />
					<input
						type="text"
						placeholder="Filter by page title, URL path, session ID, or city..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="w-full pl-10 pr-4 py-2 text-xs rounded-xl bg-slate-50 border border-slate-200 focus:outline-none focus:border-indigo-500 text-slate-900"
					/>
				</div>

				<div className="flex items-center gap-1.5 flex-wrap">
					{eventTypes.map((type) => (
						<button
							type="button"
							key={type}
							onClick={() => setActiveFilter(type)}
							className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
								activeFilter === type
									? 'bg-indigo-600 text-white shadow-xs'
									: 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200'
							}`}>
							{type === 'ALL' ? 'All Ingested Events' : type}
						</button>
					))}
				</div>
			</div>

			{/* Events Table / Stream */}
			<Card title={`Live Ingested Events (${filteredEvents.length} events)`}>
				<div className="divide-y divide-slate-100 text-xs">
					{filteredEvents.length === 0 ? (
						<div className="py-12 text-center text-slate-400 space-y-1">
							<Activity size={24} className="mx-auto text-slate-300 mb-1" />
							<p className="font-semibold text-slate-700">No matching events found for {activeStore?.name}</p>
							<p>Use the Sandbox or API snippet to dispatch real events.</p>
						</div>
					) : (
						filteredEvents.map((ev) => (
							<div
								key={ev.id}
								onClick={() => setSelectedSession(ev)}
								className="py-3.5 px-2 flex items-center justify-between gap-3 hover:bg-slate-50 rounded-xl transition-colors cursor-pointer group">
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
									<div className="min-w-0 space-y-0.5">
										<div className="flex items-center gap-2">
											<strong className="text-slate-900 truncate font-bold">{ev.title}</strong>
											<span className="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-slate-100 text-slate-600 border border-slate-200">
												{ev.eventType}
											</span>
											{ev.vitalMetric && (
												<span className="text-[10px] px-1.5 py-0.2 rounded-full font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
													{ev.vitalMetric}: {ev.vitalValue}s
												</span>
											)}
										</div>
										<div className="text-[11px] text-slate-400 font-mono truncate">
											{ev.path} • {ev.city} • {ev.device} ({ev.browser}) • Ref: {ev.referrer}
										</div>
									</div>
								</div>

								<div className="text-right shrink-0">
									<span className="font-mono text-xs text-slate-600">{ev.timestamp}</span>
									<span className="text-[11px] text-indigo-600 block font-semibold group-hover:underline">
										Inspect Session →
									</span>
								</div>
							</div>
						))
					)}
				</div>
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
							<div className="font-bold text-slate-900 text-xs">Chronological Multi-Step Journey:</div>
							<div className="relative pl-6 border-l-2 border-indigo-200 space-y-4 py-2">
								{sessionEvents.length > 0 ? (
									sessionEvents.map((ev, i) => (
										<div key={i} className="relative">
											<span className="absolute -left-[31px] top-1 w-3.5 h-3.5 rounded-full bg-indigo-600 border-2 border-white shadow-2xs" />
											<div className="font-bold text-slate-900 text-xs">{ev.title}</div>
											<div className="text-[11px] text-slate-500 font-mono">
												{ev.path} • {ev.eventType} • {ev.timestamp}
											</div>
											{ev.eventData && (
												<pre className="p-2 rounded-lg bg-slate-100 text-[10px] font-mono text-slate-700 mt-1">
													{JSON.stringify(ev.eventData, null, 2)}
												</pre>
											)}
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
