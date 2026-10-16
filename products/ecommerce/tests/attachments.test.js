/**
 * Order attachments (fixed-choices E20): the merchant's kinds, what staff send, the records kept and what a status needs.
 */
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_ATTACHMENT_KINDS,
	attachmentSource,
	attachmentsOf,
	checkAttachmentInputs,
	checkAttachmentKinds,
	missingAttachments,
} from '../core/attachments.js';

const KINDS = [
	{ key: 'packing_video', label: 'Packing video', type: /** @type {const} */ ('video'), requiredAt: 'packed', shoppers: true },
	{ key: 'receipt', label: 'Signed receipt', type: /** @type {const} */ ('file'), requiredAt: '', shoppers: false },
];

describe('order attachments', () => {
	it('checks the kinds: a type, a status key or none, shown to shoppers or not', () => {
		expect(checkAttachmentKinds(DEFAULT_ATTACHMENT_KINDS)).toMatchObject({ ok: true });
		expect(checkAttachmentKinds([{ key: 'photo', label: 'Photo' }])).toEqual({
			ok: true,
			value: [{ key: 'photo', label: 'Photo', type: 'file', requiredAt: '', shoppers: false }],
		});
		expect(checkAttachmentKinds([{ key: 'a', label: 'A', type: 'audio' }])).toMatchObject({
			errors: [{ path: '/value/0/type' }],
		});
		expect(checkAttachmentKinds([{ key: 'a', label: 'A', requiredAt: 'Packed!' }])).toMatchObject({
			errors: [{ path: '/value/0/requiredAt' }],
		});
	});

	it('takes an upload key or an https address (YouTube as its private embed address)', () => {
		expect(attachmentSource('orders/1/video.mp4')).toEqual({ key: 'orders/1/video.mp4' });
		expect(attachmentSource('https://youtu.be/dQw4w9WgXcQ')).toEqual({
			url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
		});
		expect(attachmentSource('https://cdn.example/p.jpg')).toEqual({ url: 'https://cdn.example/p.jpg' });
		expect(attachmentSource('http://cdn.example/p.jpg')).toBeNull();
		expect(attachmentSource('../secret')).toBeNull();
		expect(checkAttachmentInputs([{ kind: 'receipt', url: 'javascript:x' }])).toMatchObject({ field: 'attachments/0/url' });
		expect(checkAttachmentInputs(Array.from({ length: 11 }, () => ({ kind: 'a', key: 'k' })))).toMatchObject({
			field: 'attachments',
		});
	});

	it('keeps records of the list’s kinds, never more than 30 on an order, and names what a status still needs', () => {
		const at = new Date(0);
		let n = 0;
		const made = attachmentsOf([{ kind: 'receipt', key: 'r.pdf' }], KINDS, { held: 0, at, by: 'Sam', id: () => `att_${++n}` });
		expect(made).toEqual({
			ok: true,
			value: [{ id: 'att_1', kind: 'receipt', type: 'file', key: 'r.pdf', url: null, at, by: 'Sam' }],
		});
		expect(attachmentsOf([{ kind: 'gone', key: 'x' }], KINDS, { held: 0, at, by: 'Sam', id: () => 'x' })).toMatchObject({
			field: 'attachments/0/kind',
		});
		expect(attachmentsOf([{ kind: 'receipt', key: 'x' }], KINDS, { held: 30, at, by: 'Sam', id: () => 'x' })).toMatchObject({
			field: 'attachments',
		});
		expect(missingAttachments(KINDS, 'packed', []).map((kind) => kind.key)).toEqual(['packing_video']);
		expect(missingAttachments(KINDS, 'packed', [{ kind: 'packing_video' }])).toEqual([]);
		expect(missingAttachments(KINDS, 'dispatched', [])).toEqual([]);
	});
});
