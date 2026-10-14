/**
 * Parts of the product page (PLAN 0.8.10 E4, E5, E7, E9, E10, E12, E16): the variant picker's axes (the option axes,
 * up to 6, else the variants' attributes, plus the condition when two variants differ only by grade), the stock text
 * of a variant ("Only N left", "N in stock", Sold out), photos with their smaller sizes, size and blur placeholder, the
 * grade's details (color, description, content, return days and condition video), the product video, the FAQs, the
 * Size guide (a dialog, a full-screen sheet on phones, with an in/cm switch) and the shopper's own alerts
 * (`GET /v1/shop/alerts`, read once per sign-in and shared by the widgets of a page).
 * @module
 */
import { youtubeId } from '../core/catalog-content.js';
import { button, h, paragraphs, safeHref } from './shop-common.js';

/** @typedef {import('./shop-common.js').Texts} Texts */
/** @typedef {import('./widget.js').Shop} Shop */

/**
 * A photo or clip as the shop answers it (E6).
 * @typedef {{ url: string | null, alt: string, type?: string, width?: number, height?: number, blur?: string,
 *   sizes?: Partial<Record<'thumb' | 'card' | 'detail', string | null>> }} PageMedia
 */

/**
 * A grade as the shop answers it (E10).
 * @typedef {{ key: string, label: string, description?: string, color?: string, video?: string, videoUrl?: string | null,
 *   content?: { summary: string, bullets: Array<{ text: string, icon: string }> }, returnDays?: number | null,
 *   warrantyDays?: number | null }} PageGrade
 */

/**
 * A variant as the product page reads it.
 * @typedef {{ id: string, name: string, options: Record<string, string>, price: number, compareAtPrice: number | null,
 *   deal?: { id: string, name: string, savings: number } | null, inStock: boolean, soldOut?: boolean,
 *   stockLeft?: number | null, grade: PageGrade | null, warrantyDays?: number | null,
 *   attributes?: Array<{ id: string, slug: string, name: string, value: unknown, label: string }>, media?: PageMedia[] }} PageVariant
 *   `price`: the price shown (after automatic deals); `deal`: the deal in it and what it takes off one unit
 */

/**
 * One axis of the variant picker: its values in order and how a variant's value is read.
 * @typedef {{ key: string, label: string, grade: boolean, values: Array<{ value: string, text: string }>,
 *   of: (variant: PageVariant) => string }} Axis
 */

/** The key of the condition axis (never an option name: option names do not start with `#`). */
export const GRADE_AXIS = '#grade';

/**
 * The axes of a product's variant picker: its option axes; else, when its variants carry attributes, one axis per
 * attribute (by label); then the condition when two variants have the same values and differ only by grade.
 * @param {{ options: Array<{ name: string, values: string[] }>, variants: PageVariant[] }} item
 * @returns {Axis[]}
 */
export const axesOf = (item) => {
	/** @type {Axis[]} */
	const axes = item.options.map((option) => ({
		key: option.name,
		label: option.name,
		grade: false,
		values: option.values.map((value) => ({ value, text: value })),
		of: (variant) => variant.options?.[option.name] ?? '',
	}));
	if (axes.length === 0) {
		/** @type {Map<string, Axis>} */
		const byAttribute = new Map();
		for (const variant of item.variants)
			for (const attribute of variant.attributes ?? []) {
				const axis = byAttribute.get(attribute.id) ?? {
					key: `#attr.${attribute.id}`,
					label: attribute.name,
					grade: false,
					values: [],
					of: (other) => other.attributes?.find((entry) => entry.id === attribute.id)?.label ?? '',
				};
				if (!axis.values.some((entry) => entry.value === attribute.label))
					axis.values.push({ value: attribute.label, text: attribute.label });
				byAttribute.set(attribute.id, axis);
			}
		axes.push(...byAttribute.values());
	}
	/** @type {Map<string, Set<string>>} */
	const grades = new Map();
	for (const variant of item.variants) {
		const key = JSON.stringify(axes.map((axis) => axis.of(variant)));
		grades.set(key, (grades.get(key) ?? new Set()).add(variant.grade?.key ?? ''));
	}
	if ([...grades.values()].some((keys) => keys.size > 1)) {
		/** @type {Array<{ value: string, text: string }>} */
		const values = [];
		for (const variant of item.variants) {
			const value = variant.grade?.key ?? '';
			if (!values.some((entry) => entry.value === value)) values.push({ value, text: variant.grade?.label ?? '' });
		}
		axes.push({ key: GRADE_AXIS, label: '', grade: true, values, of: (variant) => variant.grade?.key ?? '' });
	}
	return axes;
};

/**
 * The variant of the chosen values.
 * @param {Axis[]} axes
 * @param {PageVariant[]} variants
 * @param {Record<string, string>} chosen
 * @returns {PageVariant | null}
 */
export const pickVariant = (axes, variants, chosen) =>
	variants.find((variant) => axes.every((axis) => axis.of(variant) === (chosen[axis.key] ?? ''))) ?? null;

/** @param {PageVariant} variant whether it can be added to the cart */
export const buyable = (variant) => variant.inStock && variant.soldOut !== true;

/**
 * The variant to show after the shopper picks `value` on `axis`: the one with that value sharing the most other chosen
 * values (one that can be bought first), so a pick never leads to a combination that does not exist.
 * @param {Axis[]} axes
 * @param {PageVariant[]} variants
 * @param {Record<string, string>} chosen
 * @param {Axis} axis
 * @param {string} value
 * @returns {PageVariant | null}
 */
export const nearestVariant = (axes, variants, chosen, axis, value) => {
	const exact = pickVariant(axes, variants, { ...chosen, [axis.key]: value });
	if (exact) return exact;
	/** @param {PageVariant} variant */
	const score = (variant) =>
		axes.filter((other) => other !== axis && other.of(variant) === (chosen[other.key] ?? '')).length * 2 +
		(buyable(variant) ? 1 : 0);
	return variants
		.filter((variant) => axis.of(variant) === value)
		.reduce(
			(best, variant) => (best === null || score(variant) > score(best) ? variant : best),
			/** @type {PageVariant | null} */ (null),
		);
};

/**
 * What the page says of a variant's stock (E9): Sold out, out of stock, "Only N left" up to `low`, "N in stock", or in
 * stock; `tone` is a status color.
 * @param {Texts} t
 * @param {PageVariant} variant
 * @param {number} low the `lowStockShown` setting
 * @returns {{ text: string, tone: 'danger' | 'warning' | 'success' }}
 */
export const stockText = (t, variant, low) => {
	if (variant.soldOut === true) return { text: t('page.soldOut'), tone: 'danger' };
	if (!variant.inStock) return { text: t('page.outOfStock'), tone: 'danger' };
	const left = variant.stockLeft;
	if (typeof left === 'number' && left > 0)
		return left <= low
			? { text: t('page.onlyLeft', { count: left }), tone: 'warning' }
			: { text: t('page.inStockCount', { count: left }), tone: 'success' };
	return { text: t('page.inStock'), tone: 'success' };
};

/**
 * A photo with its size and, while it loads, its blur placeholder (E6).
 * @param {Document} doc
 * @param {PageMedia} media
 * @param {'thumb' | 'detail'} size the smaller copy to show when there is one
 * @param {string} alt
 */
export const photoOf = (doc, media, size, alt) => {
	const img = /** @type {HTMLImageElement} */ (
		h(doc, 'img', {
			src: String(media.sizes?.[size] || media.url),
			alt,
			decoding: 'async',
			...(media.width ? { width: String(media.width) } : {}),
			...(media.height ? { height: String(media.height) } : {}),
		})
	);
	if (typeof media.blur === 'string' && /^data:image\/[\w.+-]+;base64,[\w+/=]+$/.test(media.blur)) {
		img.style.backgroundImage = `url("${media.blur}")`;
		img.classList.add('blur');
		img.addEventListener(
			'load',
			() => {
				img.style.removeProperty('background-image');
				img.classList.remove('blur');
			},
			{ once: true },
		);
	}
	return img;
};

/**
 * The link to a grade's condition video: its YouTube page, or the https address of the file (`videoUrl`, which the
 * shop answer fills in); '' without one.
 * @param {Pick<PageGrade, 'videoUrl'>} grade
 */
export const gradeVideoUrl = (grade) => {
	const value = grade.videoUrl;
	const id = youtubeId(value);
	if (id) return `https://www.youtube.com/watch?v=${id}`;
	return typeof value === 'string' && value.startsWith('https://') ? safeHref(value) : '';
};

/**
 * The details of a grade (E10): its color, label, description, content, return days and condition video.
 * @param {Document} doc
 * @param {Texts} t
 * @param {PageGrade} grade
 */
export const gradeDetails = (doc, t, grade) => {
	const swatch = h(doc, 'span', { class: 'swatch', 'aria-hidden': 'true' });
	if (grade.color) swatch.style.backgroundColor = grade.color;
	const bullets = grade.content?.bullets ?? [];
	const video = gradeVideoUrl(grade);
	return h(
		doc,
		'div',
		{ class: 'grade' },
		h(doc, 'p', { class: 'grade-name' }, grade.color ? swatch : null, t('page.grade', { grade: grade.label })),
		grade.description ? h(doc, 'p', { class: 'meta' }, grade.description) : null,
		grade.content?.summary ? h(doc, 'p', {}, grade.content.summary) : null,
		bullets.length > 0
			? h(
					doc,
					'ul',
					{ class: 'bullets' },
					...bullets.map((bullet) => h(doc, 'li', bullet.icon ? { 'data-icon': bullet.icon } : {}, bullet.text)),
				)
			: null,
		typeof grade.returnDays === 'number' && grade.returnDays > 0
			? h(doc, 'p', { class: 'meta' }, t('page.returnDays', { days: grade.returnDays }))
			: null,
		video ? h(doc, 'a', { href: video, target: '_blank', rel: 'noopener' }, t('page.gradeVideo')) : null,
	);
};

/**
 * The product video (E4): a file plays in the page, a YouTube video plays in its privacy-enhanced frame (loaded when
 * near), another address is a link; null without a video.
 * @param {Document} doc
 * @param {Texts} t
 * @param {any} video
 * @param {string} name the product's name (the frame's title)
 */
export const videoBlock = (doc, t, video, name) => {
	const url = typeof video?.url === 'string' && video.url.startsWith('https://') ? safeHref(video.url) : '';
	if (!url) return null;
	const player =
		video.kind === 'file'
			? h(
					doc,
					'video',
					{ controls: '', preload: 'metadata', 'aria-label': t('page.videoTitle', { name }) },
					h(doc, 'source', { src: url, ...(typeof video.type === 'string' && video.type ? { type: video.type } : {}) }),
					h(doc, 'a', { href: url }, t('page.videoLink')),
				)
			: video.kind === 'youtube'
				? h(doc, 'iframe', {
						src: url,
						title: t('page.videoTitle', { name }),
						loading: 'lazy',
						allow: 'encrypted-media; picture-in-picture; fullscreen',
						allowfullscreen: '',
						referrerpolicy: 'strict-origin-when-cross-origin',
					})
				: h(doc, 'a', { href: url, target: '_blank', rel: 'noopener' }, t('page.videoLink'));
	return h(
		doc,
		'section',
		{ class: 'wide', 'aria-label': t('page.video') },
		h(doc, 'h2', {}, t('page.video')),
		h(doc, 'div', { class: video.kind === 'url' ? '' : 'player' }, player),
	);
};

/**
 * The product's questions and answers (E16), or null without any.
 * @param {Document} doc
 * @param {Texts} t
 * @param {unknown} faqs
 */
export const faqBlock = (doc, t, faqs) => {
	const list = (Array.isArray(faqs) ? faqs : []).filter((faq) => faq && typeof faq.question === 'string' && faq.question);
	if (list.length === 0) return null;
	return h(
		doc,
		'section',
		{ class: 'wide faqs' },
		h(doc, 'h2', {}, t('page.faqs')),
		...list.map((faq) => h(doc, 'details', {}, h(doc, 'summary', {}, faq.question), ...paragraphs(doc, faq.answer))),
	);
};

// ---------------------------------------------------------------------------------------------- size guide (E5)

/** Plain numbers and ranges of numbers ("32", "32.5", "32-34") are converted between inches and centimeters. */
const NUMERIC = /^\s*(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?\s*$/;

/**
 * A size chart cell in another unit (1 in = 2.54 cm, one decimal); other text stays as it is.
 * @param {string} text
 * @param {'in' | 'cm'} from
 * @param {'in' | 'cm'} to
 */
export const convertCell = (text, from, to) => {
	const match = from === to ? null : NUMERIC.exec(text);
	if (!match) return text;
	/** @param {string} raw */
	const one = (raw) => (Number(raw.replace(',', '.')) * (from === 'in' ? 2.54 : 1 / 2.54)).toFixed(1);
	return match[2] ? `${one(String(match[1]))}–${one(match[2])}` : one(String(match[1]));
};

/**
 * @typedef {{ name: string, unit: string, columns: Array<{ key: string, label: string }>,
 *   rows: Array<{ size: string, label: string, values: Record<string, string> }>, fitAdvice: string, notes: string }} SizeChart
 */

/**
 * The Size guide: a button, and the dialog it opens in `layer` (a full-screen sheet on phones) with the table, the
 * in/cm switch, the fit advice and the notes. Escape, the Close button and a click beside the dialog close it, and the
 * focus goes back to the button.
 * @param {{ doc: Document, t: Texts, chart: SizeChart, layer: HTMLElement }} input
 */
export const sizeGuide = ({ doc, t, chart, layer }) => {
	const stored = chart.unit === 'cm' ? 'cm' : 'in';
	/** @type {'in' | 'cm'} */
	let unit = stored;
	const title = chart.name || t('page.sizeGuide');

	const close = () => {
		layer.replaceChildren();
		opener.focus();
	};

	const show = () => {
		const table = h(
			doc,
			'table',
			{ class: 'sizes' },
			h(
				doc,
				'thead',
				{},
				h(
					doc,
					'tr',
					{},
					h(doc, 'th', { scope: 'col' }, t('page.sizeColumn')),
					...chart.columns.map((column) => h(doc, 'th', { scope: 'col' }, column.label)),
				),
			),
			h(
				doc,
				'tbody',
				{},
				...chart.rows.map((row) =>
					h(
						doc,
						'tr',
						{},
						h(doc, 'th', { scope: 'row' }, row.label || row.size),
						...chart.columns.map((column) => h(doc, 'td', {}, convertCell(row.values?.[column.key] ?? '', stored, unit))),
					),
				),
			),
		);
		/** @param {'in' | 'cm'} to @param {string} text */
		const unitButton = (to, text) =>
			button(
				doc,
				text,
				() => {
					unit = to;
					show();
					/** @type {HTMLElement | null} */ (layer.querySelector(`[data-unit="${to}"]`))?.focus();
				},
				{ class: 'icon', 'aria-pressed': String(unit === to), 'data-unit': to },
			);
		const shut = button(doc, t('page.sizeClose'), close, { class: 'secondary', 'data-close': '' });
		const sheet = h(
			doc,
			'div',
			{ class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ss-size-title' },
			h(doc, 'div', { class: 'sheet-head' }, h(doc, 'h2', { id: 'ss-size-title' }, title), shut),
			h(
				doc,
				'div',
				{ class: 'actions', role: 'group', 'aria-label': t('page.sizeUnits') },
				unitButton('in', t('page.sizeIn')),
				unitButton('cm', t('page.sizeCm')),
			),
			h(doc, 'div', { class: 'scroll' }, table),
			chart.fitAdvice ? h(doc, 'h3', {}, t('page.fitAdvice')) : null,
			...paragraphs(doc, chart.fitAdvice),
			...paragraphs(doc, chart.notes).map((node) => {
				node.classList.add('meta');
				return node;
			}),
		);
		const overlay = h(doc, 'div', { class: 'overlay' }, sheet);
		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) close();
		});
		overlay.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') return close();
			if (event.key !== 'Tab') return;
			// the focus stays inside the dialog
			const stops = /** @type {HTMLElement[]} */ ([...sheet.querySelectorAll('button')]);
			const first = stops[0];
			const last = stops.at(-1);
			const active = /** @type {ShadowRoot | Document} */ (sheet.getRootNode()).activeElement;
			if (event.shiftKey && active === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && active === last) {
				event.preventDefault();
				first?.focus();
			}
		});
		const wasOpen = layer.childElementCount > 0;
		layer.replaceChildren(overlay);
		if (!wasOpen) shut.focus();
	};

	const opener = button(doc, t('page.sizeGuide'), show, {
		class: 'secondary',
		'aria-haspopup': 'dialog',
		'data-focus': 'sizeGuide',
	});
	return opener;
};

// ----------------------------------------------------------------------------------------------------- alerts

/**
 * An alert as the shop answers it.
 * @typedef {{ id: string, kind: string, productId: string, variantId: string | null, status: string }} ShopAlert
 */

/** @param {Shop} shop */
const createAlerts = (shop) => {
	/** @type {{ signIn: string | null, items: Promise<ShopAlert[]> } | null} */
	let cache = null;
	return Object.freeze({
		/**
		 * The signed-in shopper's alerts (empty for guests or when they cannot be read).
		 * @returns {Promise<ShopAlert[]>}
		 */
		list: () => {
			const signIn = shop.signIn();
			if (!signIn) return Promise.resolve([]);
			if (cache?.signIn !== signIn)
				cache = {
					signIn,
					items: shop
						.call('/v1/shop/alerts')
						.then((answer) => (answer.ok && Array.isArray(answer.data?.items) ? answer.data.items : [])),
				};
			return cache.items;
		},
		/** Read the alerts again on the next `list` (one was set or stopped). */
		forget: () => {
			cache = null;
		},
	});
};

/** @type {WeakMap<Shop, ReturnType<typeof createAlerts>>} */
const sharedAlerts = new WeakMap();

/**
 * The shopper's alerts shared by every widget of this `shop`.
 * @param {Shop} shop
 */
export const alertsOf = (shop) => {
	const found = sharedAlerts.get(shop);
	if (found) return found;
	const made = createAlerts(shop);
	sharedAlerts.set(shop, made);
	return made;
};
