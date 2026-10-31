'use client';
/**
 * The connections of a website as the first views of the Developers tab (owner 2026-10-21: no Connections tab). Each
 * connection is one view of the list: its row has the connection's state as a dot, who needs it as its line, and its
 * page is one rich {@link Card} (icon, name, state, the product's hint as the help line) holding the saved value, then
 * the product's own form, the single value field with Save and test, or, for a connection the Portal owns (`managed`:
 * the database, the storage, the AI provider key and the links to other products), a note that says where it is set
 * with a link to the Portal. Test (and, once something is saved, Remove in the More menu, after a confirmation) are
 * the page's actions; who needs the connection is behind the (i).
 * @module
 */
import { useState } from 'react';
import { Button } from './Button.js';
import { Card, ManagedNote } from './display.js';
import { SettingList } from './blocks.js';
import { Input } from './fields.js';
import { ConfirmDialog } from './overlay.js';
import { call, fill, useLoad } from './dashboard-api.js';
import { describeProblem } from './problems.js';
import { toneOf, useDashboard, websiteSettingsUrl } from './dashboard-parts.js';

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('./dashboard-page.js').Section} Section */
/** @typedef {import('react').ReactNode} ReactNode */
/**
 * One connection of a website (`GET …/connections`).
 * @typedef {{ name: string, label: string, kind?: string, neededBy: string[], status: string, message?: string,
 *   managed?: boolean, last4?: string | null }} Connection `managed`: the Portal owns it (the database, the storage, the AI provider key, the links)
 */
/**
 * What a product adds to its connections: `form(item, save)` is the product's own form for a connection (null: the one
 * value field) and `hint(name)` its help line under the status.
 * @typedef {{ form?: (item: Connection, save: (value: unknown) => Promise<void>) => ReactNode,
 *   hint?: (name: string) => ReactNode }} ConnectionParts
 */

/**
 * Loads the connections and draws them as views. `parts` is the product's forms and hints; `null` leaves the connections
 * out altogether (a product whose connections are all the Portal's). The hook is used by the Developers tab: `answer`
 * is `undefined` when nothing is loaded, `sections(list)` makes the views of an answer's connections, `dialog` is the
 * Remove confirmation, `result` the outcome of the last write (a toast).
 * @param {{ websiteId: string | null, merchantId?: string | null, who: { kind: string }, portal: string,
 *   parts?: ConnectionParts | null }} options
 * @returns {{ answer: Answer | null | undefined, result: Answer | null, dialog: ReactNode,
 *   sections: (list: Connection[]) => Section[] }}
 */
export function useConnections({ websiteId, merchantId, who, portal, parts }) {
	const { texts, namesOf } = useDashboard();
	const C = texts.connections;
	const wanted = parts !== null;
	const base = `/v1/dashboard/websites/${websiteId}/connections`;
	const { answer, reload } = useLoad(wanted ? base : null);
	const [values, setValues] = useState(/** @type {Record<string, string>} */ ({}));
	/** Why the last "Save and test" of a connection's value was refused (by name); gone when the value is edited. */
	const [refused, setRefused] = useState(/** @type {Record<string, string>} */ ({}));
	const [result, setResult] = useState(/** @type {Answer | null} */ (null));
	const [removing, setRemoving] = useState(/** @type {{ name: string, label: string } | null} */ (null));
	/** @param {Promise<Answer>} pending */
	const act = async (pending) => {
		const answered = await pending;
		setResult(answered);
		reload();
		return answered;
	};
	/**
	 * Sets or clears what is typed in the value field of a connection.
	 * @param {string} name
	 * @param {string} value
	 */
	const typeInto = (name, value) => setValues((all) => ({ ...all, [name]: value }));
	/**
	 * Saves what is typed in a connection's value field. The field empties only once the server accepted it; a refused
	 * key stays in the field and its reason shows on the card.
	 * @param {string} name
	 * @param {(value: unknown) => Promise<Answer>} send
	 * @param {string} sent
	 */
	const saveTyped = async (name, send, sent) => {
		setRefused((all) => ({ ...all, [name]: '' }));
		const answered = await send(sent.trim());
		if (answered.ok) setValues((all) => (all[name] === sent ? { ...all, [name]: '' } : all));
		else setRefused((all) => ({ ...all, [name]: describeProblem(answered.problem) }));
	};
	/** @param {Connection[]} list */
	const sections = (list) =>
		list.map((item) => {
			/** @param {unknown} value */
			const send = (value) => act(call('PUT', `${base}/${item.name}`, { value }));
			/** @param {unknown} value */
			const save = async (value) => {
				await send(value);
			};
			const managed = item.managed === true;
			const own = parts?.form && !managed ? parts.form(item, save) : null;
			const help = parts?.hint ? parts.hint(item.name) : null;
			const tone = toneOf(item.status);
			const state = String(C[/** @type {'connected'} */ (item.status)]);
			const needed = item.neededBy.length > 0 ? fill(C.neededBy, { features: namesOf(item.neededBy, 4) }) : C.neededByNone;
			const typed = values[item.name] ?? '';
			const field = !managed && !own;
			return {
				id: `connection-${item.name}`,
				label: item.label,
				icon: /** @type {const} */ ('plug'),
				status: tone,
				statusLabel: state,
				meta: needed,
				group: texts.developers.groups.connections,
				info: needed,
				actions: {
					...(item.kind === 'link'
						? {}
						: { secondary: [{ label: C.test, onClick: () => act(call('POST', `${base}/${item.name}/test`)) }] }),
					...(item.status === 'not_connected' || managed
						? {}
						: {
								more: [
									{
										label: C.remove,
										danger: true,
										onSelect: () => setRemoving({ name: item.name, label: item.label }),
									},
								],
							}),
				},
				content: (
					<Card
						lead={{ icon: 'plug', tone }}
						title={item.label}
						status={{ tone, label: state }}
						{...(help && !managed ? { help } : {})}
						{...(field
							? {
									action: (
										<Button size="sm" disabled={!typed.trim()} onClick={() => saveTyped(item.name, send, typed)}>
											{C.save}
										</Button>
									),
								}
							: {})}>
						{item.last4 || item.message ? (
							<p className="flex flex-wrap items-center gap-2 text-sm">
								{item.last4 ? <code>••••{item.last4}</code> : null}
								{item.message ? <span className="text-muted">{item.message}</span> : null}
							</p>
						) : null}
						{managed ? (
							<ManagedNote
								title={texts.managed.title}
								href={websiteSettingsUrl({
									portal,
									admin: who.kind === 'admin',
									websiteId,
									merchantId,
									section: item.kind === 'link' ? 'links' : 'connections',
								})}
								linkLabel={C.managed.open}>
								{C.managed[/** @type {'database'} */ (item.kind ?? 'database')] ?? C.managed.link}
							</ManagedNote>
						) : own ? (
							own
						) : (
							<SettingList>
								<Input
									label={C.value}
									type="password"
									autoComplete="off"
									value={typed}
									{...(refused[item.name] ? { error: refused[item.name] } : {})}
									onChange={(event) => {
										typeInto(item.name, event.target.value);
										setRefused((all) => (all[item.name] ? { ...all, [item.name]: '' } : all));
									}}
								/>
							</SettingList>
						)}
					</Card>
				),
			};
		});
	const dialog = wanted ? (
		<ConfirmDialog
			open={removing !== null}
			title={fill(C.removeTitle, { name: removing?.label ?? '' })}
			confirmLabel={C.remove}
			cancelLabel={texts.cancel}
			danger
			onClose={() => setRemoving(null)}
			onConfirm={async () => {
				const name = removing?.name ?? '';
				setRemoving(null);
				await act(call('DELETE', `${base}/${name}`));
			}}>
			<p>{C.removeHelp}</p>
		</ConfirmDialog>
	) : null;
	return { answer: wanted ? answer : undefined, result, dialog, sections };
}
