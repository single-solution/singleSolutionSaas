import React, { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Input } from '@saas/ui/inputs/TextInput';
import { Card } from '@saas/ui/cards/Card';

export default function ConversationsList() {
	const [search, setSearch] = useState('');

	const conversations = [
		{
			id: 'cv_101',
			user: 'Guest #8821',
			preview: 'Where is my delivery for #CT-9912?',
			status: 'active',
			messages: 6,
			timestamp: '1m ago',
		},
		{
			id: 'cv_102',
			user: 'Fatima Noor',
			preview: 'Is the velvet lawn suit in stock in Size M?',
			status: 'resolved',
			messages: 4,
			timestamp: '12m ago',
		},
		{
			id: 'cv_103',
			user: 'Bilal Khan',
			preview: 'Need to change shipping address urgently.',
			status: 'escalated',
			messages: 9,
			timestamp: '24m ago',
		},
	];

	return (
		<div className="space-y-6">
			<PageHeader
				title="Live Conversations"
				subtitle="Real-time multi-channel customer chats handled by AI agents and live staff"
			/>

			<Card>
				<div className="mb-4">
					<Input
						placeholder="Search conversations by user or query..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>
				<DataTable
					columns={[
						{
							key: 'user',
							label: 'Customer',
							render: (v, r) => (
								<Link href={`/conversations/${r.id}`} className="font-semibold text-zinc-900 hover:underline">
									{v}
								</Link>
							),
						},
						{
							key: 'preview',
							label: 'Last Message',
							render: (v) => <span className="text-zinc-600 truncate max-w-xs block">{v}</span>,
						},
						{
							key: 'status',
							label: 'Status',
							render: (v) => (
								<Badge type={v === 'resolved' ? 'active' : v === 'escalated' ? 'danger' : 'info'}>
									{v.toUpperCase()}
								</Badge>
							),
						},
						{ key: 'messages', label: 'Messages Count' },
						{ key: 'timestamp', label: 'Updated' },
					]}
					data={conversations}
				/>
			</Card>
		</div>
	);
}
