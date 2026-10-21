'use client';
/**
 * The colored hint that says what to do next (plan rule 12, easy for a new person): one line on a soft tint, an icon
 * at the left, the sentence, and at the right the one action with an arrow (a link through the shell's `linkAs`, or a
 * button). It fades in. `onDismiss` adds a small close button, so the hint can be put away.
 * @module
 */
import { cx } from './cx.js';
import { CALLOUTS } from './display.js';
import { Icon } from './icons.js';
import { useShell } from './shell-state.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./display.js').Tone} Tone */
/** @typedef {{ dismiss: string }} NextStepTexts */

/** The words a next step says itself (replace them to translate). @type {Readonly<NextStepTexts>} */
export const NEXT_STEP_TEXTS = Object.freeze({ dismiss: 'Dismiss' });

/** The one action of a hint: its words, and where it goes (`href`) or what it does (`onClick`). */
const ACTION =
	'ss-motion ss-press inline-flex shrink-0 items-center gap-1 rounded-sm font-semibold underline-offset-2 hover:underline ' +
	'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/**
 * @param {{ icon?: import('./icons.js').IconName, tone?: Tone | 'accent', children?: ReactNode,
 *   action?: { label: ReactNode, href?: string, onClick?: () => void }, onDismiss?: () => void,
 *   texts?: Partial<NextStepTexts>, linkAs?: import('react').ElementType, className?: string }} props `tone`: the
 *   accent blue by default (`accent`), or a meaning's color; `action`: a link when it has an `href`, else a button
 */
export function NextStep({ icon = 'bulb', tone = 'accent', children, action, onDismiss, texts, linkAs, className }) {
	const shell = useShell();
	const LinkTag = linkAs ?? shell.linkAs ?? 'a';
	const words = { ...NEXT_STEP_TEXTS, ...texts };
	const arrow = <Icon name="arrowRight" size={14} />;
	return (
		<div
			role="note"
			className={cx(
				'flex animate-ss-fade items-center gap-2.5 rounded-card px-3.5 py-2 text-sm',
				CALLOUTS[tone === 'accent' ? 'primary' : tone].box,
				className,
			)}>
			<span aria-hidden="true" className="shrink-0">
				<Icon name={icon} size={15} />
			</span>
			<div className="min-w-0 flex-1 text-pretty">{children}</div>
			{action ? (
				action.href ? (
					<LinkTag href={action.href} className={ACTION}>
						{action.label}
						{arrow}
					</LinkTag>
				) : (
					<button type="button" className={ACTION} {...(action.onClick ? { onClick: action.onClick } : {})}>
						{action.label}
						{arrow}
					</button>
				)
			) : null}
			{onDismiss ? (
				<button
					type="button"
					aria-label={words.dismiss}
					title={words.dismiss}
					onClick={onDismiss}
					className="ss-motion ss-press -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-fg/10 focus-visible:outline-2 focus-visible:outline-focus">
					<Icon name="close" size={13} />
				</button>
			) : null}
		</div>
	);
}
