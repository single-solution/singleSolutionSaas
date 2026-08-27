import React, { useState } from 'react';
import { Save, CheckCircle2, Trash2 } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { Select } from '@saas/ui/selects/Select';
import { usePortal } from '../../context/PortalContext';

export default function SettingsPage() {
	const { clearAllData, showToast } = usePortal();
	const [saved, setSaved] = useState(false);
	const [settings, setSettings] = useState({
		platformName: 'SingleSolution SaaS Suite',
		supportEmail: 'ops@singlesolutionsaas.com',
		rateLimit: '2500',
		defaultPlan: 'pro',
		webhookTimeout: '5000',
	});

	const handleSave = (e) => {
		e.preventDefault();
		setSaved(true);
		showToast('Platform settings saved successfully.');
		setTimeout(() => setSaved(false), 2000);
	};

	return (
		<div className="max-w-2xl space-y-6">
			<PageHeader
				title="Global Platform Settings"
				subtitle="Configure platform-wide rate limits, security thresholds, and notifications"
			/>

			<form onSubmit={handleSave} className="space-y-6">
				<Card title="Brand & Identity">
					<div className="space-y-4 text-xs">
						<div>
							<Label>Platform Brand Title</Label>
							<Input
								value={settings.platformName}
								onChange={(e) => setSettings({ ...settings, platformName: e.target.value })}
							/>
						</div>
						<div>
							<Label>Support & Escalation Email</Label>
							<Input
								type="email"
								value={settings.supportEmail}
								onChange={(e) => setSettings({ ...settings, supportEmail: e.target.value })}
							/>
						</div>
					</div>
				</Card>

				<Card title="Traffic & Security Rate Limits">
					<div className="space-y-4 text-xs">
						<div>
							<Label>Global Edge API Rate Limit (req / min / IP)</Label>
							<Input
								type="number"
								value={settings.rateLimit}
								onChange={(e) => setSettings({ ...settings, rateLimit: e.target.value })}
							/>
						</div>
						<div>
							<Label>Outbound Webhook Delivery Timeout (ms)</Label>
							<Input
								type="number"
								value={settings.webhookTimeout}
								onChange={(e) => setSettings({ ...settings, webhookTimeout: e.target.value })}
							/>
						</div>
						<div>
							<Label>Default Merchant Provisioning Plan</Label>
							<Select
								value={settings.defaultPlan}
								onChange={(e) => setSettings({ ...settings, defaultPlan: e.target.value })}>
								<option value="core">Core Tier ($99/mo)</option>
								<option value="pro">Pro Tier ($450/mo)</option>
								<option value="enterprise">Enterprise Tier ($1,200/mo)</option>
							</Select>
						</div>
					</div>
				</Card>

				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-3">
						<Button type="submit">
							<Save size={14} /> Save Platform Configuration
						</Button>
						{saved && (
							<span className="text-xs text-emerald-700 flex items-center gap-1 font-semibold">
								<CheckCircle2 size={14} /> Saved!
							</span>
						)}
					</div>

					<Button type="button" variant="secondary" onClick={clearAllData}>
						<Trash2 size={13} className="text-rose-600" /> Clear All Tenant Data
					</Button>
				</div>
			</form>
		</div>
	);
}
