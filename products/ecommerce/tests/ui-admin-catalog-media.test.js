// @vitest-environment jsdom
/* global window */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imageSize } from '../ui/admin-media.js';
import { ALL, detailOf, dialogOf, hasDialog, menu, product, start, submitDialog } from './ui-admin-catalog-data.js';
import {
	answer,
	buttonIn,
	change,
	checkIn,
	choose,
	click,
	fieldIn,
	invalid,
	panelOf,
	problem,
	resetPage,
	statuses,
	textOf,
	TEXTS,
	tick,
	type,
} from './ui-admin-helpers.js';

beforeEach(resetPage);
afterEach(() => {
	resetPage();
	Reflect.deleteProperty(window, 'createImageBitmap');
});

/** @param {string} name @param {string} type */
const file = (name, type) => new window.File(['x'], name, { type });

/** Uploads that answer per type. */
const UPLOADS = {
	'POST /v1/admin/catalog/uploads': (/** @type {any} */ call) =>
		call.body.type === 'image/gif'
			? invalid('/type')
			: answer(200, {
					key: `ecommerce/products/prd_1/n.${call.body.type.split('/')[1]}`,
					upload: { method: 'PUT', url: 'https://bucket.example/up', headers: { 'content-type': call.body.type } },
				}),
	'PUT /up': () => answer(200),
};

describe('catalog admin: product files', () => {
	it('arranges, describes, removes and uploads photos (with their size)', async () => {
		/** @type {any[]} */
		const puts = [];
		/** @type {any[]} */
		const attached = [];
		window.createImageBitmap = /** @type {any} */ (async () => ({ width: 1200, height: 900, close: () => {} }));
		const { root, server } = await start(ALL, {
			...UPLOADS,
			'PUT /v1/admin/products/prd_1/media': (/** @type {any} */ call) => {
				puts.push(call.body);
				return answer(200, { media: call.body.items.map((/** @type {any} */ item) => ({ ...item, url: null })) });
			},
			'DELETE /v1/admin/products/prd_1/media': (/** @type {any} */ call) =>
				call.url.searchParams.get('key')?.endsWith('b.jpg')
					? answer(200, { media: [product().media[0]] })
					: problem(404, 'not_found'),
			'POST /v1/admin/products/prd_1/media': (/** @type {any} */ call) => {
				attached.push(call.body);
				return answer(200, {
					media: [...product().media, { key: call.body.key, url: 'https://cdn.example/c.png', alt: '' }],
				});
			},
		});
		const panel = panelOf(root, 'products');
		await click(buttonIn(detailOf(panel), 'Photos'));
		const dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('800 × 600');
		await click(buttonIn(dialog, 'Later'));
		await click(buttonIn(dialog, 'Earlier'));
		await click(buttonIn(dialog, 'Later'));
		type(fieldIn(dialog, 'Text of image 1'), 'rear');
		await click(buttonIn(dialog, 'Remove', 1));
		await click(buttonIn(dialog, 'Confirm remove'));
		expect(statuses(dialog)).toContain(TEXTS['problem.not_found']);
		await click(buttonIn(dialog, 'Remove'));
		await click(buttonIn(dialog, 'Confirm remove'));
		expect(dialog.querySelectorAll('.thumbs figure')).toHaveLength(1);
		// the detail behind follows
		expect(detailOf(panel).querySelectorAll('.thumbs figure')).toHaveLength(1);
		const picker = fieldIn(dialog, 'Add images');
		await choose(picker, [file('c.png', 'image/png')]);
		expect(attached[0]).toEqual({ key: 'ecommerce/products/prd_1/n.png', alt: '', width: 1200, height: 900 });
		expect(server.last('PUT /up')?.headers['content-type']).toBe('image/png');
		expect(dialog.querySelectorAll('.thumbs figure')).toHaveLength(3);
		// a photo under 500 × 500 is attached with a warning (G1)
		window.createImageBitmap = /** @type {any} */ (async () => ({ width: 400, height: 900, close: () => {} }));
		server.routes['POST /v1/admin/products/prd_1/media'] = (/** @type {any} */ call) =>
			answer(200, { media: [...product().media, { key: call.body.key, url: null, alt: '', width: 400, height: 900 }] });
		await choose(picker, [file('small.png', 'image/png')]);
		expect(statuses(dialog)).toContain(
			'small.png is 400 × 900 pixels: shopping catalogs refuse product photos under 500 × 500 from Jan 31, 2027 (about 1500 × 1500 is best).',
		);
		expect(textOf(dialog)).toContain('400 × 900: under 500 × 500');
		await choose(picker, [file('c.gif', 'image/gif')]);
		expect(statuses(dialog)).toContain(TEXTS['problem.field.type']);
		server.routes['PUT /up'] = () => answer(403);
		await choose(picker, [file('c.png', 'image/png')]);
		expect(statuses(dialog)).toContain('The file could not be uploaded. Please try again.');
		server.routes['PUT /up'] = () => {
			throw new Error('offline');
		};
		await choose(picker, [file('c.png', 'image/png')]);
		expect(statuses(dialog)).toContain('The file could not be uploaded. Please try again.');
		server.routes['PUT /up'] = () => answer(200);
		server.routes['POST /v1/admin/products/prd_1/media'] = () => invalid('/key');
		await choose(picker, [file('c.png', 'image/png')]);
		expect(statuses(dialog)).toContain(TEXTS['problem.validation_failed']);
		server.routes['PUT /v1/admin/products/prd_1/media'] = () => invalid('/items/0/alt');
		await submitDialog(root);
		expect(statuses(dialog)).toContain(TEXTS['problem.field.alt']);
		server.routes['PUT /v1/admin/products/prd_1/media'] = (/** @type {any} */ call) => {
			puts.push(call.body);
			return answer(200, { media: call.body.items });
		};
		await submitDialog(root);
		expect(puts.at(-1).items[0]).toEqual({ key: 'ecommerce/products/prd_1/a.jpg', alt: 'front' });
		expect(hasDialog(root)).toBe(false);
	});

	it('reads image sizes only when the browser can', async () => {
		const blob = new window.Blob(['x']);
		expect(await imageSize(/** @type {any} */ ({}), blob)).toBeNull();
		expect(
			await imageSize(
				/** @type {any} */ ({
					createImageBitmap: async () => {
						throw new Error('not an image');
					},
				}),
				blob,
			),
		).toBeNull();
		expect(await imageSize(/** @type {any} */ ({ createImageBitmap: async () => ({ width: 0, height: 0 }) }), blob)).toBeNull();
	});

	it('sets the video: an upload, a YouTube video, an address or none', async () => {
		/** @type {any[]} */
		const patches = [];
		const { root, server } = await start(ALL, {
			...UPLOADS,
			'PATCH /v1/admin/products/prd_1': (/** @type {any} */ call) => {
				patches.push(call.body);
				if (call.body.video?.kind === 'url' && !call.body.video.url.startsWith('https://')) return invalid('/video/key');
				return answer(
					200,
					product({
						video: call.body.video ? { ...call.body.video, type: 'video/mp4', url: 'https://cdn.example/v.mp4' } : null,
					}),
				);
			},
		});
		const panel = panelOf(root, 'products');
		await menu(detailOf(panel), 'Video');
		let dialog = dialogOf(root);
		expect(fieldIn(dialog, 'YouTube address or id').value).toBe('dQw4w9WgXcQ');
		await change(fieldIn(dialog, 'Video'), 'file');
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Pick a video file first.');
		Object.defineProperty(fieldIn(dialog, 'Video file'), 'files', { configurable: true, value: [file('v.mp4', 'video/mp4')] });
		await submitDialog(root);
		expect(server.last('POST /v1/admin/catalog/uploads')?.body).toMatchObject({
			for: 'product',
			id: 'prd_1',
			type: 'video/mp4',
		});
		expect(patches.at(-1)).toEqual({ video: { kind: 'file', key: 'ecommerce/products/prd_1/n.mp4' } });
		expect(textOf(detailOf(panel))).toContain('Uploaded video (video/mp4)');
		// an uploaded video plays in the dialog and can stay as it is
		await click(buttonIn(detailOf(panel), 'Video'));
		dialog = dialogOf(root);
		expect(dialog.querySelector('video')?.getAttribute('src')).toBe('https://cdn.example/v.mp4');
		await submitDialog(root);
		expect(hasDialog(root)).toBe(false);
		await click(buttonIn(detailOf(panel), 'Video'));
		dialog = dialogOf(root);
		server.routes['PUT /up'] = () => answer(500);
		Object.defineProperty(fieldIn(dialog, 'Video file'), 'files', {
			configurable: true,
			value: [file('v.webm', 'video/webm')],
		});
		await submitDialog(root);
		expect(statuses(dialog)).toContain('The file could not be uploaded. Please try again.');
		server.routes['POST /v1/admin/catalog/uploads'] = () => invalid('/size');
		await submitDialog(root);
		expect(statuses(dialog)).toContain(TEXTS['problem.validation_failed']);
		await change(fieldIn(dialog, 'Video'), 'url');
		type(fieldIn(dialog, 'Video address'), 'http://x');
		await submitDialog(root);
		expect(statuses(dialog)).toContain(TEXTS['problem.field.video']);
		type(fieldIn(dialog, 'Video address'), 'https://cdn.example/v.mp4');
		await submitDialog(root);
		expect(patches.at(-1)).toEqual({ video: { kind: 'url', url: 'https://cdn.example/v.mp4' } });
		await click(buttonIn(detailOf(panel), 'Video'));
		await change(fieldIn(dialogOf(root), 'Video'), 'youtube');
		type(fieldIn(dialogOf(root), 'YouTube address or id'), 'https://youtu.be/dQw4w9WgXcQ');
		await submitDialog(root);
		expect(patches.at(-1)).toEqual({ video: { kind: 'youtube', id: 'https://youtu.be/dQw4w9WgXcQ' } });
		await click(buttonIn(detailOf(panel), 'Video'));
		await change(fieldIn(dialogOf(root), 'Video'), 'none');
		await submitDialog(root);
		expect(patches.at(-1)).toEqual({ video: null });
		expect(textOf(detailOf(panel))).toContain('No video.');
	});

	it('picks and uploads the photos of a variant', async () => {
		const { root, server } = await start(ALL, {
			...UPLOADS,
			'POST /v1/admin/products/prd_1/media': (/** @type {any} */ call) =>
				answer(200, { media: [...product().media, { key: call.body.key, url: 'https://cdn.example/n.png', alt: '' }] }),
			'PATCH /v1/admin/products/prd_1': () => answer(200, product()),
		});
		const panel = panelOf(root, 'products');
		await click(buttonIn(detailOf(panel), 'Edit'));
		const editor = detailOf(panel);
		await click(buttonIn(editor, 'Photos (1)'));
		let dialog = dialogOf(root);
		expect(checkIn(dialog, 'front').checked).toBe(true);
		await tick(checkIn(dialog, 'back'), true);
		await tick(checkIn(dialog, 'front'), false);
		await choose(fieldIn(dialog, 'Upload photos for the product'), [file('n.png', 'image/png')]);
		expect(statuses(dialog)).toContain('Uploaded and checked.');
		expect(checkIn(dialog, 'Photo 3').checked).toBe(true);
		server.routes['POST /v1/admin/catalog/uploads'] = () => problem(503, 'storage_not_connected');
		await choose(fieldIn(dialog, 'Upload photos for the product'), [file('m.png', 'image/png')]);
		expect(statuses(dialog)).toContain(TEXTS['problem.storage_not_connected']);
		await submitDialog(root);
		expect(buttonIn(editor, 'Photos (2)')).toBeTruthy();
		// the uploaded photo is offered to the other variants too
		await click(buttonIn(editor, 'Photos (0)'));
		dialog = dialogOf(root);
		expect(dialog.querySelectorAll('figure')).toHaveLength(3);
		await submitDialog(root);
		await click(buttonIn(editor, 'Save'));
		expect(server.last('PATCH /v1/admin/products/prd_1')?.body.variants[0].media).toEqual([
			{ key: 'ecommerce/products/prd_1/b.jpg', alt: 'back' },
			{ key: 'ecommerce/products/prd_1/n.png', alt: '' },
		]);
		// a product without photos says so
		resetPage();
		const bare = await start(ALL, { 'GET /v1/admin/products/prd_1': () => answer(200, product({ media: [] })) });
		const detail = detailOf(panelOf(bare.root, 'products'));
		expect(textOf(detail)).toContain('No photos yet.');
		await click(buttonIn(detail, 'Edit'));
		await click(buttonIn(detailOf(panelOf(bare.root, 'products')), 'Photos (1)'));
		expect(textOf(dialogOf(bare.root))).toContain('No photos yet.');
	});

	it('adds license keys and files to a digital product', async () => {
		const digital = product({
			kind: 'digital',
			options: [],
			variants: [{ ...product().variants[0], options: {}, locations: {} }],
			trackStock: false,
			digital: {
				files: [{ key: 'ecommerce/digital/prd_1/manual.pdf', type: 'application/pdf', size: 2048, alt: '' }],
				retired: [],
				licenceKeys: true,
				downloadLimit: 3,
			},
			media: [],
		});
		let keys = () => answer(200, { added: 2, available: 5 });
		const { root, server } = await start(['catalog', 'digital_goods'], {
			'GET /v1/admin/products/prd_1': () => answer(200, digital),
			'POST /v1/admin/products/prd_1/licences': () => keys(),
			'POST /v1/admin/products/prd_1/files': (/** @type {any} */ call) =>
				answer(200, {
					file: { name: call.body.name, type: call.body.type, size: call.body.size },
					upload: { url: 'https://bucket.example/file' },
				}),
			'PUT /file': () => answer(200),
		});
		const detail = detailOf(panelOf(root, 'products'));
		expect(textOf(detail)).toContain('manual.pdf (2 KB)');
		expect(textOf(detail)).toContain('Downloads allowed (0 = no limit)3');
		await click(buttonIn(detail, 'Add license keys'));
		type(fieldIn(dialogOf(root), 'License keys (one per line)'), 'K1\n\nK2\n');
		keys = () => invalid('/keys');
		await submitDialog(root);
		expect(statuses(dialogOf(root))).toContain(TEXTS['problem.field.keys']);
		keys = () => answer(200, { added: 2, available: 5 });
		await submitDialog(root);
		expect(server.last('POST /v1/admin/products/prd_1/licences')?.body).toEqual({ keys: ['K1', 'K2'] });
		expect(statuses(detail)).toContain('2 keys added; 5 available.');
		const picker = fieldIn(detail, 'Add a file');
		await choose(picker, []);
		await choose(picker, [new window.File(['abc'], 'My Guide.pdf', { type: '' })]);
		expect(server.last('POST /v1/admin/products/prd_1/files')?.body).toEqual({
			name: 'My-Guide.pdf',
			type: 'application/octet-stream',
			size: 3,
		});
		expect(statuses(detail)).toContain('My-Guide.pdf uploaded.');
		await choose(picker, [new window.File(['abc'], '...', { type: 'text/plain' })]);
		expect(server.last('POST /v1/admin/products/prd_1/files')?.body.name).toBe('file');
		server.routes['PUT /file'] = () => answer(500);
		await choose(picker, [new window.File(['abc'], 'a.txt', { type: 'text/plain' })]);
		expect(statuses(detail)).toContain('The file could not be uploaded. Please try again.');
		server.routes['POST /v1/admin/products/prd_1/files'] = () => problem(503, 'storage_not_connected');
		await choose(picker, [new window.File(['abc'], 'a.txt', { type: 'text/plain' })]);
		expect(statuses(detail)).toContain(TEXTS['problem.storage_not_connected']);
	});

	it('removes files and license keys, saying what stays with the orders that have them', async () => {
		const digital = product({
			kind: 'digital',
			options: [],
			variants: [{ ...product().variants[0], options: {}, locations: {} }],
			trackStock: false,
			digital: {
				files: [
					{ key: 'ecommerce/digital/prd_1/manual.pdf', type: 'application/pdf', size: 2048, alt: '' },
					{ key: 'ecommerce/digital/prd_1/extra.zip', type: 'application/zip', size: 4096, alt: '' },
				],
				retired: [],
				licenceKeys: true,
				downloadLimit: 0,
			},
			media: [],
		});
		let removeFile = () => problem(404, 'not_found');
		let removeKeys = () => invalid('/keys');
		const { root, server } = await start(['catalog', 'digital_goods'], {
			'GET /v1/admin/products/prd_1': () => answer(200, digital),
			'DELETE /v1/admin/products/prd_1/files/extra.zip': () => removeFile(),
			'POST /v1/admin/products/prd_1/licences/remove': () => removeKeys(),
		});
		const detail = detailOf(panelOf(root, 'products'));
		await click(/** @type {HTMLElement} */ (detail.querySelector('button[aria-label="Remove extra.zip"]')));
		expect(textOf(dialogOf(root))).toContain('Orders placed from now on do not get extra.zip.');
		await submitDialog(root);
		expect(statuses(dialogOf(root))).toContain(TEXTS['problem.not_found']);
		removeFile = () =>
			answer(200, { files: [{ name: 'manual.pdf', type: 'application/pdf', size: 2048 }], keptForOrders: true });
		await submitDialog(root);
		expect(hasDialog(root)).toBe(false);
		expect(statuses(detail)).toContain('extra.zip removed. Orders placed before keep downloading it.');
		expect(textOf(detail)).not.toContain('extra.zip (4 KB)');
		expect(textOf(detail)).toContain('manual.pdf (2 KB)');
		// license keys: the ones no order was given
		await click(buttonIn(detail, 'Remove license keys'));
		type(fieldIn(dialogOf(root), 'License keys to remove (one per line)'), 'K1\nK9\n');
		await submitDialog(root);
		expect(statuses(dialogOf(root))).toContain(TEXTS['problem.field.keys']);
		removeKeys = () => answer(200, { removed: 1, given: 1, available: 4 });
		await submitDialog(root);
		expect(server.last('POST /v1/admin/products/prd_1/licences/remove')?.body).toEqual({ keys: ['K1', 'K9'] });
		expect(statuses(detail)).toContain('1 keys removed; 1 were given to orders and stay with them; 4 available.');
		// nothing typed: refused before asking
		await click(buttonIn(detail, 'Remove license keys'));
		await submitDialog(root);
		expect(statuses(dialogOf(root))).toContain(TEXTS['catalogAdmin.licencesNone']);
		expect(server.all('POST /v1/admin/products/prd_1/licences/remove')).toHaveLength(2);
	});

	it('formats the rich description with the toolbar and previews it safely', async () => {
		const { root } = await start(['catalog']);
		const panel = panelOf(root, 'products');
		await click(buttonIn(detailOf(panel), 'Edit'));
		const editor = detailOf(panel);
		const area = /** @type {HTMLTextAreaElement} */ (fieldIn(editor, 'Description (HTML)'));
		const preview = /** @type {HTMLElement} */ (editor.querySelector('.rich.preview'));
		expect(preview.querySelector('strong')?.textContent).toBe('text');
		/** @param {string} value @param {number} start @param {number} end @param {string} tool */
		const format = async (value, start, end, tool) => {
			area.value = value;
			area.setSelectionRange(start, end);
			await click(buttonIn(editor, tool));
			return area.value;
		};
		expect(await format('Hello world', 0, 5, 'Bold')).toBe('<strong>Hello</strong> world');
		expect(await format('Hello', 0, 5, 'Italic')).toBe('<em>Hello</em>');
		expect(await format('Hello', 0, 5, 'Underline')).toBe('<u>Hello</u>');
		expect(await format('Hello', 0, 5, 'Heading')).toBe('<h3>Hello</h3>');
		expect(await format('Hello', 0, 5, 'Subheading')).toBe('<h4>Hello</h4>');
		expect(await format('Hello', 0, 5, 'Paragraph')).toBe('<p>Hello</p>');
		expect(await format('Hello', 0, 5, 'Quote')).toBe('<blockquote>Hello</blockquote>');
		expect(await format('Shop', 0, 4, 'Link')).toBe('<a href="https://">Shop</a>');
		expect(await format('one\ntwo\n', 0, 8, 'Bulleted list')).toBe('<ul><li>one</li><li>two</li></ul>');
		expect(await format('', 0, 0, 'Numbered list')).toBe('<ol><li></li></ol>');
		area.value =
			'<p>Hi <i>there</i></p><iframe src="https://x"></iframe><img src=x onerror="alert(1)"><a href="https://a.example/x">a</a><a href="//evil">b</a><div>plain</div>';
		area.dispatchEvent(new window.Event('input'));
		expect(preview.querySelector('em')?.textContent).toBe('there');
		expect(preview.querySelector('iframe, img, div')).toBeNull();
		expect(textOf(preview)).toContain('plain');
		expect([...preview.querySelectorAll('a')].map((node) => node.getAttribute('href'))).toEqual(['https://a.example/x', null]);
	});
});
