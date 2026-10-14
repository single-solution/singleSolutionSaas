import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { IDMAP_FILE, SETTINGS_FILE, linesOf, read } from '../src/index.js';
import { sbSource } from '../src/fixture/index.js';
import { SISTERS_BOUTIQUE_MAPPING } from '../src/mappings/sisters-boutique/index.js';
import { freshDb, removeDir, tempDir } from './helpers.js';

/**
 * The Sisters Boutique sample read with the SB mapping into a fresh folder: the manifest, each target's records, the
 * settings plan and the id map. `change` edits the source documents before they are stored.
 * @param {{ change?: (docs: Record<string, Array<Record<string, any>>>) => void, cleanups: Array<() => Promise<unknown>> }} options
 */
export const readSisters = async ({ change, cleanups }) => {
	const source = await freshDb();
	const docs = sbSource();
	change?.(docs);
	for (const [name, list] of Object.entries(docs)) if (list.length > 0) await source.db.collection(name).insertMany(list);
	const dir = await tempDir();
	cleanups.push(async () => {
		await source.db.dropDatabase();
		await source.client.close();
		await removeDir(dir);
	});
	const manifest = await read({
		mapping: SISTERS_BOUTIQUE_MAPPING,
		db: source.db,
		dir,
		now: () => Date.parse('2026-10-14T00:00:00Z'),
	});
	/** @param {string} target @returns {Promise<any[]>} */
	const records = async (target) => {
		const file = manifest.targets.find((entry) => `${entry.product}.${entry.collection}` === target)?.file;
		if (!file) return [];
		return linesOf(await readFile(path.join(dir, file), 'utf8')).map((line) => JSON.parse(line.text));
	};
	/** @type {import('../src/index.js').SettingsPlan} */
	const settings = JSON.parse(await readFile(path.join(dir, SETTINGS_FILE), 'utf8'));
	/** @type {Record<string, string>} */
	const idmap = JSON.parse(await readFile(path.join(dir, IDMAP_FILE), 'utf8'));
	return { manifest, records, settings, idmap, dir, db: source.db };
};
