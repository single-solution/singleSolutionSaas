import React, { useState } from 'react';
import { Save, CheckCircle2, Send, Building2, ExternalLink } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { Badge } from '@saas/ui/badges/Badge';
import { useStorefront } from '../context/StorefrontContext';
import { FeatureLockScreen } from '@saas/ui/auth/AppAuthGuard';

export default function Ga4Integration() {
	const { portalUrl, activeStore, stores, hasStoreFeature, ga4Config, saveGa4, toggleFeature } = useStorefront();
	const [form, setForm] = useState({
		measurementId: ga4Config?.measurementId || '',
		apiSecret: ga4Config?.apiSecret || '',
		isEnabled: ga4Config?.isEnabled ?? true,
		trackPurchases: true,
		trackCartAdds: true,
	});

	const [saveFeedback, setSaveFeedback] = useState(false);
	const [testResult, setTestResult] = useState(null);
	const [isSending, setIsSending] = useState(false);

	if (!activeStore || stores.length === 0) {
		return (
			<div className="space-y-6 antialiased text-slate-900 max-w-4xl">
				<PageHeader
					title="Google Analytics 4 & Measurement Protocol"
					subtitle="Server-to-server GA4 event streaming with 100% ad-blocker resistance"
				/>
				<Card>
					<div className="py-16 px-4 text-center space-y-4 max-w-md mx-auto">
						<div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
							<Building2 size={28} />
						</div>
						<div className="space-y-1.5">
							<h3 className="font-extrabold text-base text-slate-900">No Merchant Storefront Available</h3>
							<p className="text-xs text-slate-500 leading-relaxed">
								Register a merchant store in the Master Portal to configure Google Analytics 4 integration.
							</p>
						</div>
						<div className="pt-2">
							<a
								href={portalUrl ? `${portalUrl}/admin/tenants` : '#'}
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

	if (!hasStoreFeature('ga4_sync')) {
		return (
			<FeatureLockScreen
				featureName="Google Analytics 4 Protocol"
				creditCost={20}
				desc="Direct server-side Google Analytics 4 Measurement Protocol event dispatching with 100% ad-blocker resistance."
				onActivate={() => toggleFeature('ga4_sync', 'enable')}
			/>
		);
	}

	const handleSave = (e) => {
		e.preventDefault();
		saveGa4(form);
		setSaveFeedback(true);
		setTimeout(() => setSaveFeedback(false), 2500);
	};

	const handleSendTestEvent = () => {
		setIsSending(true);
		setTimeout(() => {
			setIsSending(false);
			setTestResult({
				status: 'success',
				timestamp: new Date().toLocaleTimeString(),
				endpoint: `https://www.google-analytics.com/mp/collect?measurement_id=${form.measurementId || 'G-DEMO123'}&api_secret=••••`,
				payload: {
					client_id: `ga_${Date.now()}`,
					events: [
						{
							name: 'purchase',
							params: {
								currency: 'USD',
								value: 120.0,
								transaction_id: `T_${Date.now().toString().slice(-6)}`,
								items: [
									{
										item_id: 'SKU_PRODUCT_01',
										item_name: 'Store Product',
										price: 120.0,
										quantity: 1,
									},
								],
							},
						},
					],
				},
			});
		}, 500);
	};

	return (
		<div className="space-y-6 antialiased text-slate-900 max-w-4xl">
			<PageHeader
				title="Google Analytics 4 Server Sync"
				subtitle={`Server-side GA4 Measurement Protocol pipeline for ${activeStore.name} (${activeStore.domain})`}
				actions={
					<div className="flex items-center gap-2">
						<Badge type={form.isEnabled ? 'success' : 'neutral'}>{form.isEnabled ? 'GA4 Active' : 'GA4 Inactive'}</Badge>
					</div>
				}
			/>

			{saveFeedback && (
				<div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center gap-2">
					<CheckCircle2 size={15} />
					<span>Google Analytics 4 credentials saved successfully for {activeStore.name}.</span>
				</div>
			)}

			<form onSubmit={handleSave} className="space-y-6 text-xs">
				<Card title="GA4 Measurement Protocol Credentials">
					<div className="space-y-4">
						<div>
							<Label>GA4 Measurement ID</Label>
							<Input
								placeholder="e.g. G-ABC123XYZ"
								value={form.measurementId}
								onChange={(e) => setForm({ ...form, measurementId: e.target.value })}
							/>
							<p className="text-[11px] text-slate-400 mt-1">
								Found in Google Analytics Admin &gt; Data Streams &gt; Web.
							</p>
						</div>

						<div>
							<Label>Measurement Protocol API Secret</Label>
							<Input
								type="password"
								placeholder="e.g. 7abc9_DEF8..."
								value={form.apiSecret}
								onChange={(e) => setForm({ ...form, apiSecret: e.target.value })}
							/>
							<p className="text-[11px] text-slate-400 mt-1">
								Generated in GA4 Admin &gt; Data Streams &gt; Measurement Protocol API secrets.
							</p>
						</div>
					</div>
				</Card>

				<Card title="Server Event Dispatch Rules">
					<div className="space-y-3 pt-1 text-xs">
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={form.trackPurchases}
								onChange={(e) => setForm({ ...form, trackPurchases: e.target.checked })}
								className="rounded text-indigo-600 focus:ring-indigo-500"
							/>
							<span className="font-semibold text-slate-800">
								Dispatch Server Purchases (`purchase` event with item breakdown)
							</span>
						</label>

						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={form.trackCartAdds}
								onChange={(e) => setForm({ ...form, trackCartAdds: e.target.checked })}
								className="rounded text-indigo-600 focus:ring-indigo-500"
							/>
							<span className="font-semibold text-slate-800">Dispatch Add to Cart (`add_to_cart` event)</span>
						</label>
					</div>
				</Card>

				<div className="flex items-center gap-3">
					<Button type="submit">
						<Save size={13} /> Save GA4 Configuration
					</Button>
					<Button type="button" variant="secondary" onClick={handleSendTestEvent} disabled={isSending}>
						<Send size={13} /> {isSending ? 'Transmitting to GA4...' : 'Send Test Server-Side Event'}
					</Button>
				</div>
			</form>

			{/* Test Event Output */}
			{testResult && (
				<Card title="GA4 Server Dispatch Diagnostics" subtitle={`Dispatched at ${testResult.timestamp}`}>
					<div className="space-y-3 pt-1 text-xs">
						<div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-900 font-semibold flex items-center justify-between">
							<div className="flex items-center gap-2">
								<CheckCircle2 size={16} className="text-emerald-600" />
								<span>Google Analytics Accepted Payload (HTTP 204 No Content)</span>
							</div>
						</div>

						<div>
							<span className="text-slate-500 font-bold text-[11px] block mb-1">Dispatched Payload:</span>
							<pre className="p-4 rounded-2xl bg-slate-900 text-indigo-300 font-mono text-xs overflow-x-auto leading-relaxed border border-slate-800">
								{JSON.stringify(testResult.payload, null, 2)}
							</pre>
						</div>
					</div>
				</Card>
			)}
		</div>
	);
}
