/**
 * The rules@1 AST. Programs are plain, JSON-serialisable objects: `{ v: 1, ast }`. No source positions are stored,
 * so a program printed with `format()` and re-compiled yields a deep-equal AST.
 */

/**
 * @typedef {'==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not in' | 'contains' | '+' | '-' | '*' | '/' | '%'} BinaryOp
 */

/**
 * @typedef {{ type: 'literal', value: number | string | boolean | null }} LiteralNode
 * @typedef {{ type: 'duration', ms: number }} DurationNode
 * @typedef {{ type: 'date', ms: number }} DateNode
 * @typedef {{ type: 'list', items: Node[] }} ListNode
 * @typedef {{ type: 'ident', name: string }} IdentNode
 * @typedef {{ type: 'member', object: Node, key: string }} MemberNode
 * @typedef {{ type: 'index', object: Node, index: Node }} IndexNode
 * @typedef {{ type: 'unary', op: 'not' | '-', arg: Node }} UnaryNode
 * @typedef {{ type: 'binary', op: BinaryOp, left: Node, right: Node }} BinaryNode
 * @typedef {{ type: 'logical', op: 'and' | 'or', args: Node[] }} LogicalNode
 * @typedef {{ type: 'cond', test: Node, ifTrue: Node, ifFalse: Node }} CondNode
 * @typedef {{ type: 'call', fn: string, args: Node[] }} CallNode
 * @typedef {LiteralNode | DurationNode | DateNode | ListNode | IdentNode | MemberNode | IndexNode | UnaryNode | BinaryNode | LogicalNode | CondNode | CallNode} Node
 */

/**
 * A compiled, versioned program.
 * @typedef {{ v: 1, ast: Node }} Program
 */

export const BINARY_OPS = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'not in', 'contains', '+', '-', '*', '/', '%']);
export const COMPARISON_OPS = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'not in', 'contains']);

/**
 * Direct children of a node, in evaluation order.
 * @param {Node} node
 * @returns {Node[]}
 */
export function childrenOf(node) {
	switch (node.type) {
		case 'list':
			return node.items;
		case 'member':
			return [node.object];
		case 'index':
			return [node.object, node.index];
		case 'unary':
			return [node.arg];
		case 'binary':
			return [node.left, node.right];
		case 'logical':
		case 'call':
			return node.args;
		case 'cond':
			return [node.test, node.ifTrue, node.ifFalse];
		default:
			return [];
	}
}

/**
 * True for `a`, `a.b`, `a[0]`, `a.b['c'].d` … rooted at an identifier.
 * @param {Node} node
 * @returns {boolean}
 */
export function isPathNode(node) {
	if (node.type === 'ident') return true;
	if (node.type === 'member' || node.type === 'index') return isPathNode(node.object);
	return false;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** @param {string} s @returns {boolean} */
export const isIdentifierName = (s) => IDENT_RE.test(s);

/**
 * Dotted path text for a static path node, e.g. `order.lines[0].price`, `event.data['first-name']`, `order.lines[]`
 * (dynamic index). `it` is replaced by `itPath` (the list the predicate iterates, with `[]`), or yields null.
 * @param {Node} node
 * @param {string | null} itPath
 * @returns {string | null}
 */
export function staticPath(node, itPath) {
	if (node.type === 'ident') return node.name === 'it' ? itPath : node.name;
	if (node.type === 'member' || node.type === 'index') {
		const base = staticPath(node.object, itPath);
		if (base === null) return null;
		if (node.type === 'member') return `${base}.${node.key}`;
		const ix = node.index;
		if (ix.type === 'literal' && typeof ix.value === 'number') return `${base}[${ix.value}]`;
		if (ix.type === 'literal' && typeof ix.value === 'string')
			return isIdentifierName(ix.value) ? `${base}.${ix.value}` : `${base}[${JSON.stringify(ix.value)}]`;
		return `${base}[]`;
	}
	return null;
}

/**
 * Deep-freeze an AST in place (it was created by us, so this never touches caller data).
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value)) deepFreeze(v);
	}
	return value;
}
