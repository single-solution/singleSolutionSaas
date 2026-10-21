'use client';
/**
 * Growth's own parts of the shared dashboard tabs (PLAN 0.4.3): the Overview's tags ready, the tag features with no id
 * or script yet and the setup at a glance; the notes above each settings card (`settingsNotice`, on Settings and
 * Defaults); and the page script, shop events, API and snippets in Developers. The other tabs are the shared ones as
 * they are.
 * @module
 */
import { Button, CodeBlock, Section, Stat, useViewerTimeZone } from '@ss/ui';
import { DefaultsTab, DevelopersTab, OverviewTab, SettingsTab, fill, useLoad, useSetupSteps } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { searchParamsOf, tagsReady } from '../../core/config.js';
import { createSnippets } from '../../core/snippets.js';
import { BROWSER_EVENTS, SITE_EVENTS } from '../../core/widgets.js';
import { listExtras } from './lists.js';
import { SETUP } from './setup-steps.js';
import { settingsNotice } from './setup.js';
import { TEXTS } from './texts.js';

/** @typedef {import('@ss/ui/dashboard').TabProps} TabProps */
/** @typedef {import('@ss/ui/dashboard').FeatureSettings} FeatureSettings */

/**
 * The settings of each feature and shared group, from the settings screen's answer.
 * @param {{ features: Array<{ key: string, values: Record<string, { value: unknown }> }> }} data
 */
const valuesOf = (data) =>
	Object.fromEntries(
		data.features.map((feature) => [
			feature.key,
			Object.fromEntries(Object.entries(feature.values).map(([name, entry]) => [name, entry.value])),
		]),
	);

/**
 * Growth's part of the Overview (PLAN 0.6 "Overviews talk"), from the website's settings: the tags ready (while a tag
 * feature is on), the tag features with no id or script yet, and the setup steps (`setup-steps.js`; the custom scripts
 * have a step of their own, as they live in the consent categories).
 * @type {import('@ss/ui/dashboard').UseOverviewMore}
 */
const useGrowthOverview = (overview, { websiteId, open }) => {
	const settings = useLoad(`/v1/dashboard/websites/${websiteId}/settings`);
	// custom scripts live in the consent categories (G3): read them only while Custom scripts is on
	const scripts = overview?.ok === true && overview.data.featuresOn.includes('custom_scripts');
	const categories = useLoad(scripts ? `/v1/dashboard/websites/${websiteId}/lists/consent_categories` : null);
	const setup = useSetupSteps({ overview, websiteId, open, settings: settings.answer }, SETUP);
	if (!overview?.ok || !settings.answer?.ok) return {};
	const data = overview.data;
	const values = valuesOf(settings.answer.data);
	const tags = tagsReady(data.featuresOn, values, categories.answer?.ok ? categories.answer.data.value : []);
	const missing = tags.total - tags.ready;
	const O = TEXTS.overview;
	return {
		needs:
			missing > 0
				? [
						{
							key: 'tags',
							tone: 'warning',
							title: missing === 1 ? O.noTag.one : fill(O.noTag.many, { count: missing }),
							effect: O.noTag.effect,
							action: (
								<Button size="sm" variant="secondary" onClick={() => open('settings')}>
									{O.noTag.action}
								</Button>
							),
						},
					]
				: [],
		steps: [
			...setup,
			...(scripts
				? [
						{
							key: 'scripts',
							label: O.scriptsStep,
							why: O.scriptsWhy,
							actionLabel: O.scriptsAction,
							done:
								tagsReady(['custom_scripts'], values, categories.answer?.ok ? categories.answer.data.value : []).ready ===
								1,
							onSelect: () => open('settings', 'tags.consent_categories'),
						},
					]
				: []),
		],
		numbers:
			tags.total > 0 ? (
				<Stat
					label={O.tags}
					value={fill(O.ofTotal, { count: tags.ready, total: tags.total })}
					hint={O.tagsHelp}
					icon="zap"
					kind="connection"
				/>
			) : null,
	};
};

/** @param {TabProps} props */
const GrowthOverview = (props) => <OverviewTab {...props} useMore={useGrowthOverview} />;

/**
 * Settings, each card with what it says about the setup: the website's switched-on features, its domain, the time,
 * the viewer's time zone and the search parameters of Searches and 404s (robots.txt keeps their result pages out).
 * @param {TabProps} props
 */
function GrowthSettings(props) {
	const timeZone = useViewerTimeZone();
	/** @type {import('@ss/ui/dashboard').SettingsNotice} */
	const notice = (key, values, features) =>
		settingsNotice(key, values, {
			on: features.filter((feature) => feature.on !== false).map((feature) => feature.key),
			domain: props.domain,
			now: Date.now(),
			timeZone,
			searchParams: searchParamsOf(
				String(features.find((feature) => feature.key === 'searches_404s')?.values.searchParams?.value ?? ''),
			),
		});
	return <SettingsTab {...props} notice={notice} {...(props.websiteId ? { extras: listExtras(props.websiteId) } : {})} />;
}

/**
 * The global defaults have no website: their cards say only what their values say.
 * @type {import('@ss/ui/dashboard').SettingsNotice}
 */
const defaultsNotice = (key, values) => settingsNotice(key, values, null);

/** @param {TabProps} props */
const GrowthDefaults = (props) => <DefaultsTab {...props} notice={defaultsNotice} />;

/**
 * Developers: the page script and the consent calls, the shop events, the API for the merchant's server, the widget
 * snippets and the ticket request.
 * @param {TabProps} props
 */
function GrowthDevelopers(props) {
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
	const D = TEXTS.developers;
	const snippets = createSnippets({
		base: origin,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
		loading: /** @type {'async' | 'blocking'} */ (manifest.widgetScriptLoading),
	});
	/** @param {string} id @param {string} title @param {string} help @param {import('react').ReactNode} body @param {import('@ss/ui').IconName} icon */
	const part = (id, title, help, body, icon) => ({
		id,
		label: title,
		icon,
		content: (
			<Section title={title} description={help}>
				{body}
			</Section>
		),
	});
	return (
		<DevelopersTab
			{...props}
			connections={null}
			sections={[
				part(
					'script',
					D.script,
					D.scriptHelp,
					<>
						<CodeBlock code={snippets.pageScript} />
						<CodeBlock code={snippets.consent} />
					</>,
					'code',
				),
				part(
					'events',
					D.events,
					D.eventsHelp,
					<>
						<CodeBlock code={[...Object.keys(BROWSER_EVENTS), ...Object.keys(SITE_EVENTS)].join('\n')} />
						<CodeBlock code={snippets.events} />
						<CodeBlock code={snippets.page} />
					</>,
					'activity',
				),
				part(
					'api',
					D.api,
					D.apiHelp,
					<>
						<CodeBlock code={snippets.analytics} />
						<CodeBlock code={snippets.robots} />
						<CodeBlock code={snippets.indexNow} />
						<CodeBlock code={snippets.seo} />
						<CodeBlock code={snippets.redirects} />
						<CodeBlock code={snippets.notice} />
					</>,
					'database',
				),
				part('widgets', D.widgets, D.widgetsHelp, <CodeBlock code={snippets.admin} />, 'box'),
				part(
					'ticket',
					D.ticket,
					D.ticketHelp,
					<>
						<CodeBlock code={snippets.ticketNode} />
						<CodeBlock code={snippets.ticketCurl} />
					</>,
					'key',
				),
			]}
		/>
	);
}

/**
 * Growth's tabs in place of the shared ones; Features and Prices are the shared ones as they are. Growth keeps no provider
 * key, and its database and links are the Portal's, so its Developers tab has no connections part.
 */
export const TABS = Object.freeze({
	overview: GrowthOverview,
	settings: GrowthSettings,
	developers: GrowthDevelopers,
	defaults: GrowthDefaults,
});
