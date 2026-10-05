'use client';
/**
 * Website lookup by domain (live or test twin) and transfer of a website — with its test twin, domain claim and
 * grants, in one transaction — to another merchant (reason required, typed confirmation).
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Card,
	Dialog,
	EmptyState,
	FormError,
	Icon,
	Input,
	KeyValueList,
	PageHeader,
	Select,
	StatusBadge,
	TypedConfirmDialog,
	describeProblem,
	fieldErrors,
	formatDateTime,
	useToast,
} from '@ss/ui';
import { Link } from '../../link.js';
import { adminFetch } from '../client.js';
import { ID, adminApi, adminRoutes } from '../paths.js';
import { ActionProblem, AdminProblem, IdChip, staffCan } from './common.js';
import { WebsiteSettingsCard } from '../../views/websites.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * @param {any} props loader result of `loadWebsites` plus `staff`
 */
export function WebsitesView(props) {
	const toast = useToast();
	const [results, setResults] = useState(/** @type {any[]} */ (props.ok ? props.results : []));
	const [transferring, setTransferring] = useState(/** @type {any} */ (null));
	const [target, setTarget] = useState('');
	const [targetError, setTargetError] = useState(/** @type {string | null} */ (null));
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	const { filter, merchants, staff } = props;
	const canWrite = staffCan(staff, 'platform.merchants.write');

	const next = () => {
		const id = target.trim();
		if (!ID.merchant.test(id)) {
			setTargetError('Enter the target merchant id (mer_…).');
			return;
		}
		if (id === transferring.merchantId) {
			setTargetError('The website already belongs to this merchant.');
			return;
		}
		setTargetError(null);
		setProblem(null);
		setConfirming(true);
	};
	const transfer = async (/** @type {{ reason: string }} */ { reason }) => {
		setBusy(true);
		setProblem(null);
		const result = await adminFetch(adminApi.transfer(transferring.websiteId), {
			method: 'POST',
			body: { toMerchantId: target.trim(), reason },
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			const fe = fieldErrors(result.problem);
			if (fe.toMerchantId) {
				setTargetError(fe.toMerchantId);
				setConfirming(false);
			}
			return;
		}
		toast.show({ title: `${transferring.domain} transferred`, description: `Now owned by ${target.trim()}.` });
		setResults((list) => list.map((w) => (w.websiteId === transferring.websiteId ? { ...w, merchantId: target.trim() } : w)));
		setConfirming(false);
		setTransferring(null);
		setTarget('');
	};

	return (
		<div className="space-y-6">
			<PageHeader title="Websites" subtitle="Look up a website by its domain and move it between merchants." />
			<form method="get" action="/admin/websites" role="search" className="flex flex-wrap items-end gap-3">
				<Input
					label="Domain"
					name="domain"
					defaultValue={filter.domain ?? ''}
					placeholder="shop.example.com"
					fieldClassName="min-w-0 flex-1 sm:max-w-md"
					autoComplete="off"
				/>
				<Select
					label="Environment"
					name="env"
					defaultValue={filter.env}
					fieldClassName="w-40"
					options={[
						{ value: 'live', label: 'Live' },
						{ value: 'test', label: 'Test twin' },
					]}
				/>
				<Button type="submit" icon={<Icon name="globe" size={14} />}>
					Look up
				</Button>
			</form>
			{props.lookupProblem ? <ActionProblem problem={props.lookupProblem} /> : null}
			{!filter.domain ? (
				<EmptyState
					icon="globe"
					title="Enter a domain"
					description="Domains are normalised (lower case, no scheme or path)."
				/>
			) : results.length === 0 ? (
				<EmptyState icon="globe" title={`No ${filter.env} website ${filter.domain}`} />
			) : (
				results.map((w) => {
					const owner = merchants[w.merchantId] ?? null;
					return (
						<Card
							key={w.websiteId}
							title={w.domain}
							subtitle={<IdChip id={w.websiteId} label="website id" />}
							actions={
								canWrite && w.env === 'live' ? (
									<Button
										variant="secondary"
										size="sm"
										onClick={() => {
											setTransferring(w);
											setTarget('');
											setTargetError(null);
											setProblem(null);
										}}>
										Transfer
									</Button>
								) : null
							}>
							<KeyValueList
								columns={3}
								items={[
									{
										label: 'Owner',
										value: (
											<Link
												href={adminRoutes.merchant(w.merchantId)}
												className="font-semibold text-primary hover:underline">
												{owner?.name ?? w.merchantId}
											</Link>
										),
									},
									{
										label: 'Environment',
										value: <Badge tone={w.env === 'test' ? 'warning' : 'success'}>{w.env}</Badge>,
									},
									{ label: 'Status', value: <StatusBadge status={w.status} /> },
									{ label: 'Test twin', value: <IdChip id={w.twinId} label="twin id" /> },
									{ label: 'Created', value: formatDateTime(w.createdAt) },
									{
										label: 'Deliveries',
										value: (
											<Link
												href={adminRoutes.integration({ websiteId: w.websiteId })}
												className="text-primary hover:underline">
												Delivery log
											</Link>
										),
									},
								]}
							/>
							{canWrite && w.status === 'active' ? (
								<div className="mt-4">
									<WebsiteSettingsCard merchantId={w.merchantId} website={w} fetcher={adminFetch} />
								</div>
							) : (
								<p className="mt-3 text-xs text-muted">
									Time zone {w.timeZone ?? 'UTC (default)'} · language {w.language ?? 'not set'} · currency{' '}
									{w.currency ?? 'not set'}
								</p>
							)}
						</Card>
					);
				})
			)}
			<Dialog
				open={Boolean(transferring) && !confirming}
				onClose={() => setTransferring(null)}
				title={`Transfer ${transferring?.domain ?? 'website'}`}
				description="The live website, its test twin and the domain claim move together; its website keys are revoked."
				footer={
					<>
						<Button variant="secondary" onClick={() => setTransferring(null)}>
							Cancel
						</Button>
						<Button onClick={next}>Continue</Button>
					</>
				}>
				<Input
					label="Target merchant id"
					value={target}
					onChange={(e) => setTarget(e.currentTarget.value)}
					error={targetError}
					placeholder="mer_…"
					className="font-mono"
					autoComplete="off"
					required
				/>
				<FormError problem={problem} fields={['toMerchantId', 'reason']} />
			</Dialog>
			<TypedConfirmDialog
				open={confirming}
				onClose={() => setConfirming(false)}
				onConfirm={(input) => void transfer(input)}
				busy={busy}
				title={`Move ${transferring?.domain ?? ''} to ${target.trim()}?`}
				expected={transferring?.domain ?? ''}
				confirmLabel="Transfer website"
				reason={{ required: true, label: 'Reason (audited)' }}
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					The current owner loses access immediately: its website keys are revoked and its team grants on this website are
					removed. Issue new keys for the new owner.
				</p>
			</TypedConfirmDialog>
		</div>
	);
}
