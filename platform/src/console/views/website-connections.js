'use client';
/**
 * Data and files and Between your products (settings-ownership design 8.3 and 8.4), two sections of Website settings.
 *
 * - **Data and files**: ONE database connection, ONE storage connection and ONE AI provider key for the website, entered
 *   here once. They are write-only: after a save the page only knows that a value is set (never the value), and a person can replace or remove
 *   it. Every change asks for the signed-in person's password again (and a code while two-step is on), so a stolen
 *   session changes nothing. Under the forms, what each product on the website gets: its own database name and folder, the
 *   AI key when its manifest asks for it, and how its own test of the value went. The provider and the model of the AI
 *   key are not secrets and are shown.
 * - **Between your products**: the links the Portal made by itself, each in words ("Chat may use Notifications") with what
 *   it may do and whether the product has its key. A person can switch a link off or on and regenerate its key (after the
 *   password); nobody can paste, read or write a token or a scope.
 * @module
 */
import { useState } from 'react';
import {
	ActionMenu,
	Badge,
	Button,
	Callout,
	EmptyState,
	FormError,
	Input,
	Row,
	Select,
	SettingRow,
	SettingsCard,
	Switch,
	useToast,
} from '@ss/ui';
import { AI_PROVIDERS } from '@ss/contracts';
import { WEBSITE_SETTINGS as T } from '../../texts/console.js';
import { apiConfirm } from '../client.js';
import { api } from '../paths.js';
import { ConfirmChange, confirmationErrors } from './confirm-change.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * What the page shows of the website's connections (`GET …/connections`): never a value.
 * @typedef {object} ConnectionsView
 * @property {number} version
 * @property {{ set: boolean, setAt: string | null }} database
 * @property {{ set: boolean, setAt: string | null, publicBaseUrl?: string }} storage the public address is not a secret: shown
 * @property {{ set: boolean, setAt: string | null, provider?: string, model?: string, baseUrl?: string }} ai the key is never
 *   shown; the provider, the model and the service address are not secrets
 * @property {Array<{ productId: string, name: string, database: { name: string, overridden: boolean, state: string, message?: string } | null,
 *   storage: { folder: string, required: boolean, state: string, message?: string } | null,
 *   ai: { state: string, message?: string } | null }>} products
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
 * The state of a value (or of a link) in words, as a badge.
 * @param {{ state: string, message?: string | undefined, words?: Record<string, string> }} props `words`: the names of the states
 *   (a product's value by default, a link's states for a link)
 */
function StateBadge({ state, message, words: names = T.data.state }) {
	const words = names[state] ?? state;
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
 * @param {{ name: 'database' | 'storage' | 'ai', title: string, help: string, set: { set: boolean, setAt: string | null },
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
	const [aiDraft, setAiDraft] = useState(/** @type {Record<string, string>} */ ({}));
	const [problems, setProblems] = useState(
		/** @type {{ database: Problem | null, storage: Problem | null, ai: Problem | null }} */ ({
			database: null,
			storage: null,
			ai: null,
		}),
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
		['publicBaseUrl', false],
	];
	/** What a field shows: the secrets start empty; the public address starts as it was saved (it is not a secret). @param {string} key */
	const shown = (key) => bucket[key] ?? (key === 'publicBaseUrl' ? (view.storage.publicBaseUrl ?? '') : '');
	/** What an AI field shows: the key starts empty; the provider, model and service address start as saved (they are not secrets). @param {string} key */
	const aiShown = (key) =>
		aiDraft[key] ??
		(key === 'provider' ? (view.ai.provider ?? AI_PROVIDERS[0]) : (view.ai[/** @type {'model' | 'baseUrl'} */ (key)] ?? ''));
	const compatible = aiShown('provider') === 'compatible';
	const valueOfAi = () => ({
		provider: aiShown('provider'),
		apiKey: aiShown('apiKey').trim(),
		model: aiShown('model').trim(),
		...(compatible ? { baseUrl: aiShown('baseUrl').trim() } : {}),
	});
	const valueOfBucket = () => ({
		...Object.fromEntries(parts.filter(([key]) => shown(key).trim() !== '').map(([key]) => [key, shown(key).trim()])),
		...(pathStyle ? { forcePathStyle: true } : {}),
	});
	return (
		<div className="col-span-full min-w-0 space-y-4">
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
								{...(key === 'publicBaseUrl' ? { help: T.data.storage.publicBaseUrlHelp, placeholder: 'https://' } : {})}
								value={shown(key)}
								onChange={(event) => setBucket({ ...bucket, [key]: event.target.value })}
							/>
						))}
						<SettingRow label={T.data.storage.pathStyle}>
							<Switch hideLabel label={T.data.storage.pathStyle} checked={pathStyle} onChange={setPathStyle} />
						</SettingRow>
					</>
				}
			/>
			<ConnectionCard
				name="ai"
				title={T.data.ai.title}
				help={T.data.ai.help}
				set={view.ai}
				manage={manage}
				canWrite={canWrite}
				problem={problems.ai}
				setProblem={(problem) => setProblems((old) => ({ ...old, ai: problem }))}
				onChanged={onChanged}
				value={valueOfAi}
				empty={() =>
					aiShown('apiKey').trim() === '' ||
					aiShown('model').trim() === '' ||
					(compatible && aiShown('baseUrl').trim() === '')
				}
				clear={() => setAiDraft({})}
				fields={
					<>
						<Select
							label={T.data.ai.fields.provider}
							value={aiShown('provider')}
							options={AI_PROVIDERS.map((provider) => ({ value: provider, label: T.data.ai.providers[provider] }))}
							onChange={(event) => setAiDraft({ ...aiDraft, provider: event.target.value })}
						/>
						<Input
							type="password"
							autoComplete="off"
							label={T.data.ai.fields.apiKey}
							help={T.data.ai.apiKeyHelp}
							placeholder={view.ai.set ? '' : T.data.ai.apiKeyPlaceholder}
							value={aiShown('apiKey')}
							onChange={(event) => setAiDraft({ ...aiDraft, apiKey: event.target.value })}
						/>
						<Input
							autoComplete="off"
							label={T.data.ai.fields.model}
							help={T.data.ai.modelHelp}
							value={aiShown('model')}
							onChange={(event) => setAiDraft({ ...aiDraft, model: event.target.value })}
						/>
						{compatible ? (
							<Input
								autoComplete="off"
								label={T.data.ai.fields.baseUrl}
								help={T.data.ai.baseUrlHelp}
								placeholder="https://"
								value={aiShown('baseUrl')}
								onChange={(event) => setAiDraft({ ...aiDraft, baseUrl: event.target.value })}
							/>
						) : null}
					</>
				}
			/>
			<SettingsCard wide title={T.data.productsTitle} description={T.data.productsHelp}>
				{view.products.length === 0 ? (
					<EmptyState compact icon="box" title={T.data.noProducts} description={T.data.noProductsHelp} />
				) : (
					<div className="divide-y divide-line-soft rounded-card border border-line-soft bg-surface">
						{view.products.map((product) => (
							<Row
								key={product.productId}
								lead={{ icon: 'box' }}
								title={product.name}
								meta={[
									product.database
										? `${T.data.databaseName(product.database.name)}${product.database.overridden ? ` (${T.data.renamed})` : ''}`
										: null,
									product.storage ? T.data.folder(product.storage.folder) : null,
									product.ai ? T.data.aiColumn : null,
								].filter(Boolean)}
								trailing={
									<div className="flex flex-wrap items-center gap-2">
										{product.database ? (
											<StateBadge state={product.database.state} message={product.database.message} />
										) : null}
										{product.storage ? (
											<StateBadge state={product.storage.state} message={product.storage.message} />
										) : null}
										{product.ai ? <StateBadge state={product.ai.state} message={product.ai.message} /> : null}
									</div>
								}
							/>
						))}
					</div>
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
			{view.links.length === 0 ? (
				<EmptyState compact icon="link" title={T.links.empty} />
			) : (
				<div className="divide-y divide-line-soft rounded-card border border-line-soft bg-surface">
					{view.links.map((link) => (
						<Row
							key={`${link.caller}>${link.callee}`}
							lead={{ icon: 'link' }}
							title={T.links.sentence(link.callerName, link.calleeName)}
							meta={
								link.state === 'on'
									? [
											link.scopes.map((scope) => scope.name).join(', '),
											link.delivered ? T.links.delivered : T.links.waiting,
										]
									: []
							}
							trailing={
								<div className="flex items-center gap-2">
									<StateBadge state={link.state} words={T.links.state} />
									{canWrite ? (
										<ActionMenu
											floating
											label={`Actions for ${T.links.sentence(link.callerName, link.calleeName)}`}
											items={[
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
											]}
										/>
									) : null}
								</div>
							}
						/>
					))}
				</div>
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
