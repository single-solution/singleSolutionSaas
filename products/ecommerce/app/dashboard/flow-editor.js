'use client';
/**
 * The order flow editor (Settings → Orders and messages; the `order_flow` list, PLAN 0.8.10 dynamic model phase 2):
 * statuses in order — their name for staff and for shoppers, kind of step, message and the line shoppers read per
 * payment method — and for each status the statuses it may move to, each move with who may make it, the permission it
 * needs, what staff give with it and its options where its kind of step leaves a choice; then the moves the shop makes
 * by itself (triggers) and where orders that need no payment first start. Moves the role rules do not allow are not
 * offered; the server checks the whole flow again (`core/flow.js` `checkOrderFlow`) and fills what is left out with
 * today's behavior. Saving keeps every field (`drafts.js` `flowToSave`).
 * @module
 */
import { useState } from 'react';
import { Button, Callout, Card, Checkbox, CheckboxGroup, FieldGrid, Input, Select } from '@ss/ui';
import {
	DEFAULT_FLOW,
	FLOW_METHODS,
	MOVE_NEEDS,
	MOVE_PERMISSIONS,
	canMove,
	moveOptionSpecs,
	moveRules,
	readOrderFlow,
	statusOf,
} from '../../core/flow.js';
import { STATUS_ROLES } from '../../core/model.js';
import { fill } from './api.js';
import { flowToSave, removeFlowStatus, renameFlowStatus } from './drafts.js';
import { EntryHead, ListOutcome, SaveRow, moved, useList } from './lists.js';
import { Loaded } from './parts.js';
import { TEXTS } from './texts.js';

/** @typedef {import('../../core/model.js').OrderFlow} OrderFlow */
/** @typedef {import('../../core/model.js').OrderMove} OrderMove */
/** @typedef {import('../../core/model.js').StatusRole} StatusRole */
/** @typedef {Required<OrderFlow>} FullFlow */

const L = TEXTS.lists;
const F = L.orderFlow;

/** @typedef {'staff' | 'staff_shopper' | 'shopper' | 'system'} WhoChoice */
/** Who may make a move: the choices of the editor and the sets they stand for. @type {Readonly<Record<WhoChoice, Array<'staff' | 'shopper' | 'system'>>>} */
const WHO = Object.freeze({
	staff: ['staff'],
	staff_shopper: ['staff', 'shopper'],
	shopper: ['shopper'],
	system: ['system'],
});

/** Roles after which the items may be with the customer (a move from them into a cancelled or refunded status is E40's). */
const AFTER_DELIVERY = Object.freeze(['delivered', 'returned_to_origin', 'returned', 'cancelled', 'refunded']);

/**
 * The statuses an order in `from` could move to under the role rules (whether or not the move is ticked).
 * @param {OrderFlow} flow @param {string} from
 */
const possibleTargets = (flow, from) =>
	flow.statuses.filter((status) => canMove({ statuses: flow.statuses, moves: [{ from, to: status.key }] }, from, status.key));

/** @param {OrderFlow} flow @param {OrderMove} move */
const allowed = (flow, move) => canMove(flow, move.from, move.to);

/** @param {string[]} who */
const whoKey = (who) =>
	/** @type {WhoChoice} */ (
		Object.entries(WHO).find(([, set]) => set.length === who.length && set.every((entry) => who.includes(entry)))?.[0] ??
			'staff'
	);

/**
 * The settings of one move: who, permission, needs and the options its kinds of step take.
 * @param {{ flow: FullFlow, move: OrderMove, onChange: (move: OrderMove) => void }} props
 */
function MoveSettings({ flow, move, onChange }) {
	const rules = moveRules(flow, move);
	const from = /** @type {StatusRole} */ (statusOf(flow, move.from)?.role);
	const to = /** @type {StatusRole} */ (statusOf(flow, move.to)?.role);
	const shopperAllowed = to === 'cancelled' && ['awaiting_payment', 'awaiting_confirmation', 'open', 'packed'].includes(from);
	/** @type {WhoChoice[]} */
	const whoChoices = ['staff', ...(shopperAllowed ? /** @type {WhoChoice[]} */ (['staff_shopper', 'shopper']) : []), 'system'];
	const specs = moveOptionSpecs(from, to, rules.who);
	/** @param {Partial<OrderMove>} patch */
	const set = (patch) => onChange({ ...move, ...patch });
	/** @param {string} name @param {unknown} value */
	const setOption = (name, value) => set({ options: { ...rules.options, [name]: value } });
	const target = statusOf(flow, move.to)?.label ?? move.to;
	return (
		<details className="rounded-lg border border-line p-3">
			<summary className="cursor-pointer text-sm font-medium">
				{fill(F.moveSettings, { status: target })}
				{AFTER_DELIVERY.includes(from) && (to === 'cancelled' || to === 'refunded') ? ` (${F.afterDelivery})` : ''}
			</summary>
			<div className="mt-3 space-y-3">
				<FieldGrid>
					<Select
						label={F.who}
						value={whoKey(rules.who)}
						options={whoChoices.map((choice) => ({ value: choice, label: F.whoChoices[choice] }))}
						onChange={(event) => set({ who: [...WHO[/** @type {WhoChoice} */ (event.target.value)]] })}
					/>
					{to === 'refunded' ? null : (
						<Select
							label={F.permission}
							value={rules.permission}
							options={MOVE_PERMISSIONS.map((permission) => ({ value: permission, label: F.permissions[permission] }))}
							onChange={(event) => set({ permission: /** @type {OrderMove['permission']} */ (event.target.value) })}
						/>
					)}
					{Object.entries(specs).map(([name, spec]) =>
						spec.kind === 'one' ? (
							<Select
								key={name}
								label={F.options[/** @type {keyof typeof F.options} */ (name)]}
								value={String(/** @type {Record<string, unknown>} */ (rules.options)[name] ?? spec.default)}
								options={spec.values.map((value) => ({
									value,
									label: /** @type {Record<string, Record<string, string>>} */ (F.values)[name]?.[value] ?? value,
								}))}
								onChange={(event) => setOption(name, event.target.value)}
							/>
						) : null,
					)}
				</FieldGrid>
				{Object.entries(specs)
					.filter(([, spec]) => spec.kind === 'methods')
					.map(([name]) => (
						<CheckboxGroup
							key={name}
							legend={F.options[/** @type {keyof typeof F.options} */ (name)]}
							options={FLOW_METHODS.map((method) => ({ value: method, label: F.methods[method] }))}
							value={/** @type {string[]} */ (/** @type {Record<string, unknown>} */ (rules.options)[name] ?? [])}
							onChange={(next) => setOption(name, next)}
						/>
					))}
				<CheckboxGroup
					legend={F.needs}
					options={MOVE_NEEDS.filter((need) => need !== 'units' || to === 'shipped' || to === 'delivered').map((need) => ({
						value: need,
						label: F.needChoices[need],
					}))}
					value={rules.needs}
					onChange={(next) => set({ needs: /** @type {OrderMove['needs']} */ (next) })}
				/>
			</div>
		</details>
	);
}

/**
 * What shoppers read of a status: its name for them, whether it sends a message and a line per payment method.
 * @param {{ status: FullFlow['statuses'][number], onChange: (patch: Partial<FullFlow['statuses'][number]>) => void }} props
 */
function ShopperFields({ status, onChange }) {
	const texts = /** @type {Record<string, string>} */ (status.shopperText ?? {});
	return (
		<details className="rounded-lg border border-line p-3">
			<summary className="cursor-pointer text-sm font-medium">{F.shopperTexts}</summary>
			<div className="mt-3 space-y-3">
				<FieldGrid>
					<Input
						label={F.shopperLabel}
						value={status.shopperLabel ?? ''}
						maxLength={60}
						onChange={(event) => onChange({ shopperLabel: event.target.value })}
					/>
					{FLOW_METHODS.map((method) => (
						<Input
							key={method}
							label={F.shopperText[method]}
							value={texts[method] ?? ''}
							maxLength={300}
							onChange={(event) =>
								onChange({ shopperText: /** @type {any} */ ({ ...texts, [method]: event.target.value }) })
							}
						/>
					))}
				</FieldGrid>
				<Checkbox
					label={F.notify}
					checked={status.notify !== false}
					onChange={(event) => onChange({ notify: event.target.checked })}
				/>
			</div>
		</details>
	);
}

/**
 * The moves the shop makes by itself and where orders that need no payment first start.
 * @param {{ flow: FullFlow, onChange: (flow: FullFlow) => void }} props
 */
function TriggersAndStarts({ flow, onChange }) {
	/** @param {StatusRole[]} roles @param {boolean} none */
	const choices = (roles, none) => [
		...(none ? [{ value: '', label: F.stay }] : []),
		...flow.statuses
			.filter((status) => roles.includes(status.role) && status.key)
			.map((status) => ({ value: status.key, label: status.label || status.key })),
	];
	/** @param {'paid' | 'windowEnd' | 'refundsCover'} name @param {string} value */
	const setTrigger = (name, value) => onChange({ ...flow, triggers: { ...flow.triggers, [name]: value } });
	/** @param {'cod' | 'pickup' | 'free'} name @param {string} value */
	const setStart = (name, value) => onChange({ ...flow, starts: { ...flow.starts, [name]: value } });
	return (
		<div className="space-y-4 rounded-xl bg-surface-2 p-4">
			<p className="text-sm font-bold">{F.triggers}</p>
			<FieldGrid>
				<Select
					label={F.triggerFields.paid}
					value={flow.triggers.paid}
					options={choices(['open'], true)}
					onChange={(event) => setTrigger('paid', event.target.value)}
				/>
				<Select
					label={F.triggerFields.windowEnd}
					value={flow.triggers.windowEnd}
					options={choices(['cancelled'], false)}
					onChange={(event) => setTrigger('windowEnd', event.target.value)}
				/>
				<Select
					label={F.triggerFields.refundsCover}
					value={flow.triggers.refundsCover}
					options={choices(['refunded'], true)}
					onChange={(event) => setTrigger('refundsCover', event.target.value)}
				/>
			</FieldGrid>
			<p className="text-sm font-bold">{F.starts}</p>
			<FieldGrid>
				<Select
					label={F.startFields.cod}
					value={flow.starts.cod}
					options={choices(['awaiting_confirmation', 'open'], false)}
					onChange={(event) => setStart('cod', event.target.value)}
				/>
				<Select
					label={F.startFields.pickup}
					value={flow.starts.pickup}
					options={choices(['awaiting_confirmation', 'open'], false)}
					onChange={(event) => setStart('pickup', event.target.value)}
				/>
				<Select
					label={F.startFields.free}
					value={flow.starts.free}
					options={choices(['awaiting_confirmation', 'open', 'awaiting_payment'], false)}
					onChange={(event) => setStart('free', event.target.value)}
				/>
			</FieldGrid>
		</div>
	);
}

/**
 * The order flow editor.
 * @param {{ websiteId: string, off?: boolean }} props
 */
export function OrderFlowEditor({ websiteId, off }) {
	const state = useList(websiteId, 'order_flow');
	const [resetShown, setResetShown] = useState(false);
	return (
		<Card title={F.title} subtitle={off ? TEXTS.settings.off : F.help}>
			<Loaded answer={state.answer}>
				{(data) => {
					/** @type {FullFlow} */
					const saved =
						data.value && Array.isArray(data.value.statuses) && Array.isArray(data.value.moves)
							? readOrderFlow(data.value)
							: DEFAULT_FLOW;
					/** @type {FullFlow} */
					const flow = state.draft ?? saved;
					/** @param {FullFlow} next */
					const setFlow = (next) => state.setDraft(next);
					/** @param {number} index @param {Partial<FullFlow['statuses'][number]>} patch */
					const setStatus = (index, patch) => {
						const old = flow.statuses[index]?.key ?? '';
						const renamed = patch.key === undefined || patch.key === old ? flow : renameFlowStatus(flow, old, patch.key);
						setFlow({
							...renamed,
							statuses: renamed.statuses.map((status, at) => (at === index ? { ...status, ...patch } : status)),
						});
					};
					/** @param {number} index */
					const removeStatus = (index) => {
						const next = removeFlowStatus(flow, flow.statuses[index]?.key ?? '');
						// a trigger or start that named it takes today's choice of the flow left
						const fallback = readOrderFlow({ statuses: next.statuses, moves: next.moves });
						setFlow({
							statuses: next.statuses,
							moves: next.moves,
							triggers: { ...fallback.triggers, ...next.triggers },
							starts: { ...fallback.starts, ...next.starts },
						});
					};
					/** @param {OrderMove} move */
					const setMove = (move) =>
						setFlow({
							...flow,
							moves: flow.moves.map((entry) => (entry.from === move.from && entry.to === move.to ? move : entry)),
						});
					return (
						<div className="space-y-4">
							{flow.statuses.map((status, index) => {
								const targets = possibleTargets(flow, status.key);
								const ticked = flow.moves.filter((move) => move.from === status.key);
								return (
									<div key={index} className="space-y-3 rounded-xl bg-surface-2 p-4">
										<EntryHead
											label={F.status}
											index={index}
											count={flow.statuses.length}
											onMove={(step) => setFlow({ ...flow, statuses: moved(flow.statuses, index, step) })}
											onRemove={() => removeStatus(index)}
										/>
										<FieldGrid>
											<Input
												label={F.label}
												value={status.label}
												maxLength={60}
												onChange={(event) => setStatus(index, { label: event.target.value })}
											/>
											<Input
												label={F.key}
												value={status.key}
												maxLength={40}
												autoComplete="off"
												onChange={(event) => setStatus(index, { key: event.target.value })}
											/>
											<Select
												label={F.role}
												value={status.role}
												options={STATUS_ROLES.map((role) => ({
													value: role,
													label: F.roles[/** @type {keyof typeof F.roles} */ (role)],
												}))}
												onChange={(event) =>
													setStatus(index, { role: /** @type {StatusRole} */ (event.target.value) })
												}
											/>
										</FieldGrid>
										<ShopperFields status={status} onChange={(patch) => setStatus(index, patch)} />
										{targets.length > 0 ? (
											<CheckboxGroup
												legend={F.moves}
												options={targets.map((target) => ({ value: target.key, label: target.label || target.key }))}
												value={ticked
													.map((move) => move.to)
													.filter((key) => targets.some((target) => target.key === key))}
												onChange={(next) =>
													setFlow({
														...flow,
														moves: [
															...flow.moves.filter((move) => move.from !== status.key || next.includes(move.to)),
															...next
																.filter((to) => !ticked.some((move) => move.to === to))
																.map((to) => ({ from: status.key, to })),
														],
													})
												}
											/>
										) : (
											<p className="text-sm text-muted">{F.noMoves}</p>
										)}
										{ticked
											.filter((move) => targets.some((target) => target.key === move.to))
											.map((move) => (
												<MoveSettings key={move.to} flow={flow} move={move} onChange={setMove} />
											))}
									</div>
								);
							})}
							<TriggersAndStarts flow={flow} onChange={setFlow} />
							{resetShown && state.draft !== null ? <Callout tone="info">{F.resetNote}</Callout> : null}
							<SaveRow
								dirty={state.draft !== null}
								onCancel={() => {
									state.setDraft(null);
									setResetShown(false);
								}}
								onSave={async () => {
									await state.save(flowToSave(flow, allowed));
									setResetShown(false);
								}}>
								<Button
									size="sm"
									variant="secondary"
									disabled={flow.statuses.length >= 30}
									onClick={() =>
										setFlow({
											...flow,
											statuses: [
												...flow.statuses,
												{
													key: '',
													label: '',
													role: /** @type {const} */ ('open'),
													shopperLabel: '',
													shopperText: { cod: '', online: '', bank_transfer: '', pickup: '' },
													notify: false,
												},
											],
										})
									}>
									{L.add}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => {
										setFlow(structuredClone(DEFAULT_FLOW));
										setResetShown(true);
									}}>
									{F.resetFlow}
								</Button>
							</SaveRow>
							<ListOutcome result={state.result} local={state.local} />
						</div>
					);
				}}
			</Loaded>
		</Card>
	);
}
