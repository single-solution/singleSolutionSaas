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
				title="SEO Engine Configuration"
				subtitle="Search engine verification codes, auto-meta rules, and crawl frequencies"
			/>

			{saved && (
				<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
					<CheckCircle2 size={15} />
					<span>SEO settings updated successfully.</span>
				</div>
			)}

			<Card title="Search Console Verification">
				<div className="space-y-4">
					<div>
						<Label>Google Site Verification Meta Tag</Label>
						<Input defaultValue="google-site-verification=849201948201" />
					</div>

					<div>
						<Label>Bing Webmaster Verification Code</Label>
						<Input defaultValue="991823719842" />
					</div>

					<Button
						onClick={() => {
							setSaved(true);
							setTimeout(() => setSaved(false), 3000);
						}}>
						<Save size={13} />
						<span>Save SEO Settings</span>
					</Button>
				</div>
			</Card>
		</div>
	);
}
