'use client';

import React, { useState } from 'react';
import { Save, CheckCircle2, Copy, Check, Sparkles, Gift, Award, Users } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { useAppContext } from '../context/AppContext';

const COLOR_PRESETS = [
	{ name: 'Amber Gold', hex: '#D97706' },
	{ name: 'Emerald Green', hex: '#059669' },
	{ name: 'Indigo Blue', hex: '#4F46E5' },
	{ name: 'Rose Red', hex: '#E11D48' },
	{ name: 'Royal Violet', hex: '#7C3AED' },
	{ name: 'Midnight Slate', hex: '#0F172A' },
];

export default function Settings() {
	const { activeStore } = useAppContext() || {};
	const [saved, setSaved] = useState(false);
	const [copied, setCopied] = useState(false);

	const [config, setConfig] = useState({
		programName: 'VIP Club Rewards',
		primaryColor: '#D97706',
		position: 'left',
		pointsPerDollar: '5',
		welcomeBonus: '100',
		referralBonus: '150',
		minRedeemPoints: '100',
	});

	const siteId = activeStore?.id || 'tnt_merchant_demo';
	const rewardsOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://loyalty.singlesolutionsaas.com';
	const embedSnippet = `<!-- SingleSolution Loyalty Rewards Launcher -->
<script
  defer
  src="${rewardsOrigin}/rewards.js"
  data-site-id="${siteId}"
  data-program-name="${config.programName}"
  data-color="${config.primaryColor}"
></script>`;

	const handleCopy = () => {
		navigator.clipboard.writeText(embedSnippet);
		setCopied(true);
		setTimeout(() => setCopied(false), 2500);
	};

	return (
		<div className="space-y-6 max-w-4xl pb-12">
			<PageHeader
				title="Loyalty Hub & Embed Configurator"
				subtitle="Configure customer points economy, VIP rewards launcher, and copy 1-line storefront embed snippet"
			/>

			{saved && (
				<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2 animate-fade-in">
					<CheckCircle2 size={16} />
					<span className="font-semibold">Loyalty program rules & embed widget settings saved successfully!</span>
				</div>
			)}

			<Card title="Embed & Install Script">
				<div className="space-y-3">
					<p className="text-xs text-slate-500">
						Paste this script tag into your storefront template (
						<code className="font-mono text-indigo-600 font-bold">&lt;head&gt;</code> or Shopify theme) to display the
						floating Rewards bubble on your store.
					</p>
					<div className="relative">
						<pre className="p-3.5 rounded-xl bg-slate-900 text-slate-200 font-mono text-[11px] overflow-x-auto leading-relaxed border border-slate-800">
							{embedSnippet}
						</pre>
						<button
							type="button"
							onClick={handleCopy}
							className="absolute top-2.5 right-2.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition-all">
							{copied ? <Check size={13} /> : <Copy size={13} />}
							<span>{copied ? 'Copied Tag' : 'Copy Code'}</span>
						</button>
					</div>
				</div>
			</Card>

			<Card title="Storefront Bubble Appearance">
				<div className="space-y-4">
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<div>
							<Label>Program Display Name</Label>
							<Input
								value={config.programName}
								onChange={(e) => setConfig({ ...config, programName: e.target.value })}
								placeholder="e.g. VIP Club Rewards"
							/>
						</div>
						<div>
							<Label>Bubble Launcher Position</Label>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => setConfig({ ...config, position: 'left' })}
									className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-all ${
										config.position === 'left'
											? 'bg-amber-50 border-amber-600 text-amber-700'
											: 'border-slate-200 text-slate-600 hover:bg-slate-50'
									}`}>
									Bottom Left
								</button>
								<button
									type="button"
									onClick={() => setConfig({ ...config, position: 'right' })}
									className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-all ${
										config.position === 'right'
											? 'bg-amber-50 border-amber-600 text-amber-700'
											: 'border-slate-200 text-slate-600 hover:bg-slate-50'
									}`}>
									Bottom Right
								</button>
							</div>
						</div>
					</div>

					<div>
						<Label>Theme Color</Label>
						<div className="flex flex-wrap items-center gap-2 pt-1">
							{COLOR_PRESETS.map((p) => (
								<button
									key={p.hex}
									type="button"
									onClick={() => setConfig({ ...config, primaryColor: p.hex })}
									className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
										config.primaryColor === p.hex ? 'ring-2 ring-offset-2 ring-slate-900 scale-110' : 'hover:scale-105'
									}`}
									style={{ backgroundColor: p.hex }}
									title={p.name}>
									{config.primaryColor === p.hex && <Check size={14} className="text-white" />}
								</button>
							))}
							<input
								type="color"
								value={config.primaryColor}
								onChange={(e) => setConfig({ ...config, primaryColor: e.target.value })}
								className="w-8 h-8 rounded-full border-0 p-0 cursor-pointer"
								title="Custom Hex"
							/>
						</div>
					</div>
				</div>
			</Card>

			<Card title="Point Earning & Referral Rules">
				<div className="space-y-4">
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<div>
							<Label>Points Earned Per $1 Spent</Label>
							<Input
								value={config.pointsPerDollar}
								onChange={(e) => setConfig({ ...config, pointsPerDollar: e.target.value })}
								placeholder="e.g. 5"
							/>
						</div>
						<div>
							<Label>New Account Welcome Bonus (Points)</Label>
							<Input
								value={config.welcomeBonus}
								onChange={(e) => setConfig({ ...config, welcomeBonus: e.target.value })}
								placeholder="e.g. 100"
							/>
						</div>
						<div>
							<Label>Refer-a-Friend Reward (Points)</Label>
							<Input
								value={config.referralBonus}
								onChange={(e) => setConfig({ ...config, referralBonus: e.target.value })}
								placeholder="e.g. 150"
							/>
						</div>
						<div>
							<Label>Minimum Points Required to Redeem</Label>
							<Input
								value={config.minRedeemPoints}
								onChange={(e) => setConfig({ ...config, minRedeemPoints: e.target.value })}
								placeholder="e.g. 100"
							/>
						</div>
					</div>

					<div className="pt-4 flex justify-end">
						<Button
							onClick={() => {
								setSaved(true);
								setTimeout(() => setSaved(false), 3000);
							}}>
							<Save size={13} />
							<span>Save Loyalty Rules</span>
						</Button>
					</div>
				</div>
			</Card>
		</div>
	);
}
