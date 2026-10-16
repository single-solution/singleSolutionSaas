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
	Badge,
	Button,
	ButtonLink,
	Callout,
	Card,
	CheckboxGroup,
	ChoicePicker,
	CodeBlock,
	Dialog,
	EmptyState,
	ErrorState,
	FieldGrid,
	FormError,
	Icon,
	IconBadge,
	Input,
	KeyValueList,
	LocalTime,
	Masonry,
	PageHeader,
	SectionLayout,
	SegmentedControl,
	Section,
	Skeleton,
	StatusBadge,
	Switch,
	ToastProvider,
	copyText,
	cx,
	describeProblem,
	useToast,
} from '@ss/ui';
import { COUNTRY_CHOICES, COUNTRY_NAMES } from '../../modules/identity/core/countries.js';
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
 * @typedef {{ sheet: Blueprint, links: ShareLink[], merchantId: string, websiteId: string,
 *   back: { href: string, label: string } }} SetupPageProps
 */
/**
 * What the consoles can do on the sheet: edit the business profile, and (admins) switch a recommended feature on.
 * @typedef {{ editProfile: () => void, switchOn: ((product: ReachableProduct, feature: string) => void) | null,
 *   switching: string | null }} SheetActions
 */

/** Choice questions in the order people see them. */
const CHOICES = /** @type {Array<keyof typeof PROFILE_CHOICES>} */ (Object.keys(PROFILE_CHOICES));
const LANGUAGE = /^[a-z]{2,3}$/;
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
				done ? 'bg-success-soft text-on-success-soft' : 'bg-warning-soft text-on-warning-soft',
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
		<dl className="divide-y divide-line-soft rounded-xl bg-surface-2/60">
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
					<IconBadge icon="box" kind="product" size="sm" />
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
									<a
										href={item.docs}
										target="_blank"
										rel="noopener noreferrer"
										className="font-semibold text-primary hover:underline">
										{SETUP.guide}
									</a>
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
						<a
							href={product.docs.guide}
							target="_blank"
							rel="noopener noreferrer"
							className="font-semibold text-primary hover:underline">
							{SETUP.guide}
						</a>
						{product.docs.openapi ? (
							<a
								href={product.docs.openapi}
								target="_blank"
								rel="noopener noreferrer"
								className="font-semibold text-primary hover:underline">
								{SETUP.openapi}
							</a>
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
			{profile ? (
				<KeyValueList items={profileLines(profile).map((line) => ({ label: line.question, value: line.answer }))} />
			) : (
				<p className="text-sm text-muted">{PROFILE.empty}</p>
			)}
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
							<ul className="space-y-2">
								{off.map(({ product, entry }) => {
									const title = titleOf(product, entry.feature);
									const needed = neededOff(product, entry.feature);
									const id = `${product.productId}:${entry.feature}`;
									return (
										<li
											key={id}
											className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl bg-surface-2/60 px-4 py-3">
											<span className="min-w-0 space-y-0.5">
												<span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
													{title}
													<Badge>{product.name}</Badge>
												</span>
												<span className="block text-xs text-muted">{entry.why}</span>
												{needed.length > 0 ? (
													<span className="block text-xs text-muted">{SETUP.alsoSwitches(needed.join(', '))}</span>
												) : null}
											</span>
											{actions?.switchOn ? (
												<Button
													size="sm"
													aria-label={SETUP.switchOnLabel(title, product.name)}
													loading={actions.switching === id}
													disabled={actions.switching !== null && actions.switching !== id}
													onClick={() => actions.switchOn?.(product, entry.feature)}>
													{SETUP.switchOn}
												</Button>
											) : null}
										</li>
									);
								})}
							</ul>
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
 * @param {{ manage: Manage, profile: BusinessProfile | null, onClose: () => void, onSaved: (sheet: Blueprint) => void }} props
 */
function ProfileDialog({ manage, profile, onClose, onSaved }) {
	const [answers, setAnswers] = useState(/** @type {BusinessProfile} */ ({ ...(profile ?? {}) }));
	const [languages, setLanguages] = useState((profile?.languages ?? []).join(', '));
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
		const codes = languages
			.split(',')
			.map((code) => code.trim().toLowerCase())
			.filter((code) => code !== '');
		/** @type {Record<string, string>} */
		const found = {};
		const wrong = codes.filter((code) => !LANGUAGE.test(code));
		if (wrong.length > 0) found.languages = PROFILE.languagesInvalid(wrong.join(', '));
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
			body: { ...answers, other, languages: [...new Set(codes)] },
		});
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		onSaved(result.data);
	};
	return (
		<Dialog open onClose={onClose} title={PROFILE.title} description={PROFILE.intro} size="lg">
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
									onChange={(event) => setOwn({ ...own, [question]: event.currentTarget.value })}
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
					<ChoicePicker
						legend={PROFILE.questions.countries}
						options={[...COUNTRY_CHOICES]}
						value={answers.countries ?? []}
						onChange={(next) => setAnswers({ ...answers, countries: next })}
						emptyText={PROFILE.notAnswered}
					/>
					<Input
						label={PROFILE.questions.languages}
						help={PROFILE.languagesHelp}
						value={languages}
						onChange={(event) => setLanguages(event.currentTarget.value)}
						error={errors.languages}
						wide
					/>
				</FieldGrid>
				<FormError problem={problem} />
				<Button loading={busy} onClick={() => void save()}>
					{PROFILE.save}
				</Button>
			</div>
		</Dialog>
	);
}

/**
 * The sections of a setup sheet: the website's facts, its business profile with the recommendations, and every
 * product's panel. The console puts them behind an inner sidebar, the public copy stacks them.
 * @param {Blueprint} sheet
 * @param {SheetActions | null} actions `actions`: in the consoles
 * @returns {Array<{ id: string, label: string, icon: import('@ss/ui').IconName, content: import('react').ReactNode }>}
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
									: SETUP.businessMissing(website.domain)}
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
			content: (
				<Section title={SETUP.products}>
					{sheet.products.length === 0 ? (
						<EmptyState compact icon="box" kind="product" title={SETUP.noProducts} />
					) : (
						<Masonry columns={2}>
							{sheet.products.map((product) =>
								product.reachable ? (
									<ProductPanel key={product.productId} product={product} valuesShown={sheet.share?.values !== false} />
								) : (
									<Callout key={product.productId} tone="warning" title={SETUP.notReachable(product.name)}>
										{SETUP.reasons[product.reason]}
									</Callout>
								),
							)}
						</Masonry>
					)}
				</Section>
			),
		},
	];
};

/**
 * The website's facts, its business profile and the recommendations, and every product's panel, one under the other.
 * @param {{ sheet: Blueprint, actions?: SheetActions | null }} props `actions`: in the consoles
 */
function SheetBody({ sheet, actions = null }) {
	return (
		<div className="space-y-6">
			{sheetSections(sheet, actions).map((section) => (
				<div key={section.id} className="space-y-6">
					{section.content}
				</div>
			))}
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
		<Dialog
			open
			onClose={onClose}
			title={url ? SETUP.linkReady : SETUP.createLink}
			description={url ? SETUP.linkOnce : SETUP.createLinkHelp}>
			{url ? (
				<CodeBlock label={SETUP.shareLink} code={url} />
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
						onChange={(event) => setDays(event.currentTarget.value)}
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
		</Dialog>
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
				<p className="rounded-xl bg-surface-2/60 px-4 py-3 text-sm text-muted">{SETUP.noLinks}</p>
			) : (
				<ul className="space-y-2" aria-label={SETUP.linksTitle}>
					{links.map((link) => (
						<li
							key={link.linkId}
							className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl bg-surface-2/60 px-4 py-3">
							<span className="min-w-0 space-y-1">
								<span className="flex flex-wrap items-center gap-2 text-sm text-fg">
									<StatusBadge status={link.status} label={SETUP.linkStatus[link.status]} />
									<span>
										{SETUP.expires} <LocalTime value={link.expiresAt} />
									</span>
								</span>
								<span className="block text-xs text-muted">
									{SETUP.createdBy[link.createdBy]} · {SETUP.shows(link.values, link.install)} ·{' '}
									{SETUP.opens(link.opens)}
									{link.openedAt ? (
										<>
											{' '}
											· {SETUP.lastOpened} <LocalTime value={link.openedAt} />
										</>
									) : null}
								</span>
							</span>
							{link.status === 'active' ? (
								<Button variant="secondary" size="sm" loading={busy === link.linkId} onClick={() => void revoke(link)}>
									{SETUP.revoke}
								</Button>
							) : null}
						</li>
					))}
				</ul>
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
 * The Setup page of a website in the merchant console (no Switch on: features are switched by Owner or Support).
 * @param {SetupPageProps} props
 */
export function MerchantSetupView({ merchantId, websiteId, ...props }) {
	return <SetupView {...props} manage={{ merchantId, websiteId }} canSwitch={false} />;
}

/**
 * The Setup page of a website in a console (each console passes its API client).
 * @param {{ sheet: Blueprint, links: ShareLink[], manage: Manage, back: { href: string, label: string },
 *   canSwitch: boolean }} props `canSwitch`: the admin console (Owner and Support) switches recommended features on
 */
export function SetupView({ sheet: initial, links, manage, back, canSwitch }) {
	const toast = useToast();
	const [sheet, setSheet] = useState(initial);
	const [refreshing, setRefreshing] = useState(false);
	const [editing, setEditing] = useState(false);
	const [switching, setSwitching] = useState(/** @type {string | null} */ (null));
	useEffect(() => setSheet(initial), [initial]);
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
	};
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
	return (
		<div className="space-y-8">
			<PageHeader
				breadcrumbs={
					<Link
						href={back.href}
						className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
						{back.label}
					</Link>
				}
				title={SETUP.title(sheet.website.domain)}
				subtitle={SETUP.intro}
				actions={
					<>
						<Button variant="secondary" loading={refreshing} onClick={() => void refresh()}>
							{SETUP.refresh}
						</Button>
						<Button variant="secondary" onClick={() => void copy()} icon={<Icon name="copy" size={14} />}>
							{SETUP.copy}
						</Button>
						<ButtonLink
							href={api.setup(manage.merchantId, manage.websiteId, { download: true })}
							download
							variant="primary"
							icon={<Icon name="arrowDown" size={14} />}>
							{SETUP.download}
						</ButtonLink>
					</>
				}
			/>
			<SectionLayout
				label={SETUP.title(sheet.website.domain)}
				sections={[
					...sheetSections(sheet, actions),
					{ id: 'share', label: SETUP.linksTitle, icon: 'link', content: <ShareLinks manage={manage} initial={links} /> },
				]}
			/>
			{editing ? (
				<ProfileDialog
					manage={manage}
					profile={sheet.website.profile}
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
	return (
		<main className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6 sm:py-12">
			<p className="text-sm font-semibold text-muted">{brand}</p>
			{state.phase === 'loading' ? (
				<Skeleton lines={6} label={SETUP.sharedLoading} />
			) : state.phase === 'missing' ? (
				<ErrorState
					title={SETUP.sharedMissing}
					message={state.problem && state.problem.status !== 404 ? describeProblem(state.problem) : SETUP.sharedMissingHelp}
				/>
			) : (
				<>
					<PageHeader
						title={SETUP.sharedTitle(state.sheet.website.domain)}
						subtitle={
							<>
								{SETUP.sharedIntro}{' '}
								{state.sheet.share ? (
									<>
										{SETUP.sharedUntil} <LocalTime value={state.sheet.share.expiresAt} />.
									</>
								) : null}
							</>
						}
						actions={
							<>
								<Button
									variant="secondary"
									onClick={() =>
										void copyText(JSON.stringify(state.sheet, null, 2)).then((ok) =>
											toast.show(ok ? { title: SETUP.copied } : { tone: 'danger', title: SETUP.copyFailed }),
										)
									}
									icon={<Icon name="copy" size={14} />}>
									{SETUP.copy}
								</Button>
								<Button onClick={() => saveJson(state.sheet)} icon={<Icon name="arrowDown" size={14} />}>
									{SETUP.download}
								</Button>
							</>
						}
					/>
					<SheetBody sheet={state.sheet} />
				</>
			)}
		</main>
	);
}
