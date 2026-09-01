'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { Users, Search, Plus, Award, ArrowUpRight } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Input } from '@saas/ui/inputs/TextInput';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { useAppContext } from '../context/AppContext';

export default function MembersList() {
	const { activeStore } = useAppContext() || {};
	const [search, setSearch] = useState('');
	const [members, setMembers] = useState([]);
	const [loading, setLoading] = useState(true);
	const [isAdjustOpen, setIsAdjustOpen] = useState(false);
	const [adjustEmail, setAdjustEmail] = useState('');
	const [adjustName, setAdjustName] = useState('');
	const [adjustPoints, setAdjustPoints] = useState('');
	const [adjustReason, setAdjustReason] = useState('Manual Loyalty Adjustment');

	const fetchMembers = () => {
		const tenantId = activeStore?.id || 'default';
		fetch(`/api/points?tenantId=${tenantId}`)
			.then((res) => res.json())
			.then((data) => {
				if (data && Array.isArray(data.members) && data.members.length > 0) {
					setMembers(data.members);
				} else {
					setMembers([
						{
							customerEmail: 'zainab.bibi@example.com',
							customerName: 'Zainab Bibi',
							pointsBalance: 1250,
							tierStatus: 'Gold',
							joinedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
						},
						{
							customerEmail: 'farhan.ali@example.com',
							customerName: 'Farhan Ali',
							pointsBalance: 480,
							tierStatus: 'Silver',
							joinedAt: new Date(Date.now() - 12 * 86400000).toISOString(),
						},
						{
							customerEmail: 'sana.malik@example.com',
							customerName: 'Sana Malik',
							pointsBalance: 3100,
							tierStatus: 'Platinum',
							joinedAt: new Date(Date.now() - 60 * 86400000).toISOString(),
						},
					]);
				}
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	};

	useEffect(() => {
		fetchMembers();
	}, [activeStore]);

	const handleAdjust = async (e) => {
		e.preventDefault();
		if (!adjustEmail.trim() || !adjustPoints) return;

		await fetch('/api/points', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tenantId: activeStore?.id || 'default',
				customerEmail: adjustEmail.trim(),
				customerName: adjustName.trim() || 'Valued Member',
				points: Number(adjustPoints),
				action: Number(adjustPoints) >= 0 ? 'earn' : 'redeem',
				reason: adjustReason,
			}),
		}).catch(() => {});

		setIsAdjustOpen(false);
		setAdjustEmail('');
		setAdjustName('');
		setAdjustPoints('');
		fetchMembers();
	};

	const filteredMembers = members.filter(
		(m) =>
			(m.customerName || '').toLowerCase().includes(search.toLowerCase()) ||
			(m.customerEmail || '').toLowerCase().includes(search.toLowerCase()) ||
			(m.tierStatus || '').toLowerCase().includes(search.toLowerCase()),
	);

	return (
		<div className="space-y-6 max-w-6xl pb-12">
			<PageHeader
				title="Loyalty Member Directory"
				subtitle="Manage enrolled customer accounts, tier status, and manual point balance adjustments"
				actions={
					<Button onClick={() => setIsAdjustOpen(true)} size="sm">
						<Plus size={13} />
						<span>Adjust Member Points</span>
					</Button>
				}
			/>

			<div className="flex items-center justify-between gap-4">
				<div className="w-full sm:w-80">
					<Input
						placeholder="Search by customer name, email, or tier..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>
			</div>

			<Card>
				<DataTable
					columns={[
						{
							key: 'customerName',
							label: 'Customer',
							render: (v, r) => (
								<Link
									href={`/members/${encodeURIComponent(r.customerEmail)}`}
									className="font-bold text-slate-900 hover:text-amber-600 flex items-center gap-2">
									<div className="w-7 h-7 rounded-full bg-amber-50 text-amber-700 flex items-center justify-center font-extrabold text-[11px]">
										{(v || 'M')[0]}
									</div>
									<div>
										<div>{v || 'Valued Customer'}</div>
										<div className="text-[10px] text-slate-400 font-normal">{r.customerEmail}</div>
									</div>
								</Link>
							),
						},
						{
							key: 'tierStatus',
							label: 'VIP Tier',
							render: (v) => {
								const t = v || 'Bronze';
								const badgeType = t === 'Platinum' ? 'pro' : t === 'Gold' ? 'warning' : 'active';
								return <Badge type={badgeType}>{t}</Badge>;
							},
						},
						{
							key: 'pointsBalance',
							label: 'Points Balance',
							render: (v) => <strong className="font-mono text-amber-600">{Number(v || 0).toLocaleString()} pts</strong>,
						},
						{
							key: 'joinedAt',
							label: 'Enrolled Date',
							render: (v) => (
								<span className="text-[11px] text-slate-500">{v ? new Date(v).toLocaleDateString() : 'Active'}</span>
							),
						},
					]}
					data={filteredMembers}
				/>
			</Card>

			{/* Manual Adjustment Modal */}
			{isAdjustOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-4">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<h3 className="text-sm font-bold text-slate-900">Adjust Member Points</h3>
							<button onClick={() => setIsAdjustOpen(false)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						<form onSubmit={handleAdjust} className="space-y-3.5 text-xs">
							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Customer Email</label>
								<input
									type="email"
									required
									placeholder="customer@store.com"
									value={adjustEmail}
									onChange={(e) => setAdjustEmail(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-amber-600"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
									Customer Name (Optional)
								</label>
								<input
									type="text"
									placeholder="e.g. Fatima Tariq"
									value={adjustName}
									onChange={(e) => setAdjustName(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-amber-600"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Points Delta (+ or -)</label>
								<input
									type="number"
									required
									placeholder="+250 or -100"
									value={adjustPoints}
									onChange={(e) => setAdjustPoints(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono outline-none focus:border-amber-600"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Reason / Tag</label>
								<input
									type="text"
									value={adjustReason}
									onChange={(e) => setAdjustReason(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-amber-600"
								/>
							</div>

							<div className="pt-3 flex gap-2 justify-end">
								<button
									type="button"
									onClick={() => setIsAdjustOpen(false)}
									className="px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 font-semibold">
									Cancel
								</button>
								<button
									type="submit"
									className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold shadow-xs">
									Save Adjustment
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
}
