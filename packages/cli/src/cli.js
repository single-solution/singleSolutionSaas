/**
 * `ss` command dispatcher. Every side effect is injected (`io`, `cwd`), so the whole CLI is testable in-process;
 * `bin.js` wires the real process.
 * @module
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { initApp } from './init.js';
import { formatValidation, validateProject } from './validate/index.js';
import { writeAssets } from './assets.js';

export const VERSION = '0.2.0';

/** @typedef {{ out: (text: string) => void, err: (text: string) => void }} Io */
/**
 * @typedef {object} CliDeps
 * @property {Io} io
 * @property {string} [cwd]
 */

export const USAGE = `ss — Single Solution developer CLI

Usage:
  ss app init <dir> --id <id> --name <name> [--base-url <url>] [--sdk-version <range>]
                                 generate a product (PLAN 0.4.13 layout) with the sample feature notes
  ss app validate [dir] [--json] check the product standard: layout, manifest, routes, texts, .env.example,
                                 import direction, package wiring, server shape, generated files
  ss app assets [dir] [--check]  generate openapi.json (from the routes) and api/widget-script.js (ui/ bundled for
                                 browsers); --check fails when either is out of date

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
 * `ss app <sub>`.
 * @param {string | undefined} sub
 * @param {string[]} args
 * @param {{ io: Io, cwd: string }} deps
 * @returns {Promise<number>}
 */
const app = async (sub, args, { io, cwd }) => {
	if (sub === 'init') {
		const { values, positionals } = parse(args, {
			id: { type: 'string' },
			name: { type: 'string' },
			'base-url': { type: 'string' },
			'sdk-version': { type: 'string' },
		});
		const [dir] = positionals;
		if (!dir) return usageError(io, 'app init needs a target directory');
		if (typeof values.id !== 'string' || typeof values.name !== 'string')
			return usageError(io, 'app init needs --id and --name');
		const result = await initApp({
			dir: path.resolve(cwd, dir),
			id: values.id,
			name: values.name,
			...(typeof values['base-url'] === 'string' ? { baseUrl: values['base-url'] } : {}),
			...(typeof values['sdk-version'] === 'string' ? { sdkVersion: values['sdk-version'] } : {}),
		});
		io.out(
			`Created product '${values.id}' in ${path.relative(cwd, result.dir) || '.'} (${result.files.length} files)\nNext: cd ${dir} && pnpm install && pnpm validate && pnpm dev\n`,
		);
		return 0;
	}
	if (sub === 'assets') {
		const { values, positionals } = parse(args, { check: { type: 'boolean' } });
		const check = values.check === true;
		const states = await writeAssets(path.resolve(cwd, positionals[0] ?? '.'), { check });
		const stale = states.filter((state) => !state.upToDate);
		if (check && stale.length > 0) {
			io.err(`${stale.map((state) => state.file).join(', ')} out of date: run ss app assets\n`);
			return 1;
		}
		io.out(`${states.map((state) => `${state.file} ${state.upToDate ? 'is up to date' : 'written'}`).join('\n')}\n`);
		return 0;
	}
	if (sub === 'validate') {
		const { values, positionals } = parse(args, { json: { type: 'boolean' } });
		const report = await validateProject(path.resolve(cwd, positionals[0] ?? '.'));
		io.out(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatValidation(report));
		return report.ok ? 0 : 1;
	}
	return usageError(io, `unknown app command '${sub ?? ''}'`);
};

/**
 * Run the CLI.
 * @param {string[]} argv arguments after `ss`
 * @param {CliDeps} deps
 * @returns {Promise<number>} exit code
 */
export const main = async (argv, deps) => {
	const io = deps.io;
	const cwd = deps.cwd ?? process.cwd();
	const [command, sub, ...rest] = argv;
	try {
		if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
			io.out(USAGE);
			return 0;
		}
		if (command === '--version' || command === '-v') {
			io.out(`${VERSION}\n`);
			return 0;
		}
		if (command === 'app') return await app(sub, rest, { io, cwd });
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
