'use client';
/**
 * Settings → Consents (A2): the merchant's consent list, in their order: each consent has the merchant's words next to
 * the box, a page to read, a version, required or not, and a purpose (an agreement such as the terms or a privacy
 * policy, or marketing, which is kept apart and never required). The terms consent is there from the start. The list
 * lives in the merchant database, so it needs it connected, and merchants edit it only while Consents is on. The consents
 * are rich rows (`record-section.js`); a click on a row opens its fields in place.
 * @module
 */
import { Checkbox, Input, Select } from '@ss/ui';
import { RecordSection } from './record-section.js';
import { TEXTS } from './texts.js';

/** @typedef {'agreement' | 'marketing'} Purpose */
/** @typedef {{ key: string, label: string, url: string, version: string, required: boolean, purpose: Purpose }} Consent */
/** A consent being edited, `isNew` while its key can still change. @typedef {Consent & { isNew: boolean }} Draft */

const PURPOSES = /** @type {const} */ (['agreement', 'marketing']);
/** @type {Draft} */
const EMPTY = { key: '', label: '', url: '', version: '1', required: false, purpose: 'agreement', isNew: true };
const T = TEXTS.settings.consent;

/**
 * A consent as a row: an icon for its purpose, the words next to the box, a dot while it is required, the purpose and key,
 * and the version.
 * @param {Consent} item
 */
const rowOf = (item) => ({
	lead: {
		icon: /** @type {import('@ss/ui').IconName} */ (item.purpose === 'marketing' ? 'mail' : 'shield'),
		tone: /** @type {const} */ ('primary'),
	},
	title: item.label,
	...(item.required ? { status: { tone: /** @type {const} */ ('accent'), label: T.required_badge } } : {}),
	meta: [TEXTS.settings.consentPurposes[item.purpose], item.key],
	value: `${T.columns.version} ${item.version}`,
});

/** @param {{ websiteId: string }} props */
export function ConsentsSection({ websiteId }) {
	return (
		<RecordSection
			base={`/v1/dashboard/websites/${websiteId}/consents`}
			title={TEXTS.settings.consentsTitle}
			description={TEXTS.settings.consentsHelp}
			icon="shield"
			texts={T}
			blank={EMPTY}
			draftOf={(/** @type {Consent} */ item) => ({ ...item, isNew: false })}
			bodyOf={(draft) => ({
				label: draft.label.trim(),
				url: draft.url.trim(),
				version: draft.version.trim(),
				required: draft.purpose === 'agreement' && draft.required,
				purpose: draft.purpose,
			})}
			ready={(draft) => draft.key !== '' && draft.label.trim() !== '' && draft.version.trim() !== ''}
			rowOf={rowOf}
			fields={(draft, edit) => (
				<>
					<Input
						label={T.key}
						value={draft.key}
						maxLength={40}
						disabled={!draft.isNew}
						autoComplete="off"
						onChange={(event) => edit({ key: event.target.value.trim() })}
					/>
					<Input
						label={T.label}
						value={draft.label}
						maxLength={200}
						onChange={(event) => edit({ label: event.target.value })}
					/>
					<Input
						label={T.url}
						type="url"
						value={draft.url}
						maxLength={2048}
						onChange={(event) => edit({ url: event.target.value })}
					/>
					<Input
						label={T.version}
						value={draft.version}
						maxLength={40}
						onChange={(event) => edit({ version: event.target.value })}
					/>
					<Select
						label={T.purpose}
						value={draft.purpose}
						options={PURPOSES.map((value) => ({ value, label: TEXTS.settings.consentPurposes[value] }))}
						onChange={(event) => edit({ purpose: /** @type {Purpose} */ (event.target.value) })}
					/>
					{draft.purpose === 'agreement' ? (
						<Checkbox
							label={T.required}
							checked={draft.required}
							onChange={(event) => edit({ required: event.target.checked })}
						/>
					) : null}
				</>
			)}
		/>
	);
}
