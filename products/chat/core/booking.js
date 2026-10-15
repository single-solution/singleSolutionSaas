/**
 * Book-a-slot's own questions and services (pure, C10): the merchant's lists `booking_questions` (`{ key, label, type,
 * required, options }`: text, number, yes/no, a choice, an email or a phone; seeded with name, email and phone) and
 * `booking_services` (`{ key, name, description }`, none to start). The AI asks the visitor the questions and, when
 * there are services, which one; Chat checks the answers and sends them to the merchant's booking endpoint.
 * @module
 */
import { checkFieldValue } from './fields.js';

/** The answer types a booking question may have. */
export const QUESTION_TYPES = Object.freeze(/** @type {const} */ (['text', 'number', 'yes_no', 'choice', 'email', 'phone']));

/** Most questions and services, and the longest label, name and description. */
export const BOOKING_LIMITS = Object.freeze({ questions: 20, services: 50, label: 80, description: 300, options: 30 });

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** Keys the booking tool uses itself. */
const RESERVED = Object.freeze(['service', 'slot', 'slot_id']);

/**
 * @typedef {{ key: string, label: string, type: (typeof QUESTION_TYPES)[number], required: boolean, options: string[] }}
 *   BookingQuestion
 */
/** @typedef {{ key: string, name: string, description: string }} BookingService */

/**
 * What a website starts with: the visitor's name (required), email and phone (with the setting that one of them is
 * needed).
 * @type {readonly BookingQuestion[]}
 */
export const BOOKING_QUESTION_SEED = Object.freeze([
	Object.freeze({ key: 'name', label: 'Name', type: 'text', required: true, options: [] }),
	Object.freeze({ key: 'email', label: 'Email', type: 'email', required: false, options: [] }),
	Object.freeze({ key: 'phone', label: 'Phone', type: 'phone', required: false, options: [] }),
]);

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check the booking questions a merchant saves.
 * @param {unknown} items
 * @returns {{ ok: true, value: BookingQuestion[] } | { ok: false, errors: string[] }}
 */
export const checkBookingQuestions = (items) => {
	if (!Array.isArray(items) || items.length > BOOKING_LIMITS.questions)
		return { ok: false, errors: [`Up to ${BOOKING_LIMITS.questions} questions.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {BookingQuestion[]} */
	const value = [];
	const keys = new Set();
	items.forEach((item, index) => {
		const at = `Question ${index + 1}`;
		const entry = isObject(item) ? /** @type {Record<string, unknown>} */ (item) : {};
		const key = typeof entry.key === 'string' ? entry.key : '';
		const label = typeof entry.label === 'string' ? entry.label.trim() : '';
		if (!KEY.test(key) || RESERVED.includes(key) || keys.has(key))
			return void errors.push(`${at}: a unique key (lower-case letters, digits or _; not ${RESERVED.join(', ')}).`);
		if (label.length === 0 || label.length > BOOKING_LIMITS.label)
			return void errors.push(`${at}: a label of up to ${BOOKING_LIMITS.label} characters.`);
		if (!QUESTION_TYPES.includes(/** @type {any} */ (entry.type)))
			return void errors.push(`${at}: a type (${QUESTION_TYPES.join(', ')}).`);
		const options = Array.isArray(entry.options)
			? entry.options.filter((o) => typeof o === 'string' && o.trim()).map((o) => String(o).trim().slice(0, 60))
			: [];
		if (entry.type === 'choice' && (options.length < 1 || options.length > BOOKING_LIMITS.options))
			return void errors.push(`${at}: a choice has 1–${BOOKING_LIMITS.options} options.`);
		keys.add(key);
		value.push({
			key,
			label,
			type: /** @type {BookingQuestion['type']} */ (entry.type),
			required: entry.required === true,
			options: entry.type === 'choice' ? options : [],
		});
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * Check the services a merchant saves (none = bookings without a service).
 * @param {unknown} items
 * @returns {{ ok: true, value: BookingService[] } | { ok: false, errors: string[] }}
 */
export const checkBookingServices = (items) => {
	if (!Array.isArray(items) || items.length > BOOKING_LIMITS.services)
		return { ok: false, errors: [`Up to ${BOOKING_LIMITS.services} services.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {BookingService[]} */
	const value = [];
	const keys = new Set();
	items.forEach((item, index) => {
		const at = `Service ${index + 1}`;
		const entry = isObject(item) ? /** @type {Record<string, unknown>} */ (item) : {};
		const key = typeof entry.key === 'string' ? entry.key : '';
		const name = typeof entry.name === 'string' ? entry.name.trim() : '';
		const description = typeof entry.description === 'string' ? entry.description.trim() : '';
		if (!KEY.test(key) || keys.has(key)) return void errors.push(`${at}: a unique key (lower-case letters, digits or _).`);
		if (name.length === 0 || name.length > BOOKING_LIMITS.label)
			return void errors.push(`${at}: a name of up to ${BOOKING_LIMITS.label} characters.`);
		if (description.length > BOOKING_LIMITS.description)
			return void errors.push(`${at}: a description of up to ${BOOKING_LIMITS.description} characters.`);
		keys.add(key);
		value.push({ key, name, description });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * The tool parameters of the merchant's questions and services: one parameter per question (choices as their
 * options), and `service` (one of the service keys) when there are services.
 * @param {readonly BookingQuestion[]} questions
 * @param {readonly BookingService[]} services
 * @returns {{ properties: Record<string, Record<string, unknown>>, required: string[] }}
 */
export const bookingParameters = (questions, services) => {
	/** @type {Record<string, Record<string, unknown>>} */
	const properties = {};
	for (const q of questions)
		properties[q.key] =
			q.type === 'number'
				? { type: 'number', description: q.label }
				: q.type === 'yes_no'
					? { type: 'boolean', description: q.label }
					: q.type === 'choice'
						? { type: 'string', enum: [...q.options], description: q.label }
						: { type: 'string', description: q.type === 'text' ? q.label : `${q.label} (${q.type})` };
	return {
		properties: services.length > 0 ? { ...properties, service: serviceParameter(services) } : properties,
		required: [...questions.filter((q) => q.required).map((q) => q.key), ...(services.length > 0 ? ['service'] : [])],
	};
};

/**
 * The `service` parameter: one of the keys, each described by its name and description.
 * @param {readonly BookingService[]} services
 */
export const serviceParameter = (services) => ({
	type: 'string',
	enum: services.map((s) => s.key),
	description: `The service: ${services.map((s) => `${s.key} = ${s.name}${s.description ? ` (${s.description})` : ''}`).join('; ')}.`,
});

/**
 * Check the answers of a booking: each answer as its question's type, every required one given, one of the
 * services when there are any, and, with `needsContact`, an email or phone answer (or the signed-in visitor's email,
 * which also answers the first email question left empty).
 * @param {Record<string, unknown>} args the AI's arguments
 * @param {{ questions: readonly BookingQuestion[], services: readonly BookingService[], needsContact: boolean,
 *   signedInEmail: string | null, callingCode: string }} rules
 * @returns {{ ok: true, answers: Record<string, string | number | boolean>, service: string | null }
 *   | { ok: false, ask: string[] }} `ask`: what to ask the visitor for (labels; `contact` for an email or phone)
 */
export const bookingAnswers = (args, { questions, services, needsContact, signedInEmail, callingCode }) => {
	/** @type {Record<string, string | number | boolean>} */
	const answers = {};
	/** @type {string[]} */
	const ask = [];
	for (const q of questions) {
		const raw = args[q.key];
		if (raw === undefined || raw === null || raw === '') {
			if (q.type === 'email' && signedInEmail && !Object.values(answers).includes(signedInEmail)) {
				answers[q.key] = signedInEmail;
				continue;
			}
			if (q.required) ask.push(q.label);
			continue;
		}
		const checked = checkFieldValue(q, raw, callingCode);
		if (checked.ok) answers[q.key] = checked.value;
		else ask.push(q.label);
	}
	const service = services.length > 0 ? (services.find((s) => s.key === args.service)?.key ?? null) : null;
	if (services.length > 0 && service === null) ask.push('service');
	const contact = questions.some((q) => (q.type === 'email' || q.type === 'phone') && answers[q.key] !== undefined);
	if (needsContact && !contact && !signedInEmail) ask.push('contact');
	return ask.length > 0 ? { ok: false, ask } : { ok: true, answers, service };
};
