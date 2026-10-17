'use client';
/**
 * The Overview pattern (PLAN 0.6 "Overviews talk"), one implementation for the Portal and every product dashboard: a
 * greeting with one sentence of what matters now; a **Needs you** list, each item saying what happens if it waits and
 * carrying its button; a setup checklist; the key numbers; and the latest activity as a timeline in the viewer's local
 * time.
 *
 * - The pieces take their words from the caller: `NeedsList` (each item a `NeedItem`, or the calm `NothingNeeded` line
 *   when the list is empty), `SetupChecklist`, `Timeline` and `initialsOf` (the Portal's Overviews use them).
 * - `ProductOverview` is a product dashboard's whole Overview, built from the kit's overview answer
 *   (`GET /v1/dashboard/websites/:websiteId/overview`) with the words of `overview-texts.js`, plus the product's own
 *   items, setup steps, number tiles and sections. `OverviewSkeleton` is its loading state and `RecentChanges` the
 *   timeline card the dashboards also show under Defaults and Prices.
 * @module
 */
import { Fragment, useState } from 'react';
import { Button, ButtonLink } from './Button.js';
import { cx } from './cx.js';
import {
	Badge,
	Card,
	EmptyState,
	STAT_GRID,
	SkeletonBlock,
	Stat,
	StatGrid,
	StatusBadge,
	TextLink,
} from './display.js';
import { formatCredits, supportContact } from './format.js';
import { HeaderFact, PageHeader } from './header.js';
import { Icon } from './icons.js';
import { OVERVIEW_TEXTS } from './overview-texts.js';
import { ListRow, RowList } from './rows.js';
import { LocalTime, useDisplayLocale } from './time.js';

/** @typedef {import('react').ReactNode} ReactNode */

/**
 * One item of "Needs you": what is wrong, what happens if it waits, and its button; amber, or red when something has
 * already stopped.
 * @typedef {{ key: string, tone: 'warning' | 'danger', title: ReactNode, effect: ReactNode, action?: ReactNode }} Need
 */

/**
 * One step of a setup checklist: done (ticked, struck through) or to do, with where to do it — a link (`href`, drawn
 * with the checklist's `linkAs`) or a button (`onSelect`) — and optional lines under it: `why` (one plain line on why it
 * matters, shown while it is to do) and `detail` (the value now). With `actionLabel` the where is a button at the end of
 * the row with those words; without it the label itself is the link or button. `optional` steps are listed but not
 * counted in the progress.
 * @typedef {{ key: string, label: ReactNode, done: boolean, why?: ReactNode, detail?: ReactNode, optional?: boolean,
 *   actionLabel?: string, href?: string, onSelect?: () => void }} SetupStep
 */

/**
 * One entry of a timeline: who did what, and when (shown in the viewer's local time).
 * @typedef {{ key: string, who: string, what: ReactNode, at: string | number | Date }} TimelineItem
 */

/**
 * Fill the `{name}` placeholders of a text. Values may be elements (a `<LocalTime>`): the result is then a list of
 * children; with only text values it stays a string.
 * @param {string} text
 * @param {Record<string, ReactNode>} values
 * @returns {ReactNode}
 */
const fillText = (text, values) => {
	const parts = text.split(/\{(\w+)\}/g);
	const filled = parts.map((part, i) => (i % 2 === 0 ? part : Object.hasOwn(values, part) ? values[part] : `{${part}}`));
	if (filled.every((part) => typeof part === 'string' || typeof part === 'number')) return filled.join('');
	return filled.map((part, i) => <Fragment key={i}>{part}</Fragment>);
};

/**
 * Up to two initials of a name (`Alex Morgan` → `AM`, `support@shop.example` → `SU`), for an avatar.
 * @param {string | null | undefined} name
 */
export const initialsOf = (name) => {
	const words = String(name ?? '')
		.trim()
		.split(/[\s._@-]+/)
		.filter(Boolean);
	const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0] ?? '').slice(0, 2);
	return letters.toUpperCase() || '·';
};

/**
 * One "Needs you" item.
 * @param {Omit<Need, 'key'>} props
 */
function NeedItem({ tone, title, effect, action }) {
	return (
		<li className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3.5 first:pt-0 last:pb-0 @lg:flex-nowrap @lg:items-center">
			<span
				aria-hidden="true"
				className={cx(
					'mt-1.5 size-2 shrink-0 rounded-full ring-4 @lg:mt-0',
					tone === 'danger' ? 'bg-danger-solid ring-danger-soft' : 'bg-attention-solid ring-attention-soft',
				)}
			/>
			{/* on a narrow card the button goes under the words (lined up with them) instead of squeezing them */}
			<div className="min-w-0 flex-[1_1_14rem]">
				<p className="text-sm font-medium break-words text-fg">{title}</p>
				<p className="mt-0.5 text-help text-muted">{effect}</p>
			</div>
			{action ? <div className="shrink-0 pl-5 @lg:pl-0">{action}</div> : null}
		</li>
	);
}

/**
 * The calm line of "Needs you" when nothing does.
 * @param {{ children: ReactNode }} props
 */
function NothingNeeded({ children }) {
	return (
		<p className="flex items-center gap-2 text-sm text-muted">
			<span className="flex size-5 items-center justify-center rounded-full bg-success-solid text-on-solid">
				<Icon name="check" size={12} />
			</span>
			{children}
		</p>
	);
}

/**
 * The "Needs you" items, or the calm `none` line when there are none.
 * @param {{ items: Need[], none: ReactNode }} props
 */
export function NeedsList({ items, none }) {
	if (items.length === 0) return <NothingNeeded>{none}</NothingNeeded>;
	return (
		<ul className="@container divide-y divide-line-soft">
			{items.map(({ key, ...need }) => (
				<NeedItem key={key} {...need} />
			))}
		</ul>
	);
}

/**
 * One row of a setup checklist: the tick, the step (with its why, or the value now once done), and its button.
 * @param {{ step: SetupStep, labels: SetupLabels, LinkTag: import('react').ElementType }} props
 */
function SetupRow({ step, labels, LinkTag }) {
	const action = step.actionLabel && (step.href || step.onSelect);
	const title = step.done ? (
		<span className="text-muted line-through decoration-line-strong">{step.label}</span>
	) : action ? (
		step.label
	) : step.href ? (
		<TextLink as={LinkTag} tone="plain" href={step.href} className="font-medium">
			{step.label}
		</TextLink>
	) : step.onSelect ? (
		<button type="button" onClick={step.onSelect} className="text-left font-medium text-fg hover:text-primary hover:underline">
			{step.label}
		</button>
	) : (
		step.label
	);
	const words = step.done ? null : step.why;
	const button = action
		? step.done
			? labels.review
				? { variant: /** @type {const} */ ('ghost'), text: labels.review }
				: null
			: { variant: /** @type {const} */ ('secondary'), text: step.actionLabel }
		: null;
	return (
		<ListRow
			wrap
			media={
				<span
					className={cx(
						'flex size-5 shrink-0 items-center justify-center rounded-full',
						step.done ? 'bg-success-solid text-on-solid' : 'border-[1.5px] border-dashed border-attention-solid',
					)}>
					{step.done ? <Icon name="check" size={12} /> : null}
					<span className="sr-only">{step.done ? labels.done : labels.todo}</span>
				</span>
			}
			title={title}
			{...(step.optional && labels.optional ? { status: <Badge tone="neutral">{labels.optional}</Badge> } : {})}
			{...(words || step.detail
				? {
						meta: (
							<>
								{words}
								{step.detail ? <span className={words ? 'mt-0.5 block' : 'block'}>{step.detail}</span> : null}
							</>
						),
					}
				: {})}
			{...(button
				? {
						action: step.href ? (
							<ButtonLink as={LinkTag} href={step.href} size="sm" variant={button.variant}>
								{button.text}
							</ButtonLink>
						) : (
							<Button size="sm" variant={button.variant} onClick={step.onSelect}>
								{button.text}
							</Button>
						),
					}
				: {})}
		/>
	);
}

/** @typedef {{ done: string, todo: string, review?: string, optional?: string }} SetupLabels */

/**
 * A setup checklist card: how many steps are done (a progress bar), then each step as a row — ticked and struck through
 * when done, else its why and a button to where it is done (or the label as a link or button, or plain text when it has
 * neither). Optional steps do not count in the progress.
 * @param {{ title: ReactNode, progress: ReactNode, steps: SetupStep[], labels: SetupLabels,
 *   linkAs?: import('react').ElementType, id?: string, className?: string }} props
 *   `progress`: the card's subtitle (e.g. `3 of 5 done`); `labels`: the screen-reader words of a step's state, the
 *   words of the button of a done step (`review`; none: it has no button) and of an optional step
 */
export function SetupChecklist({ title, progress, steps, labels, linkAs, id, className }) {
	const counted = steps.filter((step) => !step.optional);
	const done = counted.filter((step) => step.done).length;
	const LinkTag = linkAs ?? 'a';
	const accessibleTitle = typeof title === 'string' ? title : undefined;
	return (
		<Card {...(id ? { id } : {})} {...(className ? { className } : {})} title={title} subtitle={progress}>
			<div
				className="mb-4 h-2 overflow-hidden rounded-full bg-surface-2"
				role="progressbar"
				aria-label={accessibleTitle}
				aria-valuemin={0}
				aria-valuemax={counted.length}
				aria-valuenow={done}>
				<div
					className="h-full rounded-full bg-success-solid transition-[width] duration-(--ss-motion-slow) ease-ss"
					style={{ width: `${counted.length === 0 ? 100 : Math.round((done / counted.length) * 100)}%` }}
				/>
			</div>
			<RowList>
				{steps.map((step) => (
					<SetupRow key={step.key} step={step} labels={labels} LinkTag={LinkTag} />
				))}
			</RowList>
		</Card>
	);
}

/**
 * The latest activity as a timeline: an avatar with the person's initials, who and what, and when in the viewer's
 * local time (UTC on the server and in the first render, `LocalTime`); `empty` shows when there is nothing yet.
 * @param {{ items: TimelineItem[], empty: ReactNode }} props
 */
export function Timeline({ items, empty }) {
	if (items.length === 0) return <EmptyState compact icon="activity" kind="activity" title={empty} />;
	return (
		<ol className="space-y-4">
			{items.map((item) => (
				<li key={item.key} className="flex gap-3">
					<span
						aria-hidden="true"
						className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-micro font-bold text-on-primary-soft">
						{initialsOf(item.who)}
					</span>
					<div className="min-w-0 text-sm">
						<p className="break-words text-fg">
							<span className="font-semibold">{item.who}</span> · {item.what}
						</p>
						<p className="text-xs text-muted">
							<LocalTime value={item.at} />
						</p>
					</div>
				</li>
			))}
		</ol>
	);
}

/**
 * A dashboard's Recent changes (newest first) as a timeline card. With `limit` it shows that many and a button for the
 * rest, so a long history does not make the page long.
 * @param {{ items: ReadonlyArray<{ who: { name: string }, detail: string, at: string }>, intro?: ReactNode,
 *   limit?: number }} props
 */
export function RecentChanges({ items, intro, limit }) {
	const [all, setAll] = useState(false);
	const cut = limit !== undefined && items.length > limit && !all;
	const shown = cut ? items.slice(0, limit) : items;
	return (
		<Card title={OVERVIEW_TEXTS.changes} {...(intro ? { subtitle: intro } : {})}>
			<Timeline
				items={shown.map((item, i) => ({ key: `${item.at}-${i}`, who: item.who.name, what: item.detail, at: item.at }))}
				empty={OVERVIEW_TEXTS.noChanges}
			/>
			{limit !== undefined && items.length > limit ? (
				<Button className="mt-3" size="sm" variant="ghost" onClick={() => setAll(!all)}>
					{all ? OVERVIEW_TEXTS.showFewer : OVERVIEW_TEXTS.showAll.replace('{count}', String(items.length))}
				</Button>
			) : null}
		</Card>
	);
}

/**
 * The kit's overview answer (`GET /v1/dashboard/websites/:websiteId/overview`).
 * @typedef {object} DashboardOverview
 * @property {{ domain: string }} website
 * @property {{ status: string, graceEndsAt: string | null }} status the product's status on this website
 * @property {string[]} featuresOn
 * @property {number} todayMillicredits credits charged so far today (UTC)
 * @property {{ connections: Array<{ name: string, label: string, neededBy: string[], status: string,
 *   message?: string }>, widget: { installed: boolean, lastSeenAt: string | null } | null,
 *   business: { found: boolean } }} checklist only what the switched-on features need
 * @property {ReadonlyArray<{ who: { name: string }, detail: string, at: string }>} recentChanges
 */

/**
 * The dashboard sections an Overview's buttons open (and, for a deeper link, the section of its inner sidebar).
 * @typedef {'features' | 'settings' | 'connections' | 'developers'} OverviewTab
 */

/** @param {Need[]} needs red items first, each tone in its own order */
const urgentFirst = (needs) => [
	...needs.filter((need) => need.tone === 'danger'),
	...needs.filter((need) => need.tone !== 'danger'),
];

/**
 * A product dashboard's Overview (PLAN 0.6, 0.4.3): the greeting by name with one sentence of what matters now and the
 * product's status; "Needs you" — the status (in grace, stopped, suspended), no feature on, each connection a
 * switched-on feature needs that is missing or failed its test, the product's own `needs`, the widget not seen on the
 * website, business.json not found — red ones first, each with its button (the right section of the dashboard, the
 * Portal or support, Check again); the setup checklist beside it (a feature on, the connections, the product's own
 * `steps`, the widget with its last visit, business.json); the numbers (today's cost, features on, then the product's
 * `numbers` tiles); the product's own sections (`children`); and Recent changes as a timeline. Times are the viewer's
 * local time.
 * @param {{ data: DashboardOverview, who: { kind: 'merchant' | 'admin', name: string }, product: string,
 *   support: { channels: import('./format.js').SupportChannel[] }, portal: string, namesOf: (keys: string[], max?: number) => string,
 *   open: (tab: OverviewTab, section?: string) => void, recheck: () => Promise<unknown>, needs?: Need[], steps?: SetupStep[],
 *   numbers?: ReactNode, children?: ReactNode }} props
 *   `product`: the product's name; `support`: the support contact (merchants are told to contact it for credits; the
 *   button opens its first channel);
 *   `portal`: the Portal's address; `namesOf`: feature names of keys, at most `max`; `open`: shows a dashboard section, at a section of its inner sidebar when given;
 *   `recheck`: reads business.json again and reloads the Overview
 */
export function ProductOverview({
	data,
	who,
	product,
	support,
	portal,
	namesOf,
	open,
	recheck,
	needs = [],
	steps = [],
	numbers,
	children,
}) {
	const T = OVERVIEW_TEXTS;
	const N = T.needs;
	const S = T.setup;
	const domain = data.website.domain;
	const on = data.featuresOn;
	const status = data.status.status;
	const merchant = who.kind === 'merchant';
	const locale = useDisplayLocale();
	const { widget, business } = data.checklist;
	/** @param {string} label @param {OverviewTab} tab */
	const go = (label, tab) => (
		<Button size="sm" variant="secondary" onClick={() => open(tab)}>
			{label}
		</Button>
	);
	const toPortal = (
		<ButtonLink size="sm" href={portal}>
			{N.portal}
		</ButtonLink>
	);
	const channel = support.channels[0];
	const credits = !merchant ? (
		toPortal
	) : channel ? (
		<ButtonLink size="sm" href={channel.url}>
			{N.contact}
		</ButtonLink>
	) : null;
	const contact = supportContact(support);
	/** @param {string[]} keys */
	const featureList = (keys) => namesOf(keys.filter((key) => on.includes(key)));

	/** @type {Need[]} */
	const first = [];
	if (status === 'stopped')
		first.push({
			key: 'status',
			tone: 'danger',
			title: fillText(N.stopped.title, { product }),
			effect: fillText(merchant ? N.stopped.merchant : N.stopped.admin, { contact }),
			action: credits,
		});
	else if (status === 'suspended')
		first.push({ key: 'status', tone: 'danger', title: N.suspended.title, effect: N.suspended.effect, action: toPortal });
	else if (status === 'grace')
		first.push({
			key: 'status',
			tone: 'warning',
			title: fillText(N.grace.title, { product, time: <LocalTime value={data.status.graceEndsAt} /> }),
			effect: fillText(merchant ? N.grace.merchant : N.grace.admin, { contact }),
			action: credits,
		});
	if (on.length === 0)
		first.push({
			key: 'features',
			tone: 'warning',
			title: N.noFeatures.title,
			effect: fillText(N.noFeatures.effect, { domain }),
			action: go(N.noFeatures.action, 'features'),
		});
	for (const connection of data.checklist.connections) {
		if (connection.status === 'connected') continue;
		const failed = connection.status === 'test_failed';
		const words = failed ? N.testFailed : N.notConnected;
		const effect = fillText(words.effect, { features: featureList(connection.neededBy) });
		first.push({
			key: `connection-${connection.name}`,
			tone: failed ? 'danger' : 'warning',
			title: fillText(words.title, { label: connection.label }),
			effect: failed && connection.message ? `${connection.message} ${effect}` : effect,
			action: go(words.action, 'connections'),
		});
	}
	/** @type {Need[]} */
	const last = [];
	if (widget && !widget.installed)
		last.push({
			key: 'widget',
			tone: 'warning',
			title: fillText(N.widget.title, { domain }),
			effect: N.widget.effect,
			action: go(N.widget.action, 'developers'),
		});
	if (!business.found)
		last.push({
			key: 'business',
			tone: 'warning',
			title: fillText(N.business.title, { domain }),
			effect: fillText(N.business.effect, { domain }),
			action: (
				<Button size="sm" variant="secondary" onClick={recheck}>
					{N.business.action}
				</Button>
			),
		});
	const items = urgentFirst([...first, ...needs, ...last]);
	const top = items[0];
	const sentence = !top
		? fillText(T.allSet, { domain })
		: fillText(items.length === 1 ? T.only : items.length === 2 ? T.oneMore : T.more, {
				first: top.title,
				count: items.length - 1,
			});

	/** @type {SetupStep[]} */
	const checklist = [
		{
			key: 'features',
			label: S.features,
			why: fillText(S.featuresWhy, { domain }),
			actionLabel: S.featuresAction,
			done: on.length > 0,
			onSelect: () => open('features'),
		},
		...data.checklist.connections.map((connection) => ({
			key: `connection-${connection.name}`,
			label: fillText(S.connection, { label: connection.label }),
			why:
				connection.status === 'test_failed' && connection.message
					? connection.message
					: fillText(S.connectionWhy, { features: featureList(connection.neededBy) }),
			actionLabel: connection.status === 'test_failed' ? S.connectionFix : S.connectionAction,
			done: connection.status === 'connected',
			onSelect: () => open('connections', `connection-${connection.name}`),
		})),
		...steps,
		...(widget
			? [
					{
						key: 'widget',
						label: S.widget,
						why: S.widgetWhy,
						actionLabel: S.widgetAction,
						done: widget.installed,
						...(widget.lastSeenAt
							? { detail: fillText(S.widgetSeen, { time: <LocalTime value={widget.lastSeenAt} /> }) }
							: {}),
						onSelect: () => open('developers'),
					},
				]
			: []),
		{
			key: 'business',
			label: S.business,
			why: S.businessWhy,
			done: business.found,
			// once found there is nothing to review: the button only checks again while it is missing
			...(business.found ? {} : { actionLabel: S.businessAction, onSelect: recheck }),
		},
	];
	const counted = checklist.filter((step) => !step.optional);
	const done = counted.filter((step) => step.done).length;

	return (
		<div className="space-y-5">
			<PageHeader
				title={fillText(T.welcome, { name: who.name })}
				subtitle={sentence}
				badge={<StatusBadge status={status} label={T.status[/** @type {'active'} */ (status)] ?? status} />}
				meta={
					<HeaderFact tone={done === counted.length ? 'success' : 'attention'}>
						{fillText(S.progress, { done, total: counted.length })}
					</HeaderFact>
				}
			/>
			<div className="@container">
				<div className="grid items-start gap-5 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
					<div className="min-w-0 space-y-5">
						<Card title={N.title} {...(items.length > 0 ? { subtitle: N.intro } : {})}>
							<NeedsList items={items} none={N.none} />
						</Card>
						<StatGrid label={T.numbers}>
							<Stat
								label={T.today}
								value={formatCredits(data.todayMillicredits, { locale })}
								hint={T.todayHint}
								icon="coins"
								kind="credit"
							/>
							<Stat
								label={T.features}
								value={on.length}
								hint={on.length > 0 ? namesOf(on, 3) : T.noFeatures}
								icon="zap"
								kind="feature"
							/>
							{numbers}
						</StatGrid>
					</div>
					<div className="min-w-0 space-y-5">
						<SetupChecklist
							title={S.title}
							progress={fillText(S.progress, { done, total: counted.length })}
							steps={checklist}
							labels={{ done: S.done, todo: S.todo, review: S.review, optional: S.optional }}
						/>
						<RecentChanges items={data.recentChanges} limit={4} />
					</div>
				</div>
			</div>
			{children}
		</div>
	);
}

/**
 * The loading state of a product dashboard's Overview, shaped like it: the greeting, "Needs you" beside the setup
 * checklist, the number tiles and Recent changes.
 */
export function OverviewSkeleton() {
	return (
		<div role="status" aria-label={OVERVIEW_TEXTS.loading} aria-busy="true" className="animate-ss-fade space-y-5">
			<div className="space-y-2">
				<SkeletonBlock className="h-8 w-72 max-w-full" />
				<SkeletonBlock className="h-4 w-96 max-w-full" />
			</div>
			<div className="@container">
				<div className="grid items-start gap-5 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
					<div className="space-y-5">
						<SkeletonBlock className="h-44 rounded-card" />
						<div className={STAT_GRID}>
							<SkeletonBlock className="h-28 rounded-card" />
							<SkeletonBlock className="h-28 rounded-card" />
							<SkeletonBlock className="h-28 rounded-card" />
						</div>
					</div>
					<div className="space-y-5">
						<SkeletonBlock className="h-44 rounded-card" />
						<SkeletonBlock className="h-40 rounded-card" />
					</div>
				</div>
			</div>
		</div>
	);
}
