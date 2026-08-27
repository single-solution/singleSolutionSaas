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
				title="Loyalty Engine Rules"
				subtitle="Base point conversion ratios, expiry durations, and redemption validation limits"
			/>

			{saved && (
				<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
					<CheckCircle2 size={15} />
					<span>Loyalty rules updated successfully.</span>
				</div>
			)}

			<Card title="Point Economy Rules">
				<div className="space-y-4">
					<div>
						<Label>Points Earned Per $1 Spent</Label>
						<Input defaultValue="10" />
					</div>

					<div>
						<Label>Point Expiry Duration (Months)</Label>
						<Input defaultValue="12" />
					</div>

					<div>
						<Label>Voucher Redemption Webhook</Label>
						<Input defaultValue="https://sistersboutique.com/api/loyalty/redeem" />
					</div>

					<Button
						onClick={() => {
							setSaved(true);
							setTimeout(() => setSaved(false), 3000);
						}}>
						<Save size={13} />
						<span>Save Loyalty Rules</span>
					</Button>
				</div>
			</Card>
		</div>
	);
}
