'use client';

import React, { useState } from 'react';
import { usePortal } from '../../../../context/PortalContext';
import { Copy, Check, Eye, EyeOff, RefreshCw, Send, Terminal } from 'lucide-react';
import ConfirmModal from '../../../../components/ConfirmModal';

export default function ApiCredentialsView() {
	const { activeTenant, rotateTenantKeys, showToast } = usePortal();
	const [showSecret, setShowSecret] = useState(false);
	const [copiedKey, setCopiedKey] = useState(false);
	const [copiedSecret, setCopiedSecret] = useState(false);
	const [confirmRotate, setConfirmRotate] = useState(false);
	const [webhookUrl, setWebhookUrl] = useState(activeTenant?.domain ? `https://${activeTenant.domain}/api/webhooks` : '');
	const [testPayloadStatus, setTestPayloadStatus] = useState(null);

	const apiKey = activeTenant?.apiKey || '';
	const secretKey = activeTenant?.secretKey || '';

	const handleCopy = (text, type) => {
		if (!text) return;
		navigator.clipboard.writeText(text);
		if (type === 'key') {
			setCopiedKey(true);
			setTimeout(() => setCopiedKey(false), 2000);
		} else {
			setCopiedSecret(true);
			setTimeout(() => setCopiedSecret(false), 2000);
		}
		showToast('Copied to clipboard.');
	};

	const handleTestWebhook = () => {
		if (!webhookUrl) {
			showToast('Please enter a target webhook URL', 'warning');
			return;
		}
		setTestPayloadStatus('sending');
		setTimeout(() => {
			setTestPayloadStatus('success');
			showToast('Mock Webhook event dispatched with HMAC-SHA256 signature.');
			setTimeout(() => setTestPayloadStatus(null), 3000);
		}, 1000);
	};

	return (
		<div className="space-y-6 max-w-4xl">
			<div>
				<h1 className="text-xl font-bold text-slate-900 tracking-tight">API Keys & Security Credentials</h1>
				<p className="text-xs text-slate-500">
					Authenticate your storefront with micro-app webhooks and server-side integrations
				</p>
			</div>

			<div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-6">
				{/* Public API Key */}
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider">
							Storefront Public API Key
						</label>
						<span className="text-[10px] text-emerald-600 font-bold bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-100">
							Active
						</span>
					</div>
					<div className="flex items-center gap-2">
						<input
							type="text"
							readOnly
							value={apiKey}
							placeholder="No API key assigned"
							className="flex-1 p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono text-xs outline-none"
						/>
						<button
							type="button"
							onClick={() => handleCopy(apiKey, 'key')}
							className="px-3.5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer">
							{copiedKey ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
							<span>{copiedKey ? 'Copied' : 'Copy'}</span>
						</button>
					</div>
					<p className="text-[11px] text-slate-400">
						Safe for inclusion in frontend JavaScript snippets (telemetry, chatbots, pixel scripts).
					</p>
				</div>

				{/* Secret Key */}
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider">
							Private HMAC Secret Key
						</label>
						<button
							type="button"
							onClick={() => setConfirmRotate(true)}
							className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 cursor-pointer">
							<RefreshCw size={11} />
							<span>Rotate Key</span>
						</button>
					</div>
					<div className="flex items-center gap-2">
						<input
							type={showSecret ? 'text' : 'password'}
							readOnly
							value={secretKey}
							placeholder="No secret key assigned"
							className="flex-1 p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono text-xs outline-none"
						/>
						<button
							type="button"
							onClick={() => setShowSecret(!showSecret)}
							className="p-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 transition-colors cursor-pointer"
							title={showSecret ? 'Hide' : 'Show'}>
							{showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
						</button>
						<button
							type="button"
							onClick={() => handleCopy(secretKey, 'secret')}
							className="px-3.5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer">
							{copiedSecret ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
							<span>{copiedSecret ? 'Copied' : 'Copy'}</span>
						</button>
					</div>
					<p className="text-[11px] text-rose-500 font-medium">
						Keep this secret private. Used for signing server-to-server webhook payloads and verifying SSO handshakes.
					</p>
				</div>

				{/* Webhook Endpoint Tester */}
				<div className="pt-4 border-t border-slate-100 space-y-3">
					<div className="flex items-center gap-2">
						<Terminal size={16} className="text-indigo-600" />
						<h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Webhook Endpoint & Dispatcher</h3>
					</div>

					<div className="space-y-2 text-xs">
						<label className="block text-[11px] font-bold text-slate-700">Target Webhook Listener URL</label>
						<div className="flex items-center gap-2">
							<input
								type="text"
								placeholder="https://yourstore.com/api/webhooks"
								value={webhookUrl}
								onChange={(e) => setWebhookUrl(e.target.value)}
								className="flex-1 p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono text-xs outline-none focus:border-indigo-500"
							/>
							<button
								type="button"
								onClick={handleTestWebhook}
								disabled={testPayloadStatus === 'sending'}
								className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow-xs disabled:opacity-50">
								<Send size={13} />
								<span>{testPayloadStatus === 'sending' ? 'Sending...' : 'Send Test Ping'}</span>
							</button>
						</div>
					</div>

					{testPayloadStatus === 'success' && (
						<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
							<Check size={15} className="text-emerald-600 shrink-0" />
							<span>Test event signed with HMAC-SHA256 and dispatched successfully (HTTP 200 OK).</span>
						</div>
					)}
				</div>
			</div>

			<ConfirmModal
				isOpen={confirmRotate}
				onClose={() => setConfirmRotate(false)}
				onConfirm={() => {
					if (activeTenant) rotateTenantKeys(activeTenant.id);
					setConfirmRotate(false);
				}}
				title="Rotate Secret Key"
				message="Are you sure you want to rotate your HMAC Secret Key? Your server-side webhook verifications will need the new key to function properly."
				confirmText="Rotate Key"
				confirmStyle="warning"
			/>
		</div>
	);
}
