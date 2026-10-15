/**
 * The merchant's own patterns (C14; pure): a safe subset of regular expressions, run by a small automaton in time
 * linear in the text for each start (never the backtracking of JavaScript's own engine), with a step budget on top,
 * so no pattern a merchant saves can hang the server.
 *
 * The subset: characters, `.`, classes (`[a-z0-9]`, `[^…]`, `\d \D \w \W \s \S`, Unicode `\p{L}`, `\p{N}`, `\P{…}`),
 * escaped punctuation (`\.`, `\-`, `\+` …), groups `( … )` and `(?: … )`, alternation `|`, the repeats `* + ?`, `{n}`,
 * `{n,}` and `{n,m}` (n and m at most 100), the anchors `^` and `$` (start and end of the text) and `\b` (a word edge,
 * any script). Matching ignores case. Look-arounds and back-references are refused. Up to 200 characters.
 * @module
 */

/** The longest pattern, the most of a counted repeat, and the most steps of the compiled automaton. */
export const PATTERN_LIMITS = Object.freeze({ length: 200, repeat: 100, program: 3000 });

/** Steps one pattern may take on one text before it stops (what it found until then is kept). */
const STEP_BUDGET = 400_000;

const WORD = /[\p{L}\p{N}_]/u;

/**
 * @typedef {{ op: 'char', test: (ch: string) => boolean } | { op: 'split', x: number, y: number } | { op: 'jmp', x: number }
 *   | { op: 'assert', kind: 'start' | 'end' | 'edge' | 'inside' } | { op: 'match' }} Instruction
 * @typedef {{ type: 'char', test: (ch: string) => boolean } | { type: 'assert', kind: 'start' | 'end' | 'edge' | 'inside' }
 *   | { type: 'seq', items: Node[] } | { type: 'alt', options: Node[] } | { type: 'rep', node: Node, min: number, max: number }} Node
 */

/**
 * A one-character test from a piece of regular expression source (a class or an escape), case aside.
 * @param {string} source
 * @returns {(ch: string) => boolean}
 */
const charTest = (source) => {
	const pattern = new RegExp(`^${source}$`, 'iu');
	return (ch) => pattern.test(ch);
};

/** @param {string} ch */
const literal = (ch) => {
	const lower = ch.toLowerCase();
	const upper = ch.toUpperCase();
	return (/** @type {string} */ other) => other === ch || other === lower || other === upper || other.toLowerCase() === lower;
};

/**
 * Parse a pattern into its tree, or say what is wrong.
 * @param {string} source
 * @returns {{ ok: true, node: Node } | { ok: false, error: string }}
 */
const parse = (source) => {
	const chars = [...source];
	let i = 0;
	/** @param {string} message @returns {never} */
	const fail = (message) => {
		throw new Error(message);
	};
	/** @returns {Node} */
	const alternation = () => {
		const options = [sequence()];
		while (chars[i] === '|') {
			i += 1;
			options.push(sequence());
		}
		return options.length === 1 ? /** @type {Node} */ (options[0]) : { type: 'alt', options };
	};
	/** @returns {Node} */
	const sequence = () => {
		/** @type {Node[]} */
		const items = [];
		while (i < chars.length && chars[i] !== '|' && chars[i] !== ')') items.push(repeat());
		return { type: 'seq', items };
	};
	/** @param {string} digits */
	const count = (digits) => {
		const n = Number(digits);
		if (!/^\d{1,3}$/.test(digits) || n > PATTERN_LIMITS.repeat) fail(`A repeat counts at most ${PATTERN_LIMITS.repeat}.`);
		return n;
	};
	/** @returns {Node} */
	const repeat = () => {
		const node = atom();
		const q = chars[i];
		/** @type {[number, number] | null} */
		let range = null;
		if (q === '*') range = [0, Infinity];
		else if (q === '+') range = [1, Infinity];
		else if (q === '?') range = [0, 1];
		else if (q === '{') {
			const close = chars.indexOf('}', i);
			const body = close < 0 ? '' : chars.slice(i + 1, close).join('');
			const m = /^(\d+)(,(\d*))?$/.exec(body);
			if (!m) fail('Write { as \\{, or a repeat as {2}, {2,} or {2,5}.');
			const min = count(String(m?.[1]));
			const max = m?.[2] === undefined ? min : m[3] === '' ? Infinity : count(String(m?.[3]));
			if (max < min) fail('In {n,m}, n is at most m.');
			range = [min, max];
			i = close;
		}
		if (!range) return node;
		i += 1;
		if (chars[i] === '?') i += 1; // a lazy repeat finds the same matches here
		if (node.type === 'assert') fail('An anchor cannot repeat.');
		return { type: 'rep', node, min: range[0], max: range[1] };
	};
	/** @returns {Node} */
	const atom = () => {
		const ch = chars[i];
		if (ch === undefined) fail('The pattern ends too early.');
		if (ch === '(') {
			i += 1;
			if (chars[i] === '?') {
				if (chars[i + 1] !== ':') fail('Look-arounds and named groups are not taken: use ( … ) or (?: … ).');
				i += 2;
			}
			const node = alternation();
			if (chars[i] !== ')') fail('A group is not closed with ).');
			i += 1;
			return node;
		}
		if (ch === ')') fail('A ) has no (.');
		if (ch === '*' || ch === '+' || ch === '?' || ch === '{') fail(`${ch} repeats nothing: write \\${ch} for the character.`);
		if (ch === '^' || ch === '$') {
			i += 1;
			return { type: 'assert', kind: ch === '^' ? 'start' : 'end' };
		}
		if (ch === '.') {
			i += 1;
			return { type: 'char', test: (other) => other !== '\n' };
		}
		if (ch === '[') {
			let j = i + 1;
			if (chars[j] === '^') j += 1;
			if (chars[j] === ']') j += 1;
			while (j < chars.length && chars[j] !== ']') j += chars[j] === '\\' ? 2 : 1;
			if (j >= chars.length) fail('A [ is not closed with ].');
			const body = chars.slice(i, j + 1).join('');
			if (/\\[1-9k]/.test(body)) fail('Back-references are not taken.');
			i = j + 1;
			try {
				return { type: 'char', test: charTest(body) };
			} catch {
				return fail(`${body} is not a valid class.`);
			}
		}
		if (ch === '\\') {
			const next = chars[i + 1];
			if (next === undefined) fail('A \\ ends the pattern.');
			if (next === 'b' || next === 'B') {
				i += 2;
				return { type: 'assert', kind: next === 'b' ? 'edge' : 'inside' };
			}
			if (/[1-9k]/.test(String(next))) fail('Back-references are not taken.');
			if (next === 'p' || next === 'P') {
				const close = chars.indexOf('}', i);
				if (chars[i + 2] !== '{' || close < 0) fail('Write \\p{L} (any letter) or \\p{N} (any digit).');
				const body = chars.slice(i, close + 1).join('');
				i = close + 1;
				try {
					return { type: 'char', test: charTest(body) };
				} catch {
					return fail(`${body} is not a Unicode property.`);
				}
			}
			i += 2;
			if (/[dDwWsS]/.test(String(next))) return { type: 'char', test: charTest(`\\${next}`) };
			if (/[nrtfv0]/.test(String(next))) return { type: 'char', test: charTest(`\\${next}`) };
			if (/[\p{L}\p{N}]/u.test(String(next))) fail(`\\${next} is not taken.`);
			return { type: 'char', test: literal(String(next)) };
		}
		i += 1;
		return { type: 'char', test: literal(ch) };
	};
	try {
		const node = alternation();
		if (i < chars.length) fail('A ) has no (.');
		return { ok: true, node };
	} catch (error) {
		return { ok: false, error: /** @type {Error} */ (error).message };
	}
};

/**
 * The automaton of a tree (Thompson's construction), or null when it would be too big.
 * @param {Node} root
 * @returns {Instruction[] | null}
 */
const compileNode = (root) => {
	/** @type {Instruction[]} */
	const program = [];
	/** @param {Instruction} instruction */
	const emit = (instruction) => {
		if (program.length >= PATTERN_LIMITS.program) throw new Error('too big');
		program.push(instruction);
		return program.length - 1;
	};
	/** @param {Node} node */
	const walk = (node) => {
		if (node.type === 'char') emit({ op: 'char', test: node.test });
		else if (node.type === 'assert') emit({ op: 'assert', kind: node.kind });
		else if (node.type === 'seq') node.items.forEach(walk);
		else if (node.type === 'alt') {
			/** @type {number[]} */
			const jumps = [];
			node.options.forEach((option, index) => {
				if (index < node.options.length - 1) {
					const split = emit({ op: 'split', x: 0, y: 0 });
					/** @type {{ x: number }} */ (program[split]).x = program.length;
					walk(option);
					jumps.push(emit({ op: 'jmp', x: 0 }));
					/** @type {{ y: number }} */ (program[split]).y = program.length;
				} else walk(option);
			});
			for (const jump of jumps) /** @type {{ x: number }} */ (program[jump]).x = program.length;
		} else {
			for (let n = 0; n < node.min; n += 1) walk(node.node);
			if (node.max === Infinity) {
				const split = emit({ op: 'split', x: 0, y: 0 });
				/** @type {{ x: number }} */ (program[split]).x = program.length;
				walk(node.node);
				emit({ op: 'jmp', x: split });
				/** @type {{ y: number }} */ (program[split]).y = program.length;
			} else {
				/** @type {number[]} */
				const splits = [];
				for (let n = node.min; n < node.max; n += 1) {
					const split = emit({ op: 'split', x: 0, y: 0 });
					splits.push(split);
					/** @type {{ x: number }} */ (program[split]).x = program.length;
					walk(node.node);
				}
				for (const split of splits) /** @type {{ y: number }} */ (program[split]).y = program.length;
			}
		}
	};
	try {
		walk(root);
		emit({ op: 'match' });
		return program;
	} catch {
		return null;
	}
};

/**
 * A pattern ready to run, or what is wrong with it (in the words the dashboard and the server show).
 * @param {unknown} source
 * @returns {{ ok: true, program: Instruction[] } | { ok: false, error: string }}
 */
export const compilePattern = (source) => {
	if (typeof source !== 'string' || source.trim() === '') return { ok: false, error: 'Write a pattern.' };
	if ([...source].length > PATTERN_LIMITS.length)
		return { ok: false, error: `A pattern is up to ${PATTERN_LIMITS.length} characters.` };
	const parsed = parse(source);
	if (!parsed.ok) return parsed;
	const program = compileNode(parsed.node);
	if (!program) return { ok: false, error: 'The pattern is too complex: use fewer or smaller repeats.' };
	return { ok: true, program };
};

/**
 * The matches of a compiled pattern in a text, leftmost first and each as long as it goes, never overlapping, as
 * [start, end) in code points. Each start runs the automaton once (no backtracking); after `STEP_BUDGET` steps it stops
 * and keeps what it found.
 * @param {Instruction[]} program
 * @param {string[]} chars the text's code points
 * @returns {Array<[number, number]>}
 */
const matchesOf = (program, chars) => {
	const n = chars.length;
	let steps = 0;
	/** @param {number} at */
	const isWord = (at) => at >= 0 && at < n && WORD.test(/** @type {string} */ (chars[at]));
	/**
	 * Add a thread and every one it reaches without reading (a later start never replaces an earlier one).
	 * @param {Map<number, number>} list pc → start
	 * @param {number} pc
	 * @param {number} start
	 * @param {number} at
	 */
	const add = (list, pc, start, at) => {
		const stack = [pc];
		while (stack.length > 0) {
			const here = /** @type {number} */ (stack.pop());
			if (list.has(here) && /** @type {number} */ (list.get(here)) <= start) continue;
			list.set(here, start);
			steps += 1;
			const inst = /** @type {Instruction} */ (program[here]);
			if (inst.op === 'jmp') stack.push(inst.x);
			else if (inst.op === 'split') stack.push(inst.y, inst.x);
			else if (inst.op === 'assert') {
				const holds =
					inst.kind === 'start'
						? at === 0
						: inst.kind === 'end'
							? at === n
							: (isWord(at - 1) !== isWord(at)) === (inst.kind === 'edge');
				if (holds) stack.push(here + 1);
			}
		}
	};
	/** @type {Array<[number, number]>} */
	const found = [];
	let from = 0;
	while (from <= n && steps <= STEP_BUDGET) {
		/** @type {Map<number, number>} */
		let threads = new Map();
		/** @type {[number, number] | null} */
		let best = null;
		for (let at = from; at <= n && steps <= STEP_BUDGET; at += 1) {
			if (best === null) add(threads, 0, at, at);
			/** @type {Map<number, number>} */
			const next = new Map();
			for (const [pc, start] of threads) {
				steps += 1;
				if (best !== null && start > best[0]) continue;
				const inst = /** @type {Instruction} */ (program[pc]);
				if (inst.op === 'match') {
					if (best === null || start < best[0] || (start === best[0] && at > best[1])) best = [start, at];
				} else if (inst.op === 'char' && at < n && inst.test(/** @type {string} */ (chars[at])))
					add(next, pc + 1, start, at + 1);
			}
			const first = best === null ? Infinity : best[0];
			threads = best === null ? next : new Map([...next].filter(([, start]) => start <= first));
			if (threads.size === 0 && best !== null) break;
		}
		if (best === null) break;
		found.push(best);
		from = best[1] > best[0] ? best[1] : best[1] + 1;
	}
	return found;
};

/**
 * Replace every match of a compiled pattern.
 * @param {string} text
 * @param {Instruction[]} program
 * @param {(match: string) => string} replace
 */
export const replacePattern = (text, program, replace) => {
	const chars = [...text];
	const found = matchesOf(program, chars).filter(([start, end]) => end > start);
	if (found.length === 0) return text;
	let out = '';
	let last = 0;
	for (const [start, end] of found) {
		out += chars.slice(last, start).join('') + replace(chars.slice(start, end).join(''));
		last = end;
	}
	return out + chars.slice(last).join('');
};
