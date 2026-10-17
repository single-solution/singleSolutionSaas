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
import { Card, EmptyState, PageHeader, STAT_GRID, SkeletonBlock, Stat, StatGrid, StatusBadge } from './display.js';
import { formatCredits, supportContact } from './format.js';
import { Icon } from './icons.js';
import { OVERVIEW_TEXTS } from './overview-texts.js';
import { LocalTime, useDisplayLocale } from './time.js';

/** @typedef {import('react').ReactNode} ReactNode */

/**
 * One item of "Needs you": what is wrong, what happens if it waits, and its button; amber, or red when something has
 * already stopped.
 * @typedef {{ key: string, tone: 'warning' | 'danger', title: ReactNode, effect: ReactNode, action?: ReactNode }} Need
 */

/**
 * One step of a setup checklist: done (ticked, struck through) or to do, with where to do it — a link (`href`, drawn
 * with the checklist's `linkAs`) or a button (`onSelect`) — and an optional detail line.
 * @typedef {{ key: string, label: ReactNode, done: boolean, detail?: ReactNode, href?: string, onSelect?: () => void }} SetupStep
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
					tone === 'danger' ? 'bg-danger ring-danger-soft' : 'bg-warning ring-warning-soft',
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
			<span className="flex size-5 items-center justify-center rounded-full bg-success-soft text-on-success-soft">
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
 * A setup checklist card: how many steps are done (a progress bar), then each step — ticked and struck through when
 * done, else a link or button to where it is done (or plain text when it has neither).
 * @param {{ title: ReactNode, progress: ReactNode, steps: SetupStep[], labels: { done: string, todo: string },
 *   linkAs?: import('react').ElementType, id?: string, className?: string }} props
 *   `progress`: the card's subtitle (e.g. `3 of 5 done`); `labels`: the screen-reader words of a step's state
 */
export function SetupChecklist({ title, progress, steps, labels, linkAs, id, className }) {
	const done = steps.filter((step) => step.done).length;
	const LinkTag = linkAs ?? 'a';
	const accessibleTitle = typeof title === 'string' ? title : undefined;
	return (
		<Card {...(id ? { id } : {})} {...(className ? { className } : {})} title={title} subtitle={progress}>
			<div
				className="mb-4 h-2 overflow-hidden rounded-full bg-surface-3"
				role="progressbar"
				aria-label={accessibleTitle}
				aria-valuemin={0}
				aria-valuemax={steps.length}
				aria-valuenow={done}>
				<div
					className="h-full rounded-full bg-primary transition-[width] duration-(--ss-motion-slow) ease-ss"
					style={{ width: `${steps.length === 0 ? 100 : Math.round((done / steps.length) * 100)}%` }}
				/>
			</div>
			<ul className="space-y-2.5">
				{steps.map((step) => (
					<li key={step.key} className="flex items-start gap-3 text-sm">
						<span
							className={cx(
								'mt-px flex size-5 shrink-0 items-center justify-center rounded-full',
								step.done ? 'bg-success-soft text-on-success-soft' : 'border-[1.5px] border-dashed border-line-strong',
							)}>
							{step.done ? <Icon name="check" size={12} /> : null}
							<span className="sr-only">{step.done ? labels.done : labels.todo}</span>
						</span>
						<span className="min-w-0">
							{step.done ? (
								<span className="text-muted line-through decoration-line-strong">{step.label}</span>
							) : step.href ? (
								<LinkTag href={step.href} className="font-medium text-fg hover:text-primary hover:underline">
									{step.label}
								</LinkTag>
							) : step.onSelect ? (
								<button
									type="button"
									onClick={step.onSelect}
									className="text-left font-medium text-fg hover:text-primary hover:underline">
									{step.label}
								</button>
							) : (
								<span className="font-medium text-fg">{step.label}</span>
							)}
							{step.detail ? <span className="block text-xs text-muted">{step.detail}</span> : null}
						</span>
					</li>
				))}
			</ul>
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

/** The dashboard sections an Overview's buttons open. @typedef {'features' | 'settings' | 'connections' | 'developers'} OverviewTab */

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
 *   open: (tab: OverviewTab) => void, recheck: () => Promise<unknown>, needs?: Need[], steps?: SetupStep[],
 *   numbers?: ReactNode, children?: ReactNode }} props
 *   `product`: the product's name; `support`: the support contact (merchants are told to contact it for credits; the
 *   button opens its first channel);
 *   `portal`: the Portal's address; `namesOf`: feature names of keys, at most `max`; `open`: shows a dashboard section;
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
		{ key: 'features', label: T.setup.features, done: on.length > 0, onSelect: () => open('features') },
		...data.checklist.connections.map((connection) => ({
			key: `connection-${connection.name}`,
			label: fillText(T.setup.connection, { label: connection.label }),
			done: connection.status === 'connected',
			onSelect: () => open('connections'),
		})),
		...steps,
		...(widget
			? [
					{
						key: 'widget',
						label: T.setup.widget,
						done: widget.installed,
						...(widget.lastSeenAt
							? { detail: fillText(T.setup.widgetSeen, { time: <LocalTime value={widget.lastSeenAt} /> }) }
							: {}),
						onSelect: () => open('developers'),
					},
				]
			: []),
		{ key: 'business', label: T.setup.business, done: business.found },
	];
	const done = checklist.filter((step) => step.done).length;

	return (
		<div className="space-y-5">
			<PageHeader
				title={fillText(T.welcome, { name: who.name })}
				subtitle={sentence}
				actions={<StatusBadge status={status} label={T.status[/** @type {'active'} */ (status)] ?? status} />}
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
							title={T.setup.title}
							progress={fillText(T.setup.progress, { done, total: checklist.length })}
							steps={checklist}
							labels={{ done: T.setup.done, todo: T.setup.todo }}
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
