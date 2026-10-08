/**
 * The parts the visitor chat shows above its composer: the guest-limit answer (sign-in link, lead form or text), the
 * contact form, flow steps, the rating prompt and the transcript form. Each `send` answers the text to show.
 * @module
 */
import { buttonOf, customInput, formPart, webAddress } from './common.js';
import { element } from './dom.js';

/** @typedef {{ doc: Document, t: import('./common.js').Texts, make: import('./common.js').FieldMaker }} Kit */

/**
 * The `Sign in to continue` link to the sign-in page, returning to this page (`returnTo`); plain text without a
 * usable sign-in URL.
 * @param {Kit & { signInUrl: string, here: string }} input
 */
export const signInPart = ({ doc, t, signInUrl, here }) => {
	const address = webAddress(signInUrl, here);
	if (!address) return element(doc, 'p', { class: 'notice' }, t('chat.signInToContinue'));
	const url = new URL(address);
	url.searchParams.set('returnTo', here);
	const part = element(doc, 'p', { class: 'notice' });
	part.append(element(doc, 'a', { href: url.href, class: 'action' }, t('chat.signInToContinue')));
	return part;
};

/**
 * The fields of a contact (name, e-mail, phone, message), labelled.
 * @param {Kit} kit
 * @param {readonly string[]} names
 */
const contactFields = ({ t, make }, names) => {
	/** @type {Record<string, [string, string, Record<string, string>]>} */
	const kinds = {
		name: ['input', t('chat.name'), { maxlength: '120', autocomplete: 'name' }],
		email: ['input', t('chat.email'), { type: 'email', maxlength: '254', autocomplete: 'email' }],
		phone: ['input', t('chat.phone'), { type: 'tel', maxlength: '40', autocomplete: 'tel' }],
		message: ['textarea', t('chat.message'), { rows: '3', maxlength: '2000' }],
	};
	return names.flatMap((name) => {
		const kind = kinds[name];
		return kind ? [{ name, ...make.field(...kind) }] : [];
	});
};

/**
 * The lead form: the merchant's fields, custom fields and the consent box.
 * @param {Kit & { leads: import('./common.js').ChatSettings['leads'], customFields: import('./common.js').CustomField[],
 *   send: (fields: Record<string, string | number | boolean>, consent: boolean | undefined) => Promise<string> }} input
 */
export const leadPart = ({ doc, t, make, leads, customFields, send }) => {
	const fields = [
		...contactFields({ doc, t, make }, leads.fields).map((field) => ({ ...field, read: () => field.input.value.trim() })),
		...customFields
			.filter((definition) => leads.customFields.includes(definition.key))
			.map((definition) => ({ name: definition.key, ...customInput(doc, make, t, definition) })),
	];
	const consent = leads.consentText ? make.check(leads.consentText) : null;
	return formPart(doc, {
		title: t('chat.leaveContact'),
		nodes: [...fields.map((field) => field.wrap), ...(consent ? [consent.wrap] : [])],
		label: t('chat.leadSend'),
		submit: async () => {
			if (consent && !consent.input.checked) return t('chat.consentNeeded');
			/** @type {Record<string, string | number | boolean>} */
			const values = {};
			for (const field of fields) {
				const value = field.read();
				if (value !== '') values[field.name] = value;
			}
			return send(values, consent ? true : undefined);
		},
	});
};

/**
 * The contact form (name, e-mail, phone): a name and an e-mail or phone are needed.
 * @param {Kit & { send: (contact: Record<string, string>) => Promise<string> }} input
 */
export const contactPart = ({ doc, t, make, send }) => {
	const fields = contactFields({ doc, t, make }, ['name', 'email', 'phone']);
	return formPart(doc, {
		title: t('chat.contactAsk'),
		nodes: fields.map((field) => field.wrap),
		label: t('chat.contactSend'),
		submit: async () => {
			/** @type {Record<string, string>} */
			const contact = {};
			for (const field of fields) if (field.input.value.trim()) contact[field.name] = field.input.value.trim();
			if (!contact.name || !(contact.email || contact.phone)) return t('chat.contactMissing');
			return send(contact);
		},
	});
};

/**
 * One flow step: buttons for a question, yes/no or choice; an input for other fields.
 * @param {Kit & { step: { kind: string, buttons?: string[], type?: string, options?: string[] }, label: string,
 *   send: (answer: string) => Promise<string> }} input
 */
export const flowPart = ({ doc, t, make, step, label, send }) => {
	const choices =
		step.kind === 'question'
			? (step.buttons ?? [])
			: step.type === 'yes_no'
				? [t('common.yes'), t('common.no')]
				: step.type === 'choice'
					? (step.options ?? [])
					: null;
	if (choices) {
		const part = element(doc, 'div', { class: 'part choices' });
		const note = element(doc, 'p', { class: 'status', role: 'status' });
		for (const choice of choices) {
			const button = buttonOf(doc, choice, { class: 'secondary small' });
			button.addEventListener('click', async () => {
				note.textContent = await send(choice);
			});
			part.append(button);
		}
		part.append(note);
		return part;
	}
	/** @type {Record<string, string>} */
	const types = { email: 'email', phone: 'tel', number: 'number' };
	const field = make.field('input', label, { type: types[step.type ?? ''] ?? 'text', maxlength: '500', required: '' });
	return formPart(doc, { nodes: [field.wrap], label: t('chat.flowSend'), submit: () => send(field.input.value.trim()) });
};

/**
 * The rating prompt: thumbs for a scale of 2, else 1 to the scale; an optional comment.
 * @param {Kit & { scale: number, comment: boolean, send: (score: number, comment: string) => Promise<string> }} input
 */
export const ratingPart = ({ doc, t, make, scale, comment, send }) => {
	const part = element(doc, 'div', { class: 'part' });
	const row = element(doc, 'div', { class: 'choices' });
	const note = element(doc, 'p', { class: 'status', role: 'status' });
	const text = comment ? make.field('textarea', t('chat.ratingComment'), { rows: '2', maxlength: '1000' }) : null;
	const labels =
		scale === 2 ? [t('chat.ratingDown'), t('chat.ratingUp')] : Array.from({ length: scale }, (_, index) => String(index + 1));
	let score = 0;
	const submit = async () => {
		note.textContent = await send(score, text?.input.value.trim() ?? '');
	};
	labels.forEach((label, index) => {
		const button = buttonOf(doc, label, { class: 'secondary small', 'aria-pressed': 'false' });
		button.addEventListener('click', () => {
			score = index + 1;
			for (const each of row.querySelectorAll('button')) each.setAttribute('aria-pressed', String(each === button));
			if (!text) void submit();
		});
		row.append(button);
	});
	part.append(element(doc, 'p', { class: 'ask' }, t('chat.ratingAsk')), row);
	if (text) {
		const go = buttonOf(doc, t('chat.ratingSend'));
		go.addEventListener('click', () => {
			if (score > 0) void submit();
			else note.textContent = t('chat.ratingPick');
		});
		part.append(text.wrap, go);
	}
	part.append(note);
	return part;
};

/**
 * The transcript form: the e-mail (prefilled for a signed-in visitor) and Cancel.
 * @param {Kit & { email: string, send: (email: string) => Promise<string>, close: () => void }} input
 */
export const transcriptPart = ({ doc, t, make, email, send, close }) => {
	const field = make.field('input', t('chat.email'), { type: 'email', maxlength: '254', required: '' });
	field.input.value = email;
	const cancel = buttonOf(doc, t('chat.cancel'), { class: 'secondary' });
	cancel.addEventListener('click', close);
	const form = formPart(doc, {
		title: t('chat.transcriptAsk'),
		nodes: [field.wrap],
		label: t('chat.transcriptSend'),
		submit: () => send(field.input.value.trim()),
	});
	form.insertBefore(cancel, form.querySelector('[role="status"]'));
	return form;
};
