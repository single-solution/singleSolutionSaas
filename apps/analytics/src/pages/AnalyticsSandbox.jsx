import React, { useState } from 'react';
import {
	Sparkles,
	Play,
	Code,
	Copy,
	CheckCircle2,
	Eye,
	Search,
	ShoppingBag,
	Zap,
	AlertTriangle,
	Trash2,
	RefreshCw,
} from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { useStorefront } from '../context/StorefrontContext';
import { Link } from 'react-router-dom';

export default function AnalyticsSandbox() {
	const { activeStore, recordStoreEvent, resetStoreEvents } = useStorefront();
	const [lastEvent, setLastEvent] = useState(null);
	const [copied, setCopied] = useState(false);
	const [toastMsg, setToastMsg] = useState('');

	const siteId = activeStore?.id || 'tnt_storefront';
	const apiKey = activeStore?.apiKey || 'pk_live_sample';

	const embedScriptCode = `<!-- SingleSolution Analytics Pro Telemetry -->
<script
  defer
  src="http://localhost:5001/telemetry.js"
  data-site-id="${siteId}"
  data-api-key="${apiKey}"
></script>`;

	const handleCopy = () => {
		navigator.clipboard.writeText(embedScriptCode);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const showFeedback = (msg) => {
		setToastMsg(msg);
		setTimeout(() => setToastMsg(''), 3000);
	};

	const fireEvent = (type, customData) => {
		const ev = recordStoreEvent({
			eventType: type,
			path: customData.path || '/products/flagship-device',
			title: customData.title || 'Store Page View',
			eventName: customData.eventName,
			vitalMetric: customData.vitalMetric,
			vitalValue: customData.vitalValue,
			vitalRating: customData.vitalRating,
			eventData: customData.eventData,
		});
		setLastEvent(ev);
		showFeedback(`Ingested ${type} event into ${activeStore?.name}: ${ev.id}`);
	};

	const handleSeedBatch = () => {
		const batch = [
			{
				eventType: 'page_view',
				path: '/',
				title: 'Home • Storefront Landing',
				city: 'Karachi, Sindh',
				device: 'Mobile Phone',
				browser: 'Mobile Safari',
			},
			{
				eventType: 'page_view',
				path: '/products/flagship-device',
				title: 'Flagship Device Specification Page',
				city: 'Karachi, Sindh',
				device: 'Mobile Phone',
				browser: 'Mobile Safari',
			},
			{
				eventType: 'custom',
				eventName: 'cart_item_added',
				path: '/cart',
				title: 'Added Flagship to Bag',
				city: 'Karachi, Sindh',
				device: 'Mobile Phone',
				browser: 'Mobile Safari',
			},
			{
				eventType: 'custom',
				eventName: 'checkout_started',
				path: '/checkout',
				title: 'Checkout Initiated',
				city: 'Karachi, Sindh',
				device: 'Mobile Phone',
				browser: 'Mobile Safari',
			},
			{
				eventType: 'custom',
				eventName: 'order_completed',
				path: '/checkout/success',
				title: 'Order Confirmed #ORD-1092',
				city: 'Karachi, Sindh',
				device: 'Mobile Phone',
				browser: 'Mobile Safari',
				eventData: { total: '$1,199.00', items: 1 },
			},
			{
				eventType: 'search',
				path: '/search?q=wireless+fast+charger',
				title: 'Search: wireless fast charger',
				city: 'Lahore, Punjab',
				device: 'Desktop PC',
				browser: 'Chrome Desktop',
				eventData: { query: 'wireless fast charger', resultCount: 6 },
			},
			{
				eventType: 'search',
				path: '/search?q=limited+edition+case',
				title: 'Search: limited edition case',
				city: 'Islamabad',
				device: 'Mobile Phone',
				browser: 'Mobile Safari',
				eventData: { query: 'limited edition case', resultCount: 0 },
			},
			{
				eventType: 'error_404',
				path: '/deals/old-url',
				title: 'Page Not Found (404)',
				city: 'Multan',
				device: 'Mobile Phone',
				browser: 'Chrome Mobile',
				referrer: 'instagram.com',
			},
		];

		batch.forEach((b) => recordStoreEvent(b));
		showFeedback(`Ingested batch of 8 real telemetry events into ${activeStore?.name}!`);
	};

	const handleClear = () => {
		resetStoreEvents();
		setLastEvent(null);
		showFeedback(`Reset all telemetry data for ${activeStore?.name} to clean zero state.`);
	};

	return (
		<div className="space-y-6 antialiased text-slate-900">
			<PageHeader
				title="Telemetry Simulator & Storefront Embed"
				subtitle={`Test real event ingestion and trigger custom actions for ${activeStore?.name} (${activeStore?.domain})`}
				actions={
					<div className="flex items-center gap-2">
						<Button size="sm" variant="secondary" onClick={handleSeedBatch}>
							<Sparkles size={13} /> Seed Test Traffic Batch
						</Button>
						<Button size="sm" variant="danger" onClick={handleClear}>
							<Trash2 size={13} /> Reset Data to Zero
						</Button>
					</div>
				}
			/>

			{toastMsg && (
				<div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center gap-2">
					<CheckCircle2 size={15} />
					<span>{toastMsg}</span>
				</div>
			)}

			{/* 1-Click Embed Snippet Card */}
			<Card
				title="Storefront Integration Snippet"
				subtitle="Paste this lightweight tag into your store HTML <head> or Next.js layout"
				action={
					<div className="flex items-center gap-2">
						<Link to="/connect">
							<Button size="sm" variant="secondary">
								Full API Docs
							</Button>
						</Link>
						<Button size="sm" onClick={handleCopy}>
							{copied ? <CheckCircle2 size={13} className="text-emerald-500" /> : <Copy size={13} />}
							<span>{copied ? 'Copied' : 'Copy Script Tag'}</span>
						</Button>
					</div>
				}>
				<div className="space-y-3 pt-1 text-xs">
					<pre className="p-4 rounded-2xl bg-slate-900 text-indigo-300 font-mono text-xs overflow-x-auto leading-relaxed border border-slate-800">
						{embedScriptCode}
					</pre>
					<p className="text-[11px] text-slate-500">
						Automatically captures Core Web Vitals (LCP, CLS, INP), page navigation, funnel stages, search terms, and 404
						dead links with zero performance impact.
					</p>
				</div>
			</Card>

			{/* Interactive Event Simulator Actions */}
			<Card title="Live Event Fire Simulator" subtitle="Click any button to inject a live telemetry event into the dashboard">
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
					<button
						type="button"
						onClick={() =>
							fireEvent('page_view', {
								path: '/products/flagship-device',
								title: 'Flagship Device Specification Page',
							})
						}
						className="p-4 rounded-2xl bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-300 text-left transition-all cursor-pointer space-y-1">
						<div className="flex items-center gap-2 font-bold text-xs text-slate-900">
							<Eye size={15} className="text-indigo-600" />
							<span>Fire Product Page View</span>
						</div>
						<p className="text-[11px] text-slate-500">Simulate a customer landing on a product page</p>
					</button>

					<button
						type="button"
						onClick={() =>
							fireEvent('custom', {
								eventName: 'cart_item_added',
								path: '/cart',
								title: 'Added Item to Cart',
								eventData: { item: 'Flagship Smartphone', price: '$1,199.00' },
							})
						}
						className="p-4 rounded-2xl bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 text-left transition-all cursor-pointer space-y-1">
						<div className="flex items-center gap-2 font-bold text-xs text-slate-900">
							<ShoppingBag size={15} className="text-emerald-600" />
							<span>Fire Add to Cart Trigger</span>
						</div>
						<p className="text-[11px] text-slate-500">Advance buyer to Step 03 of conversion funnel</p>
					</button>

					<button
						type="button"
						onClick={() =>
							fireEvent('custom', {
								eventName: 'order_completed',
								path: '/checkout/success',
								title: 'Order Confirmed #ORD-8819',
								eventData: { orderId: 'ORD-8819', total: '$1,199.00' },
							})
						}
						className="p-4 rounded-2xl bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-300 text-left transition-all cursor-pointer space-y-1">
						<div className="flex items-center gap-2 font-bold text-xs text-slate-900">
							<CheckCircle2 size={15} className="text-indigo-600" />
							<span>Fire Order Completed</span>
						</div>
						<p className="text-[11px] text-slate-500">Record a successful e-commerce purchase</p>
					</button>

					<button
						type="button"
						onClick={() =>
							fireEvent('search', {
								path: '/search?q=fast+wireless+charger',
								title: 'Search: fast wireless charger',
								eventData: { query: 'fast wireless charger', resultCount: 8 },
							})
						}
						className="p-4 rounded-2xl bg-slate-50 hover:bg-slate-100 border border-slate-200 text-left transition-all cursor-pointer space-y-1">
						<div className="flex items-center gap-2 font-bold text-xs text-slate-900">
							<Search size={15} className="text-slate-700" />
							<span>Fire Search Intent Query</span>
						</div>
						<p className="text-[11px] text-slate-500">Record buyer keyword query</p>
					</button>

					<button
						type="button"
						onClick={() =>
							fireEvent('web_vital', {
								vitalMetric: 'LCP',
								vitalValue: 1.1,
								vitalRating: 'good',
								path: '/categories/smartphones',
								title: 'Catalog LCP Web Vital',
							})
						}
						className="p-4 rounded-2xl bg-slate-50 hover:bg-amber-50 border border-slate-200 hover:border-amber-300 text-left transition-all cursor-pointer space-y-1">
						<div className="flex items-center gap-2 font-bold text-xs text-slate-900">
							<Zap size={15} className="text-amber-600" />
							<span>Fire LCP Web Vital (1.1s)</span>
						</div>
						<p className="text-[11px] text-slate-500">Inject real-device speed metric</p>
					</button>

					<button
						type="button"
						onClick={() =>
							fireEvent('error_404', {
								path: '/deals/expired-page',
								title: 'Page Not Found (404)',
							})
						}
						className="p-4 rounded-2xl bg-slate-50 hover:bg-rose-50 border border-slate-200 hover:border-rose-300 text-left transition-all cursor-pointer space-y-1">
						<div className="flex items-center gap-2 font-bold text-xs text-slate-900">
							<AlertTriangle size={15} className="text-rose-600" />
							<span>Fire 404 Broken Link</span>
						</div>
						<p className="text-[11px] text-slate-500">Record broken URL detection</p>
					</button>
				</div>

				{lastEvent && (
					<div className="mt-4 p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
						<div className="flex justify-between items-center">
							<span className="font-bold text-slate-900 flex items-center gap-1.5 text-emerald-600">
								<CheckCircle2 size={14} /> Ingested Event Successfully into {activeStore?.name}:
							</span>
							<span className="font-mono text-[11px] text-slate-500">{lastEvent.id}</span>
						</div>
						<pre className="p-3 rounded-xl bg-white border border-slate-200 text-[11px] font-mono text-slate-800 overflow-x-auto">
							{JSON.stringify(lastEvent, null, 2)}
						</pre>
					</div>
				)}
			</Card>
		</div>
	);
}
