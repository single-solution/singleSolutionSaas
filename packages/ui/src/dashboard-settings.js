'use client';
/**
 * The views of the settings tabs, a list of rich rows beside the page (owner 2026-10-21): the section lists of Settings
 * (a row per feature, grouped by category; all of a feature's settings are on its one page, its groups as cards, its
 * lists, then Advanced, all open), Texts (a row per screen or widget, each a table whose text opens in a drawer) and Defaults (both). Each
 * comes as an editor hook (the unsaved edits and the saves) and a function that builds the sections of a
 * {@link SectionsPage} from it; a view says what it is for in the (i) of its page, not in a heading of its own
 * (layout contract R2).
 * @module
 */
import { useState } from 'react';
import { Button } from './Button.js';
import { SaveBar } from './blocks.js';
import { DataTable } from './DataTable.js';
import { SoftBreaks, StatusPill, TextLink } from './display.js';
import { Input } from './fields.js';
import { Drawer } from './overlay.js';
import { SchemaForm } from './SchemaForm.js';
import { ADVANCED_GROUP, shapeOf } from './schema.js';
import { call, fill } from './dashboard-api.js';
import { humanize } from './format.js';
import { Outcome, hasSettings } from './dashboard-parts.js';

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('./dashboard-page.js').Section} Section */
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
 * The row of Settings that holds one setting, for a link that opens it (`?view=settings#catalog`): the feature, whose
 * one page has all its settings (an old address of one of its groups, `#catalog.page-addresses`, opens the feature too).
 * @param {FeatureSettings} feature
 */
export const settingSectionOf = (feature) => feature.key;

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
 *   notice?: SettingsNotice, group?: string, withAdvanced?: boolean, texts: Dashboard['texts'],
 *   portalLink?: PortalLink }} props the `notice` is shown above the cards; `withAdvanced={false}` leaves out the
 *   Advanced section (it is shown apart, last); `portalLink` makes the link of a value the Portal's website settings
 *   give
 */
function FeatureForm({ feature, features, editor, savedSource, notice, group, withAdvanced = true, texts, portalLink }) {
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
			withAdvanced={withAdvanced}
			advancedTexts={{ title: texts.settings.advanced, description: texts.settings.advancedHelp }}
			generateText={texts.settings.generate}
			onReset={(name) => void editor.reset(feature.key, name)}
			onChange={(name, value) => editor.change(feature.key, name, value)}
			before={notice && group === undefined ? notice(feature.key, values, features) : null}
			after={editor.result?.feature === feature.key && group === undefined ? <Outcome result={editor.result.answer} /> : null}
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
 * How a website's Settings draws one feature: the look of its row (`row`: its switch, status, meta, warning, and the
 * (i) text of its page when that says more than the description), `lead` above its page (a notice that a connection
 * does not work), and `off`: the feature is off, so its page is only `lead` (its description and what to do to switch
 * it on) and none of its settings or lists is drawn.
 * @typedef {{ row?: Partial<Section>, lead?: ReactNode, off?: boolean }} FeatureLook
 */

/**
 * The sections of the features' settings: one row per feature (listed under its category chip). All of a feature's
 * settings are on its one page, open: a card for each group, then the lists of its own as parts under their headings,
 * and Advanced last. The Owner's defaults list the features that have settings; a website's Settings (`look`) lists
 * them all, each as `look` draws it.
 * @param {{ features: FeatureSettings[], editor: SettingsEditor, savedSource: string, dash: Dashboard,
 *   notice?: SettingsNotice, extras?: Record<string, FeatureExtra>, portalLink?: PortalLink,
 *   look?: (feature: FeatureSettings) => FeatureLook }} options
 *   `portalLink`: the address of a section of the website's Website settings in the Portal; with it a setting that
 *   starts from them (`x-ui.defaultFrom`) says so and links there (not on the Owner's global defaults)
 * @returns {Section[]}
 */
export function featureSections({ features, editor, savedSource, dash, notice, extras = {}, portalLink, look }) {
	const { texts } = dash;
	const S = texts.settings;
	const shown = look ? features : features.filter((feature) => hasSettings(feature) || extras[feature.key] !== undefined);
	const byKey = new Map(shown.map((feature) => [feature.key, feature]));
	return dash.byCategory(shown.map((feature) => feature.key)).flatMap((category) =>
		category.keys.flatMap((key) => {
			const feature = /** @type {FeatureSettings} */ (byKey.get(key));
			const own = look?.(feature) ?? {};
			// a feature that is off has no settings page: only what it says about itself
			const extra = own.off ? undefined : extras[key];
			const description = dash.describe(key);
			const viewId = `${key}.${slug(S.settingsView)}`;
			/** @param {string} [group] @param {boolean} [withAdvanced] */
			const formOf = (group, withAdvanced) => (
				<FeatureForm
					feature={feature}
					features={features}
					editor={editor}
					savedSource={savedSource}
					texts={texts}
					{...(group !== undefined ? { group } : {})}
					{...(withAdvanced === false ? { withAdvanced } : {})}
					{...(portalLink ? { portalLink } : {})}
					{...(notice ? { notice } : {})}
				/>
			);
			const shape = hasSettings(feature) && !own.off ? shapeOf(feature.schema) : { groups: [], advanced: false };
			const node = extra !== undefined && !hasItems(extra) ? extra : null;
			// Advanced is the last part of the page, after the lists (a form of only Advanced settings draws it itself)
			const split = shape.groups.length > 0 && shape.advanced;
			/** @type {Section[]} */
			const views = [];
			/** @type {Section[]} */
			const beside = [];
			if (own.off) views.push({ id: viewId, label: S.settingsView, content: own.lead });
			else {
				if (shape.groups.length > 0 || shape.advanced || node !== null)
					views.push({
						id: viewId,
						label: S.settingsView,
						content: (
							<>
								{shape.groups.length > 0 || shape.advanced ? formOf(undefined, !split) : null}
								{node}
							</>
						),
					});
				if (hasItems(extra))
					for (const item of extra.items)
						(item.top ? beside : views).push({
							id: `${key}.${item.id}`,
							label: item.label,
							...(item.top ? { group: category.title } : {}),
							content: item.content,
						});
				if (split) views.push({ id: `${key}.${slug(S.advanced)}`, label: S.advanced, content: formOf(ADVANCED_GROUP) });
				// a website's feature that is on but has nothing to set still has its page
				if (views.length === 0 && look)
					views.push({ id: viewId, label: S.settingsView, content: <p className="text-sm text-muted">{S.none}</p> });
				const first = views[0];
				if (own.lead && first)
					views[0] = {
						...first,
						content: (
							<>
								{own.lead}
								{first.content}
							</>
						),
					};
			}
			if (views.length === 0) return beside;
			const row = {
				id: key,
				label: feature.name,
				group: category.title,
				...(own.off ? {} : { info: description }),
				...own.row,
			};
			const only = views.length === 1 ? views[0] : undefined;
			return [only ? { ...only, ...row } : { ...row, children: views }, ...beside];
		}),
	);
}

/* ---------------------------------------------------------------------------------------------------------- texts */

/** The edits without one text. @param {Record<string, string>} all @param {string} key */
const without = (all, key) => Object.fromEntries(Object.entries(all).filter(([name]) => name !== key));

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
		/** Saves the edited words of a text; whether it worked. @param {string} key */
		save: async (key) => {
			const answer = await call('PUT', saveUrl(key), { value: edits[key] });
			setResult({ key, answer });
			if (answer.ok) setEdits((all) => without(all, key));
			reload();
			return answer.ok;
		},
		/** Sets a text back to the default; whether it worked. @param {string} key */
		reset: async (key) => {
			const answer = resetBody ? await call('PUT', saveUrl(key), { value: null }) : await call('DELETE', saveUrl(key));
			setResult({ key, answer });
			if (answer.ok) setEdits((all) => without(all, key));
			reload();
			return answer.ok;
		},
		/** Forgets the unsaved words of a text and its last outcome. @param {string} key */
		discard: (key) => {
			setEdits((all) => without(all, key));
			setResult((last) => (last?.key === key ? null : last));
		},
	};
}

/** @typedef {ReturnType<typeof useTextsEditor>} TextsEditor */
/** @typedef {{ key: string, english: string, value: string, source: string }} WidgetText */

/**
 * A table of widget texts (layout contract R5: a list is a table, a record is edited in a drawer): the key, the English
 * words, what is shown now and whether it was changed here. A click on a row opens the text in a drawer with a box for
 * the words and Save (Reset to default when the text was changed here, Cancel); a text that saved closes the drawer, a
 * refused one stays open with what was typed. Drawn in a flush page body.
 * @param {{ items: WidgetText[], editor: TextsEditor, savedSource: string, texts: Dashboard['texts'], caption: string,
 *   empty?: string }} props `caption`: what the table lists, for screen readers; `empty`: what it says with no rows
 */
export function TextsTable({ items, editor, savedSource, texts, caption, empty }) {
	const T = texts.texts;
	const [opened, setOpened] = useState(/** @type {WidgetText | null} */ (null));
	const key = opened?.key ?? '';
	const edited = opened ? editor.edits[key] : undefined;
	const close = () => {
		if (opened) editor.discard(opened.key);
		setOpened(null);
	};
	/** Runs a write on the open text and closes the drawer when it worked. @param {(key: string) => Promise<boolean>} run */
	const finish = async (run) => {
		if (await run(key)) close();
	};
	/** @type {import('./DataTable.js').DataColumn<WidgetText>[]} */
	const columns = [
		{ key: 'key', header: T.columns.key, sortable: true, render: (text) => <SoftBreaks text={text.key} /> },
		{ key: 'english', header: T.columns.english, low: true, wrap: true, className: 'min-w-48 max-w-sm text-muted' },
		{ key: 'value', header: T.columns.shown, wrap: true, className: 'min-w-48 max-w-sm' },
		{
			key: 'status',
			header: T.columns.status,
			kind: 'status',
			render: (text) => (text.source === savedSource ? <StatusPill status="info">{T.edited}</StatusPill> : null),
		},
	];
	return (
		<>
			<DataTable
				caption={caption}
				columns={columns}
				rows={items}
				rowKey={(text) => text.key}
				rowLabel={(text) => text.key}
				onRowClick={setOpened}
				{...(empty ? { empty } : {})}
			/>
			<Drawer
				open={opened !== null}
				onClose={close}
				title={opened ? <SoftBreaks text={opened.key} /> : ''}
				{...(opened ? { description: fill(T.englishWas, { english: opened.english }) } : {})}
				footer={
					<>
						{opened?.source === savedSource ? (
							<Button variant="ghost" onClick={() => finish(editor.reset)}>
								{texts.reset}
							</Button>
						) : null}
						<Button variant="secondary" onClick={close}>
							{texts.cancel}
						</Button>
						<Button disabled={edited === undefined} onClick={() => finish(editor.save)}>
							{texts.save}
						</Button>
					</>
				}>
				{opened ? (
					<>
						<Input
							label={T.yours}
							value={edited ?? opened.value}
							onChange={(event) => editor.change(opened.key, event.target.value)}
						/>
						{editor.result?.key === opened.key ? <Outcome result={editor.result.answer} /> : null}
					</>
				) : null}
			</Drawer>
		</>
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
 * The sidebar sections of the widget texts: a page per screen or widget, a table of its texts, with how many of them
 * were changed as the count in the sidebar and how many there are behind the (i).
 * @param {{ items: WidgetText[], editor: TextsEditor, savedSource: string, dash: Dashboard, group?: string }} options
 * @returns {Section[]}
 */
export function textSections({ items, editor, savedSource, dash, group }) {
	const { texts } = dash;
	const T = texts.texts;
	return textGroups(items).map((entry) => {
		const changed = entry.items.filter((text) => text.source === savedSource).length;
		return {
			id: `text-${entry.id || 'other'}`,
			label: entry.label,
			...(group ? { group } : {}),
			...(changed > 0 ? { badge: changed } : {}),
			flush: true,
			info: (
				<>
					<p>{fill(T.count, { count: entry.items.length })}</p>
					<p>{T.help}</p>
				</>
			),
			content: (
				<TextsTable
					items={entry.items}
					editor={editor}
					savedSource={savedSource}
					texts={texts}
					caption={fill(T.caption, { screen: entry.label })}
				/>
			),
		};
	});
}
