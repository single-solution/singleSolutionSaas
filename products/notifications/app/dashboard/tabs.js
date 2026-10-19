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
import { Badge, Button, Card, CodeBlock, DataTable, Section, Stat } from '@ss/ui';
import { ConnectionsTab, DevelopersTab, OverviewTab, SettingsTab, useLoad, useSetupSteps } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { createSnippets } from '../../core/snippets.js';
import { PROVIDER_FORMS, ProviderForm } from './providers.js';
import { TemplatesSection } from './templates.js';
import { TEXTS } from './texts.js';
import { FallbackChainsCard, QuietHoursCard, StopKeywordsCard, TemplateSettingsCard, TopicsCard } from './lists.js';
import { SETUP } from './setup-steps.js';
import { WebhookUrlsCard } from './webhooks.js';

/** @typedef {import('@ss/ui/dashboard').TabProps} TabProps */

/**
 * The Overview's own part: the merchant's templates counted, the setup steps (`setup-steps.js`) and, while Outgoing
 * webhooks is on (its address list is read only then), an address to add while there is none.
 * @type {import('@ss/ui/dashboard').UseOverviewMore}
 */
const useNotificationsOverview = (overview, { websiteId, open }) => {
	const base = `/v1/dashboard/websites/${websiteId}`;
	const templates = useLoad(`${base}/templates`);
	const setup = useSetupSteps({ overview, websiteId, open }, SETUP);
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
								<Button size="sm" variant="secondary" onClick={() => open('settings', 'webhooks')}>
									{O.noWebhookUrls.action}
								</Button>
							),
						},
					]
				: [],
		steps: setup,
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

/**
 * The webhook URLs under Outgoing webhooks.
 * @param {{ websiteId: string }} props
 */
function WebhookUrls({ websiteId }) {
	return <WebhookUrlsCard websiteId={websiteId} off={false} />;
}

/**
 * Settings: the templates, their topics and settings, and the stop words under Templates; the fallback channels under
 * Fallback channel; the quiet hours under Quiet hours; and the webhook URLs under Outgoing webhooks. Each is listed
 * while its feature is on.
 * @param {TabProps} props
 */
function NotificationsSettings(props) {
	const websiteId = /** @type {string} */ (props.websiteId);
	return (
		<SettingsTab
			{...props}
			extras={{
				templates: {
					items: [
						{ id: 'list', label: TEXTS.settings.templatesTitle, content: <TemplatesSection websiteId={websiteId} /> },
						{
							id: 'topics',
							label: TEXTS.settings.lists.topics.title,
							content: <TopicsCard websiteId={websiteId} off={false} />,
						},
						{
							id: 'settings',
							label: TEXTS.settings.lists.templates.title,
							content: <TemplateSettingsCard websiteId={websiteId} off={false} />,
						},
						{
							id: 'stop',
							label: TEXTS.settings.lists.keywords.title,
							content: <StopKeywordsCard websiteId={websiteId} off={false} />,
						},
					],
				},
				fallback: <FallbackChainsCard websiteId={websiteId} off={false} />,
				quiet_hours: <QuietHoursCard websiteId={websiteId} off={false} />,
				webhooks: <WebhookUrls websiteId={websiteId} />,
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
			sections={[
				part(
					'send',
					D.send,
					D.sendHelp,
					<>
						<CodeBlock code={snippets.send} />
						<CodeBlock code={snippets.sendCurl} />
					</>,
					'mail',
				),
				part(
					'keys',
					D.keys,
					D.keysHelp,
					<Card padded={false} className="overflow-hidden">
						<DataTable
							caption={D.keys}
							loading={!templates.answer}
							skeletonRows={3}
							columns={[
								{ key: 'key', header: D.keyColumns.key, render: (row) => <code>{row.key}</code> },
								{
									key: 'channels',
									header: D.keyColumns.channels,
									wrap: true,
									render: (row) => (
										<span className="flex flex-wrap gap-1">
											{row.channels.map((channel) => (
												<Badge key={channel} tone="info">
													{TEXTS.settings.channels[/** @type {keyof typeof TEXTS.settings.channels} */ (channel)]}
												</Badge>
											))}
										</span>
									),
								},
							]}
							rows={[...keys].map(([key, channels]) => ({ key, channels }))}
							rowKey={(row) => row.key}
							rowLabel={(row) => row.key}
							empty={D.noKeys}
						/>
					</Card>,
					'key',
				),
				part(
					'widgets',
					D.widgets,
					D.widgetsHelp,
					<>
						<CodeBlock code={snippets.visitor} />
						<CodeBlock code={snippets.admin} />
					</>,
					'box',
				),
				part('ticket', D.ticket, D.ticketHelp, <CodeBlock code={snippets.ticketNode} />, 'shield'),
				part('webhook', D.webhook, D.webhookHelp, <CodeBlock code={snippets.webhook} />, 'bell'),
				part(
					'replies',
					D.replies,
					D.repliesHelp,
					<CodeBlock code={snippets.inbound.replaceAll('<websiteId>', String(props.websiteId))} />,
					'link',
				),
			]}
		/>
	);
}

/** Notifications' tabs in place of the standard ones (the others are the shared tabs as they are). */
export const TABS = Object.freeze({
	overview: NotificationsOverview,
	settings: NotificationsSettings,
	connections: NotificationsConnections,
	developers: NotificationsDevelopers,
});
