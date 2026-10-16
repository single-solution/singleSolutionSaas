/**
 * Tags on customers and orders (E11), the routes both share: the tags in use with how many records hold each
 * (`GET …/tags`), a tag renamed everywhere (`POST …/tags/rename { from, to }`; a record that has both keeps it once), a
 * tag removed everywhere (`POST …/tags/remove { tag }`) and tags added to and removed from many records at once
 * (`POST …/tags/apply { ids, add, remove }`). Each change is in the activity log; orders get a new `updatedAt`, so an
 * edit made from an older copy is refused as with any change.
 * @module
 */
import { TAG_LIMITS, checkTags } from '../core/customer-segments.js';
import { bodyOf } from './service.js';

/** @typedef {import('./service.js').Service} Service */

/** Most tags `GET …/tags` lists, and most records one apply names. */
const MAX_LISTED = 500;
const MAX_APPLY = 500;

/**
 * @param {Service} service
 * @param {{ collection: string, what: 'customers' | 'orders', idFilter: (ids: string[]) => Record<string, unknown>,
 *   stamp: boolean, now: () => number }} options `idFilter`: the records the ids name (customers: customer or user ids);
 *   `stamp`: a change sets `updatedAt`
 */
export const createTagTools = (service, { collection, what, idFilter, stamp, now }) => {
	/** @param {any} ctx */
	const open = async (ctx) => {
		const s = await service.site(ctx);
		return { s, records: (await s.data()).collection(collection) };
	};

	/** @param {unknown} value @param {string} field */
	const oneTag = (value, field) => {
		const checked = checkTags([value]);
		if (!checked.ok) throw service.invalid(field, `A tag has 1 to ${TAG_LIMITS.tag} characters.`);
		return /** @type {string} */ (checked.value[0]);
	};

	const stamped = () => (stamp ? { updatedAt: new Date(now()) } : {});

	/** GET …/tags: every tag in use, the most used first. @param {any} ctx */
	const list = async (ctx) => {
		const { s, records } = await open(ctx);
		const rows = await records
			.aggregate(
				[
					{ $match: { websiteId: s.websiteId, 'tags.0': { $exists: true } } },
					{ $unwind: '$tags' },
					{ $group: { _id: '$tags', count: { $sum: 1 } } },
					{ $sort: { count: -1, _id: 1 } },
					{ $limit: MAX_LISTED },
				],
				{ maxTimeMS: 3000 },
			)
			.toArray();
		return { items: rows.map((row) => ({ tag: String(row._id), count: Number(row.count) })) };
	};

	/** POST …/tags/rename `{ from, to }`. @param {any} ctx */
	const rename = async (ctx) => {
		const body = bodyOf(ctx);
		const from = oneTag(body.from, 'from');
		const to = oneTag(body.to, 'to');
		const { s, records } = await open(ctx);
		const done = await records.updateMany({ websiteId: s.websiteId, tags: from }, [
			{
				$set: {
					tags: {
						$reduce: {
							input: { $map: { input: '$tags', in: { $cond: [{ $eq: ['$$this', from] }, to, '$$this'] } } },
							initialValue: [],
							in: { $cond: [{ $in: ['$$this', '$$value'] }, '$$value', { $concatArrays: ['$$value', ['$$this']] }] },
						},
					},
					...stamped(),
				},
			},
		]);
		await service.log(ctx, `${what}.tag_renamed`, from, { label: from, detail: `${from} → ${to}: ${done.modifiedCount}` });
		return { changed: done.modifiedCount };
	};

	/** POST …/tags/remove `{ tag }`. @param {any} ctx */
	const remove = async (ctx) => {
		const tag = oneTag(bodyOf(ctx).tag, 'tag');
		const { s, records } = await open(ctx);
		const done = await records.updateMany(
			{ websiteId: s.websiteId, tags: tag },
			{ $pull: { tags: tag }, ...(stamp ? { $set: stamped() } : {}) },
		);
		await service.log(ctx, `${what}.tag_removed`, tag, { label: tag, detail: `${done.modifiedCount}` });
		return { changed: done.modifiedCount };
	};

	/** POST …/tags/apply `{ ids, add, remove }`. @param {any} ctx */
	const apply = async (ctx) => {
		const body = bodyOf(ctx);
		const ids = Array.isArray(body.ids)
			? [...new Set(body.ids.filter((/** @type {unknown} */ id) => typeof id === 'string' && id !== ''))]
			: [];
		if (ids.length === 0 || ids.length > MAX_APPLY || ids.length !== body.ids.length)
			throw service.invalid('ids', `Give 1 to ${MAX_APPLY} different ids.`);
		const add = checkTags(body.add ?? []);
		if (!add.ok) throw service.invalid('add', add.message);
		const removed = checkTags(body.remove ?? []);
		if (!removed.ok) throw service.invalid('remove', removed.message);
		if (add.value.length === 0 && removed.value.length === 0) throw service.invalid('add', 'Give tags to add or remove.');
		const { s, records } = await open(ctx);
		const match = { websiteId: s.websiteId, ...idFilter(ids) };
		const matched = await records.countDocuments(match);
		const adding = add.value.filter((tag) => !removed.value.includes(tag));
		// only the records whose tags change (so orders keep their updatedAt otherwise)
		const changes = [
			...(removed.value.length > 0 ? [{ tags: { $in: removed.value } }] : []),
			...adding.map((tag) => ({ tags: { $ne: tag } })),
		];
		const done = await records.updateMany({ ...match, $or: changes }, [
			{
				$set: {
					tags: {
						$slice: [
							{
								$concatArrays: [
									{
										$filter: {
											input: { $ifNull: ['$tags', []] },
											cond: { $not: [{ $in: ['$$this', removed.value] }] },
										},
									},
									{
										$filter: {
											input: adding,
											cond: { $not: [{ $in: ['$$this', { $ifNull: ['$tags', []] }] }] },
										},
									},
								],
							},
							TAG_LIMITS.tags,
						],
					},
					...stamped(),
				},
			},
		]);
		await service.log(ctx, `${what}.tagged`, `${done.modifiedCount} ${what}`, {
			label: `${done.modifiedCount} ${what}`,
			detail: [
				...(add.value.length > 0 ? [`added ${add.value.join(', ')}`] : []),
				...(removed.value.length > 0 ? [`removed ${removed.value.join(', ')}`] : []),
			].join('; '),
		});
		return { matched, changed: done.modifiedCount };
	};

	return Object.freeze({ list, rename, remove, apply });
};
