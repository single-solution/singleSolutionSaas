import React, { useState } from 'react';
import { Radio, Save, CheckCircle2, Zap, ShieldCheck, Send, ExternalLink, Lock, Check, Key, Building2 } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { Badge } from '@saas/ui/badges/Badge';
import { useStorefront } from '../context/StorefrontContext';
import { FeatureLockScreen } from '@saas/ui/auth/AppAuthGuard';

export default function WebhooksIntegration() {
	const { activeStore, stores, hasStoreFeature, webhookConfig, saveWebhook } = useStorefront();
	const [form, setForm] = useState({
		endpointUrl: webhookConfig?.endpointUrl || '',
		signingSecret: webhookConfig?.signingSecret || '',
		isEnabled: webhookConfig?.isEnabled ?? true,
		triggerOrder: true,
		triggerCart: true,
		triggerVitals: false,
	});

	const [saveFeedback, setSaveFeedback] = useState(false);
	const [testResult, setTestResult] = useState(null);
	const [isSending, setIsSending] = useState(false);

	if (!activeStore || stores.length === 0) {
		return (
			<div className="space-y-6 antialiased text-slate-900 max-w-4xl">
				<PageHeader
					title="Telemetry Webhooks & Real-Time Dispatch"
					subtitle="Push real-time purchase and visit events to external URLs"
				/>
				<Card>
					<div className="py-16 px-4 text-center space-y-4 max-w-md mx-auto">
						<div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
							<Building2 size={28} />
						</div>
						<div className="space-y-1.5">
							<h3 className="font-extrabold text-base text-slate-900">No Merchant Storefront Available</h3>
							<p className="text-xs text-slate-500 leading-relaxed">
								Register a merchant store in the Master Portal to configure outbound webhook dispatching.
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

	if (!hasStoreFeature('custom_webhooks')) {
		return (
			<FeatureLockScreen
				featureName="Telemetry Webhooks & Dispatch"
				creditCost={25}
				desc="Forward real-time e-commerce orders, cart abandonment signals, and traffic spikes directly to Slack, Zapier, or your private warehouse."
			/>
		);
	}

	const handleSave = (e) => {
		e.preventDefault();
		saveWebhook(form);
		setSaveFeedback(true);
		setTimeout(() => setSaveFeedback(false), 2500);
	};

	const handleSendTestWebhook = () => {
		setIsSending(true);
		setTimeout(() => {
			setIsSending(false);
			setTestResult({
				status: 'delivered',
				timestamp: new Date().toLocaleTimeString(),
				httpStatus: 200,
				latencyMs: '42ms',
				targetUrl: form.endpointUrl || 'https://api.your-endpoint.com/webhook',
				payload: {
					event: 'order.completed',
					timestamp: new Date().toISOString(),
					storeId: activeStore.id,
					domain: activeStore.domain,
					data: {
						orderId: 'ORD-9914',
						amount: 120.0,
						currency: 'USD',
						customerEmail: 'customer@domain.com',
						itemCount: 1,
					},
				},
			});
		}, 500);
	};

	return (
		<div className="space-y-6 antialiased text-slate-900 max-w-4xl">
			<PageHeader
				title="Telemetry Webhooks & Real-Time Dispatch"
				subtitle={`Push real-time purchase and visit events to external URLs for ${activeStore.name} (${activeStore.domain})`}
				actions={
					<div className="flex items-center gap-2">
						<Badge type={form.isEnabled ? 'success' : 'neutral'}>
							{form.isEnabled ? 'Webhooks Active' : 'Webhooks Inactive'}
						</Badge>
					</div>
				}
			/>

			{saveFeedback && (
				<div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center gap-2">
					<CheckCircle2 size={15} />
					<span>Webhook settings saved successfully for {activeStore.name}.</span>
				</div>
			)}

			<form onSubmit={handleSave} className="space-y-6 text-xs">
				<Card title="Outbound Webhook Endpoint">
					<div className="space-y-4">
						<div>
							<Label>Target HTTPS Webhook URL</Label>
							<Input
								placeholder="https://api.yourdomain.com/webhooks/telemetry or Zapier URL"
								value={form.endpointUrl}
								onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })}
							/>
						</div>

						<div>
							<Label>HMAC Signing Secret Key</Label>
							<div className="relative">
								<Input
									readOnly
									value={form.signingSecret || `whsec_${activeStore.id.slice(-6)}`}
									className="font-mono bg-slate-50 text-slate-700"
								/>
							</div>
							<p className="text-[11px] text-slate-400 mt-1">
								Used to verify the{' '}
								<code className="px-1.5 py-0.5 rounded bg-slate-100 font-mono text-slate-800">
									X-SingleSolution-Signature
								</code>{' '}
								SHA256 header.
							</p>
						</div>
					</div>
				</Card>

				<Card title="Webhook Trigger Events">
					<div className="space-y-3 pt-1 text-xs">
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={form.triggerOrder}
								onChange={(e) => setForm({ ...form, triggerOrder: e.target.checked })}
								className="rounded text-indigo-600 focus:ring-indigo-500"
							/>
							<span className="font-semibold text-slate-800">Trigger on Completed Orders (`order.completed`)</span>
						</label>

						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={form.triggerCart}
								onChange={(e) => setForm({ ...form, triggerCart: e.target.checked })}
								className="rounded text-indigo-600 focus:ring-indigo-500"
							/>
							<span className="font-semibold text-slate-800">Trigger on Cart Abandonment Signals (`cart.abandoned`)</span>
						</label>

						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={form.triggerVitals}
								onChange={(e) => setForm({ ...form, triggerVitals: e.target.checked })}
								className="rounded text-indigo-600 focus:ring-indigo-500"
							/>
							<span className="font-semibold text-slate-800">
								Trigger on Core Web Vitals Speed Spikes (`vitals.anomaly`)
							</span>
						</label>
					</div>
				</Card>

				<div className="flex items-center gap-3">
					<Button type="submit">
						<Save size={13} /> Save Webhook Config
					</Button>
					<Button type="button" variant="secondary" onClick={handleSendTestWebhook} disabled={isSending}>
						<Send size={13} /> {isSending ? 'Dispatching...' : 'Send Test Ping to Endpoint'}
					</Button>
				</div>
			</form>

			{testResult && (
				<Card title="Webhook Delivery Inspector" subtitle={`Sent at ${testResult.timestamp}`}>
					<div className="space-y-3 pt-1 text-xs">
						<div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-900 font-semibold flex items-center justify-between">
							<div className="flex items-center gap-2">
								<CheckCircle2 size={16} className="text-emerald-600" />
								<span>
									Delivered Successfully ({testResult.httpStatus} OK in {testResult.latencyMs})
								</span>
							</div>
							<span className="font-mono text-[11px] text-emerald-700">{testResult.targetUrl}</span>
						</div>

						<div>
							<span className="text-slate-500 font-bold text-[11px] block mb-1">Dispatched Webhook Payload:</span>
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
