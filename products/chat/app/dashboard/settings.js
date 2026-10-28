'use client';
/**
 * Settings tab (PLAN 0.8.3 Chat dashboard): the kit's settings of the switched-on features, listed by category in the
 * inner sidebar, with Chat's list editors under the feature they belong to (fallback answers under the Assistant,
 * tools and the signing secret, booking questions and services, page types and page rules, flows, custom fields,
 * office hours, tags, topics and priorities, teams, upload types and redaction patterns). The widget texts are the Texts
 * tab; the theme, the Format and the alert people are the Portal's Website settings.
 * @module
 */
import { Callout } from '@ss/ui';
import { SettingsTab as SharedSettingsTab, useLoad } from '@ss/ui/dashboard';
import { LABEL_LISTS } from '../../core/labels.js';
import { aiLabelShown } from '../../core/widgets.js';
import {
	BookingQuestionsEditor,
	BookingServicesEditor,
	CustomFieldsEditor,
	FallbackAnswersEditor,
	FlowsEditor,
	LabelsEditor,
	OfficeExceptionsEditor,
	OfficeHoursEditor,
	PageRulesEditor,
	PageTypesEditor,
	RedactionPatternsEditor,
	TeamsEditor,
	ToolSecret,
	ToolsEditor,
	UploadTypesEditor,
} from './lists.js';
import { TEXTS } from './texts.js';

/**
 * The AI label warning (PLAN 0.8.3 AI) on the AI replies card while the label is hidden: Show the AI label off, or
 * Never disclose on (C1).
 * @param {string} key
 * @param {Record<string, unknown>} values
 */
export const aiLabelNotice = (key, values) =>
	key === 'ai_replies' && !aiLabelShown(values) ? (
		<Callout tone="warning" className="mb-4">
			{TEXTS.settings.aiLabelWarning}
		</Callout>
	) : null;

/**
 * The features that are on (and their settings values), from the settings answer the tab has already read.
 * @param {string} websiteId
 */
const useFeatures = (websiteId) => {
	const settings = useLoad(`/v1/dashboard/websites/${websiteId}/settings`);
	/** @type {Array<{ key: string, on?: boolean, values: Record<string, { value: unknown }> }>} */
	const features = settings.answer?.ok ? settings.answer.data.features : [];
	return {
		/** @param {string} key */
		on: (key) => features.some((feature) => feature.key === key && feature.on !== false),
		/** @param {string} key @param {string} name */
		value: (key, name) => features.find((feature) => feature.key === key)?.values[name]?.value,
	};
};

/** The fallback answers, with the languages of Language lock offered. @param {{ websiteId: string }} props */
function FallbackAnswers({ websiteId }) {
	const { on, value } = useFeatures(websiteId);
	const legacyLangs = on('language_lock') ? value('language_lock', 'allowedLanguages') : null;
	const aiLangs = value('ai_replies', 'allowedLanguages');
	const languages = Array.isArray(legacyLangs) ? legacyLangs : Array.isArray(aiLangs) ? aiLangs : [];
	return <FallbackAnswersEditor websiteId={websiteId} off={false} languages={languages.map(String)} on={on} />;
}

/** The flows, with Custom fields offered as steps while it is on. @param {{ websiteId: string }} props */
function Flows({ websiteId }) {
	const { on } = useFeatures(websiteId);
	return <FlowsEditor websiteId={websiteId} off={false} customFields={on('custom_fields') || on('leads_flows')} />;
}

/**
 * Chat's list editors, each under its feature (a feature that is off is not listed).
 * @param {string} websiteId
 * @returns {Record<string, import('@ss/ui/dashboard').FeatureExtra>}
 */
const extrasOf = (websiteId) => ({
	ai_replies: {
		items: [
			{
				id: 'fallback-answers',
				label: TEXTS.lists.fallbackAnswers.title,
				content: <FallbackAnswers websiteId={websiteId} />,
			},
		],
	},
	fallback_answers: <FallbackAnswers websiteId={websiteId} />,
	webhook_tools: {
		items: [
			{ id: 'tools', label: TEXTS.lists.tools.title, content: <ToolsEditor websiteId={websiteId} off={false} bare /> },
			{ id: 'secret', label: TEXTS.secret.title, content: <ToolSecret websiteId={websiteId} bare /> },
		],
	},
	book_slot: {
		items: [
			{
				id: 'questions',
				label: TEXTS.lists.bookingQuestions.title,
				content: <BookingQuestionsEditor websiteId={websiteId} off={false} bare />,
			},
			{
				id: 'services',
				label: TEXTS.lists.bookingServices.title,
				content: <BookingServicesEditor websiteId={websiteId} off={false} bare />,
			},
		],
	},
	visitor_chat: {
		items: [
			{
				id: 'page-types',
				label: TEXTS.lists.pageTypes.title,
				content: <PageTypesEditor websiteId={websiteId} off={false} bare />,
			},
			{
				id: 'upload-types',
				label: TEXTS.lists.uploadTypes.title,
				content: <UploadTypesEditor websiteId={websiteId} off={false} bare />,
			},
			{
				id: 'page-rules',
				label: TEXTS.lists.pageRules.title,
				content: <PageRulesEditor websiteId={websiteId} off={false} bare />,
			},
		],
	},
	proactive_pages: <PageRulesEditor websiteId={websiteId} off={false} bare />,
	leads_flows: {
		items: [
			{
				id: 'flows',
				label: TEXTS.lists.flows.title,
				content: <Flows websiteId={websiteId} />,
			},
			{
				id: 'custom-fields',
				label: TEXTS.lists.customFields.title,
				content: <CustomFieldsEditor websiteId={websiteId} off={false} bare />,
			},
		],
	},
	custom_fields: <CustomFieldsEditor websiteId={websiteId} off={false} bare />,
	handoff: {
		items: [
			{
				id: 'hours',
				label: TEXTS.lists.officeHours.title,
				content: <OfficeHoursEditor websiteId={websiteId} off={false} bare />,
			},
			{
				id: 'exceptions',
				label: TEXTS.lists.officeExceptions.title,
				content: <OfficeExceptionsEditor websiteId={websiteId} off={false} bare />,
			},
		],
	},
	inbox: {
		items: [
			...LABEL_LISTS.map((list) => ({
				id: list,
				label: TEXTS.lists.labels[list].title,
				content: <LabelsEditor websiteId={websiteId} list={list} off={false} bare />,
			})),
			{
				id: 'teams',
				label: TEXTS.lists.teams.title,
				content: <TeamsEditor websiteId={websiteId} off={false} bare />,
			},
		],
	},
	assignment: <TeamsEditor websiteId={websiteId} off={false} />,
	attachments: <UploadTypesEditor websiteId={websiteId} off={false} />,
	moderation: <RedactionPatternsEditor websiteId={websiteId} off={false} />,
});

/** @param {import('@ss/ui/dashboard').TabProps & { warnings?: (on: string[]) => string[] }} props */
export function SettingsTab(props) {
	return <SharedSettingsTab {...props} notice={aiLabelNotice} extras={extrasOf(String(props.websiteId))} />;
}
