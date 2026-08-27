import React, { useState } from 'react';
import { Save, CheckCircle2 } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Input, Label } from '@saas/ui/inputs/TextInput';

export default function Settings() {
	const [saved, setSaved] = useState(false);

	return (
		<div className="space-y-6 max-w-2xl">
			<PageHeader
				title="Chatbot Integration Settings"
				subtitle="Webhook callbacks, agent handoff triggers, and customer identifier headers"
			/>

			{saved && (
				<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
					<CheckCircle2 size={15} />
					<span>Integration settings updated successfully.</span>
				</div>
			)}

			<Card title="Integration Webhooks">
				<div className="space-y-4">
					<div>
						<Label>Order Lookup API Endpoint</Label>
						<Input defaultValue="https://sistersboutique.com/api/orders/lookup" />
					</div>

					<div>
						<Label>Human Agent Escalation Webhook</Label>
						<Input defaultValue="https://sistersboutique.com/api/webhooks/escalations" />
					</div>

					<Button
						onClick={() => {
							setSaved(true);
							setTimeout(() => setSaved(false), 3000);
						}}>
						<Save size={13} />
						<span>Save Settings</span>
					</Button>
				</div>
			</Card>
		</div>
	);
}
