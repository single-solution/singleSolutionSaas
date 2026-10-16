'use client';
/**
 * The merchant-list editor (fixed-choices audit K3): one pattern for every list a merchant owns — rows they add,
 * rename, reorder and remove (payment methods, contact channels, claim kinds, units…). The caller draws a row's fields;
 * the editor adds the row frame, Move up / Move down / Remove on each row and Add at the end (until `max`). Keyboard
 * and screen readers get real buttons named with the row (`Move up: Email`).
 * @module
 */
import { Button, IconButton } from './Button.js';
import { cx } from './cx.js';
import { Icon } from './icons.js';

/**
 * Words of the editor.
 * @typedef {{ add: string, remove: string, moveUp: string, moveDown: string, empty: string,
 *   full: (max: number) => string }} ListEditorTexts
 */

/** Words of the editor (US English; products pass their own). @type {Readonly<ListEditorTexts>} */
export const LIST_EDITOR_TEXTS = Object.freeze({
	add: 'Add',
	remove: 'Remove',
	moveUp: 'Move up',
	moveDown: 'Move down',
	empty: 'None yet.',
	full: (/** @type {number} */ max) => `At most ${max}.`,
});

/**
 * A list moved: the row at `from` now at `to` (a copy; the same list when either is out of range).
 * @template T
 * @param {readonly T[]} items
 * @param {number} from
 * @param {number} to
 * @returns {T[]}
 */
export const moveItem = (items, from, to) => {
	if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];
	const out = [...items];
	const [moved] = out.splice(from, 1);
	out.splice(to, 0, /** @type {T} */ (moved));
	return out;
};

/**
 * @template T
 * @param {{ legend: string, items: readonly T[], onChange: (next: T[]) => void, newItem: () => T,
 *   renderItem: (item: T, index: number, update: (next: T) => void) => import('react').ReactNode,
 *   nameOf?: (item: T, index: number) => string, max?: number, help?: string, error?: string | null,
 *   texts?: Partial<ListEditorTexts>, className?: string, disabled?: boolean }} props
 *   `renderItem`: the row's fields (`update` replaces the row); `nameOf`: the row's name in button labels (default its
 *   position); `max`: the most rows (Add is gone at it)
 */
export function ListEditor({
	legend,
	items,
	onChange,
	newItem,
	renderItem,
	nameOf = (_item, index) => String(index + 1),
	max,
	help,
	error,
	texts,
	className,
	disabled = false,
}) {
	const T = { ...LIST_EDITOR_TEXTS, ...texts };
	const full = max !== undefined && items.length >= max;
	return (
		<fieldset className={cx('col-span-full min-w-0 space-y-3', className)} disabled={disabled}>
			<legend className="mb-2 block text-label font-medium leading-5 text-fg">
				{legend}
				{items.length > 0 ? <span className="ml-1.5 font-normal text-muted">{items.length}</span> : null}
			</legend>
			{help ? <p className="text-xs text-muted">{help}</p> : null}
			{items.length === 0 ? <p className="text-sm text-muted">{T.empty}</p> : null}
			<ol className="space-y-2">
				{items.map((item, index) => {
					const name = nameOf(item, index);
					return (
						<li
							key={index}
							className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-surface-2/40 px-3 py-3">
							<div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-3">
								{renderItem(item, index, (next) => onChange(items.map((old, i) => (i === index ? next : old))))}
							</div>
							<div className="flex shrink-0 items-center gap-1 pt-6">
								<IconButton
									label={`${T.moveUp}: ${name}`}
									disabled={index === 0}
									onClick={() => onChange(moveItem(items, index, index - 1))}>
									<Icon name="arrowUp" size={14} />
								</IconButton>
								<IconButton
									label={`${T.moveDown}: ${name}`}
									disabled={index === items.length - 1}
									onClick={() => onChange(moveItem(items, index, index + 1))}>
									<Icon name="arrowDown" size={14} />
								</IconButton>
								<IconButton
									label={`${T.remove}: ${name}`}
									onClick={() => onChange(items.filter((_old, i) => i !== index))}>
									<Icon name="close" size={14} />
								</IconButton>
							</div>
						</li>
					);
				})}
			</ol>
			{full ? (
				<p className="text-xs text-muted">{T.full(/** @type {number} */ (max))}</p>
			) : (
				<Button type="button" size="sm" variant="secondary" onClick={() => onChange([...items, newItem()])}>
					<Icon name="plus" size={14} />
					{T.add}
				</Button>
			)}
			{error ? (
				<p role="alert" className="text-xs text-danger">
					{error}
				</p>
			) : null}
		</fieldset>
	);
}
