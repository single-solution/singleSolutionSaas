'use client';
/**
 * The merchant's own lists of business choices (fixed-choices E18–E20, E40): claim kinds (a name, the window each is
 * counted in, its outcomes and whether shoppers may make it) and claim statuses (a name on a fixed role), feature
 * `returns`; cancel and failed-delivery reasons (each counting against the customer or not) and order attachment kinds
 * (photo, video or file, optionally needed at a status, shown to shoppers or not), feature `checkout`; review
 * questions (a rating or one of its choices), feature `reviews`. Saved
 * whole with the shared list editor (`./lists.js`).
 * @module
 */
import { Checkbox, CheckboxGroup, FieldGrid, Input, Select, TextArea } from '@ss/ui';
import { ATTACHMENT_LIMITS, ATTACHMENT_TYPES } from '../../core/attachments.js';
import { REASON_LIMIT } from '../../core/order-reasons.js';
import { QUESTION_LIMITS, QUESTION_TYPES } from '../../core/reviews.js';
import { CLAIM_LIST_LIMITS, CLAIM_OUTCOMES, CLAIM_ROLES, CLAIM_WINDOWS } from '../../core/returns.js';
import { cleanLines, keyOf } from './drafts.js';
import { ListEditor } from './lists.js';
import { TEXTS } from './texts.js';

/** @typedef {import('./lists.js').EditorProps} EditorProps */

const L = TEXTS.lists;
const K = TEXTS.lists.claimKinds;
const S = TEXTS.lists.claimStatuses;

/** A word of a table cell from a map of words (the key itself when there is none). @param {Record<string, string>} words @param {string} key */
const word = (words, key) => words[key] ?? key;

/** Yes or No for a column. @param {boolean} on */
const yesNo = (on) => (on ? L.columns.yes : L.columns.no);

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
			look={{
				icon: 'list',
				facts: (kind) => [word(K.windows, kind.window ?? 'return')],
				value: (kind) => `${L.columns.shoppers}: ${yesNo(kind.shoppers !== false)}`,
			}}
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
			look={{ icon: 'activity', facts: (status) => [word(S.roles, status.role ?? 'approved')] }}
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

const R = TEXTS.lists.reasons;

/**
 * A reason list (`cancel_reasons` or `delivery_failure_reasons`): a name, a key and whether it counts against the
 * customer.
 * @param {EditorProps & { list: 'cancel_reasons' | 'delivery_failure_reasons' }} props
 */
export function ReasonsEditor({ websiteId, off, list }) {
	const words = R[list];
	return (
		<ListEditor
			websiteId={websiteId}
			list={list}
			title={words.title}
			help={words.help}
			itemLabel={R.item}
			max={REASON_LIMIT}
			off={off}
			look={{
				icon: 'alert',
				facts: (reason) => (reason.countsAgainst === true ? [L.columns.countsAgainst] : []),
				status: (reason) => (reason.countsAgainst === true ? { tone: 'warning', label: L.columns.countsAgainst } : null),
			}}
			blank={() => ({ key: '', label: '', countsAgainst: false })}
			clean={(reason) => ({
				key: keyOf(reason.key, reason.label),
				label: String(reason.label ?? '').trim(),
				countsAgainst: reason.countsAgainst === true,
			})}
			render={(reason, set) => (
				<div className="space-y-3">
					<FieldGrid>
						<Input
							label={R.label}
							value={reason.label ?? ''}
							maxLength={120}
							onChange={(event) => set({ label: event.target.value })}
						/>
						<Input
							label={R.key}
							value={reason.key ?? ''}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set({ key: event.target.value })}
						/>
					</FieldGrid>
					<Checkbox
						label={R.countsAgainst}
						checked={reason.countsAgainst === true}
						onChange={(event) => set({ countsAgainst: event.target.checked })}
					/>
				</div>
			)}
		/>
	);
}

const A = TEXTS.lists.attachmentKinds;

/** Order attachment kinds (`attachment_kinds`, E20). @param {EditorProps} props */
export function AttachmentKindsEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="attachment_kinds"
			title={A.title}
			help={A.help}
			itemLabel={A.item}
			max={ATTACHMENT_LIMITS.kinds}
			off={off}
			look={{
				icon: 'image',
				facts: (kind) => [
					word(A.types, kind.type ?? 'photo'),
					kind.requiredAt ? `${L.columns.requiredAt}: ${kind.requiredAt}` : '',
				],
				value: (kind) => `${L.columns.shoppers}: ${yesNo(kind.shoppers === true)}`,
			}}
			blank={() => ({ key: '', label: '', type: 'photo', requiredAt: '', shoppers: false })}
			clean={(kind) => ({
				key: keyOf(kind.key, kind.label),
				label: String(kind.label ?? '').trim(),
				type: kind.type,
				requiredAt: String(kind.requiredAt ?? '').trim(),
				shoppers: kind.shoppers === true,
			})}
			render={(kind, set) => (
				<div className="space-y-3">
					<FieldGrid>
						<Input
							label={A.label}
							value={kind.label ?? ''}
							maxLength={60}
							onChange={(event) => set({ label: event.target.value })}
						/>
						<Input
							label={A.key}
							value={kind.key ?? ''}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set({ key: event.target.value })}
						/>
						<Select
							label={A.type}
							value={kind.type ?? 'photo'}
							options={ATTACHMENT_TYPES.map((type) => ({ value: type, label: A.types[type] }))}
							onChange={(event) => set({ type: event.target.value })}
						/>
						<Input
							label={A.requiredAt}
							help={A.requiredAtHelp}
							value={kind.requiredAt ?? ''}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set({ requiredAt: event.target.value })}
						/>
					</FieldGrid>
					<Checkbox
						label={A.shoppers}
						checked={kind.shoppers === true}
						onChange={(event) => set({ shoppers: event.target.checked })}
					/>
				</div>
			)}
		/>
	);
}

const Q = TEXTS.lists.reviewQuestions;

/** Review questions (`review_questions`, E40): a rating, or one of the merchant's choices (one per line). @param {EditorProps} props */
export function ReviewQuestionsEditor({ websiteId, off }) {
	return (
		<ListEditor
			websiteId={websiteId}
			list="review_questions"
			title={Q.title}
			help={Q.help}
			itemLabel={Q.item}
			max={QUESTION_LIMITS.questions}
			off={off}
			look={{
				icon: 'message',
				facts: (question) => [word(Q.types, question.type ?? 'rating')],
				value: (question) => `${L.columns.required}: ${yesNo(question.required === true)}`,
			}}
			blank={() => ({ key: '', label: '', type: 'rating', choices: '', required: false })}
			load={(question) => ({ ...question, choices: (question.choices ?? []).join('\n') })}
			clean={(question) => ({
				key: keyOf(question.key, question.label),
				label: String(question.label ?? '').trim(),
				type: question.type,
				choices: question.type === 'choice' ? cleanLines(question.choices) : [],
				required: question.required === true,
			})}
			render={(question, set) => (
				<div className="space-y-3">
					<FieldGrid>
						<Input
							label={Q.label}
							value={question.label ?? ''}
							maxLength={120}
							onChange={(event) => set({ label: event.target.value })}
						/>
						<Input
							label={Q.key}
							value={question.key ?? ''}
							maxLength={40}
							autoComplete="off"
							onChange={(event) => set({ key: event.target.value })}
						/>
						<Select
							label={Q.type}
							value={question.type ?? 'rating'}
							options={QUESTION_TYPES.map((type) => ({ value: type, label: Q.types[type] }))}
							onChange={(event) => set({ type: event.target.value })}
						/>
					</FieldGrid>
					{question.type === 'choice' ? (
						<TextArea
							label={Q.choices}
							value={question.choices ?? ''}
							rows={4}
							onChange={(event) => set({ choices: event.target.value })}
						/>
					) : null}
					<Checkbox
						label={Q.required}
						checked={question.required === true}
						onChange={(event) => set({ required: event.target.checked })}
					/>
				</div>
			)}
		/>
	);
}
