'use client';

import React, { useState, useEffect } from 'react';
import { Save, CheckCircle2, Copy, Check, MessageSquare, Bot, Sparkles, Plus, Trash2, Globe } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { useAppContext } from '../context/AppContext';

const COLOR_PRESETS = [
	{ name: 'Indigo Blue', hex: '#4F46E5' },
	{ name: 'Emerald Green', hex: '#059669' },
	{ name: 'Royal Violet', hex: '#7C3AED' },
	{ name: 'Rose Red', hex: '#E11D48' },
	{ name: 'Amber Gold', hex: '#D97706' },
	{ name: 'Midnight Slate', hex: '#0F172A' },
];

const DEFAULT_CONFIG = {
	botName: 'Emma AI Support',
	greeting: 'Hi there! 👋 How can I help you with your order, returns, or product recommendations today?',
	primaryColor: '#4F46E5',
	position: 'right',
	faqs: [
		{
			question: 'What is your return policy?',
			answer: 'We offer a 30-day full refund policy on unworn items with original tags intact.',
		},
		{
			question: 'How fast is standard shipping?',
			answer: 'Standard shipping arrives in 2-4 business days across Pakistan. Free on orders above Rs. 3,000.',
		},
		{
			question: 'Do you offer cash on delivery?',
			answer: 'Yes, Cash on Delivery (COD) is available nationwide for all orders.',
		},
	],
};

export default function BotConfig() {
	const { activeStore, activeWebsite, getWebsiteConfig, saveWebsiteConfig } = useAppContext() || {};
	const [saved, setSaved] = useState(false);
	const [copied, setCopied] = useState(false);

	const [config, setConfig] = useState(DEFAULT_CONFIG);

	// Load isolated website config when activeWebsite changes
	useEffect(() => {
		if (getWebsiteConfig) {
			const loaded = getWebsiteConfig('bot_config', {
				...DEFAULT_CONFIG,
				botName: activeWebsite?.name ? `${activeWebsite.name} AI Assistant` : 'Storefront AI Assistant',
			});
			setConfig(loaded);
			setPreviewMessages([{ sender: 'bot', text: loaded.greeting || DEFAULT_CONFIG.greeting }]);
		}
	}, [activeWebsite, getWebsiteConfig]);

	const [newFaqQ, setNewFaqQ] = useState('');
	const [newFaqA, setNewFaqA] = useState('');
	const [previewInput, setPreviewInput] = useState('');
	const [previewMessages, setPreviewMessages] = useState([{ sender: 'bot', text: config.greeting }]);

	const siteId = activeWebsite?.id || activeStore?.id || 'tnt_merchant_demo';
	const widgetOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://chatbot.singlesolutionsaas.com';
	const embedSnippet = `<!-- SingleSolution AI Live Chat Widget for ${activeWebsite?.name || 'Storefront'} -->
<script
  defer
  src="${widgetOrigin}/widget.js"
  data-site-id="${siteId}"
  data-bot-name="${config.botName}"
  data-color="${config.primaryColor}"
></script>`;

	const handleCopy = () => {
		navigator.clipboard.writeText(embedSnippet);
		setCopied(true);
		setTimeout(() => setCopied(false), 2500);
	};

	const handleSave = () => {
		if (saveWebsiteConfig) {
			saveWebsiteConfig('bot_config', config);
		}
		setSaved(true);
		setTimeout(() => setSaved(false), 3000);
	};

	const handleAddFaq = () => {
		if (!newFaqQ.trim() || !newFaqA.trim()) return;
		setConfig((prev) => ({
			...prev,
			faqs: [...prev.faqs, { question: newFaqQ.trim(), answer: newFaqA.trim() }],
		}));
		setNewFaqQ('');
		setNewFaqA('');
	};

	const handleDeleteFaq = (idx) => {
		setConfig((prev) => ({
			...prev,
			faqs: prev.faqs.filter((_, i) => i !== idx),
		}));
	};

	const handleSendMessage = (e) => {
		e.preventDefault();
		if (!previewInput.trim()) return;

		const userMsg = previewInput.trim();
		setPreviewMessages((prev) => [...prev, { sender: 'user', text: userMsg }]);
		setPreviewInput('');

		// Simulate AI bot intelligence
		setTimeout(() => {
			const lower = userMsg.toLowerCase();
			let botReply = `Thanks for asking! I'm ${config.botName}, and I can help look up your orders or assist with product sizing.`;

			const matchedFaq = config.faqs.find((f) => lower.includes(f.question.toLowerCase().slice(0, 15)));
			if (matchedFaq) {
				botReply = matchedFaq.answer;
			} else if (lower.includes('order') || lower.includes('#') || lower.includes('track')) {
				botReply = 'Please provide your Order ID (e.g. #9482) and I will look up real-time courier tracking immediately!';
			} else if (lower.includes('human') || lower.includes('agent') || lower.includes('help')) {
				botReply = 'Connecting you with a human support specialist... Please hold for 30 seconds.';
			}

			setPreviewMessages((prev) => [...prev, { sender: 'bot', text: botReply }]);
		}, 600);
	};

	return (
		<div className="space-y-6 max-w-6xl pb-12">
			<PageHeader
				title="Chatbot Studio & Embed Generator"
				subtitle={`Configure AI assistant knowledge, branding, and copy 1-line script for ${activeWebsite?.name || 'your store'}`}
			/>

			{saved && (
				<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2 animate-fade-in">
					<CheckCircle2 size={16} />
					<span className="font-semibold">
						Bot settings saved for website: <strong>{activeWebsite?.name}</strong> ({activeWebsite?.domain})
					</span>
				</div>
			)}

			{/* 1-Click Embed Snippet */}
			<Card title={`Storefront Script Tag (${activeWebsite?.name || 'Active Website'})`}>
				<div className="space-y-3">
					<p className="text-xs text-slate-500">
						Paste this 1-line script tag into your storefront{' '}
						<code className="font-mono text-indigo-600 font-bold">&lt;head&gt;</code> to activate the AI Chatbot on{' '}
						<strong>{activeWebsite?.domain || 'your domain'}</strong>.
					</p>
					<div className="relative">
						<pre className="p-3.5 rounded-xl bg-slate-900 text-slate-200 font-mono text-[11px] overflow-x-auto leading-relaxed border border-slate-800">
							{embedSnippet}
						</pre>
						<button
							type="button"
							onClick={handleCopy}
							className="absolute top-2.5 right-2.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition-all">
							{copied ? <Check size={13} /> : <Copy size={13} />}
							<span>{copied ? 'Copied Snippet' : 'Copy Script Tag'}</span>
						</button>
					</div>
				</div>
			</Card>

			{/* Main Studio Grid */}
			<div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
				{/* Left Column: Form Controls */}
				<div className="lg:col-span-7 space-y-6">
					<Card title="Bot Identity & Appearance">
						<div className="space-y-4">
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
								<div>
									<Label>Assistant Display Name</Label>
									<Input
										value={config.botName}
										onChange={(e) => setConfig({ ...config, botName: e.target.value })}
										placeholder="e.g. Emma AI Support"
									/>
								</div>
								<div>
									<Label>Widget Launcher Position</Label>
									<div className="flex gap-2">
										<button
											type="button"
											onClick={() => setConfig({ ...config, position: 'right' })}
											className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-all ${
												config.position === 'right'
													? 'bg-indigo-50 border-indigo-600 text-indigo-700'
													: 'border-slate-200 text-slate-600 hover:bg-slate-50'
											}`}>
											Bottom Right
										</button>
										<button
											type="button"
											onClick={() => setConfig({ ...config, position: 'left' })}
											className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-all ${
												config.position === 'left'
													? 'bg-indigo-50 border-indigo-600 text-indigo-700'
													: 'border-slate-200 text-slate-600 hover:bg-slate-50'
											}`}>
											Bottom Left
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
												config.primaryColor === p.hex
													? 'ring-2 ring-offset-2 ring-slate-900 scale-110'
													: 'hover:scale-105'
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
										title="Custom Color"
									/>
								</div>
							</div>

							<div>
								<Label>Greeting Message</Label>
								<textarea
									rows={3}
									value={config.greeting}
									onChange={(e) => setConfig({ ...config, greeting: e.target.value })}
									className="w-full p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-800 outline-none focus:border-indigo-600 transition-all leading-relaxed"
								/>
							</div>
						</div>
					</Card>

					<Card title="Store Knowledge Base & FAQs">
						<div className="space-y-4">
							<div className="space-y-3">
								{config.faqs.map((faq, idx) => (
									<div
										key={idx}
										className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1 relative group">
										<div className="flex items-center justify-between font-bold text-slate-800">
											<span>Q: {faq.question}</span>
											<button
												type="button"
												onClick={() => handleDeleteFaq(idx)}
												className="text-slate-400 hover:text-rose-600 transition-colors">
												<Trash2 size={13} />
											</button>
										</div>
										<p className="text-slate-600 text-[11px] leading-relaxed">A: {faq.answer}</p>
									</div>
								))}
							</div>

							<div className="p-3.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/50 space-y-2.5">
								<span className="font-bold text-xs text-slate-800">Add New FAQ Question</span>
								<Input
									placeholder="Customer Question (e.g. How do I exchange sizes?)"
									value={newFaqQ}
									onChange={(e) => setNewFaqQ(e.target.value)}
								/>
								<textarea
									rows={2}
									placeholder="Bot Answer (e.g. You can exchange sizes within 7 days by contacting us.)"
									value={newFaqA}
									onChange={(e) => setNewFaqA(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-white border border-slate-200 text-xs text-slate-800 outline-none focus:border-indigo-600"
								/>
								<button
									type="button"
									onClick={handleAddFaq}
									className="px-3.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs flex items-center gap-1.5 transition-all">
									<Plus size={13} />
									<span>Add FAQ</span>
								</button>
							</div>
						</div>
					</Card>

					<div className="flex justify-end">
						<Button onClick={handleSave}>
							<Save size={14} />
							<span>Save Settings for {activeWebsite?.name || 'Website'}</span>
						</Button>
					</div>
				</div>

				{/* Right Column: Live Interactive Phone Simulator */}
				<div className="lg:col-span-5 space-y-4">
					<div className="flex items-center justify-between">
						<span className="font-bold text-xs text-slate-700 flex items-center gap-1.5">
							<Sparkles size={14} className="text-indigo-600" />
							Interactive Live Simulator
						</span>
						<span className="text-[10px] font-mono text-slate-400">{activeWebsite?.domain || 'Storefront Preview'}</span>
					</div>

					{/* Phone Frame */}
					<div className="w-full max-w-sm mx-auto rounded-[32px] border-4 border-slate-800 bg-slate-900 p-2 shadow-2xl">
						<div className="rounded-[24px] bg-slate-50 overflow-hidden flex flex-col h-[520px] relative">
							{/* Widget Header */}
							<div
								className="p-4 text-white flex items-center justify-between shadow-xs"
								style={{ backgroundColor: config.primaryColor }}>
								<div className="flex items-center gap-2.5">
									<div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center font-bold text-xs">
										<Bot size={16} />
									</div>
									<div>
										<div className="font-extrabold text-xs leading-none">{config.botName}</div>
										<div className="text-[10px] opacity-85 flex items-center gap-1 mt-0.5">
											<span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
											<span>Online • Instant Reply</span>
										</div>
									</div>
								</div>
							</div>

							{/* Chat Messages */}
							<div className="flex-1 p-3 overflow-y-auto space-y-2.5 text-xs">
								{previewMessages.map((msg, idx) => (
									<div
										key={idx}
										className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}>
										<div
											className={`max-w-[80%] p-2.5 rounded-2xl ${
												msg.sender === 'user'
													? 'bg-indigo-600 text-white rounded-br-xs'
													: 'bg-white border border-slate-200/80 text-slate-800 rounded-bl-xs shadow-2xs'
											}`}>
											<p className="text-[11px] leading-relaxed">{msg.text}</p>
										</div>
									</div>
								))}
							</div>

							{/* Input Bar */}
							<form onSubmit={handleSendMessage} className="p-2 bg-white border-t border-slate-200 flex gap-1.5">
								<input
									type="text"
									placeholder="Ask a question..."
									value={previewInput}
									onChange={(e) => setPreviewInput(e.target.value)}
									className="flex-1 px-3 py-1.5 rounded-xl bg-slate-100 text-xs text-slate-800 outline-none focus:bg-slate-50"
								/>
								<button
									type="submit"
									className="px-3 py-1.5 rounded-xl text-white font-bold text-xs"
									style={{ backgroundColor: config.primaryColor }}>
									Send
								</button>
							</form>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
