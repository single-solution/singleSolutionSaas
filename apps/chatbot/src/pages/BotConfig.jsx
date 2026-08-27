import React, { useState } from 'react';
import { Save, CheckCircle2 } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { Select } from '@saas/ui/selects/Select';

export default function BotConfig() {
	const [saved, setSaved] = useState(false);
	const [systemPrompt, setSystemPrompt] = useState(
		'You are an AI Store Assistant. You help customers look up orders, get size recommendations, and resolve support queries with polite and concise answers.',
	);

	return (
		<div className="space-y-6 max-w-3xl">
			<PageHeader
				title="Bot Prompts & Rules"
				subtitle="Configure the AI personality, system instructions, and response constraints"
			/>

			{saved && (
				<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
					<CheckCircle2 size={15} />
					<span>Bot configuration saved and deployed to edge runtime.</span>
				</div>
			)}

			<Card title="Agent Personality & Prompt">
				<div className="space-y-4">
					<div>
						<Label>Bot Name</Label>
						<Input defaultValue="Store Concierge" />
					</div>

					<div>
						<Label>Base LLM Model</Label>
						<Select defaultValue="gemini-1.5-flash">
							<option value="gemini-1.5-flash">Google Gemini 1.5 Flash (Ultra Fast Edge)</option>
							<option value="gemini-1.5-pro">Google Gemini 1.5 Pro (Deep Reasoning)</option>
							<option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
						</Select>
					</div>

					<div>
						<Label>System Instructions & Knowledge Base Guidelines</Label>
						<textarea
							rows={5}
							value={systemPrompt}
							onChange={(e) => setSystemPrompt(e.target.value)}
							className="w-full px-3.5 py-2 rounded-xl bg-zinc-50 border border-zinc-200 text-xs text-zinc-900 focus:outline-none focus:border-zinc-900 font-mono"
						/>
					</div>

					<Button
						onClick={() => {
							setSaved(true);
							setTimeout(() => setSaved(false), 3000);
						}}>
						<Save size={13} />
						<span>Save Configuration</span>
					</Button>
				</div>
			</Card>
		</div>
	);
}
