'use client';
/**
 * Settings tab (PLAN 0.8.3 Chat dashboard): the kit's settings forms of the features the viewer may see, grouped in
 * Chat's sections, with the list editors, the tool signing secret, the theme and the widget texts. A section shows only
 * when one of its features is visible (merchants: switched-on features; admins: all, off ones marked).
 * @module
 */
import { Callout, Masonry, Section } from '@ss/ui';
import { call, useLoad } from './api.js';
import { CustomFieldsEditor, FlowsEditor, PageRulesEditor, ToolSecret, ToolsEditor } from './lists.js';
import { Loaded, SettingsForms, TextsForm, ThemeForm, hasSettings } from './parts.js';
import { TEXTS } from './texts.js';

/** @typedef {import('./parts.js').FeatureSettings} FeatureSettings */
/** @typedef {keyof typeof TEXTS.settings.sections} SectionId */

/**
 * Sections in order and the features whose settings forms each shows.
 * @type {Array<{ id: SectionId, features: string[] }>}
 */
const SECTIONS = [
	{ id: 'assistant', features: ['ai_replies', 'ai_instructions', 'ai_caps', 'ai_cost_alerts', 'language_lock'] },
	{ id: 'tools', features: ['webhook_tools', 'book_slot'] },
	{ id: 'look', features: ['visitor_chat'] },
	{ id: 'texts', features: [] },
	{ id: 'guests', features: ['guest_chat', 'signed_in_chat'] },
	{ id: 'proactive', features: ['proactive_idle', 'proactive_pages', 'proactive_exit'] },
	{ id: 'flows', features: [] },
	{ id: 'leads', features: ['leads_flows'] },
	{ id: 'customFields', features: [] },
	{ id: 'handoff', features: ['handoff', 'presence_queue'] },
	{ id: 'inbox', features: ['staff_alerts', 'inbox'] },
	{ id: 'attachments', features: ['attachments'] },
	{ id: 'ratings', features: ['ratings'] },
	{ id: 'transcripts', features: ['transcripts'] },
	{ id: 'moderation', features: ['moderation'] },
];

const PLACED = new Set(SECTIONS.flatMap((section) => section.features));

/**
 * The AI label warning (PLAN 0.8.3 AI) on the AI replies card while the label is hidden.
 * @param {string} key
 * @param {Record<string, unknown>} values
 */
export const aiLabelNotice = (key, values) =>
	key === 'ai_replies' && values.showAiLabel === false ? (
		<Callout tone="warning" className="mb-4">
			{TEXTS.settings.aiLabelWarning}
		</Callout>
	) : null;

/** @param {import('./tabs.js').TabProps} props */
export function SettingsTab({ websiteId: id }) {
	const websiteId = /** @type {string} */ (id);
	const base = `/v1/dashboard/websites/${websiteId}`;
	const settings = useLoad(`${base}/settings`);
	const texts = useLoad(`${base}/texts`);
	const theme = useLoad(`${base}/theme`);
	return (
		<Loaded answer={settings.answer}>
			{(data) => {
				/** @type {FeatureSettings[]} */
				const features = data.features;
				/** @param {string} key */
				const seen = (key) => features.find((feature) => feature.key === key) ?? null;
				/** @param {string} key */
				const off = (key) => seen(key)?.on === false;
				/** @param {string[]} keys */
				const forms = (keys) => (
					<SettingsForms
						features={features.filter((feature) => keys.includes(feature.key))}
						saveUrl={(key) => `${base}/settings/${encodeURIComponent(key)}`}
						resetBody={false}
						savedSource="website"
						reload={settings.reload}
						notice={aiLabelNotice}
					/>
				);
				/** @type {Record<SectionId, import('react').ReactNode>} */
				const extras = {
					assistant: null,
					tools:
						seen('webhook_tools') || seen('book_slot') ? (
							<>
								{seen('webhook_tools') ? <ToolsEditor websiteId={websiteId} off={off('webhook_tools')} /> : null}
								<ToolSecret websiteId={websiteId} />
							</>
						) : null,
					look: seen('visitor_chat') ? (
						<Loaded answer={theme.answer}>
							{(found) => (
								<ThemeForm
									theme={found.theme}
									save={(next) => call('PUT', `${base}/theme`, next)}
									reload={theme.reload}
								/>
							)}
						</Loaded>
					) : null,
					texts: (
						<Loaded answer={texts.answer}>
							{(found) => (
								<TextsForm
									texts={found.texts}
									saveUrl={(key) => `${base}/texts/${encodeURIComponent(key)}`}
									resetBody={false}
									savedSource="website"
									reload={texts.reload}
								/>
							)}
						</Loaded>
					),
					guests: null,
					proactive: seen('proactive_pages') ? <PageRulesEditor websiteId={websiteId} off={off('proactive_pages')} /> : null,
					flows: seen('leads_flows') ? (
						<FlowsEditor websiteId={websiteId} off={off('leads_flows')} customFields={seen('custom_fields') !== null} />
					) : null,
					leads: null,
					customFields: seen('custom_fields') ? (
						<CustomFieldsEditor websiteId={websiteId} off={off('custom_fields')} />
					) : null,
					handoff: null,
					inbox: null,
					attachments: null,
					ratings: null,
					transcripts: seen('transcripts') ? <Callout tone="info">{TEXTS.settings.transcriptsNote}</Callout> : null,
					moderation: null,
					other: null,
				};
				const others = features.filter((feature) => !PLACED.has(feature.key) && hasSettings(feature));
				const shown = [
					...SECTIONS.filter(
						(section) =>
							extras[section.id] !== null || features.some((f) => section.features.includes(f.key) && hasSettings(f)),
					),
					...(others.length > 0 ? [{ id: /** @type {SectionId} */ ('other'), features: others.map((f) => f.key) }] : []),
				];
				return (
					<div className="space-y-8">
						{shown.map((section) => (
							<Section
								key={section.id}
								title={TEXTS.settings.sections[section.id].title}
								description={TEXTS.settings.sections[section.id].help}>
								<Masonry>
									{forms(section.features)}
									{extras[section.id]}
								</Masonry>
							</Section>
						))}
					</div>
				);
			}}
		</Loaded>
	);
}
