/**
 * Visitor upload types (C11): the merchant picks which file types visitors may send from a wide safe set (images with
 * HEIC/HEIF and AVIF, PDF, video, audio for voice notes) with a size cap per type; never SVG, HTML or executables.
 */
import { describe, expect, it } from 'vitest';
import { UPLOAD_TYPE_SEED, checkUploadTypes, uploadLimits } from '../core/uploads.js';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, STAFF_TYPES, attachmentKind } from '../core/widgets.js';

describe('visitor upload types (C11)', () => {
	it('offers a wide safe set: images with HEIC, PDF, video and voice; never SVG, HTML or programs', () => {
		for (const type of ['image/heic', 'image/heif', 'image/avif', 'video/mp4', 'video/quicktime', 'audio/mpeg', 'audio/ogg'])
			expect(ATTACHMENT_TYPES).toContain(type);
		for (const type of ['image/svg+xml', 'text/html', 'application/x-msdownload', 'application/javascript'])
			expect([...ATTACHMENT_TYPES, ...STAFF_TYPES]).not.toContain(type);
		// staff may send everything visitors may, and office files
		expect(ATTACHMENT_TYPES.every((type) => STAFF_TYPES.includes(type))).toBe(true);
		expect(MAX_ATTACHMENT_BYTES).toBe(100 * 1024 * 1024);
	});

	it('seeds today’s five types at 5 MB each', () => {
		expect(UPLOAD_TYPE_SEED).toEqual(
			['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].map((type) => ({ type, maxMb: 5 })),
		);
		expect(checkUploadTypes([...UPLOAD_TYPE_SEED]).ok).toBe(true);
	});

	it('checks each type once, from the safe set, with a cap of 1–100 MB', () => {
		expect(
			checkUploadTypes([
				{ type: 'video/mp4', maxMb: 50 },
				{ type: 'audio/ogg', maxMb: 2 },
			]),
		).toEqual({
			ok: true,
			value: [
				{ type: 'video/mp4', maxMb: 50 },
				{ type: 'audio/ogg', maxMb: 2 },
			],
		});
		expect(checkUploadTypes([{ type: 'image/svg+xml', maxMb: 1 }]).ok).toBe(false);
		expect(checkUploadTypes([{ type: 'video/mp4', maxMb: 101 }]).ok).toBe(false);
		expect(checkUploadTypes([{ type: 'video/mp4', maxMb: 0 }]).ok).toBe(false);
		expect(
			checkUploadTypes([
				{ type: 'video/mp4', maxMb: 5 },
				{ type: 'video/mp4', maxMb: 6 },
			]).ok,
		).toBe(false);
	});

	it('turns the list into the types, a cap per type and the largest cap', () => {
		expect(
			uploadLimits([
				{ type: 'image/png', maxMb: 5 },
				{ type: 'video/mp4', maxMb: 40 },
			]),
		).toEqual({
			types: ['image/png', 'video/mp4'],
			limits: { 'image/png': 5 * 1024 * 1024, 'video/mp4': 40 * 1024 * 1024 },
			max: 40 * 1024 * 1024,
		});
		expect(uploadLimits([])).toEqual({ types: [], limits: {}, max: 0 });
	});

	it('says how a file shows: browser images inline, video and audio as players, the rest as files', () => {
		expect(attachmentKind('image/png')).toBe('image');
		expect(attachmentKind('image/heic')).toBe('file');
		expect(attachmentKind('video/mp4')).toBe('video');
		expect(attachmentKind('audio/ogg')).toBe('audio');
		expect(attachmentKind('application/pdf')).toBe('file');
	});
});
