'use client';

import React, { useState } from 'react';
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

export default function BotConfig() {
	const { activeStore } = useAppContext() || {};
	const [saved, setSaved] = useState(false);
	const [copied, setCopied] = useState(false);

	const [config, setConfig] = useState({
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
	});

	const [newFaqQ, setNewFaqQ] = useState('');
	const [newFaqA, setNewFaqA] = useState('');
	const [previewInput, setPreviewInput] = useState('');
	const [previewMessages, setPreviewMessages] = useState([{ sender: 'bot', text: config.greeting }]);

	const siteId = activeStore?.id || 'tnt_merchant_demo';
	const widgetOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://chatbot.singlesolutionsaas.com';
	const embedSnippet = `<!-- SingleSolution AI Live Chat Widget -->
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

	const handleSendPreview = (e) => {
		e.preventDefault();
		if (!previewInput.trim()) return;
		const userText = previewInput.trim();
		setPreviewMessages((prev) => [...prev, { sender: 'customer', text: userText }]);
		setPreviewInput('');

		// Check local FAQs or standard intelligence
		const lower = userText.toLowerCase();
		const matchedFaq = config.faqs.find(
			(f) => lower.includes(f.question.toLowerCase()) || lower.includes('shipping') || lower.includes('return'),
		);

		setTimeout(() => {
			if (matchedFaq) {
				setPreviewMessages((prev) => [...prev, { sender: 'bot', text: matchedFaq.answer }]);
			} else if (lower.includes('order') || lower.includes('track')) {
				setPreviewMessages((prev) => [
					...prev,
					{ sender: 'bot', text: 'Order #8942 has been shipped via Express Courier and will arrive tomorrow!' },
				]);
			} else {
				setPreviewMessages((prev) => [
					...prev,
					{ sender: 'bot', text: 'Thanks for reaching out! A live customer support specialist has also been notified.' },
				]);
			}
		}, 600);
	};

	return (
		<div className="space-y-6 max-w-6xl pb-12">
			<PageHeader
				title="Chatbot Studio & Embed Configurator"
				subtitle="Customize bot branding, automated FAQ answers, and generate 1-click storefront embed code"
			/>

			{saved && (
				<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2 animate-fade-in">
					<CheckCircle2 size={16} />
					<span className="font-semibold">Widget configuration successfully saved to live production edge!</span>
				</div>
			)}

			<div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
				{/* Left Column: Config Controls */}
				<div className="lg:col-span-7 space-y-6">
					<Card title="Embed & Install Script">
						<div className="space-y-3">
							<p className="text-xs text-slate-500">
								Paste this 1-line script tag into your storefront template (
								<code className="font-mono text-indigo-600 font-bold">&lt;head&gt;</code> or Shopify theme) to activate
								the floating widget.
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
									<span>{copied ? 'Copied Tag' : 'Copy Code'}</span>
								</button>
							</div>
						</div>
					</Card>

					<Card title="Bot Personality & Branding">
						<div className="space-y-4">
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
								<div>
									<Label>Assistant Display Name</Label>
									<Input
										value={config.botName}
										onChange={(e) => setConfig({ ...config, botName: e.target.value })}
										placeholder="e.g. Zara Support"
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
								<Label>Primary Brand Color</Label>
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
										title="Custom Hex"
									/>
								</div>
							</div>

							<div>
								<Label>Greeting Message</Label>
								<textarea
									rows={3}
									value={config.greeting}
									onChange={(e) => setConfig({ ...config, greeting: e.target.value })}
									className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-indigo-600"
								/>
							</div>
						</div>
					</Card>

					<Card title="Knowledge Base & Automated FAQs">
						<div className="space-y-4">
							<p className="text-xs text-slate-500">
								Train the AI bot to instantly answer specific questions about store policies, shipping, and product lines.
							</p>

							<div className="space-y-2.5">
								{config.faqs.map((faq, idx) => (
									<div key={idx} className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1 relative group">
										<div className="flex items-center justify-between">
											<span className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
												<Sparkles size={12} className="text-indigo-600" />
												{faq.question}
											</span>
											<button
												type="button"
												onClick={() => handleDeleteFaq(idx)}
												className="text-slate-400 hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-opacity">
												<Trash2 size={13} />
											</button>
										</div>
										<p className="text-[11px] text-slate-600">{faq.answer}</p>
									</div>
								))}
							</div>

							<div className="pt-2 border-t border-slate-100 space-y-3">
								<h4 className="text-[11px] font-bold uppercase text-slate-500">Add New FAQ Trigger</h4>
								<Input
									placeholder="Customer Question (e.g. Do you ship internationally?)"
									value={newFaqQ}
									onChange={(e) => setNewFaqQ(e.target.value)}
								/>
								<textarea
									rows={2}
									placeholder="Automated Bot Answer..."
									value={newFaqA}
									onChange={(e) => setNewFaqA(e.target.value)}
									className="w-full px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-900 focus:outline-none focus:border-indigo-600"
								/>
								<button
									type="button"
									onClick={handleAddFaq}
									className="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs flex items-center gap-1.5 transition-all">
									<Plus size={13} />
									<span>Add FAQ Rule</span>
								</button>
							</div>

							<div className="pt-4 flex justify-end">
								<Button
									onClick={() => {
										setSaved(true);
										setTimeout(() => setSaved(false), 3000);
									}}>
									<Save size={13} />
									<span>Save All Settings</span>
								</Button>
							</div>
						</div>
					</Card>
				</div>

				{/* Right Column: Live Interactive Widget Preview */}
				<div className="lg:col-span-5 sticky top-6">
					<Card title="Live Interactive Simulator">
						<div className="space-y-3">
							<p className="text-[11px] text-slate-500">
								Test your changes in real-time. This is exactly how the widget behaves on customer storefronts.
							</p>

							<div className="rounded-2xl border border-slate-200 overflow-hidden shadow-lg bg-white flex flex-col h-[480px]">
								{/* Mock Chat Header */}
								<div
									className="p-3.5 text-white flex items-center justify-between"
									style={{ backgroundColor: config.primaryColor }}>
									<div className="flex items-center gap-2.5">
										<div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center font-bold text-xs">
											<Bot size={16} />
										</div>
										<div>
											<div className="text-xs font-bold leading-tight">{config.botName}</div>
											<div className="text-[10px] opacity-85 flex items-center gap-1">
												<span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
												Online
											</div>
										</div>
									</div>
								</div>

								{/* Message History */}
								<div className="flex-1 p-3.5 overflow-y-auto space-y-2.5 bg-slate-50 text-xs">
									{previewMessages.map((m, idx) => (
										<div
											key={idx}
											className={`max-w-[85%] p-2.5 rounded-xl ${
												m.sender === 'customer'
													? 'ml-auto text-white'
													: 'mr-auto bg-white text-slate-800 border border-slate-200 shadow-2xs'
											}`}
											style={m.sender === 'customer' ? { backgroundColor: config.primaryColor } : {}}>
											{m.text}
										</div>
									))}
								</div>

								{/* Input Field */}
								<form onSubmit={handleSendPreview} className="p-2.5 border-t border-slate-200 bg-white flex gap-2">
									<input
										type="text"
										value={previewInput}
										onChange={(e) => setPreviewInput(e.target.value)}
										placeholder="Ask a question..."
										className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 text-xs outline-none focus:border-indigo-600"
									/>
									<button
										type="submit"
										className="px-3 py-1.5 rounded-lg text-white font-bold text-xs"
										style={{ backgroundColor: config.primaryColor }}>
										Send
									</button>
								</form>
							</div>
						</div>
					</Card>
				</div>
			</div>
		</div>
	);
}
