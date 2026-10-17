'use client';
/**
 * Website settings: the facts every product of a website shares, kept once in the Portal (settings-ownership design,
 * section 8.1). One page per website, in both consoles, on the premium frame: the sections in the inner sidebar (Business,
 * Brand and look, Region and format, Domains, pages and legal, Team and alerts, Recent changes) with the context of
 * each (a product still needs something from it, how many changes), one section at a time, forms on the shared
 * components, nested things in right drawers and the floating Save bar. A save names the version the person read; if
 * someone saved meanwhile the page offers a reload. The Portal checks every right and value again.
 * @module
 */
import { useEffect, useState } from 'react';
import {
	Callout,
	EmptyState,
	HeaderFact,
	ListRow,
	LocalTime,
	PageHeader,
	RowList,
	SectionLayout,
	TextLink,
	describeProblem,
	useToast,
} from '@ss/ui';
import { WEBSITE_SETTINGS as T } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { api } from '../paths.js';
import { BrandSection, BusinessSection, PagesSection, RegionSection, TeamSection } from './website-settings-sections.js';

/** @typedef {import('@ss/contracts').WebsiteSettings} WebsiteSettings */
/** @typedef {{ productId: string, name: string, requires: string[], missing: string[] }} Readiness */
/** @typedef {{ at: string, section: string, version: number, changed: string[], who: { type: string, name: string | null } }} Change */
/**
 * @typedef {object} WebsiteSettingsPageProps
 * @property {{ settings: WebsiteSettings, readiness: Readiness[], can: { write: boolean } }} data
 * @property {Change[]} changes newest first
 * @property {string} merchantId
 * @property {string} websiteId
 * @property {string} domain
 * @property {{ href: string, label: string }} back
 */

/** The section a missing value belongs to: `region.currency` is in `region`. @param {string} path */
const sectionOfPath = (path) => path.split('.')[0] ?? '';

/**
 * The words for what a product still needs: `currency, country`.
 * @param {string[]} paths
 */
const needs = (paths) => paths.map((path) => /** @type {Record<string, string>} */ (T.paths)[path] ?? path).join(', ');

/**
 * What the products ask the settings to say that is still empty, as a line each; empty when nothing is missing.
 * @param {Readiness[]} readiness
 */
export const readinessLines = (readiness) =>
	readiness.filter((item) => item.missing.length > 0).map((item) => T.readyMissing(item.name, needs(item.missing)));

/** The Recent changes section: who changed what, when. @param {{ changes: Change[] }} props */
function ChangesSection({ changes }) {
	return (
		<div className="col-span-full min-w-0 space-y-4">
			<p className="text-sm text-muted">{T.changes.intro}</p>
			{changes.length === 0 ? (
				<EmptyState compact icon="clock" title={T.changes.empty} />
			) : (
				<RowList label={T.changes.title}>
					{changes.map((change) => (
						<ListRow
							key={`${change.version}-${change.at}`}
							icon="clock"
							title={T.changes.row(
								/** @type {Record<string, string>} */ (T.sections)[change.section] ?? change.section,
								change.version,
							)}
							meta={
								<>
									{T.changes.fields(change.changed)} · {T.changes.by(change.who.name)} · <LocalTime value={change.at} />
								</>
							}
						/>
					))}
				</RowList>
			)}
		</div>
	);
}

/**
 * The page.
 * @param {WebsiteSettingsPageProps} props
 */
export function WebsiteSettingsView({ data, changes: initialChanges, merchantId, websiteId, domain, back }) {
	const toast = useToast();
	const manage = { merchantId, websiteId };
	const [settings, setSettings] = useState(data.settings);
	const [readiness, setReadiness] = useState(data.readiness);
	const [changes, setChanges] = useState(initialChanges);
	const [stale, setStale] = useState(false);
	useEffect(() => {
		setSettings(data.settings);
		setReadiness(data.readiness);
	}, [data]);
	useEffect(() => setChanges(initialChanges), [initialChanges]);

	const loadChanges = async () => {
		const result = await apiFetch(api.websiteSettingsChanges(merchantId, websiteId));
		if (result.ok) setChanges(result.data.items);
	};
	/** @param {{ settings: WebsiteSettings, readiness: Readiness[] }} answer */
	const saved = (answer) => {
		setSettings(answer.settings);
		setReadiness(answer.readiness);
		setStale(false);
		void loadChanges();
	};
	const reload = async () => {
		const result = await apiFetch(api.websiteSettings(merchantId, websiteId));
		if (!result.ok) {
			toast.show({ tone: 'danger', title: describeProblem(result.problem) });
			return;
		}
		saved(result.data);
		toast.show({ title: T.reloaded });
	};

	const canWrite = data.can.write;
	const common = {
		settings,
		manage,
		canWrite,
		stale,
		onSaved: saved,
		onStale: () => setStale(true),
		onReload: () => void reload(),
	};
	/** What the products still need from a section: a dot on its link and who needs it. @param {string} section */
	const contextOf = (section) => {
		const waiting = readiness.filter((item) => item.missing.some((path) => sectionOfPath(path) === section));
		return waiting.length === 0
			? {}
			: { status: /** @type {const} */ ('attention'), statusLabel: T.needsSetup(waiting.map((item) => item.name).join(', ')) };
	};
	const lines = readinessLines(readiness);
	return (
		<div className="space-y-6">
			<PageHeader
				breadcrumbs={
					<TextLink as={Link} href={back.href} className="inline-flex items-center gap-1 text-sm">
						{back.label}
					</TextLink>
				}
				title={T.title(domain)}
				subtitle={T.intro}
				meta={
					<>
						<HeaderFact>{T.version(settings.version)}</HeaderFact>
						<HeaderFact label={T.savedAt}>
							{settings.updatedAt ? <LocalTime value={settings.updatedAt} /> : T.neverSaved}
						</HeaderFact>
					</>
				}
			/>
			{lines.length > 0 ? (
				<Callout tone="attention" title={T.readyTitle}>
					<ul className="list-disc space-y-0.5 pl-5">
						{lines.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</Callout>
			) : null}
			<SectionLayout
				label={T.sectionsLabel}
				sections={[
					{
						id: 'business',
						label: T.sections.business,
						icon: 'home',
						group: T.groups.facts,
						...contextOf('business'),
						content: <BusinessSection {...common} />,
					},
					{
						id: 'brand',
						label: T.sections.brand,
						icon: 'palette',
						group: T.groups.facts,
						...contextOf('brand'),
						content: <BrandSection {...common} />,
					},
					{
						id: 'region',
						label: T.sections.region,
						icon: 'globe',
						group: T.groups.facts,
						...contextOf('region'),
						content: <RegionSection {...common} />,
					},
					{
						id: 'pages',
						label: T.sections.pages,
						icon: 'link',
						group: T.groups.facts,
						...contextOf('pages'),
						content: <PagesSection {...common} />,
					},
					{
						id: 'team',
						label: T.sections.team,
						icon: 'users',
						group: T.groups.facts,
						...contextOf('team'),
						content: <TeamSection {...common} />,
					},
					{
						id: 'changes',
						label: T.sections.changes,
						icon: 'clock',
						group: T.groups.activity,
						...(changes.length > 0 ? { badge: String(changes.length) } : {}),
						content: <ChangesSection changes={changes} />,
					},
				]}
			/>
		</div>
	);
}
