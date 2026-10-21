'use client';
/**
 * The views of the settings tabs, a list of rich rows beside the page (owner 2026-10-21): the section lists of Settings
 * (a row per feature, grouped by category; all of a feature's settings are on its one page, its groups as cards, its
 * lists, then Advanced, all open), Texts (a row per screen or widget, "{n} texts · {m} changed"; its page is every text as a
 * field in place, label the English words, help where it shows, Reset to default when changed) and Defaults (both). Each
 * comes as an editor hook (the unsaved edits and the saves; both collect every edit into the page's ONE save bar,
 * {@link SettingsBar}) and a function that builds the sections of a {@link SectionsPage} from it; a view says what it
 * is for in the (i) of its page, not in a heading of its own (layout contract R2).
 * @module
 */
import { useState } from 'react';
import { SaveBar, SettingList, SettingsCard } from './blocks.js';
import { EmptyState, TextLink } from './display.js';
import { Input, TextArea } from './fields.js';
import { SchemaForm } from './SchemaForm.js';
import { ADVANCED_GROUP, shapeOf } from './schema.js';
import { call, fill } from './dashboard-api.js';
import { humanize } from './format.js';
import { describeProblem, problemCode } from './problems.js';
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
 * Why a text was refused, for under its field: the server's own words when it refused the words (a lost
 * `{placeholder}`, a text too long), else the friendly sentence of the problem.
 * @param {Parameters<typeof describeProblem>[0]} problem
 */
const reasonOf = (problem) => {
	const detail = typeof problem?.detail === 'string' ? problem.detail.trim() : '';
	return detail && problemCode(problem) === 'validation_failed' ? detail : describeProblem(problem);
};

/**
 * The widget texts' unsaved edits and their saves, like {@link useSettingsEditor}: the edits of every text, on any
 * screen, wait for the page's one Save bar; Save writes each edited text on its own, keeps the edit of a text that was
 * refused and says why under that text (`errors`); Reset sets a saved text back to the default at once.
 * @param {{ saveUrl: (key: string) => string, resetBody: boolean, reload: () => void }} options
 */
export function useTextsEditor({ saveUrl, resetBody, reload }) {
	const [edits, setEdits] = useState(/** @type {Record<string, string>} */ ({}));
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [result, setResult] = useState(/** @type {Answer | null} */ (null));
	const [saving, setSaving] = useState(false);
	return {
		edits,
		errors,
		result,
		saving,
		dirty: Object.keys(edits).length > 0,
		/**
		 * Sets the words of a text; the saved words (`saved`) are no edit.
		 * @param {string} key @param {string} value @param {string} [saved]
		 */
		change: (key, value, saved) => {
			setEdits((all) => (value === saved ? without(all, key) : { ...all, [key]: value }));
			setErrors((all) => without(all, key));
		},
		/** Sets a text back to the default. @param {string} key */
		reset: async (key) => {
			const answer = resetBody ? await call('PUT', saveUrl(key), { value: null }) : await call('DELETE', saveUrl(key));
			setResult(answer);
			if (answer.ok) {
				setEdits((all) => without(all, key));
				setErrors((all) => without(all, key));
			}
			reload();
		},
		/** Saves every edited text; the ones that were refused stay edited, each with its reason. */
		save: async () => {
			setSaving(true);
			/** @type {Answer | null} */
			let outcome = null;
			/** @type {Record<string, string>} */
			const left = {};
			/** @type {Record<string, string>} */
			const refused = {};
			for (const [key, value] of Object.entries(edits)) {
				const answer = await call('PUT', saveUrl(key), { value });
				if (answer.ok) outcome ??= answer;
				else {
					outcome = answer;
					left[key] = value;
					refused[key] = reasonOf(answer.problem);
				}
			}
			setSaving(false);
			setResult(outcome);
			setEdits(left);
			setErrors(refused);
			reload();
		},
		discard: () => {
			setEdits({});
			setErrors({});
			setResult(null);
		},
	};
}

/** @typedef {ReturnType<typeof useTextsEditor>} TextsEditor */
/** @typedef {{ key: string, english: string, value: string, source: string }} WidgetText */

/**
 * Whether a text was changed: it is the website's own (`savedSource`), or what it says is not the English default (a
 * global default the Owner set is a change too).
 * @param {WidgetText} text @param {string} savedSource
 */
export const isChanged = (text, savedSource) => text.source === savedSource || text.value !== text.english;

/** A text longer than this (or in lines) is edited in a multi-line box. */
const LONG_TEXT = 80;

/**
 * Where a text shows, from its key: its parts as words (`grid.sort.price_asc` is "Grid › Sort › Price asc").
 * @param {string} key
 */
const whereOf = (key) => key.split('.').map(humanize).join(' › ');

/** The Reset link beside a changed text (the look of the one in {@link SchemaForm}). @param {{ onClick: () => void, children: ReactNode }} props */
function ResetLink({ onClick, children }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="rounded text-help font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus">
			{children}
		</button>
	);
}

/**
 * Widget texts as fields in place (layout contract R5: a record is edited where it is shown; the page's one Save bar
 * keeps the edits): a setting row for each text, its label the English words and its help where it shows (from its
 * key), a box for the words shown now (a multi-line one for a long text) and Reset to default beside the label of a text
 * that was changed here. A text the server refused says why under its box. Drawn in one card; with no texts, `empty`
 * says so.
 * @param {{ items: WidgetText[], editor: TextsEditor, savedSource: string, texts: Dashboard['texts'], empty?: string }} props
 */
export function TextFields({ items, editor, savedSource, texts, empty }) {
	const T = texts.texts;
	if (items.length === 0) return empty ? <EmptyState icon="search" title={empty} /> : null;
	return (
		<SettingsCard wide>
			<SettingList>
				{items.map((text) => {
					const Control =
						text.english.length > LONG_TEXT || text.value.length > LONG_TEXT || /\n/.test(text.english) ? TextArea : Input;
					const error = editor.errors[text.key];
					return (
						<Control
							key={text.key}
							name={text.key}
							label={text.english}
							help={fill(T.where, { where: whereOf(text.key) })}
							value={editor.edits[text.key] ?? text.value}
							onChange={(event) => editor.change(text.key, event.target.value, text.value)}
							{...(error ? { error } : {})}
							{...(text.source === savedSource
								? { aside: <ResetLink onClick={() => void editor.reset(text.key)}>{texts.reset}</ResetLink> }
								: {})}
						/>
					);
				})}
			</SettingList>
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
 * The rows of the widget texts: a row per screen or widget ("{n} texts · {m} changed" under its name) whose page is
 * all its texts as fields, open to edit.
 * @param {{ items: WidgetText[], editor: TextsEditor, savedSource: string, dash: Dashboard, group?: string }} options
 * @returns {Section[]}
 */
export function textSections({ items, editor, savedSource, dash, group }) {
	const { texts } = dash;
	const T = texts.texts;
	return textGroups(items).map((entry) => ({
		id: `text-${entry.id || 'other'}`,
		label: entry.label,
		...(group ? { group } : {}),
		meta: [
			entry.items.length === 1 ? T.countOne : fill(T.count, { count: entry.items.length }),
			fill(T.changed, { count: entry.items.filter((text) => isChanged(text, savedSource)).length }),
		],
		info: T.help,
		content: <TextFields items={entry.items} editor={editor} savedSource={savedSource} texts={texts} />,
	}));
}
