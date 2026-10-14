/**
 * The product on the kit: `createProductInstance(options)` wires `@ss/app-kit` `createProduct` with this product's
 * manifest (each feature's settings schema from `schemas/` inline), its English widget texts, the merchant database
 * indexes, the data-rights hooks, the widget settings the kit's widget config routes answer and its part of the
 * website Setup sheet (the OpenAPI document, the guide's "What your website builds" per feature and a short summary in
 * its own words). The Next.js route and the tests pass the rest (config, store, clock, network).
 * Public entry `./product` of this package, so a system test can compose the product with `./routes`.
 * @module
 */
import { createProduct } from '@ss/app-kit';
import guide from '../docs/guide.json' with { type: 'json' };
import manifestFile from '../manifest.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import importSettings from '../schemas/import.settings.json' with { type: 'json' };
import notesSettings from '../schemas/notes.settings.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import { checkImportedNote, noteView } from '../core/notes.js';
import { NOTE_INDEXES, createNotesStore } from './notes-store.js';

/** Settings schema of each feature (manifest.json points at them with `$ref`). @type {Record<string, unknown>} */
const SETTINGS = { notes: notesSettings, import: importSettings };

/** The manifest as the kit and the Portal take it: settings schemas inline. */
export const manifest = /** @type {import('@ss/contracts').Manifest} */ (
	/** @type {unknown} */ ({
		...manifestFile,
		features: manifestFile.features.map((feature) => ({ ...feature, settings: SETTINGS[feature.key] })),
	})
);

export { strings };

/**
 * Data rights (PLAN 0.4.11): a visitor's notes are found by the email they left.
 * @type {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>}
 */
const dataRights = {
	exportUser: async (ctx, user) =>
		user.email ? { notes: (await createNotesStore(await ctx.data()).byEmail(user.email.toLowerCase())).map(noteView) } : {},
	deleteUser: async (ctx, user) => ({
		deleted: user.email ? await createNotesStore(await ctx.data()).deleteByEmail(user.email.toLowerCase()) : 0,
		anonymised: 0,
	}),
};

/**
 * @typedef {Omit<import('@ss/app-kit').ProductOptions, 'manifest' | 'strings' | 'hooks' | 'connections' | 'data' | 'openapi' | 'build'>} InstanceOptions
 */

/**
 * The product (kit routes, status, settings, connections, merchant database …) for this deployment.
 * @param {InstanceOptions} options at least `config` and `problems` from `configFromEnv()`
 */
export const createProductInstance = (options) => {
	const product = createProduct({
		...options,
		manifest,
		strings,
		hooks: {
			...dataRights,
			// what the widgets need of the settings (GET /v1/widget/config); never secrets
			widgetConfig: async (ctx) => ({
				maxLength: (await product.settings.values(/** @type {string} */ (ctx.websiteId), 'notes')).maxLength,
			}),
			// what this product adds to the website's Setup sheet in its own words (event types, list summaries,
			// summaries); never secrets
			blueprint: async ({ websiteId, on }) => ({
				summaries: on.includes('notes')
					? [
							{
								title: 'Notes',
								text: `Visitors leave notes of up to ${(await product.settings.values(websiteId, 'notes')).maxLength} characters.`,
							},
						]
					: [],
			}),
		},
		data: { indexes: NOTE_INDEXES },
		// the website Setup sheet: the API document and what the merchant's website builds per feature
		openapi,
		build: guide.build,
		// the import feature (test-only here, PLAN 0.8.10 K10): notes moved in with ss-import
		imports: { collections: { notes: { check: checkImportedNote } } },
	});
	return product;
};

/** @typedef {ReturnType<typeof createProductInstance>} Product */
