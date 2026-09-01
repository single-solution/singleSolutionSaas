'use client';

import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Send, User, Bot, CheckCircle, AlertTriangle, ArrowLeft } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { useAppContext } from '../context/AppContext';

export default function ConversationDetail() {
	const params = useParams();
	const convoId = params?.id || 'conv_live_891';
	const { activeStore } = useAppContext() || {};

	const [convo, setConvo] = useState(null);
	const [messages, setMessages] = useState([
		{
			sender: 'customer',
			text: 'Hi! I placed an order #9421 yesterday. When will it arrive?',
			timestamp: new Date(Date.now() - 10 * 60000).toISOString(),
		},
		{
			sender: 'bot',
			text: 'Order #9421 has been packed and scheduled for courier dispatch today. Estimated delivery is tomorrow by 5:00 PM.',
			timestamp: new Date(Date.now() - 9 * 60000).toISOString(),
		},
	]);
	const [reply, setReply] = useState('');
	const [status, setStatus] = useState('Active');

	useEffect(() => {
		fetch(`/api/chat?conversationId=${convoId}`)
			.then((res) => res.json())
			.then((data) => {
				if (data?.conversation) {
					setConvo(data.conversation);
					if (Array.isArray(data.conversation.messages) && data.conversation.messages.length > 0) {
						setMessages(data.conversation.messages);
					}
					if (data.conversation.status) {
						setStatus(data.conversation.status);
					}
				}
			})
			.catch(() => {});
	}, [convoId]);

	const handleSendReply = (e) => {
		e.preventDefault();
		if (!reply.trim()) return;

		const newMsg = {
			sender: 'agent',
			text: reply.trim(),
			timestamp: new Date().toISOString(),
		};

		setMessages((prev) => [...prev, newMsg]);
		setReply('');

		// Post to backend
		fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				conversationId: convoId,
				tenantId: activeStore?.id || 'default',
				message: `[Human Staff Response]: ${newMsg.text}`,
				customerName: convo?.customerName || 'Customer',
			}),
		}).catch(() => {});
	};

	return (
		<div className="space-y-6 max-w-4xl pb-12">
			<PageHeader
				title={`Conversation #${convoId.substring(0, 12)}`}
				subtitle={`Live Support Session • ${convo?.customerName || 'Ayesha Tariq'}`}
				actions={
					<div className="flex items-center gap-2">
						<Badge type={status === 'Resolved' ? 'active' : status === 'Escalated' ? 'danger' : 'info'}>{status}</Badge>
						<button
							type="button"
							onClick={() => setStatus(status === 'Resolved' ? 'Active' : 'Resolved')}
							className="px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs flex items-center gap-1.5 transition-all">
							<CheckCircle size={13} className="text-emerald-600" />
							<span>{status === 'Resolved' ? 'Reopen Chat' : 'Mark Resolved'}</span>
						</button>
						<Link href="/conversations">
							<Button variant="secondary" size="sm">
								<ArrowLeft size={13} />
								<span>Inbox</span>
							</Button>
						</Link>
					</div>
				}
			/>

			<Card>
				<div className="space-y-4 mb-6 min-h-[300px] max-h-[500px] overflow-y-auto p-2">
					{messages.map((m, i) => (
						<div key={i} className={`flex gap-3 ${m.sender === 'customer' ? 'justify-start' : 'justify-end'}`}>
							{m.sender === 'customer' && (
								<div className="w-8 h-8 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-xs font-bold shrink-0">
									<User size={14} />
								</div>
							)}
							<div
								className={`p-3.5 rounded-2xl max-w-md text-xs leading-relaxed ${
									m.sender === 'customer'
										? 'bg-slate-100 text-slate-900 border border-slate-200'
										: m.sender === 'agent'
											? 'bg-indigo-600 text-white shadow-xs'
											: 'bg-slate-900 text-white shadow-xs'
								}`}>
								<div className="text-[10px] font-bold opacity-75 mb-0.5">
									{m.sender === 'customer' ? 'Customer' : m.sender === 'agent' ? 'Staff Agent' : 'AI Bot'}
								</div>
								<p>{m.text}</p>
								<span className="block text-[10px] mt-1 opacity-70 text-right">
									{m.timestamp
										? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
										: '10:42 AM'}
								</span>
							</div>
							{m.sender !== 'customer' && (
								<div className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-bold shrink-0">
									<Bot size={14} />
								</div>
							)}
						</div>
					))}
				</div>

				<form onSubmit={handleSendReply} className="pt-4 border-t border-slate-100 flex gap-2">
					<input
						type="text"
						placeholder="Type a human takeover response to send to the customer..."
						value={reply}
						onChange={(e) => setReply(e.target.value)}
						className="flex-1 px-4 py-2.5 text-xs rounded-xl bg-slate-50 border border-slate-200 focus:outline-none focus:border-indigo-600"
					/>
					<Button size="md" type="submit">
						<Send size={13} />
						<span>Send Message</span>
					</Button>
				</form>
			</Card>
		</div>
	);
}
