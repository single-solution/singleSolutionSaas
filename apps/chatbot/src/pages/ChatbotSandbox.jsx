import React, { useState } from 'react';
import { Bot, Send, Sparkles } from 'lucide-react';
import { Card } from '@saas/ui/cards/Card';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';

export default function ChatbotSandbox() {
	const [messages, setMessages] = useState([
		{
			sender: 'bot',
			text: 'Hello! I am your AI assistant in test mode. Ask me anything about store products or order statuses.',
		},
	]);
	const [input, setInput] = useState('');

	const handleSend = () => {
		if (!input.trim()) return;
		const userMsg = { sender: 'user', text: input };
		const botReply = {
			sender: 'bot',
			text: `[Sandbox Response] Simulated response for: "${input}". Live APIs respond in ~1.2s.`,
		};
		setMessages((prev) => [...prev, userMsg, botReply]);
		setInput('');
	};

	return (
		<div className="space-y-6 max-w-3xl">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-zinc-950">Chatbot Sandbox Simulator</h1>
					<p className="text-xs text-zinc-400">Test AI responses, intent classification, and tool execution in real-time.</p>
				</div>
				<Badge type="info">Local Sandbox</Badge>
			</div>

			<Card>
				<div className="space-y-3 min-h-[260px] max-h-[360px] overflow-y-auto mb-4 p-2">
					{messages.map((m, i) => (
						<div key={i} className={`flex gap-2 ${m.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
							<div
								className={`p-3 rounded-2xl max-w-sm text-xs leading-relaxed ${m.sender === 'user' ? 'bg-zinc-950 text-white' : 'bg-zinc-100 text-zinc-900'}`}>
								{m.text}
							</div>
						</div>
					))}
				</div>

				<div className="flex gap-2 pt-3 border-t border-zinc-100">
					<input
						type="text"
						placeholder="Type a test query (e.g. 'Where is order #8841?')..."
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => e.key === 'Enter' && handleSend()}
						className="flex-1 px-3.5 py-2 rounded-xl bg-zinc-50 border border-zinc-200 text-xs focus:outline-none focus:border-zinc-900"
					/>
					<Button onClick={handleSend} size="md">
						<Send size={13} />
						<span>Test</span>
					</Button>
				</div>
			</Card>
		</div>
	);
}
