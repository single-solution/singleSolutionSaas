import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Send, User, Bot } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';

export default function ConversationDetail() {
	const { id } = useParams();
	const [reply, setReply] = useState('');

	const messages = [
		{
			sender: 'user',
			text: 'Hi, I placed an order #CT-9912 yesterday. Can you tell me when it will arrive?',
			time: '10:42 AM',
		},
		{
			sender: 'bot',
			text: 'Hello! Let me check that for you right away. Order #CT-9912 is currently packed and scheduled for courier pickup today at 4:00 PM. Estimated delivery is tomorrow afternoon.',
			time: '10:42 AM',
		},
		{ sender: 'user', text: 'Great, thanks! Can I still change the delivery phone number?', time: '10:44 AM' },
		{
			sender: 'bot',
			text: 'Yes! Please reply with the new phone number and I will update your shipping manifest immediately.',
			time: '10:44 AM',
		},
	];

	return (
		<div className="space-y-6 max-w-4xl">
			<PageHeader
				title={`Conversation ${id || '#cv_101'}`}
				subtitle="Customer Support Session • Sisters Boutique Storefront"
				actions={
					<div className="flex items-center gap-2">
						<Badge type="active">AI Handled</Badge>
						<Link href="/">
							<Button variant="secondary" size="sm">
								Back to Inbox
							</Button>
						</Link>
					</div>
				}
			/>

			<Card>
				<div className="space-y-4 mb-6">
					{messages.map((m, i) => (
						<div key={i} className={`flex gap-3 ${m.sender === 'user' ? 'justify-start' : 'justify-end'}`}>
							{m.sender === 'user' && (
								<div className="w-8 h-8 rounded-full bg-zinc-200 text-zinc-700 flex items-center justify-center text-xs font-bold shrink-0">
									<User size={14} />
								</div>
							)}
							<div
								className={`p-4 rounded-2xl max-w-md text-xs leading-relaxed ${m.sender === 'user' ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-950 text-white shadow-xs'}`}>
								<p>{m.text}</p>
								<span
									className={`block text-[10px] mt-1 ${m.sender === 'user' ? 'text-zinc-400' : 'text-zinc-400 text-right'}`}>
									{m.time}
								</span>
							</div>
							{m.sender === 'bot' && (
								<div className="w-8 h-8 rounded-full bg-zinc-950 text-white flex items-center justify-center text-xs font-bold shrink-0">
									<Bot size={14} />
								</div>
							)}
						</div>
					))}
				</div>

				<div className="pt-4 border-t border-zinc-100 flex gap-2">
					<input
						type="text"
						placeholder="Type a human agent takeover reply..."
						value={reply}
						onChange={(e) => setReply(e.target.value)}
						className="flex-1 px-4 py-2 text-xs rounded-xl bg-zinc-50 border border-zinc-200 focus:outline-none focus:border-zinc-900"
					/>
					<Button size="md">
						<Send size={13} />
						<span>Send</span>
					</Button>
				</div>
			</Card>
		</div>
	);
}
