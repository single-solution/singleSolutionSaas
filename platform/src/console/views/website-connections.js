'use client';
/**
 * Data and files and Between your products (settings-ownership design 8.3 and 8.4), two sections of Website settings.
 *
 * - **Data and files**: ONE database connection and ONE storage connection for the website, entered here once. They are
 *   write-only: after a save the page only knows that a value is set (never the value), and a person can replace or remove
 *   it. Every change asks for the signed-in person's password again (and a code while two-step is on), so a stolen
 *   session changes nothing. Under the forms, what each product on the website gets: its own database name and folder and
 *   how its own test of the value went.
 * - **Between your products**: the links the Portal made by itself, each in words ("Chat may use Notifications") with what
 *   it may do and whether the product has its key. A person can switch a link off or on and regenerate its key (after the
 *   password); nobody can paste, read or write a token or a scope.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	EmptyState,
	FormError,
	Input,
	ListRow,
	PasswordConfirmDialog,
	RowList,
	SettingRow,
	SettingsCard,
	Switch,
	useToast,
} from '@ss/ui';
import { WEBSITE_SETTINGS as T } from '../../texts/console.js';
import { apiConfirm } from '../client.js';
import { api } from '../paths.js';
import { confirmationErrors } from './website.js';
import { factorOf } from './common.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * What the page shows of the website's connections (`GET …/connections`): never a value.
 * @typedef {object} ConnectionsView
 * @property {number} version
 * @property {{ set: boolean, setAt: string | null }} database
 * @property {{ set: boolean, setAt: string | null }} storage
 * @property {Array<{ productId: string, name: string, database: { name: string, overridden: boolean, state: string, message?: string } | null,
 *   storage: { folder: string, required: boolean, state: string, message?: string } | null }>} products
 * @property {Array<{ caller: string, callerName: string, callee: string, calleeName: string, state: 'on' | 'off' | 'idle',
 *   scopes: Array<{ scope: string, name: string, description: string }>, delivered: boolean }>} links
 * @property {{ write: boolean }} can
 */
/**
 * @typedef {object} ConnectionsProps
 * @property {ConnectionsView | null} view
 * @property {{ merchantId: string, websiteId: string }} manage
 * @property {boolean} canWrite
 * @property {(view: ConnectionsView) => void} onChanged
 */

/** @type {Record<string, 'success' | 'attention' | 'danger' | 'neutral'>} */
const TONES = {
	connected: 'success',
	waiting: 'attention',
	test_failed: 'danger',
	not_set: 'neutral',
	on: 'success',
	off: 'neutral',
	idle: 'neutral',
};

/**
 * The password dialog of a change: the person's password (and a code when the Portal asks for one), the request, and the
 * reason under its field when refused. It keeps the request in the page's hands: `send(confirmation)` returns the answer.
 * @param {{ open: boolean, title: string, help: string, confirmLabel: string, danger?: boolean,
 *   send: (confirmation: { password: string, code?: string, recoveryCode?: string }) => Promise<{ ok: true } | { ok: false, problem: Problem }>,
 *   onClose: () => void, onDone: () => void }} props
 */
function ConfirmChange({ open, title, help, confirmLabel, danger = false, send, onClose, onDone }) {
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState(/** @type {{ password?: string, code?: string, form?: string }} */ ({}));
	const [wantsCode, setWantsCode] = useState(false);
	/** @param {{ password: string, code: string }} input */
	const confirm = async ({ password, code }) => {
		setBusy(true);
		setErrors({});
		const result = await send({ password, ...factorOf(code) });
		setBusy(false);
		if (result.ok) {
			onDone();
			return;
		}
		const found = confirmationErrors(result.problem);
		if (found.code) setWantsCode(true);
		// a refusal that is not about the password (a value the Portal does not accept) is shown by the form, not here
		if (!found.password && !found.code && result.problem.status === 422) {
			onClose();
			return;
		}
		setErrors(found);
	};
	return (
		<PasswordConfirmDialog
			open={open}
			onClose={onClose}
			onConfirm={(input) => void confirm(input)}
			busy={busy}
			danger={danger}
			showCode={wantsCode}
			confirmLabel={confirmLabel}
			title={title}
			errors={errors}
			texts={{ password: T.data.password, passwordHelp: T.data.passwordHelp, code: T.data.code, codeHelp: T.data.codeHelp }}>
			<p className="text-sm text-muted">{help}</p>
		</PasswordConfirmDialog>
	);
}

/**
 * The state of a value in words, as a badge.
 * @param {{ state: string, message?: string | undefined }} props
 */
function StateBadge({ state, message }) {
	const words = /** @type {Record<string, string>} */ (T.data.state)[state] ?? state;
	return (
		<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
			<Badge tone={TONES[state] ?? 'neutral'} dot>
				{words}
			</Badge>
			{message ? <span className="text-help text-muted">{message}</span> : null}
		</span>
	);
}

/**
 * One connection card: its state, the write-only form and Remove. Saving or removing asks for the password.
 * @param {{ name: 'database' | 'storage', title: string, help: string, set: { set: boolean, setAt: string | null },
 *   fields: import('react').ReactNode, value: () => unknown, empty: () => boolean, clear: () => void,
 *   manage: { merchantId: string, websiteId: string }, canWrite: boolean, problem: Problem | null,
 *   setProblem: (problem: Problem | null) => void, onChanged: (view: ConnectionsView) => void }} props
 */
function ConnectionCard({
	name,
	title,
	help,
	set,
	fields,
	value,
	empty,
	clear,
	manage,
	canWrite,
	problem,
	setProblem,
	onChanged,
}) {
	const toast = useToast();
	const [asking, setAsking] = useState(/** @type {null | 'save' | 'remove'} */ (null));
	/** @param {{ password: string, code?: string, recoveryCode?: string }} confirmation */
	const send = async (confirmation) => {
		const saving = asking === 'save';
		const result = await apiConfirm(
			saving
				? api.websiteConnection(manage.merchantId, manage.websiteId, name)
				: api.websiteConnectionRemove(manage.merchantId, manage.websiteId, name),
			{
				method: saving ? 'PUT' : 'POST',
				body: saving ? { value: value(), ...confirmation } : confirmation,
			},
		);
		if (!result.ok) {
			if (saving && !confirmationErrors(result.problem).password && result.status === 422) setProblem(result.problem);
			return result;
		}
		setProblem(null);
		onChanged(result.data);
		return { ok: /** @type {const} */ (true) };
	};
	return (
		<SettingsCard
			wide
			title={title}
			description={help}
			actions={
				set.set ? (
					<span className="flex items-center gap-2">
						<StateBadge state="connected" />
						<span className="text-help text-muted">
							{T.data.isSet(set.setAt ? new Date(set.setAt).toISOString().slice(0, 10) : '')}
						</span>
					</span>
				) : (
					<Badge tone="neutral" dot>
						{T.data.notSet}
					</Badge>
				)
			}>
			<fieldset disabled={!canWrite} className="contents">
				{fields}
			</fieldset>
			{problem ? <FormError problem={problem} className="col-span-full" /> : null}
			{canWrite ? (
				<div className="col-span-full flex flex-wrap gap-2 px-1 pt-1">
					<Button size="sm" disabled={empty()} onClick={() => setAsking('save')}>
						{set.set ? T.data.replace : T.data.save}
					</Button>
					{set.set ? (
						<Button size="sm" variant="secondary" onClick={() => setAsking('remove')}>
							{T.data.remove}
						</Button>
					) : null}
				</div>
			) : null}
			<ConfirmChange
				open={asking !== null}
				title={asking === 'remove' ? T.data.confirmRemove(title) : T.data.confirmSave(title)}
				help={T.data.confirmHelp}
				confirmLabel={asking === 'remove' ? T.data.remove : T.data.save}
				danger={asking === 'remove'}
				send={send}
				onClose={() => setAsking(null)}
				onDone={() => {
					toast.show({ title: asking === 'remove' ? T.data.removed : T.data.saved });
					clear();
					setAsking(null);
				}}
			/>
		</SettingsCard>
	);
}

/**
 * The Data and files section.
 * @param {ConnectionsProps} props
 */
export function ConnectionsSection({ view, manage, canWrite, onChanged }) {
	const [uri, setUri] = useState('');
	const [bucket, setBucket] = useState(/** @type {Record<string, string>} */ ({}));
	const [pathStyle, setPathStyle] = useState(false);
	const [problems, setProblems] = useState(
		/** @type {{ database: Problem | null, storage: Problem | null }} */ ({ database: null, storage: null }),
	);
	if (!view)
		return (
			<Callout tone="info" className="col-span-full">
				{T.readOnly}
			</Callout>
		);
	const S = T.data.storage.fields;
	/** @type {Array<[keyof typeof S, boolean]>} */
	const parts = [
		['endpoint', false],
		['region', true],
		['bucket', true],
		['accessKeyId', true],
		['secretAccessKey', true],
		['prefix', false],
	];
	const valueOfBucket = () => ({
		...Object.fromEntries(
			parts.filter(([key]) => (bucket[key] ?? '').trim() !== '').map(([key]) => [key, (bucket[key] ?? '').trim()]),
		),
		...(pathStyle ? { forcePathStyle: true } : {}),
	});
	return (
		<div className="col-span-full min-w-0 space-y-4">
			<p className="text-sm text-muted">{T.data.intro}</p>
			<ConnectionCard
				name="database"
				title={T.data.database.title}
				help={T.data.database.help}
				set={view.database}
				manage={manage}
				canWrite={canWrite}
				problem={problems.database}
				setProblem={(problem) => setProblems((old) => ({ ...old, database: problem }))}
				onChanged={onChanged}
				value={() => uri.trim()}
				empty={() => uri.trim() === ''}
				clear={() => setUri('')}
				fields={
					<Input
						wide
						type="password"
						autoComplete="off"
						label={T.data.database.field}
						help={T.data.database.fieldHelp}
						placeholder={view.database.set ? '' : T.data.database.placeholder}
						value={uri}
						onChange={(event) => setUri(event.target.value)}
					/>
				}
			/>
			<ConnectionCard
				name="storage"
				title={T.data.storage.title}
				help={T.data.storage.help}
				set={view.storage}
				manage={manage}
				canWrite={canWrite}
				problem={problems.storage}
				setProblem={(problem) => setProblems((old) => ({ ...old, storage: problem }))}
				onChanged={onChanged}
				value={valueOfBucket}
				empty={() => parts.some(([key, needed]) => needed && (bucket[key] ?? '').trim() === '')}
				clear={() => {
					setBucket({});
					setPathStyle(false);
				}}
				fields={
					<>
						{parts.map(([key]) => (
							<Input
								key={key}
								type={key === 'secretAccessKey' || key === 'accessKeyId' ? 'password' : 'text'}
								autoComplete="off"
								label={S[key]}
								value={bucket[key] ?? ''}
								onChange={(event) => setBucket({ ...bucket, [key]: event.target.value })}
							/>
						))}
						<SettingRow label={T.data.storage.pathStyle}>
							<Switch hideLabel label={T.data.storage.pathStyle} checked={pathStyle} onChange={setPathStyle} />
						</SettingRow>
					</>
				}
			/>
			<SettingsCard wide title={T.data.productsTitle} description={T.data.productsHelp}>
				{view.products.length === 0 ? (
					<EmptyState compact icon="box" title={T.data.noProducts} />
				) : (
					<RowList label={T.data.productsTitle}>
						{view.products.map((product) => (
							<ListRow
								key={product.productId}
								product={product.productId}
								title={product.name}
								meta={
									<span className="flex flex-col gap-1">
										{product.database ? (
											<span className="flex flex-wrap items-center gap-2">
												<code>{T.data.databaseName(product.database.name)}</code>
												{product.database.overridden ? (
													<span className="text-help text-muted">{T.data.renamed}</span>
												) : null}
												<StateBadge state={product.database.state} message={product.database.message} />
											</span>
										) : null}
										{product.storage ? (
											<span className="flex flex-wrap items-center gap-2">
												<code>{T.data.folder(product.storage.folder)}</code>
												<StateBadge state={product.storage.state} message={product.storage.message} />
											</span>
										) : null}
									</span>
								}
							/>
						))}
					</RowList>
				)}
			</SettingsCard>
		</div>
	);
}

/**
 * The Between your products section.
 * @param {ConnectionsProps} props
 */
export function LinksSection({ view, manage, canWrite, onChanged }) {
	const toast = useToast();
	const [asking, setAsking] = useState(
		/** @type {null | { link: ConnectionsView['links'][number], action: 'regenerate' | 'off' | 'on' }} */ (null),
	);
	if (!view)
		return (
			<Callout tone="info" className="col-span-full">
				{T.readOnly}
			</Callout>
		);
	/** @param {{ password: string, code?: string, recoveryCode?: string }} confirmation */
	const send = async (confirmation) => {
		if (!asking)
			return { ok: /** @type {const} */ (false), problem: /** @type {Problem} */ ({ status: 400, title: 'Nothing to do' }) };
		const { link, action } = asking;
		const result = await apiConfirm(
			action === 'regenerate'
				? api.websiteLinkRegenerate(manage.merchantId, manage.websiteId, link.callee, link.caller)
				: api.websiteLinkSwitch(manage.merchantId, manage.websiteId, link.callee, link.caller),
			{ method: 'POST', body: action === 'regenerate' ? confirmation : { on: action === 'on', ...confirmation } },
		);
		if (!result.ok) return result;
		onChanged(result.data);
		return { ok: /** @type {const} */ (true) };
	};
	return (
		<div className="col-span-full min-w-0 space-y-4">
			<p className="text-sm text-muted">{T.links.intro}</p>
			{view.links.length === 0 ? (
				<EmptyState compact icon="link" title={T.links.empty} />
			) : (
				<RowList label={T.links.title}>
					{view.links.map((link) => {
						const what = T.links.sentence(link.callerName, link.calleeName);
						return (
							<ListRow
								key={`${link.caller}>${link.callee}`}
								product={link.caller}
								title={what}
								status={<StateBadge state={link.state} />}
								meta={
									<span className="flex flex-col gap-1">
										{link.state === 'on' ? (
											<span>
												{T.links.allows} {link.scopes.map((scope) => scope.name).join(', ')}
											</span>
										) : null}
										{link.state === 'on' ? (
											<span className="text-help text-muted">
												{link.delivered ? T.links.delivered : T.links.waiting}
											</span>
										) : null}
									</span>
								}
								{...(canWrite
									? {
											more: [
												...(link.state === 'off'
													? [
															{
																label: T.links.switchOn,
																onSelect: () => setAsking({ link, action: /** @type {const} */ ('on') }),
															},
														]
													: [
															...(link.state === 'on'
																? [
																		{
																			label: T.links.regenerate,
																			onSelect: () =>
																				setAsking({ link, action: /** @type {const} */ ('regenerate') }),
																		},
																	]
																: []),
															{
																label: T.links.switchOff,
																danger: true,
																onSelect: () => setAsking({ link, action: /** @type {const} */ ('off') }),
															},
														]),
											],
										}
									: {})}
							/>
						);
					})}
				</RowList>
			)}
			<ConfirmChange
				open={asking !== null}
				title={
					asking
						? asking.action === 'regenerate'
							? T.links.confirmRegenerate(T.links.sentence(asking.link.callerName, asking.link.calleeName))
							: asking.action === 'off'
								? T.links.confirmOff(T.links.sentence(asking.link.callerName, asking.link.calleeName))
								: T.links.confirmOn(T.links.sentence(asking.link.callerName, asking.link.calleeName))
						: ''
				}
				help={
					asking?.action === 'regenerate'
						? T.links.regenerateHelp
						: asking?.action === 'off'
							? T.links.offHelp
							: T.links.onHelp
				}
				confirmLabel={
					asking?.action === 'regenerate'
						? T.links.regenerate
						: asking?.action === 'off'
							? T.links.switchOff
							: T.links.switchOn
				}
				danger={asking?.action === 'off'}
				send={send}
				onClose={() => setAsking(null)}
				onDone={() => {
					toast.show({
						title:
							asking?.action === 'regenerate'
								? T.links.regenerated
								: asking?.action === 'off'
									? T.links.switchedOff
									: T.links.switchedOn,
					});
					setAsking(null);
				}}
			/>
		</div>
	);
}
