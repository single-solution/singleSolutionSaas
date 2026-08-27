import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Input } from '@saas/ui/inputs/TextInput';
import { usePortal } from '../../context/PortalContext';

export default function AuditLogs() {
	const { auditLogs } = usePortal();
	const [search, setSearch] = useState('');

	const filteredLogs = auditLogs.filter(
		(l) =>
			l.actor.toLowerCase().includes(search.toLowerCase()) ||
			l.action.toLowerCase().includes(search.toLowerCase()) ||
			l.target.toLowerCase().includes(search.toLowerCase()),
	);

	return (
		<div className="space-y-6">
			<PageHeader
				title="Platform Security & Audit Trail"
				subtitle="Immutable event logs recording administrative, tenant, and API security operations"
			/>

			<div className="relative">
				<Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400" size={15} />
				<Input
					className="pl-10"
					placeholder="Filter audit trail by actor, action, or target ID..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
			</div>

			<DataTable
				columns={[
					{
						key: 'timestamp',
						label: 'Time',
						render: (v) => <span className="font-mono text-xs text-zinc-400">{v}</span>,
					},
					{
						key: 'actor',
						label: 'Initiator',
						render: (v) => <strong className="text-zinc-900 text-xs font-semibold">{v}</strong>,
					},
					{
						key: 'action',
						label: 'Event Action',
						render: (v) => <span className="text-zinc-700 text-xs">{v}</span>,
					},
					{
						key: 'target',
						label: 'Target Entity',
						render: (v) => <span className="font-mono text-xs text-zinc-500">{v}</span>,
					},
					{
						key: 'type',
						label: 'Severity',
						render: (v) => (
							<Badge type={v === 'danger' ? 'danger' : v === 'warning' ? 'warning' : 'info'}>{v.toUpperCase()}</Badge>
						),
					},
				]}
				data={filteredLogs}
			/>
		</div>
	);
}
