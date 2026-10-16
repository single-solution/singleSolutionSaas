/**
 * Form pieces the catalog admin widget's editors share (PLAN 0.8.10 E1, E3, E16): FAQs, SEO fields (title,
 * description, canonical address, social image, noindex, nofollow, focus keyword) with the page's search result and
 * share preview (R7 #105, `@ss/ui/seo-preview`, redrawn as the merchant types), content blocks (a summary and
 * bullets with icons), groups of checkboxes, yes / no / inherited selects, and the rich description editor (a toolbar
 * that writes the allowed tags into the HTML and a live safe preview). Rich text is never inserted as HTML: it is
 * parsed in an inert document and only the allowed elements (and the `href` of links) are copied.
 * @module
 */

import { SEO_PREVIEW_TEXTS, seoPreview } from '@ss/ui/seo-preview';
import { htmlToText } from '../core/catalog-content.js';
import { categoryLink, productLink } from '../core/links.js';
import { previewHead } from '../core/seo-preview.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Choice} Choice */
/** @typedef {import('../core/seo-preview.js').PreviewPage} PreviewPage */
/** @typedef {'product' | 'category' | 'brand' | 'landing'} PreviewKind */
/** @typedef {{ question: string, answer: string }} Faq */

/** At most this many FAQs (E16), content bullets (E1). */
const MAX_FAQS = 20;
const MAX_BULLETS = 12;

/** The elements a rich description may hold (E3); `b` and `i` are read as `strong` and `em`. */
const RICH_TAGS = new Set(['p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a']);
/** A contact link rich text may keep (SF-1): an email address or a phone number. */
const CONTACT_LINK = /^(?:mailto:[^\s"'<>\\]{3,254}|tel:\+?[0-9][0-9 ().-]{2,30})$/i;
const RICH_SYNONYMS = Object.freeze(/** @type {Record<string, string>} */ ({ b: 'strong', i: 'em' }));
/** Elements dropped with everything inside them. */
const RICH_DROPPED = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math']);

/**
 * A link address kept in rich text: an https address or a path on the website, else ''.
 * @param {string} value
 */
export const safeHref = (value) => {
	const href = value.trim();
	if (href.startsWith('/') && !href.startsWith('//') && !/\s/.test(href)) return href;
	try {
		const url = new URL(href);
		return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
	} catch {
		return '';
	}
};

/**
 * Rich text as nodes of `doc`: parsed in an inert document, then only the allowed elements and text copied (other
 * elements give their children; scripts, styles and frames are dropped with their content).
 * @param {Document} doc @param {string} html
 * @returns {Node[]}
 */
export const richNodes = (doc, html) => {
	const inert = doc.implementation.createHTMLDocument('');
	const template = /** @type {HTMLTemplateElement} */ (inert.createElement('template'));
	template.innerHTML = html;
	/** @param {Node} source @returns {Node[]} */
	const copy = (source) =>
		[...source.childNodes].flatMap((node) => {
			if (node.nodeType === 3) return [doc.createTextNode(node.textContent ?? '')];
			if (node.nodeType !== 1) return [];
			const name = node.nodeName.toLowerCase();
			if (RICH_DROPPED.has(name)) return [];
			const tag = RICH_SYNONYMS[name] ?? name;
			if (!RICH_TAGS.has(tag)) return copy(node);
			const out = doc.createElement(tag);
			if (tag === 'a') {
				const raw = String(/** @type {Element} */ (node).getAttribute('href') ?? '').trim();
				const href = CONTACT_LINK.test(raw) ? raw : safeHref(raw);
				if (href) out.setAttribute('href', href);
				out.setAttribute('rel', 'noopener');
			}
			out.append(...copy(node));
			return [out];
		});
	return copy(template.content);
};

/**
 * Plain text as paragraphs of rich text (blank lines part paragraphs, single line breaks are kept).
 * @param {string} text
 */
export const paragraphsOf = (text) =>
	text
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.filter(Boolean)
		.map(
			(part) => `<p>${part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>')}</p>`,
		)
		.join('\n');

/**
 * The rich description editor: a toolbar (bold, italic, underline, headings, paragraph, quote, link, lists) that
 * wraps the selected text in the allowed tags, the HTML, and a live preview built safely.
 * @param {Kit} kit @param {string} html
 */
export const richEditor = (kit, html) => {
	const { t, h } = kit;
	const area = kit.area(html, { rows: '8', maxlength: '20000', spellcheck: 'true' });
	const preview = h('div', { class: 'rich preview', 'aria-label': t('catalogAdmin.preview') });
	const draw = () => preview.replaceChildren(...richNodes(kit.doc, area.value));
	area.addEventListener('input', draw);
	/** @param {(selected: string) => string} change */
	const edit = (change) => {
		const start = area.selectionStart;
		const end = area.selectionEnd;
		const next = change(area.value.slice(start, end));
		area.value = area.value.slice(0, start) + next + area.value.slice(end);
		area.setSelectionRange(start, start + next.length);
		draw();
	};
	/** @param {string} tag @param {string} [open] */
	const wrap = (tag, open = `<${tag}>`) => edit((selected) => `${open}${selected}</${tag}>`);
	/** @param {'ul' | 'ol'} tag */
	const list = (tag) =>
		edit((selected) => {
			const lines = selected.split(/\r?\n/).filter((entry) => entry.trim());
			return `<${tag}>${(lines.length > 0 ? lines : ['']).map((entry) => `<li>${entry.trim()}</li>`).join('')}</${tag}>`;
		});
	/** @type {Array<[string, () => void]>} */
	const tools = [
		['bold', () => wrap('strong')],
		['italic', () => wrap('em')],
		['underline', () => wrap('u')],
		['heading', () => wrap('h3')],
		['subheading', () => wrap('h4')],
		['paragraph', () => wrap('p')],
		['quote', () => wrap('blockquote')],
		['link', () => wrap('a', '<a href="https://">')],
		['bullets', () => list('ul')],
		['numbers', () => list('ol')],
	];
	const bar = h(
		'div',
		{ class: 'toolbar', role: 'toolbar', 'aria-label': t('catalogAdmin.formatting') },
		tools.map(([key, action]) => kit.button(t(`catalogAdmin.rich.${key}`), action)),
	);
	draw();
	return {
		node: kit.group(t('catalogAdmin.description'), [
			bar,
			kit.field(t('catalogAdmin.descriptionHtml'), area),
			kit.text('p', { class: 'muted' }, t('catalogAdmin.preview')),
			preview,
		]),
		value: () => area.value.trim(),
	};
};

/**
 * FAQs: a question and its answer per row, removable, with Add (at most 20).
 * @param {Kit} kit @param {Faq[]} faqs @param {string} [legend]
 */
export const faqsEditor = (kit, faqs, legend = kit.t('catalogAdmin.faqs')) => {
	const { t, h } = kit;
	const rows = h('div', { class: 'faqs' });
	/** @type {Array<{ question: HTMLInputElement, answer: HTMLTextAreaElement }>} */
	let entries = [];
	/** @param {Faq} faq */
	const make = (faq) => ({
		question: kit.input(faq.question, { maxlength: '300' }),
		answer: kit.area(faq.answer, { rows: '2', maxlength: '4000' }),
	});
	const draw = () => {
		rows.replaceChildren(
			...entries.map((entry, index) =>
				h('div', { class: 'faq' }, [
					kit.field(t('catalogAdmin.question', { number: index + 1 }), entry.question),
					kit.field(t('catalogAdmin.answer', { number: index + 1 }), entry.answer),
					kit.button(
						t('admin.remove'),
						() => {
							entries = entries.filter((other) => other !== entry);
							draw();
						},
						{ attributes: { 'aria-label': t('catalogAdmin.removeQuestion', { number: index + 1 }) } },
					),
				]),
			),
		);
		add.hidden = entries.length >= MAX_FAQS;
	};
	const add = kit.button(t('catalogAdmin.addQuestion'), () => {
		entries.push(make({ question: '', answer: '' }));
		draw();
	});
	entries = faqs.map(make);
	draw();
	return {
		node: kit.group(legend, [rows, add]),
		/** @returns {Faq[]} rows with something typed */
		value: () =>
			entries
				.map((entry) => ({ question: entry.question.value.trim(), answer: entry.answer.value.trim() }))
				.filter((faq) => faq.question || faq.answer),
	};
};

/**
 * @typedef {{ title?: string, description?: string, canonicalUrl?: string, ogImage?: string, noindex?: boolean,
 *   nofollow?: boolean, focusKeyword?: string, titleMode?: 'template' | 'as_written',
 *   source?: 'merchant' | 'import' | 'ai' | null, score?: number }} Seo
 */

/**
 * The addresses of product and category pages from the editor's values (the `catalog` settings `productUrl` and
 * `categoryUrl` on the website's domain), or '' without a domain or slug.
 * @param {Kit} kit
 * @param {Array<{ id: string, slug?: string, path?: string[] }>} categories
 * @param {Array<{ id: string, slug?: string }>} brands
 */
export const pageLinks = (kit, categories, brands) => {
	const domain = String(kit.settings.seo?.domain ?? '');
	const context = {
		domain,
		categories: new Map(categories.map((item) => [item.id, { slug: item.slug ?? '', path: item.path ?? [] }])),
		brands: new Map(brands.map((item) => [item.id, { slug: item.slug ?? '' }])),
	};
	return {
		/** @param {{ id: string, slug: string, categoryIds: string[], brandId: string | null }} product */
		product: (product) =>
			domain && product.slug ? productLink(String(kit.settings.catalog?.productUrl ?? ''), product, context) : '',
		/** @param {{ id?: string, slug: string }} category */
		category: (category) =>
			domain && category.slug ? categoryLink(String(kit.settings.catalog?.categoryUrl ?? ''), category, context) : '',
	};
};

/** Plain text of rich text, for a description that falls back on it. @param {string} html */
export const plainOf = (html) => htmlToText(html);

/**
 * The search result and share preview of a page (R7 #105): the head {@link previewHead} works out from what `read`
 * gives now, redrawn by `refresh` (and on every input and change inside the nodes given to `watch`); null when the
 * widget config has no SEO settings.
 * @param {Kit} kit
 * @param {PreviewKind} kind
 * @param {() => PreviewPage} read
 */
export const seoPreviewOf = (kit, kind, read) => {
	const settings = kit.settings.seo;
	if (!settings) return null;
	const texts = Object.fromEntries(Object.keys(SEO_PREVIEW_TEXTS).map((key) => [key, kit.t(`catalogAdmin.seoPreview.${key}`)]));
	const view = seoPreview(kit.doc, previewHead(kind, read(), settings), { texts });
	const refresh = () => view.update(previewHead(kind, read(), settings));
	return {
		node: view.node,
		refresh,
		/** @param {...(Node | null | undefined)} nodes */
		watch: (...nodes) => {
			for (const node of nodes) {
				node?.addEventListener('input', refresh);
				node?.addEventListener('change', refresh);
			}
		},
	};
};

/**
 * The SEO fields of a product, category or brand (E16), with the page's preview when `page` says which page they
 * describe (`read`: the editor's other values now; `watch` the nodes holding them).
 * @param {Kit} kit @param {Seo | null | undefined} seo
 * @param {{ kind: PreviewKind, read: () => Omit<PreviewPage, 'seo'> }} [page]
 */
export const seoEditor = (kit, seo, page) => {
	const { t, h } = kit;
	const given = seo ?? {};
	const title = kit.input(given.title ?? '', { maxlength: '200' });
	const description = kit.area(given.description ?? '', { maxlength: '500' });
	const canonical = kit.input(given.canonicalUrl ?? '', { maxlength: '500', inputmode: 'url' });
	const image = kit.input(given.ogImage ?? '', { maxlength: '500', inputmode: 'url' });
	const keyword = kit.input(given.focusKeyword ?? '', { maxlength: '100' });
	const noindex = kit.check(t('catalogAdmin.noindex'), given.noindex === true);
	const nofollow = kit.check(t('catalogAdmin.nofollow'), given.nofollow === true);
	const asWritten = kit.check(t('catalogAdmin.titleAsWritten'), given.titleMode === 'as_written');
	const preview = page
		? seoPreviewOf(kit, page.kind, () => ({
				...page.read(),
				seo: {
					title: title.value,
					titleMode: asWritten.box.checked ? 'as_written' : 'template',
					description: description.value,
					canonicalUrl: canonical.value,
					ogImage: image.value,
				},
			}))
		: null;
	const node = kit.group(t('catalogAdmin.seo'), [
		h('div', { class: 'fields' }, [
			kit.field(t('catalogAdmin.seoTitle'), title),
			kit.field(t('catalogAdmin.focusKeyword'), keyword),
			kit.field(t('catalogAdmin.canonicalUrl'), canonical),
			kit.field(t('catalogAdmin.ogImage'), image),
		]),
		asWritten.node,
		kit.field(t('catalogAdmin.seoDescription'), description),
		h('div', { class: 'fields' }, [noindex.node, nofollow.node]),
		preview?.node,
	]);
	preview?.watch(node);
	return {
		node,
		/** Redraw the preview when any of these nodes' fields change. @param {...(Node | null | undefined)} nodes */
		watch: (...nodes) => preview?.watch(...nodes),
		value: () => ({
			title: title.value.trim(),
			description: description.value.trim(),
			canonicalUrl: canonical.value.trim(),
			ogImage: image.value.trim(),
			noindex: noindex.box.checked,
			nofollow: nofollow.box.checked,
			focusKeyword: keyword.value.trim(),
			titleMode: asWritten.box.checked ? 'as_written' : 'template',
		}),
	};
};

/**
 * The SEO fields as facts of a detail, with the SEO score while SEO is on (E42).
 * @param {Kit} kit @param {Seo | null | undefined} seo
 * @returns {Array<[string, string]>}
 */
export const seoFacts = (kit, seo) => {
	const { t } = kit;
	const given = seo ?? {};
	return [
		[
			t('catalogAdmin.seoTitle'),
			given.title && given.titleMode === 'as_written'
				? t('catalogAdmin.asWrittenTitle', { title: given.title })
				: (given.title ?? ''),
		],
		[t('catalogAdmin.seoDescription'), given.description ?? ''],
		[t('catalogAdmin.seoSource'), given.source ? t(`catalogAdmin.seoSource.${given.source}`) : ''],
		[t('catalogAdmin.focusKeyword'), given.focusKeyword ?? ''],
		[t('catalogAdmin.canonicalUrl'), given.canonicalUrl ?? ''],
		[t('catalogAdmin.ogImage'), given.ogImage ?? ''],
		[t('catalogAdmin.robots'), [given.noindex ? 'noindex' : '', given.nofollow ? 'nofollow' : ''].filter(Boolean).join(', ')],
		[t('catalogAdmin.seoScore'), typeof given.score === 'number' ? t('catalogAdmin.seoScoreOf', { score: given.score }) : ''],
	];
};

/**
 * A record's SEO checks (E42, while SEO is on): each passed or to fix; null without checks.
 * @param {Kit} kit @param {{ checks?: Array<{ key: string, ok: boolean }> } | null | undefined} seo
 */
export const seoChecks = (kit, seo) => {
	const { t, h } = kit;
	if (!Array.isArray(seo?.checks) || seo.checks.length === 0) return null;
	return h(
		'ul',
		{ class: 'checks', 'aria-label': t('catalogAdmin.seoChecks') },
		seo.checks.map((check) =>
			h('li', {}, [
				kit.badge(t(check.ok ? 'catalogAdmin.seoCheckPassed' : 'catalogAdmin.seoCheckFix'), check.ok ? 'success' : 'warning'),
				kit.text('span', {}, ` ${t(`catalogAdmin.seoCheck.${check.key}`)}`),
			]),
		),
	);
};

/**
 * A content block (E1): a summary and up to 12 bullets, each a text with an icon name.
 * @param {Kit} kit @param {{ summary?: string, bullets?: Array<{ text: string, icon: string }> } | null | undefined} content
 */
export const contentEditor = (kit, content) => {
	const { t, h } = kit;
	const summary = kit.area(content?.summary ?? '', { rows: '3', maxlength: '2000' });
	const rows = h('div', { class: 'bullets' });
	/** @type {Array<{ text: HTMLInputElement, icon: HTMLInputElement }>} */
	let entries = [];
	/** @param {{ text: string, icon: string }} bullet */
	const make = (bullet) => ({
		text: kit.input(bullet.text, { maxlength: '300' }),
		icon: kit.input(bullet.icon, { maxlength: '40' }),
	});
	const draw = () => {
		rows.replaceChildren(
			...entries.map((entry, index) =>
				h('div', { class: 'row inline' }, [
					kit.field(t('catalogAdmin.bullet', { number: index + 1 }), entry.text),
					kit.field(t('catalogAdmin.bulletIcon', { number: index + 1 }), entry.icon),
					kit.button(
						t('admin.remove'),
						() => {
							entries = entries.filter((other) => other !== entry);
							draw();
						},
						{ attributes: { 'aria-label': t('catalogAdmin.removeBullet', { number: index + 1 }) } },
					),
				]),
			),
		);
		add.hidden = entries.length >= MAX_BULLETS;
	};
	const add = kit.button(t('catalogAdmin.addBullet'), () => {
		entries.push(make({ text: '', icon: '' }));
		draw();
	});
	entries = (content?.bullets ?? []).map(make);
	draw();
	return {
		node: kit.group(t('catalogAdmin.content'), [kit.field(t('catalogAdmin.contentSummary'), summary), rows, add]),
		value: () => ({
			summary: summary.value.trim(),
			bullets: entries
				.map((entry) => ({ text: entry.text.value.trim(), icon: entry.icon.value.trim() }))
				.filter((bullet) => bullet.text),
		}),
	};
};

/**
 * A group of checkboxes, with an optional count badge per choice.
 * @param {Kit} kit @param {string} legend @param {Choice[]} choices @param {string[]} chosen
 * @param {Record<string, number>} [counts]
 */
export const checkGroup = (kit, legend, choices, chosen, counts) => {
	const boxes = choices.map((choice) => {
		const { box, node } = kit.check(choice.label, chosen.includes(choice.value));
		if (counts) node.append(kit.countBadge(counts[choice.value] ?? 0) ?? '');
		return { value: choice.value, box, node };
	});
	return {
		node: kit.group(legend, [
			kit.h(
				'div',
				{ class: 'checks' },
				boxes.map((entry) => entry.node),
			),
		]),
		/** @returns {string[]} */
		value: () => boxes.filter((entry) => entry.box.checked).map((entry) => entry.value),
	};
};

/**
 * Choices of a size chart select (E5): none, then the charts by name.
 * @param {Kit} kit @param {Array<{ id: string, name: string }>} charts
 * @returns {Choice[]}
 */
export const chartChoices = (kit, charts) => [
	{ value: '', label: kit.t('catalogAdmin.noChart') },
	...charts.map((chart) => ({ value: chart.id, label: chart.name })),
];

/**
 * The earlier addresses of a product or category (E13), read only.
 * @param {Kit} kit @param {string[] | undefined} previous
 */
export const earlierSlugs = (kit, previous) =>
	previous && previous.length > 0
		? kit.text('p', { class: 'muted' }, kit.t('catalogAdmin.earlierSlugs', { slugs: previous.join(', ') }))
		: null;
