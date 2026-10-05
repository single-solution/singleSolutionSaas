/**
 * List operations (Mode C semantics shared by the API routes, the widget state call and the dashboard): create, read,
 * rename / opt in, delete, add and remove items, and the guest → customer merge. Rules live in core/; this module
 * reads and writes through the repositories and returns outcomes, never HTTP. Entry changes are compare-and-set on
 * the list's `rev`, retried, so concurrent hearts on two tabs never lose a change.
 */
import { parseItem } from '../core/item.js';
import { addEntry, listName, newEntry, planMerge, removeEntry } from '../core/lists.js';
import { listView } from '../core/views.js';
import { CAS_ATTEMPTS } from '../adapters/db.js';

/**
 * @typedef {import('../adapters/db.js').Owner} Owner
 * @typedef {import('../core/views.js').StoredList & { rev: number, contactEmail?: string | null }} List
 * @typedef {{ ok: false, code: string, detail?: string, errors?: Array<{ path: string, code: string }> }} Failure
 * @typedef {{ ok: true, status?: number, body: any } | Failure} Outcome
 * @typedef {object} Site
 * @property {string} websiteId
 * @property {any} doc
 * @property {import('./settings.js').Settings} settings
 * @property {import('../adapters/db.js').Repositories} repos
 * @property {string | null} domain
 * @property {boolean} allowSubdomains
 * @property {string} lang the website's language (entitlement), for default names
 * @property {(key: string) => string} text a string of the catalog in the website's language
 * @typedef {object} Deps
 * @property {() => number} now
 * @property {(prefix: string) => string} newId
 */

/** Alias of an owner's default list in paths. */
export const DEFAULT_LIST = 'default';
/** Most lists returned for one owner. */
export const MAX_OWNER_LISTS = 100;

/**
 * @param {string} code
 * @param {string} [detail]
 * @param {Array<{ path: string, code: string }>} [errors]
 * @returns {Failure}
 */
export const failure = (code, detail, errors) => ({
	ok: false,
	code,
	...(detail ? { detail } : {}),
	...(errors ? { errors } : {}),
});

/**
 * @param {Deps} deps
 */
export const createLists = (deps) => {
	const DAY_MS = 86_400_000;
	/** @param {Site} site @param {Owner} owner */
	const expiryFor = (site, owner) =>
		owner.kind === 'guest' ? new Date(deps.now() + site.settings.guests.ttlDays * DAY_MS) : null;
	/** @param {List} list @param {Owner | null} owner */
	const owns = (list, owner) => owner === null || (list.ownerKind === owner.kind && list.ownerId === owner.id);
	/** @param {List} list @param {Owner | null} owner */
	const view = (list, owner) => listView(list, { items: true, reveal: owner === null, now: deps.now() });

	/**
	 * A new list document.
	 * @param {Site} site
	 * @param {Owner} owner
	 * @param {{ name: string, isDefault: boolean, notify?: boolean, items?: import('../core/lists.js').Entry[] }} fields
	 * @returns {List & { expiresAt: Date | null }}
	 */
	const draft = (site, owner, { name, isDefault, notify = false, items = [] }) => {
		const on = new Date(deps.now()).toISOString();
		return {
			id: deps.newId('wl'),
			ownerKind: owner.kind,
			ownerId: owner.id,
			name,
			isDefault,
			notify,
			items,
			share: null,
			rev: 0,
			createdOn: on,
			touchedOn: on,
			expiresAt: expiryFor(site, owner),
		};
	};

	/**
	 * The owner's default list (else their oldest list), created when they have none.
	 * @param {Site} site
	 * @param {Owner} owner
	 * @returns {Promise<List>}
	 */
	const defaultList = async (site, owner) => {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const found = (await site.repos.lists.defaultOf(owner)) ?? (await site.repos.lists.ofOwner(owner, 1))[0];
			if (found) return found;
			const list = draft(site, owner, { name: site.text('list.default_name'), isDefault: true });
			if (await site.repos.lists.insert(list)) return list;
		}
		/* v8 ignore next -- a concurrent insert always leaves a default list to find */
		throw new Error('default list could not be created');
	};

	/**
	 * A list the owner may act on (`default` = their default list, created on demand when `create`).
	 * @param {Site} site
	 * @param {Owner | null} owner null = server key acting merchant-wide
	 * @param {string} id
	 * @param {{ create?: boolean }} [options]
	 * @returns {Promise<List | null>}
	 */
	const owned = async (site, owner, id, { create = false } = {}) => {
		if (id === DEFAULT_LIST) {
			if (!owner) return null;
			return create ? defaultList(site, owner) : ((await site.repos.lists.defaultOf(owner)) ?? null);
		}
		const list = await site.repos.lists.get(id);
		return list && owns(list, owner) ? list : null;
	};

	/**
	 * Apply an entry change with compare-and-set on `rev`.
	 * @param {Site} site
	 * @param {Owner | null} owner
	 * @param {string} id
	 * @param {(list: List) => { ok: true, items: import('../core/lists.js').Entry[], result: Record<string, unknown> }
	 *   | Failure} change
	 * @param {{ create?: boolean }} [options]
	 * @returns {Promise<Outcome>}
	 */
	const mutate = async (site, owner, id, change, options = {}) => {
		for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
			const list = await owned(site, owner, id, options);
			if (!list) return failure('not_found', 'No such list.');
			const next = change(list);
			if (!next.ok) return next;
			const holder = { kind: list.ownerKind, id: list.ownerId };
			const set = holder.kind === 'guest' ? { expiresAt: expiryFor(site, holder) } : {};
			if (await site.repos.lists.replaceItems(list.id, list.rev, next.items, set)) {
				const saved = { ...list, items: next.items, rev: list.rev + 1, touchedOn: new Date(deps.now()).toISOString() };
				return { ok: true, body: { ...next.result, list: view(saved, owner) } };
			}
		}
		return failure('conflict', 'The list changed too often; try again.');
	};

	return Object.freeze({
		owned,
		defaultList,
		/**
		 * @param {Site} site
		 * @param {Owner | null} owner
		 * @param {{ after?: unknown, fetchLimit: number }} page
		 */
		page: async (site, owner, page) =>
			(await site.repos.lists.page({ owner, ...page })).map((/** @type {List} */ list) =>
				listView(list, { reveal: owner === null, now: deps.now() }),
			),
		/**
		 * Every list of an owner with items (the widget state).
		 * @param {Site} site
		 * @param {Owner} owner
		 */
		ofOwner: async (site, owner) =>
			(await site.repos.lists.ofOwner(owner, MAX_OWNER_LISTS)).map((/** @type {List} */ list) => view(list, owner)),
		/**
		 * @param {Site} site
		 * @param {Owner | null} owner
		 * @param {string} id
		 * @returns {Promise<Outcome>}
		 */
		get: async (site, owner, id) => {
			const list = await owned(site, owner, id);
			return list ? { ok: true, body: view(list, owner) } : failure('not_found', 'No such list.');
		},
		/**
		 * Create a named list (the owner's first list becomes their default list).
		 * @param {Site} site
		 * @param {Owner} owner
		 * @param {Record<string, unknown>} body
		 * @returns {Promise<Outcome>}
		 */
		create: async (site, owner, body) => {
			const name = listName(body.name, site.settings.lists.maxNameLength);
			if (!name) return failure('validation_failed', 'A list name is required.', [{ path: '/name', code: 'required' }]);
			const count = await site.repos.lists.countOfOwner(owner);
			if (count >= site.settings.lists.maxLists)
				return failure('limit_reached', `At most ${site.settings.lists.maxLists} lists.`);
			let list = draft(site, owner, { name, isDefault: count === 0 });
			// a concurrent first save created the default list meanwhile: this one is a named list
			if (!(await site.repos.lists.insert(list))) {
				list = { ...list, isDefault: false };
				await site.repos.lists.insert(list);
			}
			return { ok: true, status: 201, body: listView(list, { items: true, now: deps.now() }) };
		},
		/**
		 * Rename a list, or opt in / out of price-drop and back-in-stock signals (customers only).
		 * @param {Site} site
		 * @param {Owner | null} owner
		 * @param {string} id
		 * @param {Record<string, unknown>} body
		 * @param {{ email?: string | null }} [identity] the login's e-mail, kept for signals when the merchant allows
		 * @returns {Promise<Outcome>}
		 */
		update: async (site, owner, id, body, { email = null } = {}) => {
			/** @type {Record<string, unknown>} */
			const set = {};
			if (body.name !== undefined) {
				const name = listName(body.name, site.settings.lists.maxNameLength);
				if (!name) return failure('validation_failed', 'The list name is empty.', [{ path: '/name', code: 'invalid' }]);
				set.name = name;
			}
			if (body.notify !== undefined) {
				if (typeof body.notify !== 'boolean')
					return failure('validation_failed', 'notify must be a boolean.', [{ path: '/notify', code: 'invalid' }]);
				if (!site.settings.enabled('price_drop_hook'))
					return failure('element_disabled', 'Price-drop and back-in-stock signals are not enabled.');
				if (owner?.kind === 'guest')
					return failure('identity_required', 'Sign in to be told about price drops and restocks.');
				set.notify = body.notify;
				set.notifyChangedOn = new Date(deps.now()).toISOString();
				set.contactEmail = body.notify && site.settings.signals.includeEmail ? email : null;
			}
			if (Object.keys(set).length === 0)
				return failure('validation_failed', 'Nothing to change.', [{ path: '/', code: 'empty' }]);
			const list = await owned(site, owner, id);
			if (!list) return failure('not_found', 'No such list.');
			if (set.notify === true && list.ownerKind !== 'customer')
				return failure('identity_required', 'Only customer lists can receive signals.');
			const saved = await site.repos.lists.update(list.id, set);
			return { ok: true, body: view(saved, owner) };
		},
		/**
		 * Delete a list; when it was the default list, the owner's oldest remaining list becomes the default.
		 * @param {Site} site
		 * @param {Owner | null} owner
		 * @param {string} id
		 * @returns {Promise<Outcome>}
		 */
		remove: async (site, owner, id) => {
			const list = await owned(site, owner, id);
			if (!list || !(await site.repos.lists.remove(list.id))) return failure('not_found', 'No such list.');
			if (list.isDefault) {
				const [next] = await site.repos.lists.ofOwner({ kind: list.ownerKind, id: list.ownerId }, 1);
				if (next) await site.repos.lists.update(next.id, { isDefault: true });
			}
			return { ok: true, body: { id: list.id, deleted: true } };
		},
		/**
		 * Save an item (to `default` or a named list).
		 * @param {Site} site
		 * @param {Owner | null} owner
		 * @param {string} id
		 * @param {unknown} input the item
		 * @returns {Promise<Outcome>}
		 */
		addItem: async (site, owner, id, input) => {
			const parsed = parseItem(input, {
				urlPolicy: site.settings.lists.urlPolicy,
				imagePolicy: site.settings.lists.imagePolicy,
				domain: site.domain,
				allowSubdomains: site.allowSubdomains,
			});
			if (!parsed.ok) return failure('validation_failed', 'The item is not valid.', parsed.errors);
			const entry = newEntry(parsed.item, { id: deps.newId('wli'), now: deps.now() });
			const outcome = await mutate(
				site,
				owner,
				id,
				(list) => {
					const added = addEntry(list.items, entry, {
						max: site.settings.lists.maxItems,
						whenFull: site.settings.lists.whenFull,
					});
					if (!added.ok) return failure('limit_reached', `A list holds at most ${site.settings.lists.maxItems} items.`);
					return {
						ok: true,
						items: added.entries,
						result: { entryId: added.entry.id, added: added.added, evicted: added.evicted.map((e) => e.id) },
					};
				},
				{ create: owner !== null },
			);
			return outcome.ok && outcome.body.added ? { ...outcome, status: 201 } : outcome;
		},
		/**
		 * Remove a saved item by entry id.
		 * @param {Site} site
		 * @param {Owner | null} owner
		 * @param {string} id
		 * @param {string} entryId
		 * @returns {Promise<Outcome>}
		 */
		removeItem: async (site, owner, id, entryId) =>
			mutate(site, owner, id, (list) => {
				const next = removeEntry(list.items, entryId);
				if (!next.removed) return failure('not_found', 'No such item on this list.');
				return { ok: true, items: next.entries, result: { entryId, removed: true } };
			}),
		/**
		 * Merge a guest's lists into a customer's lists, then delete the guest lists. Safe to repeat: a second merge
		 * finds nothing left, and entries are deduplicated by item.
		 * @param {Site} site
		 * @param {Owner} customer
		 * @param {Owner} guest
		 * @returns {Promise<Outcome>}
		 */
		merge: async (site, customer, guest) => {
			const guestLists = await site.repos.lists.ofOwner(guest, MAX_OWNER_LISTS);
			if (guestLists.length === 0) return { ok: true, body: { merged: 0, lists: 0 } };
			const { maxLists, maxItems } = site.settings.lists;
			for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
				const { id: targetId } = await defaultList(site, customer);
				const customerLists = await site.repos.lists.ofOwner(customer, MAX_OWNER_LISTS);
				const target = customerLists.find((/** @type {List} */ list) => list.id === targetId);
				/* v8 ignore next -- the target was deleted between two reads: plan again */
				if (!target) continue;
				const plan = planMerge({
					guest: guestLists,
					customer: customerLists,
					targetId,
					strategy: site.settings.guests.strategy,
					maxLists,
					maxItems,
				});
				if (!(await site.repos.lists.replaceItems(targetId, target.rev, plan.defaultEntries))) continue;
				for (const list of plan.newLists)
					await site.repos.lists.insert(draft(site, customer, { name: list.name, isDefault: false, items: list.entries }));
				await site.repos.lists.removeOwner(guest);
				return { ok: true, body: { merged: plan.added, lists: plan.newLists.length } };
			}
			return failure('conflict', 'The lists changed too often; try again.');
		},
	});
};

/** @typedef {ReturnType<typeof createLists>} Lists */
