/**
 * `ss` command dispatcher. Every side effect is injected (`io`, `cwd`), so the whole CLI is testable in-process;
 * `bin.js` wires the real process.
 * @module
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { initApp, INIT_KINDS } from './init.js';
import { formatValidation, validateProject } from './validate/index.js';
import { writeAssets } from './assets.js';
import { PACK_OUT_DIR, buildPack, writePack } from './pack/index.js';

export const VERSION = '0.1.0';

/** @typedef {{ out: (text: string) => void, err: (text: string) => void }} Io */
/**
 * @typedef {object} CliDeps
 * @property {Io} io
 * @property {string} [cwd]
 */

export const USAGE = `ss — Single Solution developer CLI (SSPS v1)

Usage:
  ss app init <dir> --kind service|pack --slug <slug> --name <name> [--sdk-version <range>] [--minimal]
  ss app validate [dir] [--json]
  ss app assets [dir] [--check]                generate app/_lib/assets.js (manifest, feature schemas, strings bundled
                                               into the Next.js server build); --check fails when it is out of date
  ss pack build [dir] [--out <dir>] [--json]   bundle the Mode A headless/ui modules (minified ESM, shared chunks), hash,
                                               write descriptor.json (default dist/pack); upload the folder in the Portal
                                               (Admin → Apps → Upload pack version / Upload widgets)

Exit codes: 0 ok, 1 validation failed or command error, 2 usage error.
`;

/**
 * @param {Io} io
 * @param {string} message
 * @returns {number}
 */
const usageError = (io, message) => {
	io.err(`ss: ${message}\n\n${USAGE}`);
	return 2;
};

/**
 * @param {string[]} args
 * @param {import('node:util').ParseArgsConfig['options']} options
 * @returns {{ values: Record<string, string | boolean | undefined>, positionals: string[] }}
 */
const parse = (args, options) => {
	const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true });
	return { values: /** @type {Record<string, string | boolean | undefined>} */ (values), positionals };
};

/**
 * `ss pack build`.
 * @param {string[]} args
 * @param {{ io: Io, cwd: string }} deps
 * @returns {Promise<number>}
 */
const pack = async (args, { io, cwd }) => {
	const [sub, ...rest] = args;
	if (sub !== 'build') return usageError(io, `unknown pack command '${sub ?? ''}'`);
	const { values, positionals } = parse(rest, { out: { type: 'string' }, json: { type: 'boolean' } });
	const dir = path.resolve(cwd, positionals[0] ?? '.');
	const out = path.resolve(dir, typeof values.out === 'string' ? values.out : PACK_OUT_DIR);
	const built = await buildPack(dir);
	await writePack(built, out);
	io.out(
		values.json
			? `${JSON.stringify({ out, assets: built.assets.map(({ path: file, size }) => ({ path: file, size })) }, null, 2)}\n`
			: [
					...built.assets.map((asset) => `${asset.path.padEnd(48)} ${String(asset.size).padStart(7)} B`),
					`${built.assets.length} assets and descriptor.json written to ${path.relative(cwd, out) || out}`,
					'',
				].join('\n'),
	);
	return 0;
};

/**
 * Run the CLI.
 * @param {string[]} argv arguments after `ss`
 * @param {CliDeps} deps
 * @returns {Promise<number>} exit code
 */
export const main = async (argv, deps) => {
	const io = deps.io;
	const full = { io, cwd: deps.cwd ?? process.cwd() };
	const [command, ...rest] = argv;
	try {
		if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
			io.out(USAGE);
			return 0;
		}
		if (command === '--version' || command === '-v') {
			io.out(`${VERSION}\n`);
			return 0;
		}
		if (command === 'app') {
			const [sub, ...args] = rest;
			if (sub === 'init') {
				const { values, positionals } = parse(args, {
					kind: { type: 'string' },
					slug: { type: 'string' },
					name: { type: 'string' },
					'sdk-version': { type: 'string' },
					minimal: { type: 'boolean' },
				});
				const [dir] = positionals;
				if (!dir) return usageError(io, 'app init needs a target directory');
				const kind = /** @type {'service' | 'pack'} */ (values.kind);
				if (!INIT_KINDS.includes(kind)) return usageError(io, '--kind must be service or pack');
				const result = await initApp({
					dir: path.resolve(full.cwd, dir),
					kind,
					slug: String(values.slug ?? ''),
					name: String(values.name ?? ''),
					...(typeof values['sdk-version'] === 'string' ? { sdkVersion: values['sdk-version'] } : {}),
					...(values.minimal === true ? { minimal: true } : {}),
				});
				io.out(
					`Created ${kind} product '${values.slug}' in ${path.relative(full.cwd, result.dir) || '.'} (${result.files.length} files)\nNext: cd ${dir} && ss app validate${kind === 'service' ? ' && pnpm dev' : ' && ss pack build'}\n`,
				);
				return 0;
			}
			if (sub === 'assets') {
				const { values, positionals } = parse(args, { check: { type: 'boolean' } });
				const result = await writeAssets(path.resolve(full.cwd, positionals[0] ?? '.'), { check: values.check === true });
				const where = path.relative(full.cwd, result.file) || result.file;
				if (values.check === true && !result.upToDate) {
					io.err(`${where} is out of date: run ss app assets\n`);
					return 1;
				}
				io.out(`${where} ${result.upToDate ? 'is up to date' : 'written'}\n`);
				return 0;
			}
			if (sub === 'validate') {
				const { values, positionals } = parse(args, { json: { type: 'boolean' } });
				const report = await validateProject(path.resolve(full.cwd, positionals[0] ?? '.'));
				io.out(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatValidation(report));
				return report.ok ? 0 : 1;
			}
			return usageError(io, `unknown app command '${sub ?? ''}'`);
		}
		if (command === 'pack') return await pack(rest, full);
		return usageError(io, `unknown command '${command}'`);
	} catch (error) {
		const code = /** @type {{ code?: string }} */ (error).code;
		if (
			code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ||
			code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ||
			code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL'
		) {
			return usageError(io, /** @type {Error} */ (error).message);
		}
		io.err(`ss: ${/** @type {Error} */ (error).message}\n`);
		return 1;
	}
};
