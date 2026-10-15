'use client';
/**
 * Notifications' own parts of the shared dashboard tabs (`@ss/ui/dashboard`, PLAN 0.4.3): the templates counted in the
 * Overview and a webhook URL asked for while Outgoing webhooks is on without one; Settings → Templates on top of
 * Settings and the webhook URLs and the merchant's lists (topics, template settings, fallback channels, quiet hours)
 * beside the feature settings; the provider forms of the email, SMS and WhatsApp
 * connections; and the developer sections (send API, template keys, widget and ticket snippets, the webhook signature
 * check and the reply addresses).
 * @module
 */
import { Badge, Button, Card, CodeBlock, Section, Stat } from '@ss/ui';
import { ConnectionsTab, DevelopersTab, OverviewTab, SettingsTab, useLoad } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { createSnippets } from '../../core/snippets.js';
import { PROVIDER_FORMS, ProviderForm } from './providers.js';
import { TemplatesSection } from './templates.js';
import { TEXTS } from './texts.js';
import { MerchantLists } from './lists.js';
import { WebhookUrlsCard } from './webhooks.js';

/** @typedef {import('@ss/ui/dashboard').TabProps} TabProps */

/**
 * The Overview's own part: the merchant's templates counted, and, while Outgoing webhooks is on (its URL list is read
 * only then), a URL to add while there is none.
 * @type {import('@ss/ui/dashboard').UseOverviewMore}
 */
const useNotificationsOverview = (overview, { websiteId, open }) => {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const templates = useLoad(`${base}/templates`);
	const webhooks = overview?.ok === true && overview.data.featuresOn.includes('webhooks');
	const webhookUrls = useLoad(webhooks ? `${base}/lists/webhook_urls` : null);
	/** The webhook URLs, once read (null: not read). */
	const urls = webhookUrls.answer?.ok ? Number(webhookUrls.answer.data.value.length) : null;
	const O = TEXTS.overview;
	return {
		needs:
			urls === 0
				? [
						{
							key: 'webhooks',
							tone: 'warning',
							title: O.noWebhookUrls.title,
							effect: O.noWebhookUrls.effect,
							action: (
								<Button size="sm" variant="secondary" onClick={() => open('settings')}>
									{O.noWebhookUrls.action}
								</Button>
							),
						},
					]
				: [],
		steps:
			urls === null ? [] : [{ key: 'webhooks', label: O.webhookUrlStep, done: urls > 0, onSelect: () => open('settings') }],
		numbers: (
			<Stat
				label={O.templates}
				value={templates.answer?.ok ? templates.answer.data.items.length : '—'}
				{...(templates.answer && !templates.answer.ok ? { hint: O.templatesNone } : {})}
				icon="mail"
				kind="settings"
			/>
		),
	};
};

/** @param {TabProps} props */
function NotificationsOverview(props) {
	return <OverviewTab {...props} useMore={useNotificationsOverview} />;
}

/** @param {TabProps} props */
function NotificationsSettings(props) {
	const websiteId = /** @type {string} */ (props.websiteId);
	return (
		<SettingsTab
			{...props}
			sections={<TemplatesSection websiteId={websiteId} />}
			featureCards={(features) => {
				const webhooks = features.find((feature) => feature.key === 'webhooks');
				return (
					<>
						{webhooks ? (
							<WebhookUrlsCard
								websiteId={websiteId}
								off={webhooks.on === false}
								max={Number(webhooks.values?.maxUrls?.value ?? 5)}
							/>
						) : null}
						<MerchantLists websiteId={websiteId} features={features} />
					</>
				);
			}}
		/>
	);
}

/**
 * The email, SMS and WhatsApp providers take their settings as one structured value (null: the one value field).
 * @param {import('@ss/ui/dashboard').Connection} item
 * @param {(value: unknown) => Promise<void>} save
 */
const providerForm = (item, save) => (item.name in PROVIDER_FORMS ? <ProviderForm name={item.name} onSave={save} /> : null);

/** @param {TabProps} props */
function NotificationsConnections(props) {
	return <ConnectionsTab {...props} form={providerForm} />;
}

/** @param {TabProps} props */
function NotificationsDevelopers(props) {
	const templates = useLoad(`/v1/dashboard/websites/${props.websiteId}/templates`);
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
	const snippets = createSnippets({
		base: origin,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
	});
	/** @type {Map<string, string[]>} */
	const keys = new Map();
	for (const item of templates.answer?.ok ? templates.answer.data.items : [])
		keys.set(item.key, [...new Set([...(keys.get(item.key) ?? []), item.channel])]);
	const D = TEXTS.developers;
	return (
		<DevelopersTab {...props}>
			<Section title={D.send} description={D.sendHelp}>
				<CodeBlock code={snippets.send} />
				<CodeBlock code={snippets.sendCurl} />
			</Section>
			<Section title={D.keys} description={D.keysHelp}>
				<Card>
					{keys.size === 0 ? <p className="text-sm text-muted">{D.noKeys}</p> : null}
					<ul className="space-y-2 text-sm">
						{[...keys].map(([key, channels]) => (
							<li key={key} className="flex flex-wrap items-center gap-2">
								<code className="font-semibold">{key}</code>
								{channels.map((channel) => (
									<Badge key={channel} tone="info">
										{TEXTS.settings.channels[/** @type {keyof typeof TEXTS.settings.channels} */ (channel)]}
									</Badge>
								))}
							</li>
						))}
					</ul>
				</Card>
			</Section>
			<Section title={D.widgets} description={D.widgetsHelp}>
				<CodeBlock code={snippets.visitor} />
				<CodeBlock code={snippets.admin} />
			</Section>
			<Section title={D.ticket} description={D.ticketHelp}>
				<CodeBlock code={snippets.ticketNode} />
			</Section>
			<Section title={D.webhook} description={D.webhookHelp}>
				<CodeBlock code={snippets.webhook} />
			</Section>
			<Section title={D.replies} description={D.repliesHelp}>
				<CodeBlock code={snippets.inbound.replaceAll('<websiteId>', String(props.websiteId))} />
			</Section>
		</DevelopersTab>
	);
}

/** Notifications' tabs in place of the standard ones (the others are the shared tabs as they are). */
export const TABS = Object.freeze({
	overview: NotificationsOverview,
	settings: NotificationsSettings,
	connections: NotificationsConnections,
	developers: NotificationsDevelopers,
});
