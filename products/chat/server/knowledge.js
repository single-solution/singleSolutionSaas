/**
 * Knowledge (PLAN 0.8.3): FAQ entries and articles (knowledge base) and website pages (fetched through `@ss/net` when
 * added and with Fetch again, never on a schedule), indexed as chunks for keyword retrieval. Edited in the knowledge
 * editor widget (ticket, `knowledge.edit`) or through the server API (acting for the `SS-Actor-*` user); edits are
 * written to the activity log with the entry's title or the page's title as their label.
 * @module
 */
import { created, noContent, paginate, problem } from '@ss/app-kit';
import { textOf } from '@ss/net';
import { MAX_ENTRIES, MAX_PAGES, checkEntry, entryChunks, htmlToText, pageChunks } from '../core/knowledge.js';
import { isHttpsUrl } from '../core/tools.js';
import { actorOf } from './inbox.js';
import { bodyOf, invalid } from './service.js';

/** @typedef {import('../adapters/store.js').EntryRecord} EntryRecord */
/** @typedef {import('../adapters/store.js').PageRecord} PageRecord */

/** Largest page fetched (bytes) and its deadline (ms). */
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 10_000;

/** @param {EntryRecord} e */
const entryView = (e) => ({
	id: e.id,
	kind: e.kind,
	title: e.title,
	text: e.text,
	updatedAt: new Date(e.updatedAt).toISOString(),
});

/** The kinds of entries in activity details. */
const KINDS = Object.freeze({ faq: 'FAQ', article: 'Article' });

/**
 * A page's activity label (its title, else its address) and detail (fetched, or why not).
 * @param {PageRecord} p
 */
const pageAbout = (p) => ({
	label: p.title || p.url,
	detail: p.status === 'ok' ? 'Fetched' : `Not fetched: ${p.error ?? 'unknown reason'}`,
});

/** @param {PageRecord} p */
const pageView = (p) => ({
	id: p.id,
	url: p.url,
	title: p.title,
	status: p.status,
	error: p.error,
	fetchedAt: p.fetchedAt ? new Date(p.fetchedAt).toISOString() : null,
});

/**
 * @param {import('../adapters/product.js').Product} product
 * @param {import('./service.js').Service} service
 */
export const createKnowledge = (product, service) => {
	const { now } = product;

	/** @param {any} ctx */
	const entries = async (ctx) => {
		const s = await service.site(ctx);
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const q = typeof ctx.query.q === 'string' && ctx.query.q.trim() ? ctx.query.q.trim().slice(0, 100) : null;
		const rows = await s.store.knowledge.entries({
			q,
			after: /** @type {[string, string] | null} */ (page.after),
			limit: page.fetchLimit,
		});
		return page.respond(rows.map(entryView), (e) => [e.updatedAt, e.id]);
	};

	/** @param {any} ctx */
	const createEntry = async (ctx) => {
		const s = await service.site(ctx);
		const checked = checkEntry(ctx.body);
		if (!checked.ok) throw invalid(checked.errors);
		if ((await s.store.knowledge.countEntries()) >= MAX_ENTRIES) throw invalid([`Up to ${MAX_ENTRIES} entries.`]);
		const entry = await s.store.knowledge.createEntry(checked.value);
		await s.store.knowledge.replaceChunks(entry.id, entryChunks(entry));
		await service.log(s, actorOf(ctx), 'knowledge.entry_created', entry.id, { label: entry.title, detail: KINDS[entry.kind] });
		return created({ entry: entryView(entry) });
	};

	/** @param {any} ctx */
	const updateEntry = async (ctx) => {
		const s = await service.site(ctx);
		const checked = checkEntry(ctx.body);
		if (!checked.ok) throw invalid(checked.errors);
		const entry = await s.store.knowledge.updateEntry(String(ctx.params.id), checked.value);
		if (!entry) throw problem('not_found', 'No such entry.');
		await s.store.knowledge.replaceChunks(entry.id, entryChunks(entry));
		await service.log(s, actorOf(ctx), 'knowledge.entry_updated', entry.id, { label: entry.title, detail: KINDS[entry.kind] });
		return { entry: entryView(entry) };
	};

	/** @param {any} ctx */
	const deleteEntry = async (ctx) => {
		const s = await service.site(ctx);
		const id = String(ctx.params.id);
		const removed = await s.store.knowledge.removeEntry(id);
		if (!removed) throw problem('not_found', 'No such entry.');
		await s.store.knowledge.replaceChunks(id, []);
		await service.log(s, actorOf(ctx), 'knowledge.entry_deleted', id, { label: removed.title, detail: KINDS[removed.kind] });
		return noContent();
	};

	/**
	 * Fetch a page now and index its text (a failure is kept on the page with its reason).
	 * @param {import('./service.js').Site} s
	 * @param {PageRecord} page
	 */
	const fetchPage = async (s, page) => {
		/** @type {Partial<PageRecord>} */
		let set;
		try {
			const response = await product.send(page.url, {
				timeoutMs: PAGE_TIMEOUT_MS,
				maxBytes: PAGE_MAX_BYTES,
				headers: { accept: 'text/html' },
			});
			if (response.status < 200 || response.status > 299)
				set = { status: 'failed', error: `The page answered ${response.status}.` };
			else {
				const { title, text } = htmlToText(textOf(response));
				set = { title: title || page.url, text, status: 'ok', error: null };
			}
		} catch {
			set = { status: 'failed', error: 'The page cannot be reached.' };
		}
		const updated = /** @type {PageRecord} */ (
			await s.store.knowledge.updatePage(page.id, { ...set, fetchedAt: new Date(now()) })
		);
		await s.store.knowledge.replaceChunks(page.id, updated.status === 'ok' ? pageChunks(updated) : []);
		return updated;
	};

	/** @param {any} ctx */
	const pages = async (ctx) => ({ items: (await (await service.site(ctx)).store.knowledge.pages()).map(pageView) });

	/** @param {any} ctx */
	const addPage = async (ctx) => {
		const s = await service.site(ctx);
		const url = bodyOf(ctx.body).url;
		if (!isHttpsUrl(url)) throw invalid(['Enter an https address.']);
		if ((await s.store.knowledge.countPages()) >= MAX_PAGES) throw invalid([`Up to ${MAX_PAGES} pages.`]);
		const page = await fetchPage(s, await s.store.knowledge.createPage(String(url)));
		await service.log(s, actorOf(ctx), 'knowledge.page_added', page.id, pageAbout(page));
		return created({ page: pageView(page) });
	};

	/** @param {any} ctx */
	const refetchPage = async (ctx) => {
		const s = await service.site(ctx);
		const page = await s.store.knowledge.page(String(ctx.params.id));
		if (!page) throw problem('not_found', 'No such page.');
		const updated = await fetchPage(s, page);
		await service.log(s, actorOf(ctx), 'knowledge.page_fetched', page.id, pageAbout(updated));
		return { page: pageView(updated) };
	};

	/** @param {any} ctx */
	const deletePage = async (ctx) => {
		const s = await service.site(ctx);
		const id = String(ctx.params.id);
		const removed = await s.store.knowledge.removePage(id);
		if (!removed) throw problem('not_found', 'No such page.');
		await s.store.knowledge.replaceChunks(id, []);
		await service.log(s, actorOf(ctx), 'knowledge.page_deleted', id, { label: removed.title || removed.url });
		return noContent();
	};

	return Object.freeze({ entries, createEntry, updateEntry, deleteEntry, pages, addPage, refetchPage, deletePage });
};
