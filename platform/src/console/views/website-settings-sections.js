'use client';
/**
 * The five sections of Website settings, each a form on the shared components: Business, Brand and look, Region and
 * format, Domains, pages and legal, Team and alerts. A section is one `SettingsCard` per group of settings; nested
 * things (the address, the opening hours, the currency symbols, the region names, a document, a person) are edited in a
 * right drawer whose changes go into the section's draft, which the floating Save bar saves whole. Every word comes from
 * `texts/console.js`; the Portal checks every value again.
 * @module
 */
import { createElement, useEffect, useMemo, useState } from 'react';
import { addressLines, countryChoices } from '@ss/contracts/address';
import { formatDate, formatMoney } from '@ss/contracts/format';
import { callingCodeOf } from '@ss/contracts/phone';
import { ADDRESS_REQUIRED_PARTS, WEBSITE_UNITS } from '@ss/contracts/website-settings';
import {
	ActionMenu,
	Button,
	CheckboxGroup,
	ChoicePicker,
	Drawer,
	EmptyState,
	Icon,
	IconButton,
	Input,
	ListEditor,
	Row,
	SegmentedControl,
	Select,
	SettingList,
	SettingRow,
	SettingsCard,
	Switch,
	SuggestInput,
	TextArea,
} from '@ss/ui';
import { WEBSITE_SETTINGS as T } from '../../texts/console.js';
import { SectionForm, SummaryRow, useSectionForm } from './website-settings-form.js';

/** @typedef {import('@ss/contracts').WebsiteSettings} WebsiteSettings */
/**
 * What a section needs from the page: the saved document, who we are, and how to hand a save back.
 * @typedef {object} SectionProps
 * @property {WebsiteSettings} settings
 * @property {{ merchantId: string, websiteId: string }} manage
 * @property {boolean} canWrite
 * @property {boolean} stale a save found the settings changed by someone else
 * @property {(answer: { settings: WebsiteSettings, readiness: any[] }) => void} onSaved
 * @property {() => void} onStale
 * @property {() => void} onReload
 */

/** @param {SectionProps} props @param {'business' | 'brand' | 'region' | 'pages' | 'team'} section */
const useForm = (props, section) =>
	useSectionForm({
		manage: props.manage,
		section,
		saved: /** @type {Record<string, any>} */ (props.settings[section]),
		version: props.settings.version,
		onSaved: props.onSaved,
		onStale: props.onStale,
	});

/**
 * A control that is a fieldset (a list editor, a picker, a group of choices) as a row of a card: wrapped in a plain row,
 * so the hairline between the card's rows is drawn above it and not through its legend.
 * @template {(props: any) => any} C
 * @param {C} control
 * @returns {C}
 */
const inRow = (control) =>
	/** @type {C} */ (
		/** @type {unknown} */ ((/** @type {any} */ props) => <div data-cell="">{createElement(control, props)}</div>)
	);
const RowListEditor = inRow(ListEditor);
const RowChoicePicker = inRow(ChoicePicker);
const RowCheckboxGroup = inRow(CheckboxGroup);
const RowSegmentedControl = inRow(SegmentedControl);

/** @param {import('react').ChangeEvent<any>} event */
const valueOf = (event) => event.currentTarget.value;

// ---------------------------------------------------------------------------------------------------------------
// small editors

/**
 * Time zone and currency names the runtime knows, for suggestions; empty until the page is in the browser (the server
 * and the browser would list different names and disagree on the first render).
 * @param {'timeZone' | 'currency'} key
 */
const useKnownValues = (key) => {
	const [values, setValues] = useState(/** @type {string[]} */ ([]));
	useEffect(() => {
		try {
			setValues(/** @type {any} */ (Intl).supportedValuesOf(key));
		} catch {
			setValues([]);
		}
	}, [key]);
	return values;
};

/**
 * Rows of a map (`{ name: value }`) edited as an ordered list, so a row whose name is still empty stays on the screen
 * while it is typed. `onChange` gets the map without the unnamed rows.
 * @param {Record<string, string>} map
 * @param {(next: Record<string, string>) => void} onChange
 * @returns {[Array<[string, string]>, (next: Array<[string, string]>) => void]}
 */
const useMapRows = (map, onChange) => {
	const [rows, setRows] = useState(() => /** @type {Array<[string, string]>} */ (Object.entries(map)));
	const flat = JSON.stringify(map);
	useEffect(() => {
		// the map changed from outside (Discard, a save): start again from it
		if (JSON.stringify(Object.fromEntries(rows.filter(([name]) => name !== ''))) !== flat) setRows(Object.entries(map));
	}, [flat]);
	/** @param {Array<[string, string]>} next */
	const set = (next) => {
		setRows(next);
		onChange(Object.fromEntries(next.filter(([name]) => name !== '')));
	};
	return [rows, set];
};

/**
 * A text area of lines for a list of texts (one per line); a blank line stays while it is typed.
 * @param {{ label: string, help?: string, value: string[], onChange: (next: string[]) => void, error?: string | undefined }} props
 */
function LinesField({ label, help, value, onChange, error }) {
	const [text, setText] = useState(value.join('\n'));
	const flat = JSON.stringify(value);
	useEffect(() => {
		if (JSON.stringify(parseLines(text)) !== flat) setText(value.join('\n'));
	}, [flat]);
	return (
		<TextArea
			label={label}
			{...(help ? { help } : {})}
			{...(error ? { error } : {})}
			rows={5}
			value={text}
			onChange={(event) => {
				setText(valueOf(event));
				onChange(parseLines(valueOf(event)));
			}}
		/>
	);
}

/** @param {string} text @returns {string[]} the non-empty lines, trimmed */
const parseLines = (text) =>
	text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '');

/** A drawer's Done button. @param {{ onClose: () => void }} props */
const Done = ({ onClose }) => <Button onClick={onClose}>{T.done}</Button>;

// ---------------------------------------------------------------------------------------------------------------
// Business

/**
 * The weekly hours in a line: days with the same windows are joined (`Mon–Fri 09:00–17:00 · Sat 10:00–14:00`).
 * @param {WebsiteSettings['business']['hours']} hours
 * @returns {string}
 */
export const hoursSummary = (hours) => {
	const names = T.business.daysShort;
	const perDay = names.map((_name, index) =>
		hours.weekly
			.filter((window) => window.day === index + 1)
			.sort((a, b) => a.start.localeCompare(b.start))
			.map((window) => `${window.start}–${window.end}`)
			.join(', '),
	);
	/** @type {string[]} */
	const parts = [];
	for (let day = 0; day < 7; day += 1) {
		const text = perDay[day] ?? '';
		if (text === '') continue;
		let last = day;
		while (last + 1 < 7 && perDay[last + 1] === text) last += 1;
		parts.push(`${names[day]}${last > day ? `–${names[last]}` : ''} ${text}`);
		day = last;
	}
	const dates = hours.exceptions.length > 0 ? [T.business.exceptionsCount(hours.exceptions.length)] : [];
	return [...parts, ...dates].join(' · ') || T.business.hoursNone;
};

/**
 * The weekly hours and the dates that differ, edited in the hours drawer.
 * @param {{ hours: WebsiteSettings['business']['hours'], onChange: (next: WebsiteSettings['business']['hours']) => void,
 *   error: (path: Array<string | number>) => string | undefined }} props
 */
function HoursEditor({ hours, onChange, error }) {
	const B = T.business;
	return (
		<div className="space-y-6">
			<div className="divide-y divide-line-soft border-y border-line-soft">
				{B.days.map((name, index) => {
					const day = index + 1;
					const rows = hours.weekly.map((window, at) => ({ window, at })).filter(({ window }) => window.day === day);
					return (
						<div key={day} className="space-y-2 py-3">
							<div className="flex items-center justify-between gap-2">
								<span className="text-sm font-medium text-fg">{name}</span>
								<Button
									size="sm"
									variant="ghost"
									aria-label={`${B.addWindow}: ${name}`}
									onClick={() =>
										onChange({ ...hours, weekly: [...hours.weekly, { day, start: '09:00', end: '17:00' }] })
									}>
									<Icon name="plus" size={14} />
									{B.addWindow}
								</Button>
							</div>
							{rows.length === 0 ? <p className="text-help text-muted">{B.closedAllDay}</p> : null}
							{rows.map(({ window, at }) => (
								<div key={at} className="flex items-end gap-2">
									<Input
										type="time"
										label={`${name}: ${B.start}`}
										value={window.start}
										error={error(['hours', 'weekly', at])}
										onChange={(event) =>
											onChange({
												...hours,
												weekly: hours.weekly.map((w, i) => (i === at ? { ...w, start: valueOf(event) } : w)),
											})
										}
									/>
									<Input
										type="time"
										label={`${name}: ${B.end}`}
										value={window.end}
										onChange={(event) =>
											onChange({
												...hours,
												weekly: hours.weekly.map((w, i) => (i === at ? { ...w, end: valueOf(event) } : w)),
											})
										}
									/>
									<IconButton
										label={`${T.pages.remove}: ${name} ${window.start}`}
										onClick={() => onChange({ ...hours, weekly: hours.weekly.filter((_w, i) => i !== at) })}>
										<Icon name="close" size={14} />
									</IconButton>
								</div>
							))}
						</div>
					);
				})}
			</div>
			{error(['hours', 'weekly']) ? (
				<p role="alert" className="text-help text-danger">
					{error(['hours', 'weekly'])}
				</p>
			) : null}
			<RowListEditor
				legend={B.hoursExceptions}
				help={B.hoursExceptionsHelp}
				items={hours.exceptions}
				max={200}
				onChange={(next) => onChange({ ...hours, exceptions: next })}
				newItem={() => ({ date: '', name: '', hours: [] })}
				nameOf={(item, index) => item.name || item.date || String(index + 1)}
				texts={{ add: B.addException }}
				renderItem={(item, index, update) => {
					const window = item.hours[0];
					return (
						<>
							<Input
								type="date"
								label={B.date}
								value={item.date}
								error={error(['hours', 'exceptions', index, 'date'])}
								onChange={(event) => update({ ...item, date: valueOf(event) })}
							/>
							<Input
								label={B.dateName}
								value={item.name}
								onChange={(event) => update({ ...item, name: valueOf(event) })}
							/>
							<div className="space-y-2">
								<Switch
									checked={item.hours.length === 0}
									label={B.closedAllDay}
									onChange={(closed) => update({ ...item, hours: closed ? [] : [{ start: '09:00', end: '17:00' }] })}
								/>
								{window ? (
									<div className="flex items-end gap-2">
										<Input
											type="time"
											label={B.start}
											value={window.start}
											onChange={(event) =>
												update({ ...item, hours: [{ ...window, start: valueOf(event) }, ...item.hours.slice(1)] })
											}
										/>
										<Input
											type="time"
											label={B.end}
											value={window.end}
											onChange={(event) =>
												update({ ...item, hours: [{ ...window, end: valueOf(event) }, ...item.hours.slice(1)] })
											}
										/>
									</div>
								) : null}
							</div>
						</>
					);
				}}
			/>
		</div>
	);
}

/** @param {SectionProps} props */
export function BusinessSection(props) {
	const form = useForm(props, 'business');
	const [drawer, setDrawer] = useState(/** @type {null | 'address' | 'hours'} */ (null));
	const B = T.business;
	const d = /** @type {WebsiteSettings['business']} */ (form.draft);
	const countries = useMemo(() => countryChoices(), []);
	/** @param {keyof WebsiteSettings['business']} field @param {string} label @param {string} [help] @param {Record<string, unknown>} [extra] */
	const text = (field, label, help, extra = {}) => (
		<Input
			label={label}
			{...(help ? { help } : {})}
			value={String(d[field] ?? '')}
			error={form.error([field])}
			onChange={(event) => form.change([field], valueOf(event))}
			{...extra}
		/>
	);
	const addressText = addressLines(d.address, d.address.country).join(', ');
	return (
		<SectionForm form={form} canWrite={props.canWrite} stale={props.stale} onReload={props.onReload}>
			<SettingsCard title={B.identityTitle} description={B.identityHelp}>
				<SettingList>
					{text('name', B.name, B.nameHelp, { required: true, maxLength: 200 })}
					{text('tagline', B.tagline, B.taglineHelp, { maxLength: 200 })}
					<RowListEditor
						legend={B.otherNames}
						help={B.otherNamesHelp}
						items={d.otherNames}
						max={10}
						onChange={(next) => form.change(['otherNames'], next)}
						newItem={() => ''}
						nameOf={(item, index) => item || String(index + 1)}
						renderItem={(item, index, update) => (
							<Input
								label={B.otherName}
								value={item}
								error={form.error(['otherNames', index])}
								onChange={(event) => update(valueOf(event))}
							/>
						)}
					/>
				</SettingList>
			</SettingsCard>
			<SettingsCard title={B.legalTitle} description={B.legalHelp}>
				<SettingList>
					{text('legalName', B.legalName, undefined, { maxLength: 200 })}
					{text('taxNumber', B.taxNumber, undefined, { maxLength: 60 })}
					{text('businessType', B.businessType, B.businessTypeHelp, { maxLength: 60 })}
				</SettingList>
			</SettingsCard>
			<SettingsCard title={B.contactTitle} description={B.contactHelp}>
				<SettingList>
					{text('email', B.email, undefined, { type: 'email', autoComplete: 'off' })}
					{text('phone', B.phone, undefined, { type: 'tel', autoComplete: 'off' })}
					{text('whatsapp', B.whatsapp, undefined, { type: 'tel', autoComplete: 'off' })}
					<RowListEditor
						legend={B.morePhones}
						help={B.morePhonesHelp}
						items={d.phones}
						max={10}
						onChange={(next) => form.change(['phones'], next)}
						newItem={() => ({ label: '', number: '' })}
						nameOf={(item, index) => item.label || item.number || String(index + 1)}
						renderItem={(item, index, update) => (
							<>
								<Input
									label={B.phoneLabel}
									value={item.label}
									onChange={(event) => update({ ...item, label: valueOf(event) })}
								/>
								<Input
									label={B.phoneNumber}
									type="tel"
									value={item.number}
									error={form.error(['phones', index, 'number'])}
									onChange={(event) => update({ ...item, number: valueOf(event) })}
								/>
							</>
						)}
					/>
				</SettingList>
			</SettingsCard>
			<SettingsCard title={B.addressTitle} description={B.addressHelp}>
				<SettingList>
					<SummaryRow
						label={B.addressRow}
						description={B.addressRowHelp}
						summary={addressText || T.none}
						onEdit={() => setDrawer('address')}
						error={form.error(['address', 'country']) ?? form.error(['address', 'postalCode'])}
					/>
					<SummaryRow
						label={B.hoursRow}
						description={B.hoursHelp}
						summary={hoursSummary(d.hours)}
						onEdit={() => setDrawer('hours')}
						error={form.error(['hours', 'weekly']) ?? form.error(['hours', 'exceptions'])}
					/>
				</SettingList>
			</SettingsCard>
			<SettingsCard title={B.socialTitle} description={B.socialHelp}>
				<SettingList>
					<RowListEditor
						legend={B.social}
						items={d.social}
						max={20}
						onChange={(next) => form.change(['social'], next)}
						newItem={() => ({ label: '', url: 'https://' })}
						nameOf={(item, index) => item.label || String(index + 1)}
						renderItem={(item, index, update) => (
							<>
								<Input
									label={B.socialLabel}
									value={item.label}
									onChange={(event) => update({ ...item, label: valueOf(event) })}
								/>
								<Input
									label={B.socialUrl}
									type="url"
									value={item.url}
									error={form.error(['social', index, 'url'])}
									onChange={(event) => update({ ...item, url: valueOf(event) })}
								/>
							</>
						)}
					/>
				</SettingList>
			</SettingsCard>
			<Drawer
				open={drawer === 'address'}
				onClose={() => setDrawer(null)}
				title={B.addressDrawer}
				description={B.addressDrawerHelp}
				footer={<Done onClose={() => setDrawer(null)} />}>
				<Select
					label={B.country}
					value={d.address.country}
					placeholder={T.none}
					options={countries}
					error={form.error(['address', 'country'])}
					onChange={(event) => form.change(['address', 'country'], valueOf(event))}
				/>
				{['line1', 'line2', 'area', 'city', 'region', 'postalCode'].map((part) => (
					<Input
						key={part}
						label={/** @type {any} */ (B)[part] ?? part}
						value={/** @type {Record<string, string>} */ (d.address)[part] ?? ''}
						error={form.error(['address', part])}
						onChange={(event) => form.change(['address', part], valueOf(event))}
					/>
				))}
			</Drawer>
			<Drawer
				open={drawer === 'hours'}
				onClose={() => setDrawer(null)}
				title={B.hoursDrawer}
				description={B.hoursHelp}
				size="lg"
				footer={<Done onClose={() => setDrawer(null)} />}>
				<HoursEditor hours={d.hours} onChange={(next) => form.change(['hours'], next)} error={form.error} />
			</Drawer>
		</SectionForm>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Brand and look

const PICTURES = /** @type {const} */ ([
	['logo', 'logoHelp'],
	['logoDark', 'logoDarkHelp'],
	['icon', 'iconHelp'],
	['favicon', 'faviconHelp'],
	['faviconDark', 'faviconDarkHelp'],
	['shareImage', 'shareImageHelp'],
]);

/** @param {SectionProps} props */
export function BrandSection(props) {
	const form = useForm(props, 'brand');
	const B = T.brand;
	const d = /** @type {WebsiteSettings['brand']} */ (form.draft);
	const [rows, setRows] = useMapRows(d.theme.colors, (next) => form.change(['theme', 'colors'], next));
	const accent = d.theme.colors.accent ?? '#2471e7';
	return (
		<SectionForm form={form} canWrite={props.canWrite} stale={props.stale} onReload={props.onReload}>
			<SettingsCard title={B.picturesTitle} description={B.picturesHelp}>
				<SettingList>
					{PICTURES.map(([name, help]) => (
						<Input
							key={name}
							label={B[name]}
							help={B[help]}
							type="url"
							inputMode="url"
							placeholder={B.urlPlaceholder}
							value={d.files[name]}
							error={form.error(['files', name])}
							onChange={(event) => form.change(['files', name], valueOf(event))}
						/>
					))}
				</SettingList>
			</SettingsCard>
			<SettingsCard title={B.themeTitle} description={B.themeHelp}>
				<SettingList>
					<RowSegmentedControl
						legend={B.mode}
						value={d.theme.mode}
						options={['light', 'dark', 'auto'].map((mode) => ({
							value: mode,
							label: B.modes[/** @type {'light'} */ (mode)],
						}))}
						onChange={(mode) => form.change(['theme', 'mode'], mode)}
					/>
					<Input
						label={B.fontFamily}
						help={B.fontFamilyHelp}
						value={d.theme.fontFamily}
						error={form.error(['theme', 'fontFamily'])}
						onChange={(event) => form.change(['theme', 'fontFamily'], valueOf(event))}
					/>
					<Input
						label={B.radius}
						help={B.radiusHelp}
						type="number"
						min={0}
						max={24}
						suffix="px"
						value={String(d.theme.radius)}
						error={form.error(['theme', 'radius'])}
						onChange={(event) => form.change(['theme', 'radius'], valueOf(event) === '' ? 0 : Number(valueOf(event)))}
					/>
					<SettingRow label={B.advancedTitle}>
						<TextArea
							label={B.customCss}
							help={B.customCssHelp}
							rows={6}
							spellCheck={false}
							value={d.theme.customCss}
							error={form.error(['theme', 'customCss'])}
							onChange={(event) => form.change(['theme', 'customCss'], valueOf(event))}
						/>
					</SettingRow>
				</SettingList>
			</SettingsCard>
			<SettingsCard title={B.colorsTitle} description={B.colorsHelp}>
				<SettingList>
					<RowListEditor
						legend={B.colors}
						items={rows}
						max={24}
						onChange={setRows}
						newItem={() => /** @type {[string, string]} */ ([`color${rows.length + 1}`, '#2471e7'])}
						nameOf={([name], index) => name || String(index + 1)}
						renderItem={([name, value], index, update) => (
							<>
								<Input
									label={B.colorName}
									value={name}
									error={form.error(['theme', 'colors', name])}
									onChange={(event) => update([valueOf(event), value])}
								/>
								<Input
									label={B.colorValue}
									type="color"
									value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
									onChange={(event) => update([name, valueOf(event)])}
								/>
							</>
						)}
					/>
				</SettingList>
			</SettingsCard>
			<SettingsCard title={B.previewTitle}>
				<SettingList>
					<div
						className="flex flex-wrap items-center gap-4 border border-line-soft p-4"
						style={{
							background: d.theme.mode === 'dark' ? '#0b1220' : '#ffffff',
							color: d.theme.mode === 'dark' ? '#f4f6fa' : '#0a1c40',
							borderRadius: `${Math.min(24, Math.max(0, Number(d.theme.radius) || 0))}px`,
							fontFamily: d.theme.fontFamily === 'inherit' ? 'inherit' : d.theme.fontFamily,
						}}>
						<span className="text-sm">{B.previewText}</span>
						<span
							className="px-4 py-2 text-sm font-medium"
							style={{
								background: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#2471e7',
								color: '#ffffff',
								borderRadius: `${Math.min(24, Math.max(0, Number(d.theme.radius) || 0))}px`,
							}}>
							{B.previewSample}
						</span>
					</div>
				</SettingList>
			</SettingsCard>
		</SectionForm>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Region and format

/** The countries that use the imperial units. */
const IMPERIAL = new Set(['US', 'LR', 'MM']);

/**
 * Text for money and a date in the Format, or a dash while the Format being typed is not complete.
 * @param {WebsiteSettings['region']} region
 */
const previews = (region) => {
	try {
		const format = region.format;
		const zone = region.timeZone || 'UTC';
		return {
			money: formatMoney(123456, region.currency || 'USD', format),
			date: formatDate(new Date(Date.UTC(2026, 11, 31, 15, 30)), format, { timeZone: zone, style: 'datetime' }),
		};
	} catch {
		return { money: '—', date: '—' };
	}
};

/** @param {SectionProps} props */
export function RegionSection(props) {
	const form = useForm(props, 'region');
	const [drawer, setDrawer] = useState(/** @type {null | 'symbols' | 'regions'} */ (null));
	const R = T.region;
	const d = /** @type {WebsiteSettings['region']} */ (form.draft);
	const countries = useMemo(() => countryChoices(), []);
	const zones = useKnownValues('timeZone');
	const currencyNames = useKnownValues('currency');
	const [symbolRows, setSymbolRows] = useMapRows(d.format.currencySymbols, (next) =>
		form.change(['format', 'currencySymbols'], next),
	);
	const shown = previews(d);
	/** The country fills what is still empty and follows it: the calling code and the units. @param {string} country */
	const chooseCountry = (country) => {
		form.setDraft((old) => {
			const next = /** @type {WebsiteSettings['region']} */ ({ ...old, country });
			const code = callingCodeOf(country);
			return {
				...next,
				phone: { ...old.phone, callingCode: old.phone.callingCode || code },
				units: {
					weight: old.units.weight || (country === '' ? '' : IMPERIAL.has(country) ? 'lb' : 'kg'),
					size: old.units.size || (country === '' ? '' : IMPERIAL.has(country) ? 'in' : 'cm'),
				},
			};
		});
	};
	const symbolSummary = Object.keys(d.format.currencySymbols).length;
	return (
		<SectionForm form={form} canWrite={props.canWrite} stale={props.stale} onReload={props.onReload}>
			<SettingsCard title={R.whereTitle} description={R.whereHelp}>
				<SettingList>
					<Select
						label={R.country}
						help={R.countryHelp}
						value={d.country}
						placeholder={T.none}
						options={countries}
						error={form.error(['country'])}
						onChange={(event) => chooseCountry(valueOf(event))}
					/>
					<SuggestInput
						label={R.timeZone}
						help={R.timeZoneHelp}
						suggestions={zones}
						value={d.timeZone}
						error={form.error(['timeZone'])}
						onChange={(event) => form.change(['timeZone'], valueOf(event))}
					/>
					<Input
						label={R.language}
						help={R.languageHelp}
						value={d.language}
						error={form.error(['language'])}
						onChange={(event) => form.change(['language'], valueOf(event))}
					/>
					<RowChoicePicker
						legend={R.languages}
						help={R.languagesHelp}
						options={[]}
						allowOwn
						noMatchText={R.typeToAdd}
						value={d.languages}
						error={form.error(['languages'])}
						onChange={(next) => form.change(['languages'], next)}
					/>
					<RowChoicePicker
						legend={R.countriesServed}
						options={countries}
						value={d.countriesServed}
						onChange={(next) => form.change(['countriesServed'], next)}
					/>
				</SettingList>
			</SettingsCard>
			<SettingsCard title={R.moneyTitle} description={R.moneyHelp}>
				<SettingList>
					<SuggestInput
						label={R.currency}
						help={R.currencyHelp}
						suggestions={currencyNames}
						value={d.currency}
						maxLength={3}
						error={form.error(['currency'])}
						onChange={(event) => form.change(['currency'], valueOf(event).toUpperCase())}
					/>
					<RowChoicePicker
						legend={R.currencies}
						help={R.currenciesHelp}
						options={currencyNames.map((code) => ({ value: code, label: code }))}
						allowOwn
						noMatchText={R.typeToAdd}
						value={d.currencies}
						error={form.error(['currencies'])}
						onChange={(next) => form.change(['currencies'], next)}
					/>
				</SettingList>
			</SettingsCard>
			<SettingsCard title={R.unitsTitle} description={R.unitsHelp}>
				<SettingList>
					<Select
						label={R.weight}
						value={d.units.weight}
						placeholder={R.noUnit}
						options={WEBSITE_UNITS.weight.map((unit) => ({ value: unit, label: R.weights[/** @type {'g'} */ (unit)] }))}
						error={form.error(['units', 'weight'])}
						onChange={(event) => form.change(['units', 'weight'], valueOf(event))}
					/>
					<Select
						label={R.size}
						value={d.units.size}
						placeholder={R.noUnit}
						options={WEBSITE_UNITS.size.map((unit) => ({ value: unit, label: R.sizes[/** @type {'mm'} */ (unit)] }))}
						error={form.error(['units', 'size'])}
						onChange={(event) => form.change(['units', 'size'], valueOf(event))}
					/>
				</SettingList>
			</SettingsCard>
			<SettingsCard title={R.formatTitle} description={R.formatHelp}>
				<SettingList>
					<Input
						label={R.locale}
						help={R.localeHelp}
						value={d.format.locale}
						error={form.error(['format', 'locale'])}
						onChange={(event) => form.change(['format', 'locale'], valueOf(event))}
					/>
					<RowSegmentedControl
						legend={R.currencyDisplay}
						value={d.format.currencyDisplay}
						options={['code', 'symbol'].map((mode) => ({
							value: mode,
							label: R.currencyDisplays[/** @type {'code'} */ (mode)],
						}))}
						onChange={(mode) => form.change(['format', 'currencyDisplay'], mode)}
					/>
					<Switch
						checked={d.format.wholeUnits}
						label={R.wholeUnits}
						description={R.wholeUnitsHelp}
						onChange={(next) => form.change(['format', 'wholeUnits'], next)}
					/>
					<RowSegmentedControl
						legend={R.times}
						value={d.format.times}
						options={['viewer', 'business'].map((mode) => ({
							value: mode,
							label: R.timesOptions[/** @type {'viewer'} */ (mode)],
						}))}
						onChange={(mode) => form.change(['format', 'times'], mode)}
					/>
					<SummaryRow
						label={R.symbolsRow}
						description={R.symbolsRowHelp}
						summary={symbolSummary === 0 ? R.symbolsNone : R.symbolsCount(symbolSummary)}
						onEdit={() => setDrawer('symbols')}
						error={form.error(['format', 'currencySymbols'])}
					/>
					<SettingRow label={R.preview}>
						<dl className="grid gap-1 text-sm">
							<div className="flex gap-2">
								<dt className="text-muted">{R.previewMoney}</dt>
								<dd className="text-fg tabular-nums" data-preview="money">
									{shown.money}
								</dd>
							</div>
							<div className="flex gap-2">
								<dt className="text-muted">{R.previewDate}</dt>
								<dd className="text-fg tabular-nums" data-preview="date">
									{shown.date}
								</dd>
							</div>
						</dl>
					</SettingRow>
				</SettingList>
			</SettingsCard>
			<SettingsCard title={R.phoneTitle} description={R.phoneHelp}>
				<SettingList>
					<Input
						label={R.callingCode}
						help={R.callingCodeHelp}
						value={d.phone.callingCode}
						maxLength={4}
						error={form.error(['phone', 'callingCode'])}
						onChange={(event) => form.change(['phone', 'callingCode'], valueOf(event))}
					/>
					<Input
						label={R.trunkPrefix}
						help={R.trunkPrefixHelp}
						value={d.phone.trunkPrefix}
						maxLength={2}
						error={form.error(['phone', 'trunkPrefix'])}
						onChange={(event) => form.change(['phone', 'trunkPrefix'], valueOf(event))}
					/>
					<RowChoicePicker
						legend={R.phoneCountries}
						help={R.phoneCountriesHelp}
						options={countries}
						value={d.phone.countries}
						onChange={(next) => form.change(['phone', 'countries'], next)}
					/>
				</SettingList>
			</SettingsCard>
			<SettingsCard title={R.addressTitle} description={R.addressHelp}>
				<SettingList>
					<RowCheckboxGroup
						legend={R.required}
						help={R.requiredHelp}
						options={ADDRESS_REQUIRED_PARTS.map((part) => ({ value: part, label: R.parts[/** @type {'line1'} */ (part)] }))}
						value={d.address.required}
						onChange={(next) => form.change(['address', 'required'], next)}
					/>
					<SummaryRow
						label={R.regionsRow}
						description={R.regionsRowHelp}
						summary={d.address.regions.length === 0 ? R.regionsNone : R.regionsCount(d.address.regions.length)}
						onEdit={() => setDrawer('regions')}
						error={form.error(['address', 'regions'])}
					/>
				</SettingList>
			</SettingsCard>
			<Drawer
				open={drawer === 'symbols'}
				onClose={() => setDrawer(null)}
				title={R.symbolsDrawer}
				description={R.symbolsRowHelp}
				footer={<Done onClose={() => setDrawer(null)} />}>
				<RowListEditor
					legend={R.symbolsRow}
					items={symbolRows}
					max={20}
					onChange={setSymbolRows}
					newItem={() => /** @type {[string, string]} */ (['', ''])}
					texts={{ add: R.addSymbol }}
					nameOf={([code], index) => code || String(index + 1)}
					renderItem={([code, symbol], _index, update) => (
						<>
							<Input
								label={R.symbolCode}
								value={code}
								maxLength={3}
								onChange={(event) => update([valueOf(event).toUpperCase(), symbol])}
							/>
							<Input
								label={R.symbolValue}
								value={symbol}
								maxLength={8}
								onChange={(event) => update([code, valueOf(event)])}
							/>
						</>
					)}
				/>
			</Drawer>
			<Drawer
				open={drawer === 'regions'}
				onClose={() => setDrawer(null)}
				title={R.regionsDrawer}
				description={R.regionsDrawerHelp}
				footer={<Done onClose={() => setDrawer(null)} />}>
				<RowListEditor
					legend={R.regionsRow}
					items={d.address.regions}
					max={50}
					onChange={(next) => form.change(['address', 'regions'], next)}
					newItem={() => ({ country: '', names: [] })}
					texts={{ add: R.addRegions }}
					nameOf={(item, index) => item.country || String(index + 1)}
					renderItem={(item, index, update) => (
						<>
							<Select
								label={R.country}
								value={item.country}
								placeholder={T.none}
								options={countries}
								error={form.error(['address', 'regions', index, 'country'])}
								onChange={(event) => update({ ...item, country: valueOf(event) })}
							/>
							<LinesField
								label={R.regionNames}
								value={item.names}
								onChange={(names) => update({ ...item, names })}
								error={form.error(['address', 'regions', index, 'names'])}
							/>
						</>
					)}
				/>
			</Drawer>
		</SectionForm>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Domains, pages and legal

/** @param {SectionProps} props */
export function PagesSection(props) {
	const form = useForm(props, 'pages');
	const [editing, setEditing] = useState(/** @type {number | null} */ (null));
	const P = T.pages;
	const d = /** @type {WebsiteSettings['pages']} */ (form.draft);
	const known = new Set(d.documents.map((document) => document.key));
	/** @param {string} key */
	const addDocument = (key) => {
		form.change(
			['documents'],
			[...d.documents, { key, title: /** @type {Record<string, string>} */ (P.documentNames)[key] ?? '', text: '' }],
		);
		setEditing(d.documents.length);
	};
	const open = editing === null ? null : d.documents[editing];
	return (
		<SectionForm form={form} canWrite={props.canWrite} stale={props.stale} onReload={props.onReload}>
			<SettingsCard title={P.domainsTitle} description={P.domainsHelp}>
				<SettingList>
					<RowListEditor
						legend={P.hosts}
						help={P.hostsHelp}
						items={d.hosts}
						max={10}
						onChange={(next) => form.change(['hosts'], next)}
						newItem={() => ''}
						nameOf={(item, index) => item || String(index + 1)}
						renderItem={(item, index, update) => (
							<Input
								label={P.host}
								value={item}
								error={form.error(['hosts', index])}
								onChange={(event) => update(valueOf(event))}
							/>
						)}
					/>
					<Input
						label={P.signIn}
						help={P.signInHelp}
						value={d.signIn}
						error={form.error(['signIn'])}
						onChange={(event) => form.change(['signIn'], valueOf(event))}
					/>
					<Input
						label={P.privacy}
						help={P.privacyHelp}
						value={d.privacy}
						error={form.error(['privacy'])}
						onChange={(event) => form.change(['privacy'], valueOf(event))}
					/>
				</SettingList>
			</SettingsCard>
			<SettingsCard
				wide
				title={P.legalTitle}
				description={P.legalHelp}
				actions={
					<>
						{!known.has('privacy') ? (
							<Button size="sm" variant="secondary" onClick={() => addDocument('privacy')}>
								{P.addPrivacy}
							</Button>
						) : null}
						{!known.has('terms') ? (
							<Button size="sm" variant="secondary" onClick={() => addDocument('terms')}>
								{P.addTerms}
							</Button>
						) : null}
						<Button size="sm" onClick={() => addDocument('')} disabled={d.documents.length >= 10}>
							<Icon name="plus" size={14} />
							{P.addDocument}
						</Button>
					</>
				}>
				<SettingList>
					{d.documents.length === 0 ? (
						<EmptyState compact icon="list" title={P.noDocuments} />
					) : (
						<div className="divide-y divide-line-soft rounded-card border border-line-soft bg-surface">
							{d.documents.map((document, index) => (
								<Row
									key={document.key || String(index)}
									lead={{ icon: 'list' }}
									title={document.title || document.key || String(index + 1)}
									meta={[document.key, P.documentSummary(document.text.length)].filter(Boolean)}
									onSelect={() => setEditing(index)}
									trailing={
										<ActionMenu
											floating
											label={`Actions for ${document.title || document.key || String(index + 1)}`}
											items={[
												{ label: T.edit, onSelect: () => setEditing(index) },
												{
													label: P.remove,
													danger: true,
													onSelect: () =>
														form.change(
															['documents'],
															d.documents.filter((_document, at) => at !== index),
														),
												},
											]}
										/>
									}
								/>
							))}
						</div>
					)}
					{form.error(['documents']) ? (
						<p role="alert" className="text-help text-danger">
							{form.error(['documents'])}
						</p>
					) : null}
				</SettingList>
			</SettingsCard>
			<Drawer
				open={open !== null && open !== undefined}
				onClose={() => setEditing(null)}
				title={P.documentDrawer}
				size="lg"
				footer={<Done onClose={() => setEditing(null)} />}>
				{open && editing !== null ? (
					<>
						<Input
							label={P.documentKey}
							help={P.documentKeyHelp}
							value={open.key}
							error={form.error(['documents', editing, 'key'])}
							onChange={(event) => form.change(['documents', editing, 'key'], valueOf(event))}
						/>
						<Input
							label={P.documentTitle}
							value={open.title}
							error={form.error(['documents', editing, 'title'])}
							onChange={(event) => form.change(['documents', editing, 'title'], valueOf(event))}
						/>
						<TextArea
							label={P.documentText}
							help={P.documentTextHelp}
							rows={14}
							value={open.text}
							error={form.error(['documents', editing, 'text'])}
							onChange={(event) => form.change(['documents', editing, 'text'], valueOf(event))}
						/>
					</>
				) : null}
			</Drawer>
		</SectionForm>
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Team and alerts

/** @param {SectionProps} props */
export function TeamSection(props) {
	const form = useForm(props, 'team');
	const [editing, setEditing] = useState(/** @type {number | null} */ (null));
	const M = T.team;
	const d = /** @type {WebsiteSettings['team']} */ (form.draft);
	const person = editing === null ? null : d.recipients[editing];
	return (
		<SectionForm form={form} canWrite={props.canWrite} stale={props.stale} onReload={props.onReload}>
			<SettingsCard
				wide
				title={M.peopleTitle}
				description={M.peopleHelp}
				actions={
					<Button
						size="sm"
						disabled={d.recipients.length >= 50}
						onClick={() => {
							form.change(['recipients'], [...d.recipients, { name: '', email: '', phone: '' }]);
							setEditing(d.recipients.length);
						}}>
						<Icon name="plus" size={14} />
						{M.addPerson}
					</Button>
				}>
				<SettingList>
					{d.recipients.length === 0 ? (
						<EmptyState compact icon="users" title={M.noPeople} />
					) : (
						<div className="divide-y divide-line-soft rounded-card border border-line-soft bg-surface">
							{d.recipients.map((entry, index) => (
								<Row
									key={entry.email || entry.phone || String(index)}
									lead={{ avatar: entry.name || entry.email || 'Person' }}
									title={entry.name || entry.email || entry.phone || String(index + 1)}
									meta={[entry.email, entry.phone].filter(Boolean)}
									onSelect={() => setEditing(index)}
									trailing={
										<ActionMenu
											floating
											label={`Actions for ${entry.name || entry.email || entry.phone || String(index + 1)}`}
											items={[
												{ label: T.edit, onSelect: () => setEditing(index) },
												{
													label: T.pages.remove,
													danger: true,
													onSelect: () =>
														form.change(
															['recipients'],
															d.recipients.filter((_entry, at) => at !== index),
														),
												},
											]}
										/>
									}
								/>
							))}
						</div>
					)}
					{Object.keys(form.errors).some((key) => key.startsWith('recipients')) ? (
						<p role="alert" className="text-help text-danger">
							{M.needsContact}
						</p>
					) : null}
				</SettingList>
			</SettingsCard>
			<SettingsCard title={M.alertsTitle}>
				<SettingList>
					<RowSegmentedControl
						legend={M.phoneChannel}
						help={M.phoneChannelHelp}
						value={d.phoneChannel}
						options={[
							{ value: '', label: T.none },
							{ value: 'sms', label: M.channels.sms },
							{ value: 'whatsapp', label: M.channels.whatsapp },
						]}
						onChange={(next) => form.change(['phoneChannel'], next)}
					/>
					<Switch
						checked={d.staffPush}
						label={M.staffPush}
						description={M.staffPushHelp}
						onChange={(next) => form.change(['staffPush'], next)}
					/>
				</SettingList>
			</SettingsCard>
			<SettingsCard title={M.supportTitle} description={M.supportHelp}>
				<SettingList>
					<Input
						label={M.supportEmail}
						type="email"
						value={d.support.email}
						error={form.error(['support', 'email'])}
						onChange={(event) => form.change(['support', 'email'], valueOf(event))}
					/>
					<Input
						label={M.supportPhone}
						type="tel"
						value={d.support.phone}
						error={form.error(['support', 'phone'])}
						onChange={(event) => form.change(['support', 'phone'], valueOf(event))}
					/>
				</SettingList>
			</SettingsCard>
			<Drawer
				open={person !== null && person !== undefined}
				onClose={() => setEditing(null)}
				title={M.personDrawer}
				footer={<Done onClose={() => setEditing(null)} />}>
				{person && editing !== null ? (
					<>
						<Input
							label={M.name}
							value={person.name}
							onChange={(event) => form.change(['recipients', editing, 'name'], valueOf(event))}
						/>
						<Input
							label={M.email}
							type="email"
							value={person.email}
							error={form.error(['recipients', editing, 'email'])}
							onChange={(event) => form.change(['recipients', editing, 'email'], valueOf(event))}
						/>
						<Input
							label={M.phone}
							help={M.phoneHelp}
							type="tel"
							value={person.phone}
							error={form.error(['recipients', editing, 'phone']) ?? form.error(['recipients', editing])}
							onChange={(event) => form.change(['recipients', editing, 'phone'], valueOf(event))}
						/>
					</>
				) : null}
			</Drawer>
		</SectionForm>
	);
}
