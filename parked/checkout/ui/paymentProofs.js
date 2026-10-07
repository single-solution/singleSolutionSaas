/**
 * Mode A default renderer of the `payment_proofs` element: transfer reference, file picker and upload, with progress
 * and result announced politely. Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-proof { color: var(--ss-color-text); font: var(--ss-font-body); display: grid; gap: var(--ss-space-2); }
.ss-proof input { font: inherit; color: inherit; border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); padding: var(--ss-space-2); background: var(--ss-color-surface); }
.ss-proof input:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-proof__status { color: var(--ss-color-text-muted); }
`;

/**
 * @param {{ state: import('../headless/paymentProofs.js').ProofState, actions: { setReference: (r: string) => unknown, submit: (file: any) => unknown },
 *   strings: Record<string, string>, theme?: Record<string, unknown>, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const reference = on(
		el(dom, 'input', { id: 'ss-proof-ref', type: 'text', maxlength: '120', value: state.reference ?? '', autocomplete: 'off' }),
		'input',
		(event) => actions.setReference(String(event.target?.value ?? '')),
	);
	const file = on(
		el(dom, 'input', {
			id: 'ss-proof-file',
			type: 'file',
			'aria-describedby': 'ss-proof-status',
			...(state.status === 'uploading' ? { disabled: '' } : {}),
		}),
		'change',
		(event) => {
			const picked = event.target?.files?.[0];
			if (picked) actions.submit(picked);
		},
	);
	return el(
		dom,
		'form',
		{ class: 'ss-proof', 'aria-label': t('proofs.title'), 'aria-busy': String(state.status === 'uploading') },
		[
			slots.before ?? null,
			el(dom, 'label', { for: 'ss-proof-ref' }, [t('proofs.reference')]),
			reference,
			el(dom, 'label', { for: 'ss-proof-file' }, [t('proofs.file')]),
			file,
			el(dom, 'p', { id: 'ss-proof-status', class: 'ss-proof__status', role: 'status', 'aria-live': 'polite' }, [
				state.error ?? state.message ?? (state.status === 'uploading' ? t('proofs.uploading') : ''),
			]),
			statusLine(dom, 'ss-proof', null),
			slots.after ?? null,
		],
	);
};
