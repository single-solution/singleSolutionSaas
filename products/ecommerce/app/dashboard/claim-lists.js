'use client';
/**
 * The merchant's claim lists (fixed-choices E18, feature `returns`): claim kinds (a name, the window each is counted in,
 * its outcomes and whether shoppers may make it) and claim statuses (a name on a fixed role). Saved whole with the
 * shared list editor (`./lists.js`).
 * @module
 */
import { Checkbox, CheckboxGroup, FieldGrid, Input, Select } from '@ss/ui';
import { CLAIM_LIST_LIMITS, CLAIM_OUTCOMES, CLAIM_ROLES, CLAIM_WINDOWS } from '../../core/returns.js';
import { keyOf } from './drafts.js';
import { ListEditor } from './lists.js';
import { TEXTS } from './texts.js';

/** @typedef {import('./lists.js').EditorProps} EditorProps */

const K = TEXTS.lists.claimKinds;
const S = TEXTS.lists.claimStatuses;

/** Claim kinds (`claim_kinds`). @param {EditorProps} props */
export function ClaimKindsEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="claim_kinds"
			title={K.title}
			help={K.help}
			itemLabel={K.item}
			max={CLAIM_LIST_LIMITS.kinds}
			off={off}
			blank={() => ({ key: '', label: '', window: 'return', outcomes: ['refund'], shoppers: true })}
			clean={(kind) => ({
				key: keyOf(kind.key, kind.label),
				label: String(kind.label ?? '').trim(),
				window: kind.window,
				outcomes: kind.outcomes ?? [],
				shoppers: kind.shoppers !== false,
			})}
			render={(kind, set) => (
				<div className="space-y-3">
					<FieldGrid>
						<Input
							label={K.label}
							value={kind.label ?? ''}
							maxLength={60}
							onChange={(event) => set({ label: event.target.value })}
						/>
						<Input
							label={K.key}
							value={kind.key ?? ''}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set({ key: event.target.value })}
						/>
						<Select
							label={K.window}
							value={kind.window ?? 'return'}
							options={CLAIM_WINDOWS.map((window) => ({ value: window, label: K.windows[window] }))}
							onChange={(event) => set({ window: event.target.value })}
						/>
					</FieldGrid>
					<CheckboxGroup
						legend={K.outcomes}
						options={CLAIM_OUTCOMES.map((outcome) => ({ value: outcome, label: K.outcomeChoices[outcome] }))}
						value={kind.outcomes ?? []}
						onChange={(next) => set({ outcomes: next })}
					/>
					<Checkbox
						label={K.shoppers}
						checked={kind.shoppers !== false}
						onChange={(event) => set({ shoppers: event.target.checked })}
					/>
				</div>
			)}
		/>
	);
}

/** Claim statuses (`claim_statuses`). @param {EditorProps} props */
export function ClaimStatusesEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="claim_statuses"
			title={S.title}
			help={S.help}
			itemLabel={S.item}
			max={CLAIM_LIST_LIMITS.statuses}
			off={off}
			blank={() => ({ key: '', label: '', role: 'approved' })}
			clean={(status) => ({
				key: keyOf(status.key, status.label),
				label: String(status.label ?? '').trim(),
				role: status.role,
			})}
			render={(status, set) => (
				<FieldGrid>
					<Input
						label={S.label}
						value={status.label ?? ''}
						maxLength={60}
						onChange={(event) => set({ label: event.target.value })}
					/>
					<Input
						label={S.key}
						value={status.key ?? ''}
						maxLength={40}
						autoComplete="off"
						onChange={(event) => set({ key: event.target.value })}
					/>
					<Select
						label={S.role}
						value={status.role ?? 'approved'}
						options={CLAIM_ROLES.map((role) => ({ value: role, label: S.roles[role] }))}
						onChange={(event) => set({ role: event.target.value })}
					/>
				</FieldGrid>
			)}
		/>
	);
}
