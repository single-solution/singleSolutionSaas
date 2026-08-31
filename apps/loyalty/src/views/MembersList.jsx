import React, { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Input } from '@saas/ui/inputs/TextInput';

export default function MembersList() {
	const [search, setSearch] = useState('');

	const members = [
		{ id: 'mem_1', name: 'Zainab Bibi', email: 'zainab@gmail.com', tier: 'Gold', points: 2450, spent: '$1,840' },
		{ id: 'mem_2', name: 'Farhan Ali', email: 'farhan@outlook.com', tier: 'Silver', points: 840, spent: '$620' },
		{ id: 'mem_3', name: 'Sana Malik', email: 'sana@yahoo.com', tier: 'Platinum', points: 6800, spent: '$4,500' },
	];

	return (
		<div className="space-y-6">
			<PageHeader
				title="Loyalty Program Members"
				subtitle="Directory of enrolled customers, active balances, and lifetime spend"
			/>

			<div className="space-y-4">
				<Input
					placeholder="Search by customer name, email, or tier..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
				<DataTable
					columns={[
						{
							key: 'name',
							label: 'Customer',
							render: (v, r) => (
								<Link href={`/members/${r.id}`} className="font-semibold text-zinc-900 hover:underline">
									{v}
								</Link>
							),
						},
						{ key: 'email', label: 'Email Address' },
						{
							key: 'tier',
							label: 'VIP Tier',
							render: (v) => <Badge type={v === 'Platinum' ? 'pro' : v === 'Gold' ? 'warning' : 'neutral'}>{v}</Badge>,
						},
						{
							key: 'points',
							label: 'Current Points',
							render: (v) => <strong className="font-mono text-zinc-900">{v.toLocaleString()} pts</strong>,
						},
						{ key: 'spent', label: 'Lifetime Spend' },
					]}
					data={members}
				/>
			</div>
		</div>
	);
}
