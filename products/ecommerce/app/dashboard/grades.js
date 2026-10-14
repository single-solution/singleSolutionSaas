'use client';
/**
 * Settings → Grades and serials: the condition grades editor (`grades` list of `grades_serials`, PLAN 0.8.10 E10). The
 * list shows each grade's colour, name, key, condition, return and warranty days and categories, with Edit and a More
 * menu (move, remove); a grade's every field is edited in a dialog (PLAN 0.6: secondary forms in dialogs): name and
 * key (hyphens allowed), condition (new, refurbished, used, or the SEO and feeds setting), days, colour with a swatch,
 * whether it is offered, a description of up to 1,200 characters, an inspection video (a file key or a YouTube id;
 * a pasted YouTube address keeps its id), the category it is the definition for (E45: the same key once per category,
 * with its own label, texts, days and glossary, and once for every other category), the categories it is for, its
 * content (summary and bullets with icon names) and its glossary page (title, description, text and questions). Done keeps the grade in the list; Save list
 * saves the whole list (up to 100 grades) with `PUT …/lists/grades`, and the server checks it again.
 *
 * Categories are typed as ids (`cat_…`): the dashboard shows no business data (PLAN 0.4.3) and has no route that reads
 * the website's categories, so they are entered as tags.
 * @module
 */
import { useState } from 'react';
import {
	ActionMenu,
	Badge,
	Button,
	Card,
	Checkbox,
	Dialog,
	FieldGrid,
	Icon,
	IconButton,
	Input,
	Select,
	TextArea,
	cx,
} from '@ss/ui';
import { fill } from './api.js';
import {
	GRADE_CONDITIONS,
	GRADE_LIMITS,
	blankGrade,
	cleanGrade,
	gradeProblems,
	keyOf,
	loadGrade,
	splitIds,
	videoOf,
} from './drafts.js';
import { ListOutcome, SaveRow, moved, useList } from './lists.js';
import { Loaded } from './parts.js';
import { TEXTS } from './texts.js';

/** @typedef {import('./drafts.js').GradeDraft} GradeDraft */

const L = TEXTS.lists;
const G = L.grades;

/** The look of a field label (as the shared form controls have it). */
const LEGEND = 'block text-xs font-semibold uppercase tracking-wider text-muted';

/**
 * `{length}/{max}` beside a long text's label.
 * @param {string} text
 * @param {number} max
 */
const counter = (text, max) => fill(G.count, { count: text.length, max });

/**
 * The value a colour picker can show for a CSS colour (`#rrggbb`), black for names and other forms.
 * @param {string} color
 */
const hexOf = (color) => {
	const value = color.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(value)) return value;
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
	return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : '#000000';
};

/**
 * A grade's colour as a small swatch (a neutral box when it has none).
 * @param {{ color: string, size?: 'sm' | 'md', label?: string }} props
 */
function Swatch({ color, size = 'md', label }) {
	const box = size === 'sm' ? 'size-5 rounded-md' : 'size-9 rounded-xl';
	return (
		<span
			{...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}
			className={cx(
				'inline-flex shrink-0 items-center justify-center border border-line',
				box,
				!color && 'bg-surface-2 text-muted',
			)}
			style={color ? { background: color } : undefined}>
			{color || size === 'sm' ? null : <Icon name="layers" size={14} />}
		</span>
	);
}

/**
 * Ids entered as tags: Enter, a comma or leaving the field adds what was typed; pasting several adds them all; each tag
 * has a remove button, and Backspace in the empty field removes the last one.
 * @param {{ label: string, help: string, values: string[], max: number, onChange: (next: string[]) => void }} props
 */
function IdTags({ label, help, values, max, onChange }) {
	const [text, setText] = useState('');
	/** @param {string} typed */
	const add = (typed) => {
		const found = splitIds(typed).filter((id) => !values.includes(id) && id.length <= 64);
		if (found.length > 0) onChange([...values, ...found].slice(0, max));
		setText('');
	};
	return (
		<div data-cell="" data-wide="" className="min-w-0 space-y-2">
			<Input
				label={label}
				help={help}
				aside={values.length > 0 ? fill(G.count, { count: values.length, max }) : G.categoriesAll}
				value={text}
				autoComplete="off"
				disabled={values.length >= max}
				onChange={(event) => {
					const next = event.target.value;
					if (/[\s,;]/.test(next)) add(next);
					else setText(next);
				}}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						add(text);
					} else if (event.key === 'Backspace' && text === '' && values.length > 0) onChange(values.slice(0, -1));
				}}
				onBlur={() => add(text)}
			/>
			{values.length > 0 ? (
				<ul className="flex flex-wrap gap-2">
					{values.map((id) => (
						<li key={id} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs">
							<code className="break-all">{id}</code>
							<button
								type="button"
								aria-label={fill(G.removeCategory, { id })}
								onClick={() => onChange(values.filter((value) => value !== id))}
								className="ss-motion ss-press rounded-md p-1 text-muted hover:bg-surface-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
								<Icon name="close" size={12} />
							</button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/**
 * The content's bullet points: an icon name and a text each, at most 12.
 * @param {{ bullets: GradeDraft['content']['bullets'], onChange: (next: GradeDraft['content']['bullets']) => void }} props
 */
function BulletsField({ bullets, onChange }) {
	/** @param {number} index @param {Partial<GradeDraft['content']['bullets'][number]>} patch */
	const set = (index, patch) => onChange(bullets.map((bullet, at) => (at === index ? { ...bullet, ...patch } : bullet)));
	return (
		<div className="min-w-0 space-y-3">
			<p className={LEGEND}>
				{G.bullets}{' '}
				<span className="font-normal normal-case tracking-normal">
					{fill(G.count, { count: bullets.length, max: GRADE_LIMITS.bullets })}
				</span>
			</p>
			{bullets.map((bullet, index) => (
				<div key={index} className="flex flex-wrap items-end gap-2">
					<Input
						fieldClassName="min-w-0 flex-[1_1_8rem]"
						label={G.bulletIcon}
						help={index === 0 ? G.bulletIconHelp : undefined}
						value={bullet.icon}
						maxLength={GRADE_LIMITS.icon}
						autoComplete="off"
						onChange={(event) => set(index, { icon: event.target.value })}
					/>
					<Input
						fieldClassName="min-w-0 flex-[3_1_14rem]"
						label={fill(G.bullet, { number: index + 1 })}
						value={bullet.text}
						maxLength={GRADE_LIMITS.bullet}
						onChange={(event) => set(index, { text: event.target.value })}
					/>
					<IconButton
						label={fill(G.removeBullet, { number: index + 1 })}
						onClick={() => onChange(bullets.filter((_, at) => at !== index))}>
						<Icon name="close" size={14} />
					</IconButton>
				</div>
			))}
			<Button
				size="sm"
				variant="secondary"
				disabled={bullets.length >= GRADE_LIMITS.bullets}
				onClick={() => onChange([...bullets, { text: '', icon: '' }])}>
				{G.addBullet}
			</Button>
		</div>
	);
}

/**
 * The glossary page's questions and answers, at most 20.
 * @param {{ faqs: GradeDraft['seo']['faqs'], onChange: (next: GradeDraft['seo']['faqs']) => void }} props
 */
function FaqsField({ faqs, onChange }) {
	/** @param {number} index @param {Partial<GradeDraft['seo']['faqs'][number]>} patch */
	const set = (index, patch) => onChange(faqs.map((faq, at) => (at === index ? { ...faq, ...patch } : faq)));
	return (
		<div className="min-w-0 space-y-3">
			<p className={LEGEND}>
				{G.faqs}{' '}
				<span className="font-normal normal-case tracking-normal">
					{fill(G.count, { count: faqs.length, max: GRADE_LIMITS.faqs })}
				</span>
			</p>
			{faqs.map((faq, index) => (
				<div key={index} className="space-y-3 rounded-2xl bg-surface-2 p-4">
					<div className="flex items-center gap-2">
						<span className="mr-auto text-sm font-bold">{fill(G.faq, { number: index + 1 })}</span>
						<IconButton
							label={fill(G.removeFaq, { number: index + 1 })}
							onClick={() => onChange(faqs.filter((_, at) => at !== index))}>
							<Icon name="close" size={14} />
						</IconButton>
					</div>
					<FieldGrid>
						<Input
							wide
							label={G.question}
							value={faq.question}
							maxLength={GRADE_LIMITS.question}
							onChange={(event) => set(index, { question: event.target.value })}
						/>
						<TextArea
							label={G.answer}
							rows={3}
							value={faq.answer}
							maxLength={GRADE_LIMITS.answer}
							onChange={(event) => set(index, { answer: event.target.value })}
						/>
					</FieldGrid>
				</div>
			))}
			<Button
				size="sm"
				variant="secondary"
				disabled={faqs.length >= GRADE_LIMITS.faqs}
				onClick={() => onChange([...faqs, { question: '', answer: '' }])}>
				{G.addFaq}
			</Button>
		</div>
	);
}

/**
 * Every field of one grade (the dialog's body).
 * @param {{ draft: GradeDraft, set: (patch: Partial<GradeDraft>) => void, problems: ReturnType<typeof gradeProblems>,
 *   tried: boolean }} props `tried`: Done was pressed (the missing name is shown from then on)
 */
function GradeFields({ draft, set, problems, tried }) {
	const keyError = problems.key === 'invalid' ? G.keyInvalid : problems.key === 'taken' ? G.keyTaken : undefined;
	return (
		<div className="space-y-6">
			<FieldGrid>
				<Input
					label={G.label}
					required
					value={draft.label}
					maxLength={GRADE_LIMITS.label}
					error={tried && problems.label ? G.labelMissing : undefined}
					onChange={(event) => set({ label: event.target.value })}
				/>
				<Input
					label={G.key}
					help={G.keyHelp}
					value={draft.key}
					placeholder={keyOf('', draft.label)}
					maxLength={GRADE_LIMITS.key}
					autoComplete="off"
					spellCheck={false}
					error={keyError}
					onChange={(event) => set({ key: event.target.value.toLowerCase() })}
				/>
				<Select
					label={G.condition}
					value={draft.condition}
					options={GRADE_CONDITIONS.map((condition) => ({ value: condition, label: G.conditions[condition] }))}
					onChange={(event) => set({ condition: /** @type {GradeDraft['condition']} */ (event.target.value) })}
				/>
				<Input
					label={G.returnDays}
					help={G.daysHelp}
					type="number"
					min={0}
					max={3650}
					step={1}
					inputMode="numeric"
					value={draft.returnDays}
					onChange={(event) => set({ returnDays: event.target.value })}
				/>
				<Input
					label={G.warrantyDays}
					help={G.daysHelp}
					type="number"
					min={0}
					max={3650}
					step={1}
					inputMode="numeric"
					value={draft.warrantyDays}
					onChange={(event) => set({ warrantyDays: event.target.value })}
				/>
				<Input
					label={G.color}
					help={G.colorHelp}
					value={draft.color}
					maxLength={GRADE_LIMITS.color}
					autoComplete="off"
					spellCheck={false}
					suffix={draft.color.trim() ? <Swatch color={draft.color.trim()} size="sm" /> : undefined}
					onChange={(event) => set({ color: event.target.value })}
				/>
				<Input
					label={G.colorPick}
					type="color"
					value={hexOf(draft.color)}
					onChange={(event) => set({ color: event.target.value })}
				/>
				<Checkbox
					label={G.active}
					help={G.activeHelp}
					checked={draft.active}
					onChange={(event) => set({ active: event.target.checked })}
				/>
				<TextArea
					label={G.description}
					rows={3}
					value={draft.description}
					maxLength={GRADE_LIMITS.description}
					aside={counter(draft.description, GRADE_LIMITS.description)}
					onChange={(event) => set({ description: event.target.value })}
				/>
				<Input
					wide
					label={G.video}
					help={G.videoHelp}
					value={draft.video}
					maxLength={GRADE_LIMITS.video}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => set({ video: event.target.value })}
					onBlur={() => set({ video: videoOf(draft.video) })}
				/>
				<Input
					wide
					label={G.categoryId}
					help={G.categoryIdHelp}
					value={draft.categoryId}
					maxLength={64}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => set({ categoryId: event.target.value.trim() })}
				/>
				<IdTags
					label={G.categories}
					help={G.categoriesHelp}
					values={draft.categoryIds}
					max={GRADE_LIMITS.categories}
					onChange={(categoryIds) => set({ categoryIds })}
				/>
			</FieldGrid>
			<fieldset className="min-w-0 space-y-4">
				<legend className="mb-3 text-sm font-bold text-fg">{G.content}</legend>
				<FieldGrid>
					<TextArea
						label={G.summary}
						rows={3}
						value={draft.content.summary}
						maxLength={GRADE_LIMITS.summary}
						aside={counter(draft.content.summary, GRADE_LIMITS.summary)}
						onChange={(event) => set({ content: { ...draft.content, summary: event.target.value } })}
					/>
				</FieldGrid>
				<BulletsField
					bullets={draft.content.bullets}
					onChange={(bullets) => set({ content: { ...draft.content, bullets } })}
				/>
			</fieldset>
			<fieldset className="min-w-0 space-y-4">
				<legend className="mb-1 text-sm font-bold text-fg">{G.seo}</legend>
				<p className="text-xs text-muted">{G.seoHelp}</p>
				<FieldGrid>
					<Input
						wide
						label={G.seoTitle}
						value={draft.seo.title}
						maxLength={GRADE_LIMITS.seoTitle}
						aside={counter(draft.seo.title, GRADE_LIMITS.seoTitle)}
						onChange={(event) => set({ seo: { ...draft.seo, title: event.target.value } })}
					/>
					<TextArea
						label={G.seoDescription}
						rows={2}
						value={draft.seo.description}
						maxLength={GRADE_LIMITS.seoDescription}
						aside={counter(draft.seo.description, GRADE_LIMITS.seoDescription)}
						onChange={(event) => set({ seo: { ...draft.seo, description: event.target.value } })}
					/>
					<TextArea
						label={G.seoBody}
						rows={6}
						value={draft.seo.body}
						maxLength={GRADE_LIMITS.body}
						aside={counter(draft.seo.body, GRADE_LIMITS.body)}
						onChange={(event) => set({ seo: { ...draft.seo, body: event.target.value } })}
					/>
				</FieldGrid>
				<FaqsField faqs={draft.seo.faqs} onChange={(faqs) => set({ seo: { ...draft.seo, faqs } })} />
			</fieldset>
		</div>
	);
}

/**
 * A grade's line in the list: swatch, name and key, condition, days and categories, and its actions.
 * @param {{ grade: GradeDraft, index: number, count: number, onEdit: () => void, onMove: (step: number) => void,
 *   onRemove: () => void }} props
 */
function GradeRow({ grade, index, count, onEdit, onMove, onRemove }) {
	const name = grade.label.trim() || G.unnamed;
	/** @param {string} days */
	const daysText = (days) => (days.trim() === '' ? G.daysSetting : fill(G.daysCount, { days: days.trim() }));
	const facts = [
		...(grade.categoryId.trim() ? [fill(G.categoryIdFor, { id: grade.categoryId.trim() })] : []),
		G.conditions[grade.condition],
		fill(G.days, { returns: daysText(grade.returnDays), warranty: daysText(grade.warrantyDays) }),
		grade.categoryIds.length === 0 ? G.categoriesAll : fill(G.categoriesSome, { count: grade.categoryIds.length }),
	];
	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
			<Swatch color={grade.color.trim()} label={grade.color.trim() || G.colorNone} />
			<span className="min-w-0 flex-[1_1_16rem]">
				<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className="font-semibold text-fg">{name}</span>
					<code className="text-xs text-muted">{keyOf(grade.key, grade.label)}</code>
					{grade.active ? null : <Badge>{G.notOffered}</Badge>}
				</span>
				<span className="block text-sm text-muted">{facts.join(' · ')}</span>
			</span>
			<span className="flex items-center gap-1">
				<Button size="sm" variant="secondary" onClick={onEdit}>
					{G.edit}
				</Button>
				<ActionMenu
					label={fill(G.more, { grade: name })}
					items={[
						{ label: L.up, disabled: index === 0, onSelect: () => onMove(-1) },
						{ label: L.down, disabled: index === count - 1, onSelect: () => onMove(1) },
						{ label: L.remove, danger: true, onSelect: onRemove },
					]}
				/>
			</span>
		</li>
	);
}

/** What the dialog edits: which grade (null = a new one), the working copy, whether Done was pressed. */
/** @typedef {{ open: boolean, index: number | null, draft: GradeDraft, tried: boolean }} Editing */

/**
 * Condition grades (`grades`, feature grades_serials): the list, and each grade's fields in a dialog.
 * @param {{ websiteId: string, off?: boolean }} props
 */
export function GradesEditor({ websiteId, off }) {
	const state = useList(websiteId, 'grades');
	const [editing, setEditing] = useState(
		/** @type {Editing} */ ({ open: false, index: null, draft: blankGrade(), tried: false }),
	);
	return (
		<Card title={G.title} subtitle={off ? TEXTS.settings.off : `${G.help} ${fill(L.max, { max: GRADE_LIMITS.grades })}`}>
			<Loaded answer={state.answer}>
				{(data) => {
					/** @type {GradeDraft[]} */
					const items = state.draft ?? (Array.isArray(data.value) ? data.value : []).map(loadGrade);
					/** @param {GradeDraft[]} next */
					const setItems = (next) => state.setDraft(next);
					// a key is taken by another grade for the same category, or for every category (E45)
					const otherKeys = items
						.filter((grade, at) => at !== editing.index && grade.categoryId.trim() === editing.draft.categoryId.trim())
						.map((grade) => keyOf(grade.key, grade.label));
					const problems = gradeProblems(editing.draft, otherKeys);
					/** @param {number | null} index @param {GradeDraft} draft */
					const open = (index, draft) => setEditing({ open: true, index, draft, tried: false });
					const close = () => setEditing({ ...editing, open: false });
					const done = () => {
						if (Object.keys(problems).length > 0) return setEditing({ ...editing, tried: true });
						setItems(
							editing.index === null
								? [...items, editing.draft]
								: items.map((grade, at) => (at === editing.index ? editing.draft : grade)),
						);
						close();
					};
					return (
						<div className="space-y-4">
							{items.length === 0 ? (
								<p className="text-sm text-muted">{L.none}</p>
							) : (
								<ul className="divide-y divide-line-soft">
									{items.map((grade, index) => (
										<GradeRow
											key={index}
											grade={grade}
											index={index}
											count={items.length}
											onEdit={() => open(index, grade)}
											onMove={(step) => setItems(moved(items, index, step))}
											onRemove={() => setItems(items.filter((_, at) => at !== index))}
										/>
									))}
								</ul>
							)}
							<SaveRow
								dirty={state.draft !== null}
								onCancel={() => state.setDraft(null)}
								onSave={() => state.save(items.map(cleanGrade))}>
								<Button
									size="sm"
									variant="secondary"
									disabled={items.length >= GRADE_LIMITS.grades}
									onClick={() => open(null, blankGrade())}>
									{G.add}
								</Button>
								{state.draft !== null ? (
									<Badge tone="warning" dot className="self-center">
										{G.unsaved}
									</Badge>
								) : null}
							</SaveRow>
							<ListOutcome result={state.result} local={state.local} />
							<Dialog
								open={editing.open}
								onClose={close}
								size="lg"
								title={
									editing.index === null
										? G.newTitle
										: fill(G.editTitle, { grade: editing.draft.label.trim() || G.unnamed })
								}
								description={G.dialogHelp}
								closeLabel={TEXTS.cancel}
								footer={
									<>
										<Button variant="secondary" onClick={close}>
											{TEXTS.cancel}
										</Button>
										<Button onClick={done}>{G.done}</Button>
									</>
								}>
								<GradeFields
									draft={editing.draft}
									tried={editing.tried}
									problems={problems}
									set={(patch) => setEditing((now) => ({ ...now, draft: { ...now.draft, ...patch } }))}
								/>
							</Dialog>
						</div>
					);
				}}
			</Loaded>
		</Card>
	);
}
