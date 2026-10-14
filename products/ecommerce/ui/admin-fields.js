/**
 * Form pieces the catalog admin widget's editors share (PLAN 0.8.10 E1, E3, E16): FAQs, SEO fields (title,
 * description, canonical address, social image, noindex, nofollow, focus keyword), content blocks (a summary and
 * bullets with icons), groups of checkboxes, yes / no / inherited selects, and the rich description editor (a toolbar
 * that writes the allowed tags into the HTML and a live safe preview). Rich text is never inserted as HTML: it is
 * parsed in an inert document and only the allowed elements (and the `href` of links) are copied.
 * @module
 */

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Choice} Choice */
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
 *   nofollow?: boolean, focusKeyword?: string }} Seo
 */

/**
 * The SEO fields of a product, category or brand (E16).
 * @param {Kit} kit @param {Seo | null | undefined} seo
 */
export const seoEditor = (kit, seo) => {
	const { t, h } = kit;
	const given = seo ?? {};
	const title = kit.input(given.title ?? '', { maxlength: '200' });
	const description = kit.area(given.description ?? '', { maxlength: '500' });
	const canonical = kit.input(given.canonicalUrl ?? '', { maxlength: '500', inputmode: 'url' });
	const image = kit.input(given.ogImage ?? '', { maxlength: '500', inputmode: 'url' });
	const keyword = kit.input(given.focusKeyword ?? '', { maxlength: '100' });
	const noindex = kit.check(t('catalogAdmin.noindex'), given.noindex === true);
	const nofollow = kit.check(t('catalogAdmin.nofollow'), given.nofollow === true);
	return {
		node: kit.group(t('catalogAdmin.seo'), [
			h('div', { class: 'fields' }, [
				kit.field(t('catalogAdmin.seoTitle'), title),
				kit.field(t('catalogAdmin.focusKeyword'), keyword),
				kit.field(t('catalogAdmin.canonicalUrl'), canonical),
				kit.field(t('catalogAdmin.ogImage'), image),
			]),
			kit.field(t('catalogAdmin.seoDescription'), description),
			h('div', { class: 'fields' }, [noindex.node, nofollow.node]),
		]),
		value: () => ({
			title: title.value.trim(),
			description: description.value.trim(),
			canonicalUrl: canonical.value.trim(),
			ogImage: image.value.trim(),
			noindex: noindex.box.checked,
			nofollow: nofollow.box.checked,
			focusKeyword: keyword.value.trim(),
		}),
	};
};

/**
 * The SEO fields as facts of a detail.
 * @param {Kit} kit @param {Seo | null | undefined} seo
 * @returns {Array<[string, string]>}
 */
export const seoFacts = (kit, seo) => {
	const { t } = kit;
	const given = seo ?? {};
	return [
		[t('catalogAdmin.seoTitle'), given.title ?? ''],
		[t('catalogAdmin.seoDescription'), given.description ?? ''],
		[t('catalogAdmin.focusKeyword'), given.focusKeyword ?? ''],
		[t('catalogAdmin.canonicalUrl'), given.canonicalUrl ?? ''],
		[t('catalogAdmin.ogImage'), given.ogImage ?? ''],
		[t('catalogAdmin.robots'), [given.noindex ? 'noindex' : '', given.nofollow ? 'nofollow' : ''].filter(Boolean).join(', ')],
	];
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
 * Yes, no, or as something else says (null).
 * @param {Kit} kit @param {boolean | null | undefined} value @param {string} inheritLabel
 */
export const triSelect = (kit, value, inheritLabel) => {
	const node = kit.select(
		[
			{ value: 'inherit', label: inheritLabel },
			{ value: 'yes', label: kit.t('admin.yes') },
			{ value: 'no', label: kit.t('admin.no') },
		],
		value === true ? 'yes' : value === false ? 'no' : 'inherit',
	);
	return {
		node,
		/** @returns {boolean | null} */
		value: () => (node.value === 'yes' ? true : node.value === 'no' ? false : null),
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
