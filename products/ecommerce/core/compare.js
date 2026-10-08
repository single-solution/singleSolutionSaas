/**
 * Compare (PLAN 0.8.8): products side by side — the comparable attributes (`comparable: true`) as rows with each
 * product's value, in the attributes' order. No I/O.
 * @module
 */

/** @typedef {import('./model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('./model.js').ProductRecord} ProductRecord */

/** Products compared at once, at most. */
export const MAX_COMPARE = 4;

/**
 * The product ids of `?ids=a,b,c`, in order and without repeats.
 * @param {unknown} value
 * @param {number} max
 * @returns {{ ok: true, ids: string[] } | { ok: false, message: string }}
 */
export const parseCompareIds = (value, max) => {
	const ids = [
		...new Set(
			(typeof value === 'string' ? value : '')
				.split(',')
				.map((id) => id.trim())
				.filter(Boolean),
		),
	];
	if (ids.length === 0 || ids.length > max) return { ok: false, message: `Compare 1 to ${max} products.` };
	if (!ids.every((id) => /^prd_[A-Za-z0-9]{1,64}$/.test(id))) return { ok: false, message: 'Name products by their ids.' };
	return { ok: true, ids };
};

/**
 * The comparison rows: one per comparable attribute that at least one product has, with each product's value (null
 * when it has none).
 * @param {Array<Pick<ProductRecord, 'specs'>>} products in the visitor's order
 * @param {AttributeRecord[]} attributes
 * @returns {Array<{ attributeId: string, name: string, unit: string, values: Array<string | number | boolean | null> }>}
 */
export const compareRows = (products, attributes) =>
	[...attributes]
		.filter((attribute) => attribute.comparable)
		.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
		.map((attribute) => ({
			attributeId: attribute.id,
			name: attribute.name,
			unit: attribute.unit,
			values: products.map((product) =>
				Object.hasOwn(product.specs ?? {}, attribute.id) ? (product.specs[attribute.id] ?? null) : null,
			),
		}))
		.filter((row) => row.values.some((value) => value !== null));

/**
 * The grade labels of a product's active variants (in the grades list's order, once each).
 * @param {Pick<ProductRecord, 'variants'>} product
 * @param {Array<{ key: string, label?: string }>} grades
 */
export const gradeLabels = (product, grades) => {
	const keys = new Set(product.variants.filter((v) => v.active && v.grade).map((v) => v.grade));
	return grades.filter((grade) => keys.has(grade.key)).map((grade) => grade.label || grade.key);
};
