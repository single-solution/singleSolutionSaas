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
				title="Automator Configuration"
				subtitle="Global retry budgets, dead letter queues, and API timeout limits"
			/>

			{saved && (
				<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
					<CheckCircle2 size={15} />
					<span>Automator settings updated successfully.</span>
				</div>
			)}

			<Card title="Worker Settings">
				<div className="space-y-4">
					<div>
						<Label>Max Execution Retries</Label>
						<Input defaultValue="3" />
					</div>

					<div>
						<Label>Dead Letter Webhook</Label>
						<Input defaultValue="https://sistersboutique.com/api/webhooks/failures" />
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
