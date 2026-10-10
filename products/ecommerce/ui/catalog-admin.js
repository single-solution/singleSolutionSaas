/**
 * Products and catalog (admin widget `catalog_admin`, ticket with `catalog.edit`; PLAN 0.8.8; PLAN 0.8.10 E1–E16): one
 * section at a time, each a list-and-detail screen (PLAN 0.6) — products (`./admin-products.js`), categories, brands
 * and locations (`./admin-taxonomy.js`, locations with Multi-location stock), attributes (`./admin-attributes.js`),
 * size charts (`./admin-charts.js`, with Size charts), landing pages (`./admin-landings.js`, with Landing pages) and
 * serial numbers (`./admin-serials.js`, with Grades and serials).
 * @module
 */
import { attributesTab } from './admin-attributes.js';
import { chartsTab } from './admin-charts.js';
import { mountAdmin } from './admin-kit.js';
import { landingsTab } from './admin-landings.js';
import { productsTab } from './admin-products.js';
import { createSerialFilter, serialsTab } from './admin-serials.js';
import { brandsTab, categoriesTab, createLookups, locationsTab } from './admin-taxonomy.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */
/** @typedef {import('./admin-serials.js').Links} Links */

/**
 * The sections: a key, the feature it needs and how it is built.
 * @type {ReadonlyArray<{ key: string, feature: string | null,
 *   build: (kit: Kit, panel: HTMLElement, lookups: Lookups, links: Links) => void }>}
 */
const SECTIONS = Object.freeze([
	{ key: 'products', feature: null, build: productsTab },
	{ key: 'categories', feature: null, build: categoriesTab },
	{ key: 'brands', feature: null, build: brandsTab },
	{ key: 'attributes', feature: null, build: attributesTab },
	{ key: 'charts', feature: 'size_charts', build: chartsTab },
	{ key: 'landings', feature: 'landing_pages', build: landingsTab },
	{ key: 'locations', feature: 'multi_location', build: locationsTab },
	{ key: 'serials', feature: 'grades_serials', build: serialsTab },
]);

/**
 * @param {import('./widget.js').AdminMount} input
 * @returns {Promise<void>}
 */
export const mountCatalogAdmin = async (input) => {
	mountAdmin(input, 'catalog-admin', 'catalogAdmin.title', (kit, box) => {
		const lookups = createLookups(kit);
		const ready = lookups.reload();
		/** @type {Links} */
		const links = {
			serialFilter: createSerialFilter(),
			serialsOf: (product) => {
				links.serialFilter.set(product);
				/** @type {HTMLElement | null} */ (sections.querySelector('[data-section="serials"]'))?.click();
			},
		};
		const sections = kit.sections(
			SECTIONS.filter((section) => section.feature === null || kit.has(section.feature)).map((section) => ({
				key: section.key,
				label: kit.t(`catalogAdmin.${section.key}`),
				render: (/** @type {HTMLElement} */ panel) => void ready.then(() => section.build(kit, panel, lookups, links)),
			})),
		);
		box.append(sections);
	});
};
