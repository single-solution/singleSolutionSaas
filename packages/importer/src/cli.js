/**
 * `ss-import` command dispatcher. Every side effect is injected (`io`, `env`, `fetch`, `connect`), so the whole CLI is
 * testable in process; `bin.js` wires the real process.
 *
 * Secrets never go on the command line: the store database's address comes from `SS_IMPORT_SOURCE_URI` (or
 * `--source`) and each product's server token from `SS_IMPORT_TOKEN_<PRODUCT ID>` (for example
 * `SS_IMPORT_TOKEN_ACCOUNTS`).
 * @module
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { MAPPINGS } from './mappings/index.js';
import { read } from './read.js';
import { send } from './send.js';
import { verify } from './verify.js';

/** @typedef {{ out: (text: string) => void, err: (text: string) => void }} Io */
/**
 * @typedef {object} CliDeps
 * @property {Io} io
 * @property {Record<string, string | undefined>} env
 * @property {typeof globalThis.fetch} fetch
 * @property {(uri: string) => Promise<{ db: import('./read.js').SourceDb, close: () => Promise<void> }>} connect
 * @property {Readonly<Record<string, import('./mapping.js').Mapping>>} [mappings] the mappings `--mapping` names
 *   (default: the store mappings; tests pass the test mappings)
 */

export const USAGE = `ss-import — moves a store's records into the products (PLAN 0.8.10 Migration)

Usage:
  ss-import read --mapping <name> --out <dir> [--source <mongodb uri>]
        read the store database (read only; default address SS_IMPORT_SOURCE_URI) into NDJSON files, idmap.json,
        settings.json and manifest.json in <dir>
  ss-import send --dir <dir> --product <id>=<url> [--product …] [--dry-run] [--prune] [--only <id>.<collection> …]
                 [--settings <file>] [--json]
        write the settings (settings.json, then the per-store table <file>) through PUT <url>/v1/settings, /v1/format
        and /v1/lists, post the files to POST <url>/v1/import/<collection> (?dryRun=1), with --prune remove what the
        source no longer has (POST …/prune; the final pass), and after each product's last file POST
        /v1/import/finish (again with ?after=<next> while it answers more; not on a dry run); a dry run lists every
        refused record and setting and the settings that would change; the server token of each product comes from
        SS_IMPORT_TOKEN_<ID>
  ss-import verify --dir <dir> --product <id>=<url> [--product …] [--json]
        compare the records read and their sums with GET /v1/import/status and the mapping's count routes

Mappings: ${Object.keys(MAPPINGS).join(', ')}
Exit codes: 0 ok, 1 failed records, mismatches or errors, 2 usage error.
`;

/**
 * @param {Io} io
 * @param {string} message
 */
const usageError = (io, message) => {
	io.err(`ss-import: ${message}\n\n${USAGE}`);
	return 2;
};

/**
 * The products named by `--product <id>=<url>`, with their tokens from the environment.
 * @param {string[]} pairs
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true, products: Record<string, { url: string, token: string }> } | { ok: false, message: string }}
 */
const productsOf = (pairs, env) => {
	/** @type {Record<string, { url: string, token: string }>} */
	const products = {};
	for (const pair of pairs) {
		const match = /^([a-z][a-z0-9-]{1,30})=(https?:\/\/\S+)$/.exec(pair);
		if (!match) return { ok: false, message: `--product takes <id>=<url>, not ${pair}` };
		const [, id = '', url = ''] = match;
		const variable = `SS_IMPORT_TOKEN_${id.toUpperCase().replace(/-/g, '_')}`;
		const token = env[variable];
		if (!token) return { ok: false, message: `set ${variable} to the website's server token of ${id}` };
		products[id] = { url, token };
	}
	return { ok: true, products };
};

/**
 * Run a command; answers the exit code.
 * @param {string[]} argv
 * @param {CliDeps} deps
 * @returns {Promise<number>}
 */
export const main = async (argv, { io, env, fetch, connect, mappings = MAPPINGS }) => {
	const [command, ...args] = argv;
	if (command === undefined || command === '--help' || command === 'help') {
		io.out(USAGE);
		return command === undefined ? 2 : 0;
	}
	/** @type {{ values: Record<string, any>, positionals: string[] }} */
	let parsed;
	try {
		parsed = parseArgs({
			args,
			allowPositionals: false,
			strict: true,
			options: {
				mapping: { type: 'string' },
				out: { type: 'string' },
				source: { type: 'string' },
				dir: { type: 'string' },
				product: { type: 'string', multiple: true },
				only: { type: 'string', multiple: true },
				settings: { type: 'string' },
				prune: { type: 'boolean' },
				'dry-run': { type: 'boolean' },
				json: { type: 'boolean' },
			},
		});
	} catch (error) {
		return usageError(io, error instanceof Error ? error.message : 'invalid options');
	}
	const { values } = parsed;
	try {
		if (command === 'read') {
			const mapping = values.mapping && Object.hasOwn(mappings, values.mapping) ? mappings[values.mapping] : undefined;
			if (!mapping) return usageError(io, `--mapping is one of: ${Object.keys(mappings).join(', ')}`);
			if (!values.out) return usageError(io, '--out <dir> is required');
			const uri = values.source ?? env.SS_IMPORT_SOURCE_URI;
			if (!uri) return usageError(io, 'set SS_IMPORT_SOURCE_URI (or --source) to the store database address');
			const source = await connect(uri);
			try {
				const manifest = await read({ mapping, db: source.db, dir: values.out });
				for (const step of manifest.steps)
					io.out(
						`${step.file}: ${step.records} records (${step.read} read, ${step.merged} merged, ${step.skipped} left out)\n`,
					);
			} finally {
				await source.close();
			}
			return 0;
		}
		if (command === 'send' || command === 'verify') {
			if (!values.dir) return usageError(io, '--dir <dir> is required');
			const named = productsOf(values.product ?? [], env);
			if (!named.ok) return usageError(io, named.message);
			if (command === 'send') {
				const report = await send({
					dir: values.dir,
					products: named.products,
					dryRun: values['dry-run'] === true,
					prune: values.prune === true,
					...(values.only ? { only: values.only } : {}),
					...(values.settings ? { settings: JSON.parse(await readFile(values.settings, 'utf8')) } : {}),
					fetch,
				});
				if (values.json) io.out(`${JSON.stringify(report, null, 2)}\n`);
				else {
					const dry = report.dryRun ? '[dry run] ' : '';
					const { settings } = report;
					if (settings.changes.length + settings.unchanged + settings.refused.length > 0)
						io.out(
							`${dry}settings: ${settings.changes.length} to change, ${settings.unchanged} unchanged, ${settings.refused.length} refused\n`,
						);
					for (const change of settings.changes)
						io.out(
							`  ${change.product} ${change.kind} ${change.key}: ${JSON.stringify(change.from)}${change.source ? ` (${change.source})` : ''} → ${JSON.stringify(change.to)}\n`,
						);
					for (const refused of settings.refused)
						io.out(`  REFUSED ${refused.product} ${refused.kind} ${refused.key}: ${refused.message}\n`);
					for (const step of report.steps) {
						io.out(
							`${dry}${step.product} ${step.collection}: ${step.inserted} inserted, ${step.updated} updated, ${step.failed.length} failed${step.pruned ? `, ${step.pruned.removed} ${report.dryRun ? 'to remove' : 'removed'}` : ''}\n`,
						);
						for (const failed of step.failed)
							io.out(
								`  ${step.file}:${failed.line} ${failed.id ?? ''} ${failed.errors.map((e) => `${e.path} ${e.message}`.trim()).join('; ')}\n`,
							);
						for (const key of step.pruned?.keys ?? []) io.out(`  - ${key}\n`);
					}
				}
				return report.ok ? 0 : 1;
			}
			const report = await verify({ dir: values.dir, products: named.products, fetch });
			if (values.json) io.out(`${JSON.stringify(report, null, 2)}\n`);
			else {
				for (const step of report.steps)
					io.out(
						`${step.match ? 'ok  ' : 'DIFF'} ${step.product} ${step.collection}: read ${step.expected}, imported ${step.imported ?? '?'}${step.counted === null ? '' : `, counted ${step.counted}`}\n`,
					);
				for (const total of report.totals)
					io.out(
						`${total.match ? 'ok  ' : 'DIFF'} ${total.product} ${total.key}: read ${total.expected}, product ${total.actual ?? '?'}\n`,
					);
			}
			return report.ok ? 0 : 1;
		}
		return usageError(io, `unknown command ${command}`);
	} catch (error) {
		io.err(`ss-import: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
};
