'use client';
/**
 * The Setup sheet of a website (`ss.blueprint/1`), in both consoles and on its read-only
 * shared page: the website's facts, its **business profile** and the advisor's **recommendations** (features the
 * profile calls for that are not on, with why — the admin switches one on with **Switch on**, the features it needs
 * included — and features that are on although the profile does not call for them), then one panel per product —
 * what is left to do, its features with their settings and lists, connections (state only), widgets, the install
 * snippet and browser token, staff permissions, events, what the website builds and docs. **Download JSON** and
 * **Copy JSON** give the sheet itself; in the consoles **Refresh** gathers it again, **Edit profile** saves the
 * business profile, and **Share links** makes, lists and revokes read-only links (the link is shown once). Every word
 * comes from `texts/console.js`; the Portal checks every right again.
 * @module
 */
import { useEffect, useState } from 'react';
import { OTHER_MAX, PROFILE_CHOICES, PROFILE_NONE, PROFILE_OTHER } from '@ss/contracts/profile';
import {
	ActionMenu,
	Badge,
	Button,
	Callout,
	Card,
	CheckboxGroup,
	CodeBlock,
	Drawer,
	EmptyState,
	FieldGrid,
	FormError,
	Icon,
	IconBadge,
	Input,
	KeyValueList,
	LocalTime,
	Page,
	Row,
	SegmentedControl,
	Section,
	StatusBadge,
	Switch,
	TextLink,
	ToastProvider,
	copyText,
	cx,
	describeProblem,
	useToast,
} from '@ss/ui';
import { COUNTRY_NAMES } from '../../modules/identity/core/countries.js';
import { PROFILE, SETUP } from '../../texts/console.js';
import { apiFetch, takeFragmentToken } from '../client.js';
import { Link } from '../link.js';
import { api } from '../paths.js';

/** @typedef {import('@ss/contracts').Blueprint} Blueprint */
/** @typedef {Blueprint['products'][number]} SheetProduct */
/** @typedef {Extract<SheetProduct, { reachable: true }>} ReachableProduct */
/** @typedef {import('@ss/contracts').BlueprintSetting} BlueprintSetting */
/** @typedef {import('@ss/contracts/profile').BusinessProfile} BusinessProfile */
/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * A share link as the Portal lists it.
 * @typedef {{ linkId: string, createdAt: string, createdBy: 'admin' | 'merchant', expiresAt: string,
 *   revokedAt: string | null, status: 'active' | 'revoked' | 'expired', values: boolean, install: boolean,
 *   openedAt: string | null, opens: number }} ShareLink
 */
/**
 * The website the page is about, and the console's API client.
 * @typedef {{ merchantId: string, websiteId: string }} Manage
 */
/**
 * What the consoles can do on the sheet: edit the business profile, and (admins) switch a recommended feature on.
 * @typedef {{ editProfile: () => void, switchOn: ((product: ReachableProduct, feature: string) => void) | null,
 *   switching: string | null, settingsHref: string }} SheetActions `settingsHref`: the website's settings in the Portal
 */

/** Choice questions in the order people see them. */
const CHOICES = /** @type {Array<keyof typeof PROFILE_CHOICES>} */ (Object.keys(PROFILE_CHOICES));
/** Yes-or-no questions in the order people see them. */
const YES_NO = /** @type {const} */ (['moving', 'taxes']);

/** @param {string} question */
const takesOther = (question) => /** @type {readonly string[]} */ (PROFILE_OTHER).includes(question);

/**
 * Own answers typed as one line, separated by commas: trimmed, empty ones dropped, each once (any case).
 * @param {string} line
 * @returns {string[]}
 */
const ownAnswersOf = (line) => {
	/** @type {string[]} */
	const out = [];
	for (const part of line.split(',')) {
		const text = part.trim().replace(/\s+/g, ' ');
		if (text !== '' && !out.some((kept) => kept.toLowerCase() === text.toLowerCase())) out.push(text);
	}
	return out;
};

/**
 * A business profile in words: each answered question with its answer, in the order people see them.
 * @param {BusinessProfile} profile
 * @returns {Array<{ question: string, answer: string }>}
 */
export const profileLines = (profile) => [
	...CHOICES.filter((question) => (profile[question] ?? []).length + (profile.other?.[question] ?? []).length > 0).map(
		(question) => ({
			question: PROFILE.questions[question],
			answer: [
				...(profile[question] ?? []).map(
					(option) => /** @type {Record<string, string>} */ (PROFILE.options[question])[option] ?? option,
				),
				...(profile.other?.[question] ?? []),
			].join(', '),
		}),
	),
	...YES_NO.filter((question) => typeof profile[question] === 'boolean').map((question) => ({
		question: PROFILE.questions[question],
		answer: profile[question] ? PROFILE.yes : PROFILE.no,
	})),
	...((profile.countries ?? []).length > 0
		? [
				{
					question: PROFILE.questions.countries,
					answer: (profile.countries ?? []).map((code) => COUNTRY_NAMES[code] ?? code).join(', '),
				},
			]
		: []),
	...((profile.languages ?? []).length > 0
		? [{ question: PROFILE.questions.languages, answer: (profile.languages ?? []).join(', ') }]
		: []),
];

/**
 * The features a feature needs that are off (all the way down), by title.
 * @param {ReachableProduct} product
 * @param {string} key
 * @returns {string[]}
 */
export const neededOff = (product, key) => {
	const byKey = new Map(product.features.map((feature) => [feature.key, feature]));
	/** @type {Set<string>} */
	const seen = new Set();
	/** @param {string} at */
	const walk = (at) => {
		for (const dependency of byKey.get(at)?.dependsOn ?? [])
			if (!seen.has(dependency)) {
				seen.add(dependency);
				walk(dependency);
			}
	};
	walk(key);
	return product.features.filter((feature) => seen.has(feature.key) && !feature.on).map((feature) => feature.title);
};

/**
 * A setting's value in words: yes or no, a list joined, an empty text or list as None.
 * @param {unknown} value
 * @returns {string}
 */
export const valueText = (value) => {
	if (typeof value === 'boolean') return value ? SETUP.yes : SETUP.no;
	if (Array.isArray(value)) return value.length === 0 ? SETUP.empty : value.map((item) => valueText(item)).join(', ');
	if (value === null || value === undefined || value === '') return SETUP.empty;
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
};

/**
 * The sheet as a JSON file, saved by the browser.
 * @param {Blueprint} sheet
 */
const saveJson = (sheet) => {
	const url = URL.createObjectURL(new Blob([JSON.stringify(sheet, null, 2)], { type: 'application/json' }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = `setup-${sheet.website.domain}.json`;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
};

/** @param {{ done: boolean }} props */
function Mark({ done }) {
	return (
		<span
			aria-hidden="true"
			className={cx(
				'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
				done ? 'bg-success-solid text-on-solid' : 'bg-attention-soft text-attention',
			)}>
			<Icon name={done ? 'check' : 'clock'} size={12} />
		</span>
	);
}

/** @param {{ title: string, children: import('react').ReactNode }} props */
function Part({ title, children }) {
	return (
		<div className="space-y-2">
			<h4 className="text-xs font-semibold text-muted">{title}</h4>
			{children}
		</div>
	);
}

/** @param {{ settings: BlueprintSetting[] }} props */
function Settings({ settings }) {
	if (settings.length === 0) return <p className="text-xs text-muted">{SETUP.noSettings}</p>;
	return (
		<dl className="divide-y divide-line-soft rounded-card border border-line-soft">
			{settings.map((setting) => (
				<div key={setting.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2">
					<dt className="min-w-0 text-label text-fg">{setting.title}</dt>
					<dd className="flex min-w-0 items-center gap-2 text-label font-medium break-words text-fg">
						{'value' in setting ? <span className="min-w-0">{valueText(setting.value)}</span> : null}
						{setting.set ? <span className="min-w-0 text-muted">{SETUP.secretSet}</span> : null}
						{setting.default ? <Badge>{SETUP.defaultValue}</Badge> : null}
					</dd>
				</div>
			))}
		</dl>
	);
}

/**
 * One product's panel.
 * @param {{ product: ReachableProduct, valuesShown: boolean }} props
 */
function ProductPanel({ product, valuesShown }) {
	const open = product.checklist.filter((item) => !item.done);
	const on = product.features.filter((feature) => feature.on);
	const off = product.features.filter((feature) => !feature.on);
	return (
		<Card
			as="article"
			title={
				<span className="flex flex-wrap items-center gap-2">
					<IconBadge product={product.productId} size="sm" />
					{product.name}
					<StatusBadge status={product.status} />
				</span>
			}
			subtitle={SETUP.version(product.version)}>
			<div className="space-y-5">
				<Part title={SETUP.sections.checklist}>
					{open.length === 0 ? <p className="text-sm text-muted">{SETUP.allDone}</p> : null}
					<ul className="space-y-1.5">
						{product.checklist.map((item) => (
							<li key={item.key} className="flex items-start gap-2 text-sm text-fg">
								<Mark done={item.done} />
								<span className={cx('min-w-0', item.done && 'text-muted')}>
									<span className="sr-only">{item.done ? SETUP.done : SETUP.toDo}: </span>
									{item.text}
								</span>
							</li>
						))}
					</ul>
				</Part>
				{product.summaries.length > 0 ? (
					<Part title={SETUP.sections.summaries}>
						{product.summaries.map((summary) => (
							<p key={summary.title} className="text-sm text-fg">
								<span className="font-semibold">{summary.title}:</span> {summary.text}
							</p>
						))}
					</Part>
				) : null}
				<Part title={SETUP.sections.features}>
					{!valuesShown ? <p className="text-xs text-muted">{SETUP.valuesHidden}</p> : null}
					<ul className="space-y-3">
						{on.map((feature) => (
							<li key={feature.key} className="space-y-2">
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-sm font-semibold text-fg">{feature.title}</span>
									<Badge tone="success" dot>
										{SETUP.on}
									</Badge>
								</div>
								<p className="text-xs text-muted">{feature.description}</p>
								<Settings settings={feature.settings} />
								{feature.lists.map((list) => (
									<p key={list.name} className="text-label text-fg">
										<span className="font-medium">{list.title}:</span> {list.summary}
									</p>
								))}
							</li>
						))}
					</ul>
					{off.length > 0 ? (
						<p className="text-xs text-muted">
							<span className="font-medium">{SETUP.off}:</span> {off.map((feature) => feature.title).join(', ')}
						</p>
					) : null}
				</Part>
				{product.shared.length > 0 ? (
					<Part title={SETUP.sections.shared}>
						{product.shared.map((group) => (
							<div key={group.key} className="space-y-2">
								<p className="text-sm font-semibold text-fg">{group.title}</p>
								<Settings settings={group.settings} />
							</div>
						))}
					</Part>
				) : null}
				<Part title={SETUP.sections.connections}>
					<ul className="space-y-1.5">
						{product.connections.map((connection) => (
							<li key={connection.key} className="flex flex-wrap items-center justify-between gap-2 text-sm text-fg">
								<span className="min-w-0">
									{connection.title}
									<span className="ml-2 text-xs text-muted">{connection.needed ? SETUP.needed : SETUP.notNeeded}</span>
								</span>
								<StatusBadge
									status={
										connection.state === 'connected'
											? 'connected'
											: connection.state === 'test_failed'
												? 'failed'
												: 'missing'
									}
									label={SETUP.states[connection.state]}
								/>
							</li>
						))}
					</ul>
				</Part>
				<Part title={SETUP.sections.widgets}>
					{product.widgets.length === 0 ? <p className="text-xs text-muted">{SETUP.noWidgets}</p> : null}
					<ul className="space-y-1.5">
						{product.widgets.map((widget) => (
							<li key={widget.key} className="flex flex-wrap items-center justify-between gap-2 text-sm text-fg">
								<span className="min-w-0">
									<code className="font-mono text-label">{widget.key}</code>
									<span className="ml-2 text-xs text-muted">{SETUP.widgetKinds[widget.kind]}</span>
								</span>
								<Badge tone={widget.ready ? 'success' : widget.on ? 'warning' : 'neutral'} dot>
									{widget.ready ? SETUP.ready : widget.on ? SETUP.notReady : SETUP.off}
								</Badge>
							</li>
						))}
					</ul>
				</Part>
				<Part title={SETUP.sections.install}>
					{product.install.installed !== null ? (
						<p className="text-xs text-muted">{product.install.installed ? SETUP.installed : SETUP.notInstalled}</p>
					) : null}
					{product.install.browserToken === undefined ? (
						<p className="text-xs text-muted">{SETUP.installHidden}</p>
					) : (
						<div className="space-y-3">
							{product.install.snippet ? (
								<div className="space-y-1">
									<CodeBlock label={SETUP.snippet} code={product.install.snippet} />
									<p className="text-xs text-muted">{SETUP.snippetHelp}</p>
								</div>
							) : null}
							<CodeBlock label={SETUP.browserToken} code={product.install.browserToken} />
						</div>
					)}
					<p className="text-xs text-muted">{SETUP.serverTokenIssued}</p>
				</Part>
				<Part title={SETUP.sections.build}>
					{product.build.length === 0 ? (
						<p className="text-xs text-muted">{SETUP.noBuild}</p>
					) : (
						<ul className="space-y-2">
							{product.build.map((item) => (
								<li key={item.feature} className="space-y-0.5 text-sm text-fg">
									<span className="font-medium">
										{product.features.find((feature) => feature.key === item.feature)?.title ?? item.feature}
									</span>{' '}
									<span>{item.what}</span>{' '}
									<TextLink href={item.docs} external>
										{SETUP.guide}
									</TextLink>
								</li>
							))}
						</ul>
					)}
				</Part>
				<Part title={SETUP.sections.permissions}>
					{product.staffPermissions.length === 0 ? (
						<p className="text-xs text-muted">{SETUP.noPermissions}</p>
					) : (
						<ul className="space-y-1">
							{product.staffPermissions.map((permission) => (
								<li key={permission.key} className="flex flex-wrap items-baseline gap-2 text-sm text-fg">
									<code className="font-mono text-label">{permission.key}</code>
									<span className={cx('text-xs', permission.on ? 'text-fg' : 'text-muted')}>{permission.name}</span>
								</li>
							))}
						</ul>
					)}
				</Part>
				<Part title={SETUP.sections.events}>
					{product.events.length === 0 ? (
						<p className="text-xs text-muted">{SETUP.noEvents}</p>
					) : (
						<ul className="flex flex-wrap gap-1.5">
							{product.events.map((event) => (
								<li key={event}>
									<code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg">{event}</code>
								</li>
							))}
						</ul>
					)}
				</Part>
				<Part title={SETUP.sections.docs}>
					<p className="text-sm break-words text-fg">{SETUP.apiBase(product.apiBase)}</p>
					<p className="flex flex-wrap gap-4 text-sm">
						<TextLink href={product.docs.guide} external>
							{SETUP.guide}
						</TextLink>
						{product.docs.openapi ? (
							<TextLink href={product.docs.openapi} external>
								{SETUP.openapi}
							</TextLink>
						) : null}
					</p>
				</Part>
			</div>
		</Card>
	);
}

/**
 * The business profile: its answers in words, or a call to fill it out.
 * @param {{ profile: BusinessProfile | null, actions: SheetActions | null }} props
 */
function ProfileCard({ profile, actions }) {
	// the countries and languages are the website's settings: the profile is the advisor's own once it has other answers
	const own = profile !== null && Object.keys(profile).some((question) => question !== 'countries' && question !== 'languages');
	return (
		<Card
			title={PROFILE.title}
			subtitle={PROFILE.intro}
			actions={
				actions ? (
					<Button variant="secondary" size="sm" onClick={actions.editProfile}>
						{profile ? PROFILE.edit : PROFILE.fillOut}
					</Button>
				) : null
			}>
			<div className="space-y-3">
				{own ? null : <p className="text-sm text-muted">{PROFILE.empty}</p>}
				{profile ? (
					<KeyValueList items={profileLines(profile).map((line) => ({ label: line.question, value: line.answer }))} />
				) : null}
				{actions ? (
					<p className="text-xs text-muted">
						{PROFILE.fromSettings}{' '}
						<TextLink as={Link} href={`${actions.settingsHref}/region`}>
							{SETUP.openSettings}
						</TextLink>
					</p>
				) : null}
			</div>
		</Card>
	);
}

/**
 * The advisor: features the profile calls for that are off (with Switch on for admins), and features that are on
 * although it does not call for them.
 * @param {{ sheet: Blueprint, actions: SheetActions | null }} props
 */
function Recommendations({ sheet, actions }) {
	const products = sheet.products.filter(/** @returns {p is ReachableProduct} */ (p) => p.reachable);
	/** @param {ReachableProduct} product @param {string} key */
	const titleOf = (product, key) => product.features.find((feature) => feature.key === key)?.title ?? key;
	const off = products.flatMap((product) =>
		product.recommended.filter((entry) => !entry.on).map((entry) => ({ product, entry })),
	);
	const unneeded = products.flatMap((product) => product.notRecommended.map((entry) => ({ product, entry })));
	const onCount = products.reduce((n, product) => n + product.recommended.filter((entry) => entry.on).length, 0);
	return (
		<Card title={SETUP.recommendations} subtitle={SETUP.recommendationsIntro}>
			{sheet.website.profile === null ? (
				<p className="text-sm text-muted">{SETUP.noAdvice}</p>
			) : (
				<div className="space-y-5">
					<p className="text-sm text-fg">{off.length === 0 ? SETUP.allRecommendedOn : SETUP.recommendedOn(onCount)}</p>
					{off.length > 0 ? (
						<Part title={SETUP.recommendedOff}>
							<div className="divide-y divide-line-soft rounded-card border border-line-soft bg-surface">
								{off.map(({ product, entry }) => {
									const needed = neededOff(product, entry.feature);
									return (
										<Row
											key={`${product.productId}:${entry.feature}`}
											lead={{ icon: 'sparkle' }}
											title={titleOf(product, entry.feature)}
											meta={[
												product.name,
												entry.why,
												needed.length > 0 ? SETUP.alsoSwitches(needed.join(', ')) : null,
											].filter(Boolean)}
											trailing={
												actions?.switchOn ? (
													<ActionMenu
														floating
														label={`Actions for ${titleOf(product, entry.feature)}`}
														items={[
															{
																label: SETUP.switchOn,
																disabled: actions.switching !== null,
																onSelect: () => actions.switchOn?.(product, entry.feature),
															},
														]}
													/>
												) : null
											}
										/>
									);
								})}
							</div>
							{actions ? (
								<p className="text-xs text-muted">{actions.switchOn ? SETUP.billedNote : SETUP.recommendedOffAsk}</p>
							) : null}
						</Part>
					) : null}
					{unneeded.length > 0 ? (
						<Part title={SETUP.notRecommended}>
							<p className="text-xs text-muted">{SETUP.notRecommendedHelp}</p>
							<ul className="space-y-1.5">
								{unneeded.map(({ product, entry }) => (
									<li key={`${product.productId}:${entry.feature}`} className="text-sm text-fg">
										<span className="font-semibold">{titleOf(product, entry.feature)}</span>{' '}
										<span className="text-xs text-muted">
											({product.name}) · {entry.why}
										</span>
									</li>
								))}
							</ul>
						</Part>
					) : null}
				</div>
			)}
		</Card>
	);
}

/**
 * Edit the business profile: every question optional; `none` stands alone.
 * @param {{ manage: Manage, profile: BusinessProfile | null, settingsHref: string, onClose: () => void,
 *   onSaved: (sheet: Blueprint) => void }} props `settingsHref`: where the countries and languages are set
 */
function ProfileDialog({ manage, profile, settingsHref, onClose, onSaved }) {
	// the countries and languages are the website's settings, not answered here
	const [answers, setAnswers] = useState(
		/** @type {BusinessProfile} */ (
			Object.fromEntries(
				Object.entries(profile ?? {}).filter(([question]) => question !== 'countries' && question !== 'languages'),
			)
		),
	);
	const [own, setOwn] = useState(
		/** @type {Record<string, string>} */ (
			Object.fromEntries(PROFILE_OTHER.map((question) => [question, (profile?.other?.[question] ?? []).join(', ')]))
		),
	);
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	/** @param {keyof typeof PROFILE_CHOICES} question @param {string[]} next */
	const choose = (question, next) => {
		// picking none clears the rest; picking another answer clears none
		const added = next.find((option) => !(answers[question] ?? []).includes(option));
		const kept = added === PROFILE_NONE ? [PROFILE_NONE] : next.filter((option) => option !== PROFILE_NONE || !added);
		setAnswers({ ...answers, [question]: kept });
		// none stands alone: it clears the own answers too
		if (added === PROFILE_NONE && takesOther(question)) setOwn({ ...own, [question]: '' });
	};
	const save = async () => {
		/** @type {Record<string, string>} */
		const found = {};
		/** @type {Record<string, string[]>} */
		const other = {};
		for (const question of PROFILE_OTHER) {
			const answers = ownAnswersOf(own[question] ?? '');
			if (answers.length > OTHER_MAX.answers) found[`other.${question}`] = PROFILE.otherTooMany(OTHER_MAX.answers);
			else if (answers.some((text) => text.length > OTHER_MAX.length))
				found[`other.${question}`] = PROFILE.otherTooLong(OTHER_MAX.length);
			if (answers.length > 0) other[question] = answers;
		}
		setErrors(found);
		if (Object.keys(found).length > 0) return;
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(api.setupProfile(manage.merchantId, manage.websiteId), {
			method: 'PUT',
			body: { ...answers, other },
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		onSaved(result.data);
	};
	return (
		<Drawer open onClose={onClose} title={PROFILE.title} description={PROFILE.intro} size="lg">
			<div className="space-y-5">
				<FieldGrid>
					{CHOICES.map((question) => (
						<div key={question} className="min-w-0 space-y-2">
							<CheckboxGroup
								legend={PROFILE.questions[question]}
								options={PROFILE_CHOICES[question].map((option) => ({
									value: option,
									label: /** @type {Record<string, string>} */ (PROFILE.options[question])[option] ?? option,
								}))}
								value={answers[question] ?? []}
								onChange={(next) => choose(question, next)}
							/>
							{takesOther(question) ? (
								<Input
									label={PROFILE.other}
									aria-label={PROFILE.otherLabel(PROFILE.questions[question])}
									help={PROFILE.otherHelp}
									value={own[question] ?? ''}
									onChange={(event) => {
										setOwn({ ...own, [question]: event.currentTarget.value });
										if (errors[`other.${question}`]) {
											setErrors((prev) => {
												const { [`other.${question}`]: _, ...rest } = prev;
												return rest;
											});
										}
									}}
									error={errors[`other.${question}`]}
								/>
							) : null}
						</div>
					))}
					{YES_NO.map((question) => (
						<SegmentedControl
							key={question}
							legend={PROFILE.questions[question]}
							options={[
								{ value: 'yes', label: PROFILE.yes },
								{ value: 'no', label: PROFILE.no },
								{ value: '', label: PROFILE.notAnswered },
							]}
							value={answers[question] === undefined ? '' : answers[question] ? 'yes' : 'no'}
							onChange={(value) => {
								const { [question]: _answer, ...rest } = answers;
								setAnswers(value === '' ? rest : { ...rest, [question]: value === 'yes' });
							}}
						/>
					))}
				</FieldGrid>
				<p className="text-sm text-muted">
					{PROFILE.fromSettings}{' '}
					<TextLink as={Link} href={`${settingsHref}/region`}>
						{SETUP.openSettings}
					</TextLink>
				</p>
				<FormError problem={problem} />
				<Button loading={busy} onClick={() => void save()}>
					{PROFILE.save}
				</Button>
			</div>
		</Drawer>
	);
}

/**
 * The sections of a setup sheet: the website's facts, its business profile with the recommendations, and every
 * product's panel. The console puts them behind an inner sidebar, the public copy stacks them.
 * @param {Blueprint} sheet
 * @param {SheetActions | null} actions `actions`: in the consoles
 * @returns {Array<{ id: string, label: string, icon: import('@ss/ui').IconName, content?: import('react').ReactNode,
 *   children?: Array<{ id: string, label: string, content: import('react').ReactNode }> }>}
 */
const sheetSections = (sheet, actions) => {
	const { website, access } = sheet;
	return [
		{
			id: 'website',
			label: SETUP.website,
			icon: 'globe',
			content: (
				<Card title={SETUP.website}>
					<dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
						<div className="min-w-0 space-y-0.5">
							<dt className="text-xs font-medium text-muted">{SETUP.domain}</dt>
							<dd className="text-sm break-words text-fg">{website.domain}</dd>
						</div>
						<div className="min-w-0 space-y-0.5">
							<dt className="text-xs font-medium text-muted">{SETUP.websiteStatus}</dt>
							<dd className="text-sm text-fg">
								<StatusBadge status={website.status} />
							</dd>
						</div>
						<div className="min-w-0 space-y-0.5">
							<dt className="text-xs font-medium text-muted">{SETUP.business}</dt>
							<dd className="text-sm break-words text-fg">
								{website.business.found
									? SETUP.businessFound(website.business.name ?? website.domain)
									: SETUP.businessMissing}
								{actions ? (
									<>
										{' '}
										<TextLink as={Link} href={actions.settingsHref}>
											{SETUP.openSettings}
										</TextLink>
									</>
								) : null}
							</dd>
						</div>
						<div className="min-w-0 space-y-0.5">
							<dt className="text-xs font-medium text-muted">{SETUP.allowedOrigins}</dt>
							<dd className="text-sm break-words text-fg">{access.allowedOrigins.join(', ')}</dd>
						</div>
						<div className="min-w-0 space-y-0.5">
							<dt className="text-xs font-medium text-muted">{SETUP.testingOrigins}</dt>
							<dd className="text-sm break-words text-fg">
								{access.testingOrigins.join(', ')} <span className="text-muted">({SETUP.testingNote})</span>
							</dd>
						</div>
						<div className="min-w-0 space-y-0.5 sm:col-span-2">
							<dt className="text-xs font-medium text-muted">{SETUP.serverTokens}</dt>
							<dd className="text-sm text-fg">{access.serverTokens}</dd>
						</div>
						<div className="min-w-0 space-y-0.5">
							<dt className="text-xs font-medium text-muted">{SETUP.made}</dt>
							<dd className="text-sm text-fg">
								<LocalTime value={sheet.generatedAt} />
							</dd>
						</div>
					</dl>
				</Card>
			),
		},
		{
			id: 'profile',
			label: PROFILE.title,
			icon: 'user',
			content: (
				<>
					<ProfileCard profile={website.profile} actions={actions} />
					<Recommendations sheet={sheet} actions={actions} />
				</>
			),
		},
		{
			id: 'products',
			label: SETUP.products,
			icon: 'box',
			// several products: one view each, so a product's panel is never a long column under another's
			...(sheet.products.length > 1
				? {
						children: sheet.products.map((product) => ({
							id: `product-${product.productId}`,
							label: product.name,
							content: productEntry(product, sheet.share?.values !== false),
						})),
					}
				: {
						content: (
							<Section title={SETUP.products}>
								{sheet.products.length === 0 ? (
									<EmptyState
										compact
										icon="box"
										kind="product"
										title={SETUP.noProducts}
										description={SETUP.noProductsHelp}
									/>
								) : (
									sheet.products.map((product) => productEntry(product, sheet.share?.values !== false))
								)}
							</Section>
						),
					}),
		},
	];
};

/**
 * One product of the sheet: its panel, or why it could not be reached.
 * @param {Blueprint['products'][number]} product
 * @param {boolean} valuesShown
 */
const productEntry = (product, valuesShown) =>
	product.reachable ? (
		<ProductPanel key={product.productId} product={product} valuesShown={valuesShown} />
	) : (
		<Callout key={product.productId} tone="warning" title={SETUP.notReachable(product.name)}>
			{SETUP.reasons[product.reason]}
		</Callout>
	);

/**
 * The website's facts, its business profile and the recommendations, and every product's panel, one under the other.
 * @param {{ sheet: Blueprint, actions?: SheetActions | null }} props `actions`: in the consoles
 */
function SheetBody({ sheet, actions = null }) {
	return (
		<div className="space-y-6">
			{sheetSections(sheet, actions).flatMap((section) =>
				(section.children ?? [section]).map((part) => (
					<div key={part.id} className="space-y-6">
						{part.content}
					</div>
				)),
			)}
		</div>
	);
}

/**
 * Create share link: how long it lasts and what it shows; then the link, once.
 * @param {{ manage: Manage, onClose: () => void, onCreated: (link: ShareLink) => void }} props
 */
function CreateLinkDialog({ manage, onClose, onCreated }) {
	const [days, setDays] = useState('7');
	const [values, setValues] = useState(true);
	const [install, setInstall] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [url, setUrl] = useState(/** @type {string | null} */ (null));
	const create = async () => {
		const n = Number(days);
		if (!Number.isInteger(n) || n < 1 || n > 30) {
			setError(SETUP.daysInvalid);
			return;
		}
		setError(null);
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(api.setupLinks(manage.merchantId, manage.websiteId), {
			method: 'POST',
			body: { days: n, values, install },
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setUrl(String(result.data.url));
		onCreated(result.data.link);
	};
	return (
		<Drawer
			open
			onClose={onClose}
			title={url ? SETUP.linkReady : SETUP.createLink}
			description={url ? SETUP.linkOnce : SETUP.createLinkHelp}>
			{url ? (
				<div className="space-y-4">
					<CodeBlock label={SETUP.shareLink} code={url} />
					<Button onClick={onClose}>{SETUP.done}</Button>
				</div>
			) : (
				<div className="space-y-4">
					<Input
						label={SETUP.days}
						help={SETUP.daysHelp}
						type="number"
						min={1}
						max={30}
						inputMode="numeric"
						value={days}
						onChange={(event) => {
							setDays(event.currentTarget.value);
							if (error) setError(null);
						}}
						error={error ?? undefined}
					/>
					<Switch checked={values} onChange={setValues} label={SETUP.includeValues} description={SETUP.includeValuesHelp} />
					<Switch
						checked={install}
						onChange={setInstall}
						label={SETUP.includeInstall}
						description={SETUP.includeInstallHelp}
					/>
					<FormError problem={problem} />
					<Button loading={busy} onClick={() => void create()}>
						{SETUP.create}
					</Button>
				</div>
			)}
		</Drawer>
	);
}

/**
 * The share links of the website: make one, see who made each, when it expires and was opened, revoke.
 * @param {{ manage: Manage, initial: ShareLink[] }} props
 */
function ShareLinks({ manage, initial }) {
	const toast = useToast();
	const [links, setLinks] = useState(initial);
	const [creating, setCreating] = useState(false);
	const [busy, setBusy] = useState(/** @type {string | null} */ (null));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	useEffect(() => setLinks(initial), [initial]);
	/** @param {ShareLink} link */
	const revoke = async (link) => {
		setBusy(link.linkId);
		setProblem(null);
		const result = await apiFetch(api.setupLink(manage.merchantId, manage.websiteId, link.linkId), { method: 'DELETE' });
		setBusy(null);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setLinks((list) => list.map((item) => (item.linkId === link.linkId ? result.data.link : item)));
		toast.show({ title: SETUP.revoked });
	};
	return (
		<Section
			id="setup-share-links"
			title={SETUP.linksTitle}
			description={SETUP.linksIntro}
			actions={
				<Button size="sm" onClick={() => setCreating(true)} icon={<Icon name="plus" size={14} />}>
					{SETUP.createLink}
				</Button>
			}>
			{problem ? <Callout tone="danger">{describeProblem(problem)}</Callout> : null}
			{links.length === 0 ? (
				<EmptyState compact icon="link" title={SETUP.noLinks} />
			) : (
				<div className="divide-y divide-line-soft rounded-card border border-line-soft bg-surface">
					{links.map((link) => (
						<Row
							key={link.linkId}
							lead={{ icon: 'link' }}
							title={`${SETUP.createdBy[link.createdBy]} · ${SETUP.shows(link.values, link.install)}`}
							meta={[
								SETUP.opens(link.opens),
								link.openedAt ? (
									<>
										{SETUP.lastOpened} <LocalTime value={link.openedAt} />
									</>
								) : null,
							].filter(Boolean)}
							time={<LocalTime value={link.expiresAt} />}
							trailing={
								<div className="flex items-center gap-2">
									<StatusBadge status={link.status} label={SETUP.linkStatus[link.status]} />
									<ActionMenu
										floating
										label={`Actions for ${SETUP.expires} ${link.expiresAt}`}
										items={[
											{
												label: SETUP.revoke,
												danger: true,
												disabled: link.status !== 'active' || busy !== null,
												onSelect: () => void revoke(link),
											},
										]}
									/>
								</div>
							}
						/>
					))}
				</div>
			)}
			{creating ? (
				<CreateLinkDialog
					manage={manage}
					onClose={() => setCreating(false)}
					onCreated={(link) => setLinks((list) => [link, ...list])}
				/>
			) : null}
		</Section>
	);
}

/**
 * The Setup sheet a website page keeps for its header: the sheet (null until the Setup sub-page has loaded it), gathering
 * it again, copying it and downloading it as JSON, so the header can carry those three actions (layout contract R6).
 * @param {{ sheet: Blueprint | null, manage: Manage }} props
 */
export function useSetupSheet({ sheet: initial, manage }) {
	const toast = useToast();
	const [sheet, setSheet] = useState(initial);
	const [refreshing, setRefreshing] = useState(false);
	useEffect(() => setSheet(initial), [initial]);
	const refresh = async () => {
		setRefreshing(true);
		const result = await apiFetch(api.setup(manage.merchantId, manage.websiteId, { fresh: true }));
		setRefreshing(false);
		if (!result.ok) {
			toast.show({ tone: 'danger', title: describeProblem(result.problem) });
			return;
		}
		setSheet(result.data);
		toast.show({ title: SETUP.refreshed });
	};
	const copy = async () => {
		const ok = await copyText(JSON.stringify(sheet, null, 2));
		toast.show(ok ? { title: SETUP.copied } : { tone: 'danger', title: SETUP.copyFailed });
	};
	const download = () => {
		const link = document.createElement('a');
		link.href = api.setup(manage.merchantId, manage.websiteId, { download: true });
		link.download = '';
		document.body.append(link);
		link.click();
		link.remove();
	};
	return { sheet, setSheet, refreshing, refresh: () => void refresh(), copy: () => void copy(), download };
}

/**
 * The Setup sheet sub-page of a website in a console (each console passes its API client): the sheet's cards and the
 * share links. Refresh, Copy and Download sit in the website page's header (`useSetupSheet`).
 * @param {{ state: ReturnType<typeof useSetupSheet>, links: ShareLink[], manage: Manage,
 *   canSwitch: boolean, settingsHref: string }} props `canSwitch`: the admin console (Owner and Support) switches recommended
 *   features on; `settingsHref`: the website's settings page, where its business facts, countries and languages are set
 */
export function SetupView({ state, links, manage, canSwitch, settingsHref }) {
	const toast = useToast();
	const { sheet, setSheet } = state;
	const [editing, setEditing] = useState(false);
	const [switching, setSwitching] = useState(/** @type {string | null} */ (null));
	if (!sheet) return null;
	/** @param {ReachableProduct} product @param {string} feature */
	const switchOn = async (product, feature) => {
		setSwitching(`${product.productId}:${feature}`);
		const result = await apiFetch(api.setupFeatures(manage.merchantId, manage.websiteId), {
			method: 'POST',
			body: { productId: product.productId, feature },
		});
		setSwitching(null);
		if (!result.ok) {
			toast.show({ tone: 'danger', title: describeProblem(result.problem) });
			return;
		}
		setSheet(result.data.sheet);
		const titles = /** @type {string[]} */ (result.data.added).map(
			(key) => product.features.find((f) => f.key === key)?.title ?? key,
		);
		toast.show({ title: SETUP.switchedOn(titles.join(', ')) });
	};
	/** @type {SheetActions} */
	const actions = {
		editProfile: () => setEditing(true),
		switchOn: canSwitch ? (product, feature) => void switchOn(product, feature) : null,
		switching,
		settingsHref,
	};
	return (
		<div className="space-y-6">
			<SheetBody sheet={sheet} actions={actions} />
			<ShareLinks manage={manage} initial={links} />
			{editing ? (
				<ProfileDialog
					manage={manage}
					profile={sheet.website.profile}
					settingsHref={settingsHref}
					onClose={() => setEditing(false)}
					onSaved={(saved) => {
						setSheet(saved);
						setEditing(false);
						toast.show({ title: PROFILE.saved });
					}}
				/>
			) : null}
		</div>
	);
}

/**
 * The read-only page of a share link (public, unframed, with its own toasts).
 * @param {{ brand: string }} props
 */
export function SharedSetupView({ brand }) {
	return (
		<ToastProvider>
			<SharedSetup brand={brand} />
		</ToastProvider>
	);
}

/** Where the shared page keeps its key for this tab only, so a reload still opens the copy. */
const SHARED_KEY_STORE = 'ss-shared-setup-key';

/**
 * The share key: from the address fragment (then removed from the address bar), else the one this tab kept; a link
 * that no longer works forgets it. Storage the browser refuses only loses the reload.
 * @returns {{ key: string | null, forget: () => void }}
 */
const sharedKey = () => {
	const fromAddress = takeFragmentToken('key');
	const forget = () => {
		try {
			window.sessionStorage.removeItem(SHARED_KEY_STORE);
		} catch {
			// nothing kept
		}
	};
	try {
		if (fromAddress) window.sessionStorage.setItem(SHARED_KEY_STORE, fromAddress);
		return { key: fromAddress ?? window.sessionStorage.getItem(SHARED_KEY_STORE), forget };
	} catch {
		return { key: fromAddress, forget };
	}
};

/**
 * The shared sheet: the key comes from the address fragment (`#key=`), never a URL the server sees, and is sent in a
 * POST body; the tab keeps it so a reload still opens the copy.
 * @param {{ brand: string }} props
 */
function SharedSetup({ brand }) {
	const toast = useToast();
	const [state, setState] = useState(
		/** @type {{ phase: 'loading' } | { phase: 'ready', sheet: Blueprint } | { phase: 'missing', problem: Problem | null }} */ ({
			phase: 'loading',
		}),
	);
	useEffect(() => {
		const { key, forget } = sharedKey();
		if (!key) {
			setState({ phase: 'missing', problem: null });
			return;
		}
		void apiFetch(api.sharedSetup(), { method: 'POST', body: { key }, redirectOn401: false }).then((result) => {
			if (!result.ok && result.problem?.status === 404) forget();
			setState(result.ok ? { phase: 'ready', sheet: result.data } : { phase: 'missing', problem: result.problem });
		});
	}, []);
	const ready = state.phase === 'ready' ? state.sheet : null;
	const title = ready ? SETUP.sharedTitle(ready.website.domain) : SETUP.sharedHeading;
	return (
		<main className="mx-auto flex h-dvh min-h-0 max-w-6xl flex-col p-3 sm:p-4 lg:p-6">
			<Page
				crumbs={[{ label: brand }, { label: title }]}
				loading={state.phase === 'loading'}
				{...(state.phase === 'missing'
					? {
							error: {
								title: SETUP.sharedMissing,
								message:
									state.problem && state.problem.status !== 404
										? describeProblem(state.problem)
										: SETUP.sharedMissingHelp,
							},
						}
					: {})}
				{...(ready
					? {
							actions: {
								primary: { label: SETUP.download, icon: 'arrowDown', onClick: () => saveJson(ready) },
								secondary: [
									{
										label: SETUP.copy,
										icon: 'copy',
										onClick: () =>
											void copyText(JSON.stringify(ready, null, 2)).then((ok) =>
												toast.show(ok ? { title: SETUP.copied } : { tone: 'danger', title: SETUP.copyFailed }),
											),
									},
								],
							},
						}
					: {})}>
				{ready ? (
					<>
						<p className="max-w-3xl text-sm text-muted">
							{SETUP.sharedIntro}{' '}
							{ready.share ? (
								<>
									{SETUP.sharedUntil} <LocalTime value={ready.share.expiresAt} />.
								</>
							) : null}
						</p>
						<SheetBody sheet={ready} />
					</>
				) : null}
			</Page>
		</main>
	);
}
