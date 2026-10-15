/**
 * Book-a-slot's own questions and services (C10): the merchant's questions (seeded with name, email and phone) become
 * the tool's parameters, the answers are checked by type, and a service is asked for when there are services.
 */
import { describe, expect, it } from 'vitest';
import {
	BOOKING_QUESTION_SEED,
	bookingAnswers,
	bookingParameters,
	checkBookingQuestions,
	checkBookingServices,
} from '../core/booking.js';
import { builtinSchemas } from '../core/tools.js';

/** @type {import('../core/booking.js').BookingQuestion[]} */
const QUESTIONS = [
	...BOOKING_QUESTION_SEED,
	{ key: 'guests', label: 'Number of guests', type: 'number', required: true, options: [] },
	{ key: 'seating', label: 'Seating', type: 'choice', required: false, options: ['Inside', 'Terrace'] },
];
const SERVICES = [
	{ key: 'consult', name: 'Consultation', description: '30 minutes' },
	{ key: 'repair', name: 'Repair', description: '' },
];
/** @type {Parameters<typeof bookingAnswers>[1]} */
const RULES = { questions: QUESTIONS, services: SERVICES, needsContact: true, signedInEmail: null, callingCode: '+44' };

describe('booking questions and services (C10)', () => {
	it('seeds today’s questions: name (required), email and phone', () => {
		expect(BOOKING_QUESTION_SEED.map((q) => [q.key, q.type, q.required])).toEqual([
			['name', 'text', true],
			['email', 'email', false],
			['phone', 'phone', false],
		]);
		expect(checkBookingQuestions([...BOOKING_QUESTION_SEED])).toEqual({ ok: true, value: BOOKING_QUESTION_SEED });
	});

	it('checks questions and services', () => {
		expect(checkBookingQuestions([{ key: 'party', label: ' Party size ', type: 'number', required: true }])).toEqual({
			ok: true,
			value: [{ key: 'party', label: 'Party size', type: 'number', required: true, options: [] }],
		});
		expect(checkBookingQuestions([{ key: 'service', label: 'S', type: 'text' }]).ok).toBe(false);
		expect(checkBookingQuestions([{ key: 'x', label: 'X', type: 'date' }]).ok).toBe(false);
		expect(checkBookingQuestions([{ key: 'x', label: 'X', type: 'choice', options: [] }]).ok).toBe(false);
		expect(checkBookingServices(SERVICES)).toEqual({ ok: true, value: SERVICES });
		expect(checkBookingServices([{ key: 'a', name: '' }]).ok).toBe(false);
		expect(
			checkBookingServices([
				{ key: 'a', name: 'A' },
				{ key: 'a', name: 'B' },
			]).ok,
		).toBe(false);
	});

	it('the questions and services are the booking tools’ parameters', () => {
		const { properties, required } = bookingParameters(QUESTIONS, SERVICES);
		expect(properties.guests).toEqual({ type: 'number', description: 'Number of guests' });
		expect(properties.seating).toEqual({ type: 'string', enum: ['Inside', 'Terrace'], description: 'Seating' });
		expect(properties.service).toMatchObject({ enum: ['consult', 'repair'] });
		expect(required).toEqual(['name', 'guests', 'service']);
		const [slots, book] = /** @type {any[]} */ (
			builtinSchemas({ handoff: false, booking: { questions: QUESTIONS, services: SERVICES } })
		);
		expect(slots?.parameters.required).toEqual(['from', 'to', 'service']);
		expect(book?.parameters.required).toEqual(['slotId', 'name', 'guests', 'service']);
		expect(Object.keys(book?.parameters.properties ?? {})).toEqual([
			'slotId',
			'name',
			'email',
			'phone',
			'guests',
			'seating',
			'service',
		]);
		// no services: no service parameter
		const [plain] = /** @type {any[]} */ (
			builtinSchemas({ handoff: false, booking: { questions: BOOKING_QUESTION_SEED, services: [] } })
		);
		expect(plain?.parameters.required).toEqual(['from', 'to']);
	});

	it('checks the answers by type and says what to ask for', () => {
		expect(
			bookingAnswers({ name: 'Ann', phone: '07700 900123', guests: '4', seating: 'Terrace', service: 'repair' }, RULES),
		).toEqual({ ok: true, answers: { name: 'Ann', phone: '+447700900123', guests: 4, seating: 'Terrace' }, service: 'repair' });
		expect(bookingAnswers({ name: 'Ann', guests: 2, seating: 'Roof', service: 'x' }, RULES)).toEqual({
			ok: false,
			ask: ['Seating', 'service', 'contact'],
		});
		// a signed-in visitor's email answers the email question
		expect(
			bookingAnswers({ name: 'Ann', guests: 2, service: 'consult' }, { ...RULES, signedInEmail: 'ann@example.com' }),
		).toEqual({
			ok: true,
			answers: { name: 'Ann', email: 'ann@example.com', guests: 2 },
			service: 'consult',
		});
		// without the contact rule and without services
		expect(bookingAnswers({ name: 'Ann', guests: 2 }, { ...RULES, services: [], needsContact: false })).toEqual({
			ok: true,
			answers: { name: 'Ann', guests: 2 },
			service: null,
		});
	});
});
