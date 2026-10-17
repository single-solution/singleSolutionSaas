'use client';
/**
 * The inner-sidebar views of the settings tabs (owner 2026-10-16: no long scrolls, one view per screen): the section
 * lists of Settings (a view per feature, grouped by category, with its groups as sub-items when it has many), Texts (a
 * view per screen or widget) and Defaults (both). Each comes as
 * an editor hook (the unsaved edits and the saves) and a function that builds the {@link SectionSpec}s from it.
 * @module
 */
import { useState } from 'react';
import { Button } from './Button.js';
import { Disclosure, SaveBar, SettingList, SettingRow, SettingsCard, ViewTitle } from './blocks.js';
import { Badge, SoftBreaks, TextLink } from './display.js';
import { Input, RadioGroup, SegmentedControl, Switch, TextArea } from './fields.js';
import { ListEditor } from './ListEditor.js';
import { Paged } from './paged.js';
import { SchemaForm } from './SchemaForm.js';
import { call, fill } from './dashboard-api.js';
import { GROUPS_AS_TABS_FROM, fieldsOf, shapeOf } from './schema.js';
import { humanize } from './format.js';
import { Outcome, hasSettings } from './dashboard-parts.js';

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('./blocks.js').SectionSpec} SectionSpec */
/** @typedef {import('./dashboard-parts.js').FeatureSettings} FeatureSettings */
/** @typedef {import('./dashboard-parts.js').SettingsNotice} SettingsNotice */
/** @typedef {import('./dashboard-parts.js').Dashboard} Dashboard */
/** @typedef {import('react').ReactNode} ReactNode */
/** The address of a section of the website's settings in the Portal (`region`). @typedef {(section: string) => string} PortalLink */
/**
 * What a product adds to a feature's view: a node shown under the feature's settings, or `{ items }`, views of their
 * own listed under the feature (a list editor each; with `top` the view is listed beside the feature instead of under
 * it). A node or an item brings its own heading (a `Section`).
 * @typedef {ReactNode | { items: Array<{ id: string, label: ReactNode, content: ReactNode, top?: boolean }> }} FeatureExtra
 */

/** A name as part of an address. @param {string} name */
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/**
 * The sidebar section of Settings that holds one setting, for a link that opens it (`?view=settings#catalog.page-addresses`):
 * the feature's view of the setting's group when the feature shows its groups as views, else the feature (its first view).
 * @param {FeatureSettings} feature
 * @param {string} name the setting
 * @param {string} advancedTitle the name of the Advanced view
 */
export const settingSectionOf = (feature, name, advancedTitle) => {
	const shape = shapeOf(feature.schema);
	const field = fieldsOf(feature.schema).find((entry) => entry.name === name);
	if (!field || shape.groups.length + (shape.advanced ? 1 : 0) < GROUPS_AS_TABS_FROM) return feature.key;
	return `${feature.key}.${slug(field.advanced ? advancedTitle : field.group)}`;
};

/* ------------------------------------------------------------------------------------------------- feature settings */

/**
 * The unsaved edits of the features' settings and their saves: Save writes each edited setting on its own and keeps
 * the edits of what failed; Reset sets a saved value back to the default (`resetBody`: with `PUT { value: null }`
 * instead of `DELETE`).
 * @param {{ saveUrl: (key: string) => string, resetBody: boolean, reload: () => void }} options
 */
export function useSettingsEditor({ saveUrl, resetBody, reload }) {
	const [edits, setEdits] = useState(/** @type {Record<string, Record<string, unknown>>} */ ({}));
	const [result, setResult] = useState(/** @type {{ feature: string, answer: Answer } | null} */ (null));
	const [saving, setSaving] = useState(false);
	const dirty = Object.values(edits).some((entry) => Object.keys(entry).length > 0);
	return {
		edits,
		result,
		saving,
		dirty,
		/** @param {string} feature @param {string} name @param {unknown} value */
		change: (feature, name, value) => setEdits((all) => ({ ...all, [feature]: { ...all[feature], [name]: value } })),
		/** @param {string} feature @param {string} name */
		reset: async (feature, name) => {
			const key = saveUrl(`${feature}.${name}`);
			setResult({ feature, answer: resetBody ? await call('PUT', key, { value: null }) : await call('DELETE', key) });
			reload();
		},
		save: async () => {
			setSaving(true);
			/** @type {{ feature: string, answer: Answer } | null} */
			let outcome = null;
			const left = { ...edits };
			for (const [feature, changed] of Object.entries(edits)) {
				for (const [name, value] of Object.entries(changed)) {
					const answer = await call('PUT', saveUrl(`${feature}.${name}`), { value });
					outcome = { feature, answer };
					if (!answer.ok) break;
				}
				if (outcome && !outcome.answer.ok) break;
				if (Object.keys(changed).length > 0) delete left[feature];
			}
			setSaving(false);
			setResult(outcome);
			setEdits(left);
			reload();
		},
		discard: () => {
			setEdits({});
			setResult(null);
		},
	};
}

/** @typedef {ReturnType<typeof useSettingsEditor>} SettingsEditor */

/**
 * The Save changes bar of an editor, shown only while something changed.
 * @param {{ editor: { dirty: boolean, saving: boolean, save: () => unknown, discard: () => void }, texts: Dashboard['texts'] }} props
 */
export function SettingsBar({ editor, texts }) {
	return (
		<SaveBar
			show={editor.dirty}
			saving={editor.saving}
			onSave={editor.save}
			onDiscard={editor.discard}
			message={texts.settings.unsaved}
			saveLabel={texts.settings.saveChanges}
			discardLabel={texts.settings.discard}
		/>
	);
}

/**
 * One feature's settings (all its groups, or just `group`) with the edits laid over its saved values.
 * @param {{ feature: FeatureSettings, features: FeatureSettings[], editor: SettingsEditor, savedSource: string,
 *   notice?: SettingsNotice, group?: string, texts: Dashboard['texts'], portalLink?: PortalLink }} props the `notice`
 *   is shown above the cards; `portalLink` makes the link of a value the Portal's website settings give
 */
function FeatureForm({ feature, features, editor, savedSource, notice, group, texts, portalLink }) {
	const changed = editor.edits[feature.key] ?? {};
	const values = Object.fromEntries(
		Object.entries(feature.values).map(([name, entry]) => [name, name in changed ? changed[name] : entry.value]),
	);
	const overridden = Object.fromEntries(
		Object.entries(feature.values).map(([name, entry]) => [name, entry.source === savedSource]),
	);
	// a setting that starts from the Portal's website settings (`x-ui.defaultFrom`) says where its value comes from
	const inherited = Object.fromEntries(
		Object.entries(feature.values)
			.filter(([name, entry]) => entry.source === 'portal' && entry.from && !(name in changed) && portalLink)
			.map(([name, entry]) => {
				const from = String(entry.from);
				return [
					name,
					<span key={name} data-inherited={from} className="block">
						{fill(texts.settings.inherited, { what: humanize(from.split('.').pop() ?? from).toLowerCase() })}{' '}
						<TextLink href={/** @type {PortalLink} */ (portalLink)(from.split('.')[0] ?? '')} external>
							{texts.settings.inheritedLink}
						</TextLink>
					</span>,
				];
			}),
	);
	return (
		<SchemaForm
			schema={feature.schema}
			values={values}
			overridden={overridden}
			inherited={inherited}
			tabs={false}
			{...(group !== undefined ? { group } : {})}
			advancedTexts={{ title: texts.settings.advanced, description: texts.settings.advancedHelp }}
			generateText={texts.settings.generate}
			onReset={(name) => void editor.reset(feature.key, name)}
			onChange={(name, value) => editor.change(feature.key, name, value)}
			before={notice ? notice(feature.key, values, features) : null}
			after={editor.result?.feature === feature.key ? <Outcome result={editor.result.answer} /> : null}
		/>
	);
}

/**
 * Whether a value is the `{ items }` form of a {@link FeatureExtra}.
 * @param {unknown} extra
 * @returns {extra is { items: Array<{ id: string, label: ReactNode, content: ReactNode, top?: boolean }> }}
 */
const hasItems = (extra) =>
	typeof extra === 'object' && extra !== null && !('$$typeof' in extra) && 'items' in extra && Array.isArray(extra.items);

/**
 * The sidebar sections of the features' settings: one item per feature (listed under its category), with sub-items
 * when the feature has many groups of settings or lists of its own. A website's page hides the features that are off
 * or whose needs are off (`hideOff`); the Owner's defaults show them all.
 * @param {{ features: FeatureSettings[], editor: SettingsEditor, savedSource: string, dash: Dashboard,
 *   hideOff?: boolean, notice?: SettingsNotice, extras?: Record<string, FeatureExtra>, portalLink?: PortalLink }} options
 *   `portalLink`: the address of a section of the website's Website settings in the Portal; with it a setting that
 *   starts from them (`x-ui.defaultFrom`) says so and links there (not on the Owner's global defaults)
 * @returns {SectionSpec[]}
 */
export function featureSections({ features, editor, savedSource, dash, hideOff = false, notice, extras = {}, portalLink }) {
	const { texts } = dash;
	const S = texts.settings;
	const on = new Set(features.filter((feature) => feature.on !== false).map((feature) => feature.key));
	const shown = features.filter((feature) => {
		if (hideOff && (feature.on === false || dash.needsOf(feature.key).some((key) => !on.has(key)))) return false;
		return hasSettings(feature) || extras[feature.key] !== undefined;
	});
	const byKey = new Map(shown.map((feature) => [feature.key, feature]));
	return dash.byCategory(shown.map((feature) => feature.key)).flatMap((category) =>
		category.keys.flatMap((key) => {
			const feature = /** @type {FeatureSettings} */ (byKey.get(key));
			const extra = extras[key];
			const shape = shapeOf(feature.schema);
			const names = [...shape.groups, ...(shape.advanced ? [S.advanced] : [])];
			const split = names.length >= GROUPS_AS_TABS_FROM;
			// the notice sits above the first view of a feature that has several
			const form = (/** @type {string | undefined} */ group, /** @type {boolean} */ first = true) => (
				<FeatureForm
					feature={feature}
					features={features}
					editor={editor}
					savedSource={savedSource}
					texts={texts}
					{...(portalLink ? { portalLink } : {})}
					{...(notice && first ? { notice } : {})}
					{...(group !== undefined ? { group } : {})}
				/>
			);
			const description = dash.describe(key);
			/** @type {SectionSpec[]} */
			const views = [];
			if (hasSettings(feature)) {
				if (split)
					names.forEach((name, index) => {
						const advanced = shape.advanced && index === names.length - 1;
						views.push({
							id: `${key}.${slug(name)}`,
							label: name,
							content: (
								<>
									<ViewTitle title={feature.name} description={name} />
									{form(advanced ? 'Advanced' : name, index === 0)}
									{index === names.length - 1 && extra !== undefined && !hasItems(extra) ? extra : null}
								</>
							),
						});
					});
				else
					views.push({
						id: `${key}.${slug(S.settingsView)}`,
						label: S.settingsView,
						content: (
							<>
								<ViewTitle title={feature.name} description={description} />
								{form(undefined)}
								{extra !== undefined && !hasItems(extra) ? extra : null}
							</>
						),
					});
			} else if (extra !== undefined && !hasItems(extra))
				views.push({ id: `${key}.${slug(S.settingsView)}`, label: S.settingsView, content: extra });
			/** @type {SectionSpec[]} */
			const beside = [];
			if (hasItems(extra))
				for (const item of extra.items)
					(item.top ? beside : views).push({
						id: `${key}.${item.id}`,
						label: item.label,
						...(item.top ? { group: category.title } : {}),
						content: item.content,
					});
			const only = views.length === 1 ? views[0] : undefined;
			return [
				...(views.length === 0
					? []
					: [
							only
								? { ...only, id: key, label: feature.name, group: category.title }
								: { id: key, label: feature.name, group: category.title, children: views },
						]),
				...beside,
			];
		}),
	);
}

/* ---------------------------------------------------------------------------------------------------------- texts */

/**
 * The widget texts' unsaved edits and their saves: each text saves on its own; one saved here gets a Reset.
 * @param {{ saveUrl: (key: string) => string, resetBody: boolean, reload: () => void }} options
 */
export function useTextsEditor({ saveUrl, resetBody, reload }) {
	const [edits, setEdits] = useState(/** @type {Record<string, string>} */ ({}));
	const [result, setResult] = useState(/** @type {{ key: string, answer: Answer } | null} */ (null));
	return {
		edits,
		result,
		/** @param {string} key @param {string} value */
		change: (key, value) => setEdits((all) => ({ ...all, [key]: value })),
		/** @param {string} key */
		save: async (key) => {
			const answer = await call('PUT', saveUrl(key), { value: edits[key] });
			setResult({ key, answer });
			if (answer.ok) setEdits((all) => Object.fromEntries(Object.entries(all).filter(([name]) => name !== key)));
			reload();
		},
		/** @param {string} key */
		reset: async (key) => {
			setResult({
				key,
				answer: resetBody ? await call('PUT', saveUrl(key), { value: null }) : await call('DELETE', saveUrl(key)),
			});
			reload();
		},
	};
}

/** @typedef {ReturnType<typeof useTextsEditor>} TextsEditor */
/** @typedef {{ key: string, english: string, value: string, source: string }} WidgetText */

/**
 * The text rows of a list of widget texts: the key and the English words on the left, the box to change them and Save
 * (and Reset when the text was changed here) on the right.
 * @param {{ items: WidgetText[], editor: TextsEditor, savedSource: string, texts: Dashboard['texts'] }} props
 */
function TextRows({ items, editor, savedSource, texts }) {
	return (
		<SettingList>
			{items.map((text) => {
				const englishId = `text-${text.key.replace(/[^\w-]/g, '-')}-english`;
				return (
					<SettingRow
						key={text.key}
						label={<SoftBreaks text={text.key} />}
						description={<span id={englishId}>{text.english}</span>}>
						<Input
							hideLabel
							label={<SoftBreaks text={text.key} />}
							aria-describedby={englishId}
							value={editor.edits[text.key] ?? text.value}
							onChange={(event) => editor.change(text.key, event.target.value)}
						/>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" disabled={editor.edits[text.key] === undefined} onClick={() => editor.save(text.key)}>
								{texts.save}
							</Button>
							{text.source === savedSource ? (
								<Button size="sm" variant="ghost" onClick={() => editor.reset(text.key)}>
									{texts.reset}
								</Button>
							) : null}
						</div>
						{editor.result?.key === text.key ? <Outcome result={editor.result.answer} /> : null}
					</SettingRow>
				);
			})}
		</SettingList>
	);
}

/**
 * A paged, searchable list of widget texts in one card.
 * @param {{ items: WidgetText[], editor: TextsEditor, savedSource: string, texts: Dashboard['texts'], title?: ReactNode,
 *   description?: ReactNode, searchable?: boolean }} props
 */
export function TextsCard({ items, editor, savedSource, texts, title, description, searchable = true }) {
	return (
		<SettingsCard wide {...(title ? { title } : {})} {...(description ? { description } : {})}>
			<Paged
				items={items}
				pageSize={8}
				searchFrom={searchable ? 9 : Infinity}
				label={texts.texts.search}
				texts={{ none: texts.texts.none }}
				text={(text) => `${text.key} ${text.english} ${text.value}`}>
				{(page) => <TextRows items={page} editor={editor} savedSource={savedSource} texts={texts} />}
			</Paged>
		</SettingsCard>
	);
}

/**
 * The widget texts by screen or widget (the part of a key before its first dot), in the order they first appear.
 * @param {WidgetText[]} items
 * @returns {Array<{ id: string, label: string, items: WidgetText[] }>}
 */
export const textGroups = (items) => {
	/** @type {Map<string, WidgetText[]>} */
	const groups = new Map();
	for (const item of items) {
		const id = item.key.includes('.') ? (item.key.split('.')[0] ?? '') : '';
		groups.set(id, [...(groups.get(id) ?? []), item]);
	}
	return [...groups].map(([id, list]) => ({ id, label: id ? humanize(id) : 'Other', items: list }));
};

/**
 * The sidebar sections of the widget texts: a view per screen or widget, with how many of its texts were changed.
 * @param {{ items: WidgetText[], editor: TextsEditor, savedSource: string, dash: Dashboard, group?: string }} options
 * @returns {SectionSpec[]}
 */
export function textSections({ items, editor, savedSource, dash, group }) {
	const { texts } = dash;
	return textGroups(items).map((entry) => {
		const changed = entry.items.filter((text) => text.source === savedSource).length;
		return {
			id: `text-${entry.id || 'other'}`,
			label: entry.label,
			...(group ? { group } : {}),
			...(changed > 0
				? {
						badge: <Badge tone="primary">{changed}</Badge>,
					}
				: {}),
			content: (
				<>
					<ViewTitle title={entry.label} description={fill(texts.texts.count, { count: entry.items.length })} />
					<TextsCard items={entry.items} editor={editor} savedSource={savedSource} texts={texts} />
				</>
			),
		};
	});
}
