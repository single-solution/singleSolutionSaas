/**
 * Mode B headless core of the `inspection` element: the buyer-facing inspection report behind a report token
 * (tier, score, every checklist answer with its photos), and an open photo for a viewer.
 */
import { answerText } from '../core/inspection.js';
import { badgeOf, createStore, errorMessage } from './store.js';
import { createTranslator } from './strings.js';

/** Report tokens as issued by the API. */
const TOKEN = /^grr_[A-Za-z0-9_-]{43}$/;

/**
 * @typedef {object} ReportRow
 * @property {string} item
 * @property {string} label
 * @property {string} kind
 * @property {string} answer answer in words
 * @property {boolean | null} passed pass/fail answers
 * @property {string | null} note
 * @property {Array<{ url: string, contentType: string }>} photos
 */

/**
 * @typedef {object} InspectionState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {import('./store.js').Badge | null} tier
 * @property {string | null} scoreText
 * @property {string | null} dateText
 * @property {string | null} serial
 * @property {string | null} inspector
 * @property {string | null} checklist checklist name
 * @property {ReadonlyArray<ReportRow>} rows
 * @property {{ url: string, alt: string } | null} photo the open photo
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').ElementClient,
 *   emit?: import('./store.js').Emit }} options
 */
export const createInspectionReport = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const dates = new Intl.DateTimeFormat(strings['grades.locale'] || 'en', { dateStyle: 'medium', timeZone: 'UTC' });
	const store = createStore(
		/** @type {InspectionState} */ ({
			status: 'idle',
			tier: null,
			scoreText: null,
			dateText: null,
			serial: null,
			inspector: null,
			checklist: null,
			rows: [],
			photo: null,
			error: null,
		}),
	);

	/** @param {unknown} token */
	const validate = (token) =>
		typeof token === 'string' && TOKEN.test(token)
			? []
			: [{ path: '/token', code: 'token_invalid', message: t('inspection.error.not_found') }];

	/** @param {{ token: string }} input */
	const load = async ({ token }) => {
		const problems = validate(token);
		if (problems.length > 0) {
			store.set({ status: 'error', error: problems[0]?.message ?? null });
			return { ok: false, error: { code: 'validation_failed' } };
		}
		store.set({ status: 'loading', error: null });
		const result = await client.get(`/v1/inspection-reports/${encodeURIComponent(token)}`);
		if (!result.ok) {
			store.set({ status: 'error', error: errorMessage(t, strings, 'inspection', result.error) });
			return result;
		}
		const report = result.value;
		store.set({
			status: 'ready',
			tier: report.tier ? badgeOf(report.tier, t) : null,
			scoreText: typeof report.score === 'number' ? t('inspection.score', { score: report.score }) : null,
			dateText: report.inspectedAt ? dates.format(new Date(report.inspectedAt)) : null,
			serial: report.serial ?? null,
			inspector: report.inspector ?? null,
			checklist: report.checklist?.name ?? null,
			rows: report.results.map((/** @type {any} */ row) => ({
				item: row.item,
				label: row.label,
				kind: row.kind,
				answer: answerText(row, t),
				passed: row.kind === 'pass_fail' ? row.value === true : null,
				note: row.note ?? null,
				photos: row.photos ?? [],
			})),
		});
		emit('inspection.viewed', { tier: report.tier?.key ?? null });
		return { ok: true, value: store.get() };
	};

	/**
	 * @param {string} item checklist item key
	 * @param {number} index photo index
	 */
	const openPhoto = async (item, index) => {
		const row = store.get().rows.find((entry) => entry.item === item);
		const photo = row?.photos[index];
		if (!row || !photo) return { ok: false, error: { code: 'not_found' } };
		store.set({ photo: { url: photo.url, alt: t('inspection.photo.alt', { item: row.label, number: index + 1 }) } });
		return { ok: true, value: store.get() };
	};

	const closePhoto = async () => {
		store.set({ photo: null });
		return { ok: true, value: store.get() };
	};

	return {
		state: store.get,
		actions: { load, openPhoto, closePhoto },
		subscribe: store.subscribe,
		validate,
		strings,
		destroy: store.destroy,
	};
};
