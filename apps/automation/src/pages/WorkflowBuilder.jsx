import React, { useState } from 'react';
import { Save, Plus, ArrowDown, Play, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { Select } from '@saas/ui/selects/Select';
import { Badge } from '@saas/ui/badges/Badge';

export default function WorkflowBuilder() {
	const [saved, setSaved] = useState(false);

	return (
		<div className="space-y-6 max-w-3xl">
			<PageHeader
				title="Visual Automation Pipeline Builder"
				subtitle="Connect webhook triggers with multi-channel asynchronous actions"
				actions={
					<div className="flex gap-2">
						<Link to="/workflows">
							<Button variant="secondary" size="sm">
								Back
							</Button>
						</Link>
						<Button
							size="sm"
							onClick={() => {
								setSaved(true);
								setTimeout(() => setSaved(false), 3000);
							}}>
							<Save size={13} />
							<span>Deploy Pipeline</span>
						</Button>
					</div>
				}
			/>

			{saved && (
				<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
					<CheckCircle2 size={15} />
					<span>Pipeline successfully deployed to serverless workers.</span>
				</div>
			)}

			{/* Trigger Step */}
			<Card title="1. Inbound Event Trigger">
				<div className="space-y-3">
					<div>
						<Label>Select Trigger Event</Label>
						<Select defaultValue="order.created">
							<option value="order.created">Storefront: New Order Created</option>
							<option value="order.paid">Storefront: Order Payment Captured</option>
							<option value="customer.registered">Storefront: New Customer Registered</option>
							<option value="inventory.low">Storefront: Stock Level Below Threshold</option>
						</Select>
					</div>
				</div>
			</Card>

			<div className="flex justify-center">
				<div className="p-2 rounded-full bg-zinc-100 text-zinc-400">
					<ArrowDown size={16} />
				</div>
			</div>

			{/* Action Step */}
			<Card title="2. Execute Action Step">
				<div className="space-y-3">
					<div>
						<Label>Action Channel</Label>
						<Select defaultValue="slack">
							<option value="slack">Post Message to Slack Channel</option>
							<option value="email">Send Transactional Customer Email</option>
							<option value="webhook">Post JSON Payload to Custom Webhook</option>
							<option value="loyalty">Award VIP Loyalty Points</option>
						</Select>
					</div>

					<div>
						<Label>Action Payload Configuration</Label>
						<Input defaultValue="https://hooks.slack.com/services/T00/B00/XXXX" />
					</div>
				</div>
			</Card>
		</div>
	);
}
