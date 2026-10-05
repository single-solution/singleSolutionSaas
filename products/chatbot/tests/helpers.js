/** Test doubles shared by the unit and API tests (no DOM library, no network). */

/** A minimal DOM: enough for renderer tests to inspect structure, attributes, text and listeners. */
export const createFakeDom = () => {
	/** @param {string} tag */
	const createElement = (tag) => {
		/** @type {Record<string, Array<(event: any) => void>>} */
		const listeners = {};
		const node = {
			tag,
			/** @type {Record<string, string>} */
			attributes: {},
			/** @type {any[]} */
			children: [],
			value: '',
			checked: false,
			/** @param {string} name @param {string} value */
			setAttribute: (name, value) => {
				node.attributes[name] = value;
			},
			/** @param {...any} items */
			append: (...items) => {
				node.children.push(...items);
			},
			/** @param {string} type @param {(event: any) => void} listener */
			addEventListener: (type, listener) => {
				(listeners[type] ??= []).push(listener);
			},
			/** @param {string} type @param {any} [event] */
			dispatch: (type, event = {}) => {
				for (const listener of listeners[type] ?? []) listener(event);
			},
			get textContent() {
				return node.children.map((child) => (typeof child.text === 'string' ? child.text : child.textContent)).join('');
			},
		};
		return node;
	};
	/** @param {string} text */
	const createTextNode = (text) => ({ text, textContent: text });
	return { createElement, createTextNode };
};

/**
 * Depth-first search in a fake DOM tree.
 * @param {any} node
 * @param {(node: any) => boolean} predicate
 * @returns {any[]}
 */
export const findAll = (node, predicate) => [
	...(predicate(node) ? [node] : []),
	...(node.children ?? []).flatMap((/** @type {any} */ child) => findAll(child, predicate)),
];

/** Let pending promise callbacks run. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A manual scheduler for the transport (timers fire only when the test advances time).
 * @param {number} [start]
 */
export const createScheduler = (start = 0) => {
	let now = start;
	let seq = 0;
	/** @type {Map<number, { at: number, fn: () => void }>} */
	const timers = new Map();
	return {
		now: () => now,
		/** @param {() => void} fn @param {number} ms */
		setTimeout: (fn, ms) => {
			seq += 1;
			timers.set(seq, { at: now + ms, fn });
			return seq;
		},
		/** @param {unknown} handle */
		clearTimeout: (handle) => {
			timers.delete(/** @type {number} */ (handle));
		},
		pending: () => timers.size,
		/** Advance the clock, firing due timers in order. @param {number} ms */
		advance: async (ms) => {
			const until = now + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = due[1].at;
				due[1].fn();
				await flush();
			}
			now = until;
		},
	};
};

/**
 * A visibility source the test controls.
 */
export const createVisibility = () => {
	let hidden = false;
	/** @type {Set<() => void>} */
	const listeners = new Set();
	return {
		hidden: () => hidden,
		/** @param {() => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** @param {boolean} value */
		set: (value) => {
			hidden = value;
			for (const listener of listeners) listener();
		},
		/** user input */
		poke: () => {
			for (const listener of listeners) listener();
		},
	};
};

/**
 * An `@ss/web/element`-shaped API (`request(method, path, options)` → Result) backed by a route table.
 * @param {Record<string, (input: { method: string, path: string, options: Record<string, any> }) => any>} routes `METHOD /path` → result
 */
export const createFakeApi = (routes) => {
	/** @type {Array<{ method: string, path: string, options: Record<string, any> }>} */
	const calls = [];
	return {
		calls,
		/** @param {string} method @param {string} path @param {Record<string, any>} [options] */
		request: async (method, path, options = {}) => {
			calls.push({ method, path, options });
			const handler = routes[`${method} ${path}`] ?? routes[`${method} *`];
			if (!handler) return { ok: false, error: { code: 'not_found', status: 404 } };
			return handler({ method, path, options });
		},
	};
};

/**
 * Scripted outbound HTTP for app-kit connectors and the product's outbound fetcher (`overrides.outboundSend`): AI
 * provider answers, knowledge pages and webhook tools. Records every request.
 */
export const createNetwork = () => {
	/** @type {Array<{ url: string, init: Record<string, any>, body: any }>} */
	const requests = [];
	/** @type {Array<(request: { url: string, init: Record<string, any>, body: any }) => any>} */
	const handlers = [];
	/** @type {any[]} */
	const aiQueue = [];
	/** @param {unknown} value @param {number} [status] @param {Record<string, string>} [headers] */
	const reply = (value, status = 200, headers = { 'content-type': 'application/json' }) => ({
		status,
		headers,
		body: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
		url: '',
	});
	return {
		requests,
		reply,
		/** @param {(request: { url: string, init: Record<string, any>, body: any }) => any} handler */
		on: (handler) => handlers.push(handler),
		/** Queue AI answers (OpenAI shape unless a full payload is given). @param {...any} answers */
		ai: (...answers) => aiQueue.push(...answers),
		aiCalls: () => requests.filter((r) => /\/chat\/completions|\/messages$|generateContent/.test(r.url)),
		/** @param {string} url @param {Record<string, any>} [init] */
		send: async (url, init = {}) => {
			const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : (init.body ?? null);
			const request = { url, init, body };
			requests.push(request);
			for (const handler of handlers) {
				const out = await handler(request);
				if (out) return out;
			}
			if (/\/chat\/completions$/.test(url)) {
				const next = aiQueue.shift();
				if (next instanceof Error) throw next;
				if (next && typeof next === 'object' && 'status' in next && 'body' in next) return next;
				if (next && typeof next === 'object' && 'choices' in next) return reply(next);
				if (next && typeof next === 'object' && 'tool' in next)
					return reply({
						choices: [
							{
								message: {
									content: '',
									tool_calls: [
										{
											id: `call_${requests.length}`,
											type: 'function',
											function: { name: next.tool, arguments: JSON.stringify(next.arguments ?? {}) },
										},
									],
								},
								finish_reason: 'tool_calls',
							},
						],
						usage: { prompt_tokens: 50, completion_tokens: 5 },
					});
				return reply({
					choices: [
						{ message: { content: typeof next === 'string' ? next : 'Happy to help with that!' }, finish_reason: 'stop' },
					],
					usage: { prompt_tokens: 120, completion_tokens: 20 },
				});
			}
			return reply({ error: 'not found' }, 404);
		},
	};
};
