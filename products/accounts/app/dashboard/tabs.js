'use client';
/**
 * Accounts' own parts of the shared dashboard tabs (`@ss/ui/dashboard`, PLAN 0.4.3): the custom fields in the Overview
 * (how many there are while Custom fields is on, and a field to add while there is none) and, with the consent list
 * (A2), on top of Settings; the
 * social sign-in key forms and the help line of each connection; and the developer sections (offline sign-in
 * verification, widget and ticket snippets, social sign-in return addresses and the message templates).
 * @module
 */
import { Badge, Button, Card, CodeBlock, DataTable, Section, Stat } from '@ss/ui';
import { ConnectionsTab, DevelopersTab, OverviewTab, SettingsTab, useLoad, useSetupSteps } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import messages from '../../schemas/messages.json' with { type: 'json' };
import { createSnippets } from '../../core/snippets.js';
import { ConsentsSection } from './consents.js';
import { FieldsSection } from './fields.js';
import { KEY_FORMS, KeyForm } from './forms.js';
import { SETUP } from './setup-steps.js';
import { TEXTS } from './texts.js';

/** @typedef {import('@ss/ui/dashboard').TabProps} TabProps */

/**
 * The Overview's own part: the settings the features need set (`setup-steps.js`), and the custom fields while the feature
 * is on: the fields counted (the list is read only then), and a field to add while there is none.
 * @type {import('@ss/ui/dashboard').UseOverviewMore}
 */
const useFieldsOverview = (overview, { websiteId, open }) => {
	const setup = useSetupSteps({ overview, websiteId, open }, SETUP);
	const customFields = overview?.ok === true && overview.data.featuresOn.includes('custom_fields');
	const fields = useLoad(customFields ? `/v1/dashboard/websites/${websiteId}/fields` : null);
	/** The custom fields, once read (null: not read, or the database is not connected). */
	const count = fields.answer?.ok ? Number(fields.answer.data.items.length) : null;
	const O = TEXTS.overview;
	return {
		needs:
			count === 0
				? [
						{
							key: 'fields',
							tone: 'warning',
							title: O.noFields.title,
							effect: O.noFields.effect,
							action: (
								<Button size="sm" variant="secondary" onClick={() => open('settings', 'custom_fields')}>
									{O.noFields.action}
								</Button>
							),
						},
					]
				: [],
		steps: [
			...setup,
			...(count === null
				? []
				: [
						{
							key: 'fields',
							label: O.fieldsStep,
							why: O.fieldsWhy,
							actionLabel: O.fieldsAction,
							done: count > 0,
							onSelect: () => open('settings', 'custom_fields'),
						},
					]),
		],
		numbers: customFields ? (
			<Stat
				label={O.fields}
				value={count ?? '—'}
				{...(fields.answer && !fields.answer.ok ? { hint: O.fieldsNone } : {})}
				icon="user"
				kind="settings"
			/>
		) : null,
	};
};

/** @param {TabProps} props */
function AccountsOverview(props) {
	return <OverviewTab {...props} useMore={useFieldsOverview} />;
}

/** @param {TabProps} props */
function AccountsSettings(props) {
	const websiteId = /** @type {string} */ (props.websiteId);
	// the lists sit under their feature (a merchant sees them while it is on)
	return (
		<SettingsTab
			{...props}
			extras={{
				custom_fields: <FieldsSection websiteId={websiteId} />,
				consents: <ConsentsSection websiteId={websiteId} />,
			}}
		/>
	);
}

/**
 * The one-line help under a connection: what to paste.
 * @param {string} name
 */
const connectionHint = (name) => (name === 'imported_password_pepper' ? TEXTS.connections.hints.imported_password_pepper : null);

/**
 * Google, Apple and Facebook take their keys as one structured value (null: the one value field).
 * @param {import('@ss/ui/dashboard').Connection} item
 * @param {(value: unknown) => Promise<void>} save
 */
const keyForm = (item, save) => (item.name in KEY_FORMS ? <KeyForm name={item.name} onSave={save} /> : null);

/** @param {TabProps} props */
function AccountsConnections(props) {
	return <ConnectionsTab {...props} hint={connectionHint} form={keyForm} />;
}

/** @param {TabProps} props */
function AccountsDevelopers(props) {
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
	const snippets = createSnippets({
		base: origin,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
		websiteId: String(props.websiteId),
	});
	const D = TEXTS.developers;
	return (
		<DevelopersTab
			{...props}
			sections={[
				{
					id: 'verification',
					label: D.verification,
					icon: 'shield',
					content: (
						<Section title={D.verification} description={D.verificationHelp}>
							<CodeBlock label={D.keysUrl} code={snippets.keysUrl} />
							<CodeBlock code={snippets.verify} />
							<CodeBlock code={snippets.verifyJose} />
						</Section>
					),
				},
				{
					id: 'widgets',
					label: D.widgets,
					icon: 'code',
					content: (
						<Section title={D.widgets} description={D.widgetsHelp}>
							<CodeBlock code={snippets.visitor} />
							<CodeBlock code={snippets.signedInCall} />
							<CodeBlock code={snippets.admin} />
						</Section>
					),
				},
				{
					id: 'ticket',
					label: D.ticket,
					icon: 'key',
					content: (
						<Section title={D.ticket} description={D.ticketHelp}>
							<CodeBlock code={snippets.ticketNode} />
							<CodeBlock code={snippets.ticketCurl} />
						</Section>
					),
				},
				{
					id: 'returns',
					label: D.returns,
					icon: 'link',
					content: (
						<Section title={D.returns} description={D.returnsHelp}>
							<CodeBlock code={snippets.returnAddresses} />
						</Section>
					),
				},
				{
					id: 'templates',
					label: D.templates,
					icon: 'mail',
					content: (
						<Section title={D.templates} description={D.templatesHelp}>
							<Card padded={false} className="overflow-hidden">
								<DataTable
									caption={D.templates}
									columns={[
										{ key: 'key', header: D.templateColumns.key, render: (message) => <code>{message.key}</code> },
										{
											key: 'values',
											header: D.templateColumns.values,
											wrap: true,
											render: (message) => (
												<span className="flex flex-wrap gap-1">
													{message.values.map((name) => (
														<Badge key={name} tone="info">{`{${name}}`}</Badge>
													))}
												</span>
											),
										},
									]}
									rows={messages.messages}
									rowKey={(message) => message.key}
									rowLabel={(message) => message.key}
								/>
							</Card>
						</Section>
					),
				},
			]}
		/>
	);
}

/** Accounts' tabs in place of the standard ones (the others are the shared tabs as they are). */
export const TABS = Object.freeze({
	overview: AccountsOverview,
	settings: AccountsSettings,
	connections: AccountsConnections,
	developers: AccountsDevelopers,
});
