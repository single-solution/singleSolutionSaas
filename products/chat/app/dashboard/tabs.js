'use client';
/**
 * Chat's parts of the dashboard tabs (PLAN 0.4.3, 0.8.3 Chat dashboard), on the shared tabs of `@ss/ui/dashboard`: the
 * Overview's setup steps and its booking address while the Book-a-slot tool is on, the rules between features, Chat's settings sections, the
 * developer snippets with the connections beside them (the backup AI provider form with its hint; the database, the
 * storage and the main AI key are the Portal's), and the AI label warning in Defaults.
 * @module
 */
import { Button, CodeBlock, Section } from '@ss/ui';
import { DefaultsTab, DevelopersTab, OverviewTab, useLoad, useSetupSteps, wantsSettings } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { createSnippets } from '../../core/snippets.js';
import { AiForm, FORMS } from './forms.js';
import { SettingsTab, aiLabelNotice } from './settings.js';
import { TEXTS } from './texts.js';

/** @type {ReadonlyArray<import('@ss/ui/dashboard').SetupRequirement>} */
const SETUP = Object.freeze([
	{
		key: 'instructions',
		when: ['ai_instructions'],
		setting: 'ai_instructions.instructions',
		label: 'Tell the AI about your business',
		why: 'Every answer follows what you write: what you sell, how it should sound and what it must never say.',
		action: 'Write it',
	},
	{
		key: 'booking',
		when: ['book_slot'],
		setting: 'book_slot.bookingUrl',
		label: 'Set the booking address',
		why: 'The AI cannot offer or book times until it knows the address on your server that gives free times.',
		action: 'Set address',
	},
	{
		key: 'alert-page',
		when: ['staff_alerts'],
		setting: 'staff_alerts.adminUrl',
		label: 'Set the conversation page address',
		why: 'Alerts link staff to this page of your admin, where they open the chat and reply.',
		action: 'Set address',
	},
]);

/** @typedef {import('@ss/ui/dashboard').TabProps} TabProps */

/**
 * Chat's part of the Overview (PLAN 0.6 "Overviews talk"): the settings the switched-on features need set
 * (`setup-steps.js`), and, while the Book-a-slot tool is on, its booking address to set while there is none.
 * @type {import('@ss/ui/dashboard').UseOverviewMore}
 */
const useChatOverview = (overview, { websiteId, open }) => {
	const booking = overview?.ok === true && overview.data.featuresOn.includes('book_slot');
	// the settings are read only while a feature that needs one is on
	const settings = useLoad(booking || wantsSettings(overview, SETUP) ? `/v1/dashboard/websites/${websiteId}/settings` : null);
	const setup = useSetupSteps({ overview, websiteId, open, settings: settings.answer }, SETUP);
	if (!settings.answer?.ok) return {};
	/** @type {Array<{ key: string, values: Record<string, { value: unknown }> }>} */
	const features = settings.answer.data.features;
	const set = Boolean(features.find((feature) => feature.key === 'book_slot')?.values.bookingUrl?.value);
	const O = TEXTS.overview;
	return {
		needs:
			booking && !set
				? [
						{
							key: 'booking',
							tone: /** @type {const} */ ('warning'),
							title: O.noBooking.title,
							effect: O.noBooking.effect,
							action: (
								<Button size="sm" variant="secondary" onClick={() => open('settings', 'book_slot')}>
									{O.noBooking.action}
								</Button>
							),
						},
					]
				: [],
		steps: setup,
	};
};

/**
 * Chat's rules between features (PLAN 0.8.3): no one answers (neither AI replies nor Inbox is on).
 * @param {string[]} on
 */
const ruleWarnings = (on) =>
	on.includes('visitor_chat')
		? [...(on.includes('ai_replies') || on.includes('inbox') ? [] : [TEXTS.features.noOneAnswers])]
		: [];

/**
 * The one-line help under a connection: what to paste or enter.
 * @param {string} name
 */
const connectionHint = (name) => TEXTS.connections.hints[/** @type {keyof typeof TEXTS.connections.hints} */ (name)] ?? null;

/**
 * The structured value of the backup AI provider (the other connections take one value; the database, the storage and the
 * main AI key are the Portal's).
 * @param {import('@ss/ui/dashboard').Connection} item
 * @param {(value: unknown) => Promise<void>} save
 */
const connectionForm = (item, save) => (FORMS.includes(item.name) ? <AiForm onSave={save} /> : null);

/** @param {TabProps} props */
function Overview(props) {
	return <OverviewTab {...props} useMore={useChatOverview} />;
}

/** @param {TabProps} props */
function Settings(props) {
	return <SettingsTab {...props} warnings={ruleWarnings} />;
}

/** The widget scripts, the ticket request and the tool signature check, pointing at this Chat. @param {TabProps} props */
function Developers(props) {
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
	const snippets = createSnippets({
		base: origin,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
	});
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
			connections={{ hint: connectionHint, form: connectionForm }}
			sections={[
				part('visitor', D.visitor, D.visitorHelp, <CodeBlock code={snippets.visitor} />, 'users'),
				part('admin', D.admin, D.adminHelp, <CodeBlock code={snippets.admin} />, 'box'),
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
				part('tools', D.tools, D.toolsHelp, <CodeBlock code={snippets.toolCheck} />, 'shield'),
			]}
		/>
	);
}

/** @param {TabProps} props */
function Defaults(props) {
	return <DefaultsTab {...props} notice={aiLabelNotice} />;
}

/** Chat's tabs in place of the standard ones (Prices is the standard tab). */
export const TABS = Object.freeze({
	overview: Overview,
	settings: Settings,
	developers: Developers,
	defaults: Defaults,
});
