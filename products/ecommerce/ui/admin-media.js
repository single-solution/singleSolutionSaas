/**
 * A product's files in the catalog admin widget (PLAN 0.8.8 media in the merchant's storage; PLAN 0.8.10 E4, E6):
 * photos (upload with their width and height read in the browser, alternative text, order, removal — which also
 * removes them from variants), the video (an MP4 or WebM upload, a YouTube video, an https address, or none), the
 * photos of one variant (picked from the product's photos or uploaded for the product), and the license keys and
 * downloadable files of a digital product. Uploads go to presigned addresses of the merchant's storage.
 * @module
 */
import { safeFileName } from '../core/digital.js';
import { entriesOf } from './admin-kit.js';
import { card } from './admin-screen.js';
import { IMAGE_ACCEPT } from './admin-taxonomy.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {{ key: string, alt: string, url?: string | null, width?: number, height?: number }} Photo */

/** Video types a product may have (E4). */
const VIDEO_ACCEPT = 'video/mp4,video/webm';

/**
 * The width and height of an image file, when the browser can read it.
 * @param {Window & typeof globalThis} win @param {Blob} file
 * @returns {Promise<{ width: number, height: number } | null>}
 */
export const imageSize = async (win, file) => {
	if (typeof win.createImageBitmap !== 'function') return null;
	try {
		const bitmap = await win.createImageBitmap(file);
		const size = { width: bitmap.width, height: bitmap.height };
		bitmap.close?.();
		return size.width > 0 && size.height > 0 ? size : null;
	} catch {
		return null;
	}
};

/**
 * Upload one photo for a product and attach it (E6: with its width and height).
 * @param {Kit} kit @param {string} productId @param {File} file @param {HTMLElement} note
 * @returns {Promise<Photo[] | null>} the product's photos, or null (the note says why)
 */
export const uploadPhoto = async (kit, productId, file, note) => {
	kit.say(note, kit.t('admin.uploading'));
	const asked = await kit.call('POST', '/v1/admin/catalog/uploads', {
		for: 'product',
		id: productId,
		type: file.type,
		size: file.size,
	});
	if (!asked.ok) {
		kit.fail(note, asked);
		return null;
	}
	if (!(await kit.upload(asked.data.upload, file))) {
		kit.say(note, kit.t('admin.uploadFailed'), true);
		return null;
	}
	const size = await imageSize(kit.win, file);
	const added = await kit.call('POST', `/v1/admin/products/${productId}/media`, {
		key: asked.data.key,
		alt: '',
		...(size ?? {}),
	});
	if (!added.ok) {
		kit.fail(note, added);
		return null;
	}
	return added.data.media;
};

/**
 * The photos dialog: thumbnails with alternative text, Earlier / Later, Remove (at once), Add photos, and Save order
 * and texts. `changed` gets the product's photos after every change.
 * @param {Kit} kit @param {any} product @param {(media: Photo[]) => void} changed
 */
export const photosDialog = (kit, product, changed) => {
	const { t, h } = kit;
	const note = kit.status();
	const shown = h('div', { class: 'thumbs' });
	/** @type {Array<{ key: string, url: string | null, alt: HTMLInputElement, width?: number, height?: number }>} */
	let media = [];
	/** @param {Photo[]} files */
	const take = (files) => {
		media = files.map((file) => ({
			key: file.key,
			url: file.url ?? null,
			alt: kit.input(file.alt ?? '', { maxlength: '200' }),
			...(file.width ? { width: file.width, height: file.height } : {}),
		}));
		draw();
	};
	const draw = () =>
		shown.replaceChildren(
			...media.map((file, index) =>
				h('figure', {}, [
					file.url ? kit.h('img', { src: file.url, alt: file.alt.value }) : null,
					file.width ? kit.text('figcaption', { class: 'muted' }, `${file.width} × ${file.height}`) : null,
					kit.field(t('catalogAdmin.altText', { number: index + 1 }), file.alt),
					h('div', { class: 'actions' }, [
						index > 0
							? kit.button(t('catalogAdmin.moveEarlier'), () => {
									media.splice(index - 1, 0, ...media.splice(index, 1));
									draw();
								})
							: null,
						index < media.length - 1
							? kit.button(t('catalogAdmin.moveLater'), () => {
									media.splice(index + 1, 0, ...media.splice(index, 1));
									draw();
								})
							: null,
						kit.confirmButton(t('admin.remove'), t('admin.confirmRemove'), async () => {
							const answer = await kit.call(
								'DELETE',
								`/v1/admin/products/${product.id}/media?key=${encodeURIComponent(file.key)}`,
							);
							if (!answer.ok) return kit.fail(note, answer);
							take(answer.data.media);
							changed(answer.data.media);
							return answer;
						}),
					]),
				]),
			),
		);
	take(product.media ?? []);
	const picker = kit.input('', { type: 'file', accept: IMAGE_ACCEPT, multiple: '' });
	picker.addEventListener('change', async () => {
		for (const file of [...(picker.files ?? [])]) {
			const next = await uploadPhoto(kit, product.id, file, note);
			if (!next) return;
			take(next);
			changed(next);
		}
		picker.value = '';
		kit.say(note, t('admin.saved'));
	});
	kit.dialog({
		title: t('catalogAdmin.photosOf', { name: product.name }),
		wide: true,
		body: [shown, kit.field(t('catalogAdmin.addImages'), picker), note],
		submitLabel: t('catalogAdmin.saveImages'),
		onSubmit: async () => {
			const answer = await kit.call('PUT', `/v1/admin/products/${product.id}/media`, {
				items: media.map((file) => ({ key: file.key, alt: file.alt.value })),
			});
			if (!answer.ok) return kit.reason(answer);
			changed(answer.data.media);
			return null;
		},
	});
};

/**
 * The video of a product for people.
 * @param {Kit} kit @param {any} video
 */
export const videoText = (kit, video) => {
	if (!video) return kit.t('catalogAdmin.noVideo');
	if (video.kind === 'youtube') return kit.t('catalogAdmin.videoYoutube', { id: video.id });
	if (video.kind === 'url') return video.url;
	return kit.t('catalogAdmin.videoFile', { type: video.type || 'video' });
};

/**
 * The video dialog (E4): none, an uploaded MP4 or WebM, a YouTube video (id or address), or an https address.
 * @param {Kit} kit @param {any} product @param {(product: any) => void} changed
 */
export const videoDialog = (kit, product, changed) => {
	const { t, h } = kit;
	const video = product.video ?? null;
	const kind = kit.select(
		['none', 'file', 'youtube', 'url'].map((key) => ({ value: key, label: t(`catalogAdmin.videoKind.${key}`) })),
		video?.kind ?? 'none',
	);
	const file = kit.input('', { type: 'file', accept: VIDEO_ACCEPT });
	const youtube = kit.input(video?.kind === 'youtube' ? video.id : '', { maxlength: '200' });
	const url = kit.input(video?.kind === 'url' ? video.url : '', { maxlength: '500', inputmode: 'url' });
	const parts = {
		file: kit.field(t('catalogAdmin.videoUpload'), file),
		youtube: kit.field(t('catalogAdmin.videoYoutubeId'), youtube),
		url: kit.field(t('catalogAdmin.videoUrl'), url),
	};
	const sync = () => {
		parts.file.hidden = kind.value !== 'file';
		parts.youtube.hidden = kind.value !== 'youtube';
		parts.url.hidden = kind.value !== 'url';
	};
	kind.addEventListener('change', sync);
	sync();
	const current =
		video?.kind === 'file' && video.url
			? h('video', { src: video.url, controls: '', preload: 'metadata', class: 'photo' })
			: kit.text('p', { class: 'muted' }, videoText(kit, video));
	kit.dialog({
		title: t('catalogAdmin.videoOf', { name: product.name }),
		body: [current, kit.field(t('catalogAdmin.videoKind'), kind), parts.file, parts.youtube, parts.url],
		submitLabel: t('admin.save'),
		onSubmit: async () => {
			/** @type {unknown} */
			let next = null;
			if (kind.value === 'youtube') next = { kind: 'youtube', id: youtube.value.trim() };
			else if (kind.value === 'url') next = { kind: 'url', url: url.value.trim() };
			else if (kind.value === 'file') {
				const chosen = file.files?.[0];
				if (!chosen) {
					if (video?.kind === 'file') return null;
					return t('catalogAdmin.videoPick');
				}
				const asked = await kit.call('POST', '/v1/admin/catalog/uploads', {
					for: 'product',
					id: product.id,
					type: chosen.type,
					size: chosen.size,
				});
				if (!asked.ok) return kit.reason(asked);
				if (!(await kit.upload(asked.data.upload, chosen))) return t('admin.uploadFailed');
				next = { kind: 'file', key: asked.data.key };
			}
			const answer = await kit.call('PATCH', `/v1/admin/products/${product.id}`, { video: next });
			if (!answer.ok) return kit.reason(answer);
			changed(answer.data);
			return null;
		},
	});
};

/**
 * The photos of one variant (E6): checked among the product's photos; new ones are uploaded for the product first.
 * `chosen` gets the checked photos (they are saved with the product).
 * @param {Kit} kit
 * @param {{ productId: string, name: string, photos: Photo[], picked: Photo[], uploaded: (media: Photo[]) => void,
 *   chosen: (photos: Photo[]) => void }} options
 */
export const variantPhotosDialog = (kit, { productId, name, photos, picked, uploaded, chosen }) => {
	const { t, h } = kit;
	const note = kit.status();
	const list = h('div', { class: 'thumbs' });
	/** @type {Photo[]} */
	let all = photos;
	const ticked = new Set(picked.map((photo) => photo.key));
	const draw = () =>
		list.replaceChildren(
			...(all.length === 0
				? [kit.text('p', { class: 'muted' }, t('catalogAdmin.noPhotosYet'))]
				: all.map((photo, index) => {
						const pick = kit.check(photo.alt || t('catalogAdmin.photoN', { number: index + 1 }), ticked.has(photo.key));
						pick.box.addEventListener('change', () => {
							if (pick.box.checked) ticked.add(photo.key);
							else ticked.delete(photo.key);
						});
						return h('figure', {}, [photo.url ? kit.h('img', { src: photo.url, alt: photo.alt }) : null, pick.node]);
					})),
		);
	draw();
	const picker = kit.input('', { type: 'file', accept: IMAGE_ACCEPT, multiple: '' });
	picker.addEventListener('change', async () => {
		for (const file of [...(picker.files ?? [])]) {
			const before = new Set(all.map((photo) => photo.key));
			const next = await uploadPhoto(kit, productId, file, note);
			if (!next) return;
			all = next;
			for (const photo of next) if (!before.has(photo.key)) ticked.add(photo.key);
			uploaded(next);
			draw();
		}
		picker.value = '';
		kit.say(note, t('catalogAdmin.uploadedPick'));
	});
	kit.dialog({
		title: t('catalogAdmin.variantPhotos', { variant: name }),
		wide: true,
		body: [list, kit.field(t('catalogAdmin.uploadPhotos'), picker), note],
		submitLabel: t('catalogAdmin.usePhotos'),
		onSubmit: () => {
			chosen(all.filter((photo) => ticked.has(photo.key)));
			return null;
		},
	});
};

/**
 * License keys (one per line, in a dialog) and downloadable files of a saved digital product, as a card.
 * @param {Kit} kit @param {any} product
 */
export const digitalCard = (kit, product) => {
	const { t, h } = kit;
	const note = kit.status();
	const files = h('ul', { class: 'rows' });
	/** @param {{ name: string, size: number }} file */
	const listed = (file) =>
		kit.text('li', {}, t('catalogAdmin.fileLine', { name: file.name, size: Math.ceil(file.size / 1024) }));
	files.append(
		...(product.digital?.files ?? []).map((/** @type {any} */ file) =>
			listed({ name: file.alt || file.key.split('/').pop(), size: file.size }),
		),
	);
	const addKeys = kit.button(t('catalogAdmin.addLicences'), () => {
		const keys = kit.area('', { rows: '6' });
		kit.dialog({
			title: t('catalogAdmin.addLicences'),
			body: [kit.field(t('catalogAdmin.licencesOnePerLine'), keys)],
			submitLabel: t('catalogAdmin.addLicences'),
			onSubmit: async () => {
				const answer = await kit.call('POST', `/v1/admin/products/${product.id}/licences`, { keys: entriesOf(keys.value) });
				if (!answer.ok) return kit.reason(answer);
				kit.say(note, t('catalogAdmin.licencesAdded', { added: answer.data.added, available: answer.data.available }));
				return null;
			},
		});
	});
	const picker = kit.input('', { type: 'file' });
	picker.addEventListener('change', async () => {
		const file = picker.files?.[0];
		if (!file) return;
		kit.say(note, t('admin.uploading'));
		const asked = await kit.call('POST', `/v1/admin/products/${product.id}/files`, {
			name: safeFileName(file.name) ?? 'file',
			type: file.type || 'application/octet-stream',
			size: file.size,
		});
		if (!asked.ok) return kit.fail(note, asked);
		if (!(await kit.upload(asked.data.upload, file))) return kit.say(note, t('admin.uploadFailed'), true);
		files.append(listed(asked.data.file));
		picker.value = '';
		kit.say(note, t('catalogAdmin.fileAdded', { name: asked.data.file.name }));
	});
	return card(
		kit,
		t('catalogAdmin.digitalDelivery'),
		[
			kit.fieldGrid([
				[t('catalogAdmin.licenceKeys'), kit.t(product.digital?.licenceKeys ? 'admin.yes' : 'admin.no')],
				[t('catalogAdmin.downloadLimit'), String(product.digital?.downloadLimit ?? 0)],
			]),
			files,
			kit.field(t('catalogAdmin.addFile'), picker),
			note,
		],
		[addKeys],
	);
};
