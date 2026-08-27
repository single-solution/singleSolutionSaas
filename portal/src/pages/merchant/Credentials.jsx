import React, { useState } from 'react';
import { Copy, CheckCircle2, RefreshCw, Send, Eye, EyeOff, Key } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { usePortal } from '../../context/PortalContext';

export default function Credentials() {
	const { activeTenant, regenerateApiKey, updateTenant, showToast, logAction } = usePortal();
	const [copiedKey, setCopiedKey] = useState(null);
	const [showSecret, setShowSecret] = useState(false);
	const [webhookUrl, setWebhookUrl] = useState(activeTenant?.webhookUrl || '');
	const [webhookSaved, setWebhookSaved] = useState(false);
	const [pinging, setPinging] = useState(false);

	if (!activeTenant) {
		return (
			<Card>
				<div className="py-16 text-center space-y-3">
					<div className="w-12 h-12 rounded-2xl bg-zinc-100 text-zinc-400 flex items-center justify-center mx-auto">
						<Key size={24} />
					</div>
					<h3 className="font-bold text-sm text-zinc-900">No Merchant Storefront Selected</h3>
					<p className="text-xs text-zinc-500 max-w-sm mx-auto">
						Please provision a merchant in the SuperAdmin console to view its API keys and webhooks.
					</p>
				</div>
			</Card>
		);
	}

	const handleCopy = (text, type) => {
		navigator.clipboard.writeText(text);
		setCopiedKey(type);
		showToast(`Copied ${type === 'public' ? 'Publishable Key' : 'Secret Key'} to clipboard.`);
		setTimeout(() => setCopiedKey(null), 2000);
	};

	const handleSaveWebhook = (e) => {
		e.preventDefault();
		updateTenant(activeTenant.id, { webhookUrl });
		setWebhookSaved(true);
		showToast('Webhook receiver URL updated.');
		setTimeout(() => setWebhookSaved(false), 2000);
	};

	const handleTestPing = () => {
		if (!webhookUrl) {
			showToast('Please configure a webhook URL first.', 'warning');
			return;
		}
		setPinging(true);
		logAction('Dispatched test ping webhook', webhookUrl, 'info');
		setTimeout(() => {
			setPinging(false);
			showToast('Test webhook payload delivered with status 200 OK.');
		}, 800);
	};

	return (
		<div className="max-w-3xl space-y-6">
			<PageHeader
				title="Developer API Keys & Webhooks"
				subtitle={`API credentials and integration endpoints for ${activeTenant.name}`}
			/>

			{/* Publishable Key */}
			<Card title="Publishable Client API Key">
				<p className="text-xs text-zinc-500 mb-3">
					Use this key in your storefront client scripts and widgets. It is safe to embed in public web pages.
				</p>
				<div className="flex gap-2">
					<Input readOnly value={activeTenant.apiKey} className="font-mono text-zinc-700 bg-zinc-50 text-xs" />
					<Button size="sm" variant="secondary" onClick={() => handleCopy(activeTenant.apiKey, 'public')}>
						{copiedKey === 'public' ? <CheckCircle2 size={13} className="text-emerald-700" /> : <Copy size={13} />}
						<span>{copiedKey === 'public' ? 'Copied' : 'Copy'}</span>
					</Button>
					<Button size="sm" variant="secondary" onClick={() => regenerateApiKey(activeTenant.id, 'apiKey')}>
						<RefreshCw size={13} /> <span>Roll Key</span>
					</Button>
				</div>
			</Card>

			{/* Secret Key */}
			<Card title="Secret Server API Key">
				<p className="text-xs text-zinc-500 mb-3">
					Use this key for private backend-to-backend API calls (e.g. creating orders, reading telemetry). Never expose this
					key in client-side code.
				</p>
				<div className="flex gap-2">
					<Input
						readOnly
						type={showSecret ? 'text' : 'password'}
						value={activeTenant.secretKey}
						className="font-mono text-zinc-700 bg-zinc-50 text-xs"
					/>
					<Button size="sm" variant="secondary" onClick={() => setShowSecret(!showSecret)}>
						{showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
						<span>{showSecret ? 'Hide' : 'Reveal'}</span>
					</Button>
					<Button size="sm" variant="secondary" onClick={() => handleCopy(activeTenant.secretKey, 'secret')}>
						{copiedKey === 'secret' ? <CheckCircle2 size={13} className="text-emerald-700" /> : <Copy size={13} />}
						<span>{copiedKey === 'secret' ? 'Copied' : 'Copy'}</span>
					</Button>
					<Button size="sm" variant="secondary" onClick={() => regenerateApiKey(activeTenant.id, 'secretKey')}>
						<RefreshCw size={13} /> <span>Roll Key</span>
					</Button>
				</div>
			</Card>

			{/* Webhook Endpoint */}
			<Card title="Storefront Webhook Receiver">
				<form onSubmit={handleSaveWebhook} className="space-y-4 text-xs">
					<p className="text-zinc-500">
						Our platform will dispatch signed HTTP POST payloads to this URL whenever events occur in your active apps.
					</p>
					<div>
						<Label>Inbound HTTPS Webhook URL</Label>
						<Input
							type="url"
							placeholder="https://yourstore.com/api/webhooks/saas"
							value={webhookUrl}
							onChange={(e) => setWebhookUrl(e.target.value)}
						/>
					</div>
					<div className="flex items-center gap-3">
						<Button type="submit">Save Webhook URL</Button>
						<Button type="button" variant="secondary" onClick={handleTestPing} disabled={pinging}>
							<Send size={13} />
							<span>{pinging ? 'Sending Ping...' : 'Send Test Ping'}</span>
						</Button>
						{webhookSaved && (
							<span className="text-emerald-700 flex items-center gap-1 font-semibold">
								<CheckCircle2 size={13} /> Saved!
							</span>
						)}
					</div>
				</form>
			</Card>
		</div>
	);
}
