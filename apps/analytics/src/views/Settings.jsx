import React, { useState } from 'react';
import { Save, CheckCircle2, Trash2, Building2, ExternalLink } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { useStorefront } from '../context/StorefrontContext';

export default function SettingsPage() {
	const { portalUrl, activeStore, stores, resetStoreEvents } = useStorefront();
	const [saved, setSaved] = useState(false);
	const [form, setForm] = useState({
		siteId: activeStore?.id || '',
		domain: activeStore?.domain || '',
		ignoredIps: '192.168.1.1, 10.0.0.1',
		samplingRate: '100',
		edgeEndpoint: typeof window !== 'undefined' ? `${window.location.origin}/api/events` : '/api/events',
	});

	if (!activeStore || stores.length === 0) {
		return (
			<div className="space-y-6 antialiased text-slate-900 max-w-2xl">
				<PageHeader
					title="Telemetry Configuration & Collector Settings"
					subtitle="Manage site credentials, edge collector endpoints, and data rules"
				/>
				<Card>
					<div className="py-16 px-4 text-center space-y-4 max-w-md mx-auto">
						<div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
							<Building2 size={28} />
						</div>
						<div className="space-y-1.5">
							<h3 className="font-extrabold text-base text-slate-900">No Merchant Account Available</h3>
							<p className="text-xs text-slate-500 leading-relaxed">
								Register a merchant store in the Master Portal to configure edge collector and IP exclusion rules.
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

	const handleSave = (e) => {
		e.preventDefault();
		setSaved(true);
		setTimeout(() => setSaved(false), 2500);
	};

	const handleClearStoreData = () => {
		resetStoreEvents();
		setSaved(true);
		setTimeout(() => setSaved(false), 2500);
	};

	return (
		<div className="max-w-2xl space-y-6 antialiased text-slate-900">
			<PageHeader
				title="Telemetry Configuration & Collector Settings"
				subtitle={`Manage site credentials, edge collector endpoints, and data rules for ${activeStore.name}`}
			/>

			{saved && (
				<div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2 font-semibold">
					<CheckCircle2 size={16} />
					<span>Telemetry configuration saved and deployed to edge nodes.</span>
				</div>
			)}

			<form onSubmit={handleSave} className="space-y-6 text-xs">
				<Card title="Storefront Site Credentials">
					<div className="space-y-4">
						<div>
							<Label>Storefront Site ID</Label>
							<Input readOnly value={activeStore.id} className="font-mono bg-slate-50 text-slate-700" />
						</div>
						<div>
							<Label>Authorized Store Domain</Label>
							<Input
								value={form.domain || activeStore.domain}
								onChange={(e) => setForm({ ...form, domain: e.target.value })}
								placeholder="e.g. yourstore.com"
							/>
						</div>
					</div>
				</Card>

				<Card title="Edge Collector & Traffic Rules">
					<div className="space-y-4">
						<div>
							<Label>Edge Telemetry Ingestion Endpoint</Label>
							<Input value={form.edgeEndpoint} onChange={(e) => setForm({ ...form, edgeEndpoint: e.target.value })} />
						</div>

						<div>
							<Label>Ignored Internal Staff IPs (Comma-separated)</Label>
							<Input
								value={form.ignoredIps}
								onChange={(e) => setForm({ ...form, ignoredIps: e.target.value })}
								placeholder="e.g. 192.168.1.1, 127.0.0.1"
							/>
							<p className="text-[11px] text-slate-400 mt-1">
								Traffic originating from these IP addresses will not inflate store analytics or skew conversion rates.
							</p>
						</div>

						<div>
							<Label>Traffic Sampling Rate (%)</Label>
							<Input
								type="number"
								min="1"
								max="100"
								value={form.samplingRate}
								onChange={(e) => setForm({ ...form, samplingRate: e.target.value })}
							/>
						</div>
					</div>
				</Card>

				<div className="flex items-center justify-between gap-4 pt-2">
					<Button type="submit">
						<Save size={13} />
						<span>Save Telemetry Settings</span>
					</Button>
					<Button type="button" variant="danger" onClick={handleClearStoreData}>
						<Trash2 size={13} />
						<span>Reset Store Telemetry</span>
					</Button>
				</div>
			</form>
		</div>
	);
}
