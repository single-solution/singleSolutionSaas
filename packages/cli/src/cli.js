/**
 * `ss` command dispatcher. Every side effect is injected (`io`, `cwd`, `env`, `fetch`, `untilStopped`), so the whole
 * CLI is testable in-process; `bin.js` wires the real process.
 * @module
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { generateConnectSecret, parseSigningKeys } from '@ss/protocol';
import { initApp, INIT_KINDS } from './init.js';
import { formatValidation, validateProject } from './validate/index.js';
import { loadManifest } from './manifest.js';
import { exists, isObject, readJson, walk } from './fsutil.js';
import { normaliseFixture } from './emulator/fixture.js';
import { createPortal } from './emulator/portal.js';
import { createEmulatorServer } from './emulator/server.js';
import { createDatabaseResolver } from './emulator/mongo.js';
import { formatSettlement } from './emulator/settle.js';
import { formatReport, runCertification } from './certify/index.js';
import { PACK_OUT_DIR, buildPack, measurePack, publishPack, writePack } from './pack/index.js';

export const VERSION = '0.1.0';

/** @typedef {{ out: (text: string) => void, err: (text: string) => void }} Io */
/**
 * @typedef {object} CliDeps
 * @property {Io} io
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env]
 * @property {typeof fetch} [fetch]
 * @property {() => Promise<void>} [untilStopped] resolves when `ss dev` should shut down (default: SIGINT/SIGTERM)
 * @property {(server: import('./emulator/server.js').EmulatorServer, portal: import('./emulator/portal.js').Portal) => void} [onServer] test hook
 */

/**
 * A value from a dotenv file (`NAME=value` lines), or undefined.
 * @param {string} file
 * @param {string} name
 * @returns {Promise<string | undefined>}
 */
const envFileValue = async (file, name) => {
	const text = await readFile(file, 'utf8').catch(() => '');
	const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
	const value = line
		?.slice(name.length + 1)
		.trim()
		.replace(/^(['"])(.*)\1$/, '$2');
	return value || undefined;
};

export const USAGE = `ss — Single Solution developer CLI (SSPS v1)

Usage:
  ss app init <dir> --kind service|pack --slug <slug> --name <name> [--sdk-version <range>] [--minimal]
  ss app validate [dir] [--json]
  ss pack build [dir] [--out <dir>] [--json]   bundle (minified ESM, shared chunks), hash, write descriptor.json (default dist/pack)
  ss pack publish [dir] --portal <url> [--token <sst_…>] [--key <kid:seed|@file>] [--activate]
                                               sign the descriptor (signBundle) and upload it to the Portal admin pack API
                                               (token: ADMIN_TOKEN, key: PACK_SIGNING_KEY)
  ss dev [--dir <dir>] [--port <n>] [--fixture ss.dev.json] [--state <file>] [--mongo-uri <uri>]
  ss dev env                                   the product environment (MONGODB_URI and CONNECT_SECRET)
  ss dev connect --url <product url> --secret <connect secret>
                                               connect a running product to the emulator (default secret: CONNECT_SECRET)
  ss dev launch --kind merchant|demo|admin|impersonate|partner|developer [--scope <merchantId|all>] [--merchant <id>] [--website <id>] [--actor <staff id>]
  ss dev keys [--website <id>] [--rotate] [--revoke <keyId>]
  ss dev emit <type[@v]> [--website <id>] [--data <json|@file>] [--force]
  ss dev entitlements --website <id> --element <key> --enabled true|false [--layer website|merchant|platform|admin]
  ss dev subscription --website <id> --status active|paused|cancelled [--reason <code>]
  ss dev resource --website <id> --kind database|storage|ai|messaging|payments|analytics --status connected|missing|failing|revoked
  ss dev identity [--website <id> --decision approve|reject]   list or decide identity-issuer requests
  ss dev settle [--hours <n>]
  ss dev state
  ss certify [dir] --url <product url> [--secret <s>] [--portal-url <url>] [--state <file>] [--report <file>] [--json]
                                               (connects the product itself; secret: --secret, CONNECT_SECRET or .env.local)

Exit codes: 0 ok, 1 validation/certification failed or command error, 2 usage error.
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

/** Where `ss dev` records its URL and admin token for the other `ss dev …` commands. */
export const SESSION_FILE = '.ss/dev-session.json';

/**
 * @param {string} dir
 * @returns {Promise<{ url: string, adminToken: string } | null>}
 */
const readSession = async (dir) => {
	const session = await readJson(path.join(dir, SESSION_FILE));
	return session.ok &&
		isObject(session.value) &&
		typeof session.value.url === 'string' &&
		typeof session.value.adminToken === 'string'
		? { url: session.value.url, adminToken: session.value.adminToken }
		: null;
};

/**
 * Call the running emulator's admin API.
 * @param {{ dir: string, fetch: typeof fetch, operation: string, body?: unknown, emulator?: string, adminToken?: string }} input
 * @returns {Promise<any>}
 */
const adminCall = async ({ dir, fetch, operation, body, emulator, adminToken }) => {
	const session = emulator && adminToken ? { url: emulator, adminToken } : await readSession(dir);
	if (!session)
		throw Object.assign(new Error(`no running emulator (start \`ss dev\` in ${dir}, or pass --emulator and --admin-token)`), {
			code: 'no_emulator',
		});
	/** @type {Response} */
	let response;
	try {
		response = await fetch(`${session.url}/_dev/${operation}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: { 'content-type': 'application/json', 'x-ss-dev-token': session.adminToken },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	} catch {
		throw Object.assign(new Error(`the emulator at ${session.url} is not reachable (is \`ss dev\` running?)`), {
			code: 'no_emulator',
		});
	}
	const result = await response.json();
	if (!response.ok)
		throw Object.assign(new Error(`${result.error ?? response.status}: ${result.message ?? ''}`), { code: result.error });
	return result;
};

/**
 * Product event data schemas from `schemas/events/<type@v>.json`.
 * @param {string} dir
 * @returns {Promise<Record<string, object>>}
 */
const loadEventSchemas = async (dir) => {
	/** @type {Record<string, object>} */
	const schemas = {};
	for (const file of await walk(path.join(dir, 'schemas', 'events'))) {
		if (!file.endsWith('.json') || file.includes('/')) continue;
		const parsed = await readJson(path.join(dir, 'schemas', 'events', file));
		if (parsed.ok && isObject(parsed.value)) schemas[file.slice(0, -5)] = parsed.value;
	}
	return schemas;
};

/**
 * @param {string} dir
 * @param {string | undefined} file
 */
const loadFixture = async (dir, file) => {
	const target = path.resolve(dir, file ?? 'ss.dev.json');
	if (!(await exists(target))) {
		if (file) throw Object.assign(new Error(`fixture ${file} not found`), { code: 'invalid_fixture' });
		return normaliseFixture({});
	}
	const parsed = await readJson(target);
	if (!parsed.ok) throw Object.assign(new Error(`${path.basename(target)}: ${parsed.message}`), { code: 'invalid_fixture' });
	return normaliseFixture(parsed.value);
};

/**
 * @param {string} value
 * @param {string} cwd
 * @returns {Promise<Record<string, unknown>>}
 */
const readData = async (value, cwd) => {
	const text = value.startsWith('@') ? await readFile(path.resolve(cwd, value.slice(1)), 'utf8') : value;
	const parsed = JSON.parse(text);
	if (!isObject(parsed)) throw new Error('--data must be a JSON object');
	return parsed;
};

/**
 * A private key given as `kid:seed` (the environment form) or as `@file` (`kid:seed`, or a private JWK file).
 * @param {string} value
 * @param {string} cwd
 * @returns {Promise<Record<string, unknown>>}
 */
const readKey = async (value, cwd) => {
	const text = (value.startsWith('@') ? await readFile(path.resolve(cwd, value.slice(1)), 'utf8') : value).trim();
	const invalid = () =>
		Object.assign(new Error('--key must be kid:seed (seed = base64url of 32 bytes) or a private Ed25519 JWK file'), {
			code: 'invalid_key',
		});
	if (text.startsWith('{')) {
		const parsed = JSON.parse(text);
		if (!isObject(parsed) || typeof parsed.d !== 'string' || typeof parsed.kid !== 'string') throw invalid();
		return parsed;
	}
	try {
		const [key] = parseSigningKeys(text);
		if (key) return key;
	} catch {
		// reported below
	}
	throw invalid();
};

/**
 * `ss pack build | publish` (F.18).
 * @param {string[]} args
 * @param {Required<Pick<CliDeps, 'io' | 'cwd' | 'env' | 'fetch'>> & CliDeps} deps
 * @returns {Promise<number>}
 */
const pack = async (args, deps) => {
	const { io, cwd, env, fetch } = deps;
	const [sub, ...rest] = args;
	if (sub === 'build') {
		const { values, positionals } = parse(rest, { out: { type: 'string' }, json: { type: 'boolean' } });
		const dir = path.resolve(cwd, positionals[0] ?? '.');
		const out = path.resolve(dir, typeof values.out === 'string' ? values.out : PACK_OUT_DIR);
		const built = await buildPack(dir);
		await writePack(built, out);
		const measured = measurePack(built);
		if (values.json)
			io.out(`${JSON.stringify({ out, assets: built.assets.length, budget: measured }, null, 2)}
`);
		else
			io.out(
				[
					...built.assets.map((asset) => `${asset.path.padEnd(48)} ${String(asset.size).padStart(7)} B`),
					...measured.elements.map((element) => `budget ${element.key.padEnd(24)} ${element.kb} KB gzip`),
					`budget shared ${String(measured.shared.kb)} KB gzip (${measured.shared.modules.length} modules)`,
					`${built.assets.length} assets and descriptor.json written to ${path.relative(cwd, out) || out}`,
					'',
				].join('\n'),
			);
		return 0;
	}
	if (sub === 'publish') {
		const { values, positionals } = parse(rest, {
			portal: { type: 'string' },
			token: { type: 'string' },
			key: { type: 'string' },
			activate: { type: 'boolean' },
		});
		const portalUrl = typeof values.portal === 'string' ? values.portal : env.PORTAL_URL;
		const token = typeof values.token === 'string' ? values.token : env.ADMIN_TOKEN;
		const key = typeof values.key === 'string' ? values.key : env.PACK_SIGNING_KEY;
		if (!portalUrl) return usageError(io, 'pack publish needs --portal <url> (or PORTAL_URL)');
		if (!token) return usageError(io, 'pack publish needs --token <staff API token> (or ADMIN_TOKEN)');
		if (!key) return usageError(io, 'pack publish needs --key <kid:seed|@file> (or PACK_SIGNING_KEY)');
		const dir = path.resolve(cwd, positionals[0] ?? '.');
		const result = await publishPack({
			pack: await buildPack(dir),
			portalUrl,
			token,
			signingKey: await readKey(key, cwd),
			fetch,
			activate: values.activate === true,
		});
		io.out(`Published ${result.appId} version ${result.version} (${result.uploaded} assets, ${result.status})\n`);
		return 0;
	}
	return usageError(io, `unknown pack command '${sub ?? ''}'`);
};

/**
 * `ss dev` (server) and its subcommands.
 * @param {string[]} args
 * @param {Required<Pick<CliDeps, 'io' | 'cwd' | 'env' | 'fetch'>> & CliDeps} deps
 * @returns {Promise<number>}
 */
const dev = async (args, deps) => {
	const { io, cwd, fetch } = deps;
	const [sub] = args;
	const common = {
		dir: { type: /** @type {const} */ ('string') },
		emulator: { type: /** @type {const} */ ('string') },
		'admin-token': { type: /** @type {const} */ ('string') },
	};
	const rest = args.slice(1);

	if (sub === 'env') {
		parse(rest, {});
		io.out(
			[
				'# Product environment: its own control database (empty = in memory, development only) and a random',
				'# connect secret of at least 32 characters (without it the product refuses connections).',
				'MONGODB_URI=',
				`CONNECT_SECRET=${generateConnectSecret()}`,
				'# Then connect it: `ss dev connect --url http://localhost:3000 --secret <CONNECT_SECRET>`.',
				'',
			].join('\n'),
		);
		return 0;
	}

	if (sub === undefined || sub.startsWith('-')) {
		const { values } = parse(args, {
			...common,
			port: { type: 'string' },
			fixture: { type: 'string' },
			state: { type: 'string' },
			'mongo-uri': { type: 'string' },
			'portal-url': { type: 'string' },
		});
		const dir = path.resolve(cwd, typeof values.dir === 'string' ? values.dir : '.');
		const fixture = await loadFixture(dir, typeof values.fixture === 'string' ? values.fixture : undefined);
		const statePath = typeof values.state === 'string' ? path.resolve(cwd, values.state) : null;
		const saved = statePath ? await readJson(statePath) : null;
		const snapshot = saved?.ok && isObject(saved.value) ? saved.value : undefined;
		const database = createDatabaseResolver({
			uri: typeof values['mongo-uri'] === 'string' ? values['mongo-uri'] : (deps.env.DEV_MONGODB_URI ?? null),
		});
		/** @type {Promise<void>} */
		let saving = Promise.resolve();
		/** @type {import('./emulator/portal.js').Portal | null} */
		let portalRef = null;
		const portal = await createPortal({
			fixture,
			...(typeof values['portal-url'] === 'string' ? { portalUrl: values['portal-url'] } : {}),
			...(snapshot ? { snapshot } : {}),
			fetch,
			database,
			eventSchemas: await loadEventSchemas(dir),
			log: (line) => io.out(`  ${new Date().toISOString().slice(11, 19)}  ${line}\n`),
			onChange: () => {
				if (!statePath || !portalRef) return;
				const current = portalRef;
				saving = saving.then(async () => {
					await mkdir(path.dirname(statePath), { recursive: true });
					await writeFile(statePath, `${JSON.stringify(current.snapshot(), null, 2)}\n`);
				});
			},
		});
		portalRef = portal;
		const port = typeof values.port === 'string' ? Number(values.port) : undefined;
		const server = createEmulatorServer({
			portal,
			...(port === undefined ? {} : { port }),
			log: (line) => io.err(`${line}\n`),
		});
		try {
			await server.start();
		} catch (error) {
			io.err(`ss dev: cannot listen on ${portal.portalUrl}: ${/** @type {Error} */ (error).message}\n`);
			return 1;
		}
		const sessionPath = path.join(dir, SESSION_FILE);
		await mkdir(path.dirname(sessionPath), { recursive: true });
		await writeFile(
			sessionPath,
			`${JSON.stringify({ url: portal.portalUrl, adminToken: server.adminToken, startedAt: new Date().toISOString() }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		const keys = await portal.websiteKeys();
		io.out(
			[
				`Portal emulator  ${portal.portalUrl}`,
				`  JWKS           ${portal.portalUrl}/.well-known/jwks.json`,
				`  product API    ${portal.portalUrl}/v1/product/*`,
				...fixture.websites.map((website) => `  website        ${website.id}  ${website.domain} (${website.env})`),
				...keys.map(
					(key) =>
						`  ${key.kind === 'pk' ? 'publishable' : 'secret     '}    ${key.key.slice(0, 24)}…  (${key.websiteId}; full key: ss dev keys)`,
				),
				...portal.apps().map((app) => `  connected      ${app.manifest.product.slug} → ${app.baseUrl} (${app.appId})`),
				`Connect the product: ss dev connect --url ${fixture.product.url ?? 'http://localhost:3000'} --secret <its CONNECT_SECRET>`,
				statePath
					? `State file: ${path.relative(cwd, statePath)}`
					: 'State: in memory (pass --state .ss/dev-state.json to persist)',
				'Ctrl+C to stop.',
				'',
			].join('\n'),
		);
		deps.onServer?.(server, portal);
		await (deps.untilStopped ?? defaultUntilStopped)();
		await server.stop();
		await saving;
		await database.stop();
		await rm(sessionPath, { force: true });
		io.out('Portal emulator stopped.\n');
		return 0;
	}

	const call = async (
		/** @type {Record<string, unknown>} */ values,
		/** @type {string} */ operation,
		/** @type {unknown} */ body,
	) =>
		adminCall({
			dir: path.resolve(cwd, typeof values.dir === 'string' ? values.dir : '.'),
			fetch,
			operation,
			body,
			...(typeof values.emulator === 'string' ? { emulator: values.emulator } : {}),
			...(typeof values['admin-token'] === 'string' ? { adminToken: values['admin-token'] } : {}),
		});

	switch (sub) {
		case 'connect': {
			const { values } = parse(rest, { ...common, url: { type: 'string' }, secret: { type: 'string' } });
			const secret = typeof values.secret === 'string' ? values.secret : deps.env.CONNECT_SECRET;
			if (typeof values.url !== 'string' || !secret)
				return usageError(io, 'dev connect needs --url <product url> --secret <connect secret>');
			const result = await call(values, 'connect', { url: values.url, secret });
			io.out(
				`Connected ${result.manifest.product.slug} as ${result.appId}\n  product key ${result.kid} (jkt ${result.thumbprint}) — signed answer verified\n`,
			);
			return 0;
		}
		case 'launch': {
			const { values } = parse(rest, {
				...common,
				kind: { type: 'string' },
				scope: { type: 'string' },
				merchant: { type: 'string' },
				website: { type: 'string' },
				actor: { type: 'string' },
				partner: { type: 'string' },
				developer: { type: 'string' },
				'app-id': { type: 'string' },
				url: { type: 'string' },
				ttl: { type: 'string' },
			});
			if (typeof values.kind !== 'string') return usageError(io, 'dev launch needs --kind');
			const result = await call(values, 'launch', {
				kind: values.kind,
				...(typeof values.scope === 'string' ? { scope: values.scope } : {}),
				...(typeof values.merchant === 'string' ? { merchantId: values.merchant } : {}),
				...(typeof values.website === 'string' ? { websiteId: values.website } : {}),
				...(typeof values.actor === 'string' ? { actor: values.actor } : {}),
				...(typeof values.partner === 'string' ? { partnerId: values.partner } : {}),
				...(typeof values.developer === 'string' ? { developerId: values.developer } : {}),
				...(typeof values['app-id'] === 'string' ? { appId: values['app-id'] } : {}),
				...(typeof values.url === 'string' ? { baseUrl: values.url } : {}),
				...(typeof values.ttl === 'string' ? { ttlSeconds: Number(values.ttl) } : {}),
			});
			io.out(`${result.url}\n`);
			io.err(
				`  ${result.claims.kind} launch for ${result.claims.sub}, scope ${JSON.stringify(result.claims.scope)}, expires ${new Date(result.claims.exp * 1000).toISOString()} (single use)\n`,
			);
			return 0;
		}
		case 'keys': {
			const { values } = parse(rest, {
				...common,
				website: { type: 'string' },
				rotate: { type: 'boolean' },
				revoke: { type: 'string' },
			});
			if (typeof values.revoke === 'string') {
				const key = await call(values, 'revoke', { keyId: values.revoke });
				io.out(`Revoked ${key.keyId} (${key.kind}_${key.env}, ${key.websiteId}) at ${key.revokedAt}\n`);
				return 0;
			}
			const keys = await call(
				values,
				'keys',
				values.rotate || typeof values.website === 'string'
					? { ...(typeof values.website === 'string' ? { websiteId: values.website } : {}), rotate: true }
					: undefined,
			);
			for (const key of keys) io.out(`${key.websiteId}  ${key.kind}  ${key.keyId}  ${key.key}\n`);
			return 0;
		}
		case 'emit': {
			const { values, positionals } = parse(rest, {
				...common,
				website: { type: 'string' },
				data: { type: 'string' },
				force: { type: 'boolean' },
				id: { type: 'string' },
			});
			const [type] = positionals;
			if (!type) return usageError(io, 'dev emit needs an event type, e.g. order.placed');
			const result = await call(values, 'emit', {
				type,
				...(typeof values.website === 'string' ? { websiteId: values.website } : {}),
				...(typeof values.data === 'string' ? { data: await readData(values.data, cwd) } : {}),
				...(typeof values.id === 'string' ? { id: values.id } : {}),
				...(values.force ? { force: true } : {}),
			});
			io.out(`${result.event.type} ${result.event.id} → ${result.status}\n${JSON.stringify(result.body)}\n`);
			return result.status >= 200 && result.status < 300 ? 0 : 1;
		}
		case 'entitlements': {
			const { values } = parse(rest, {
				...common,
				website: { type: 'string' },
				element: { type: 'string' },
				enabled: { type: 'string' },
				layer: { type: 'string' },
				feature: { type: 'string' },
				value: { type: 'string' },
			});
			if (typeof values.website !== 'string' || typeof values.element !== 'string')
				return usageError(io, 'dev entitlements needs --website and --element');
			const layer = await call(values, 'entitlements', {
				websiteId: values.website,
				element: values.element,
				...(typeof values.enabled === 'string' ? { enabled: values.enabled === 'true' } : {}),
				...(typeof values.feature === 'string'
					? { feature: values.feature, value: JSON.parse(String(values.value ?? 'null')) }
					: {}),
				...(typeof values.layer === 'string' ? { layer: values.layer } : {}),
			});
			io.out(`${JSON.stringify(layer.layer)}\n${deliveriesText(layer.deliveries)}`);
			return 0;
		}
		case 'subscription': {
			const { values } = parse(rest, {
				...common,
				website: { type: 'string' },
				status: { type: 'string' },
				reason: { type: 'string' },
			});
			if (typeof values.website !== 'string' || typeof values.status !== 'string')
				return usageError(io, 'dev subscription needs --website and --status active|paused|cancelled');
			const result = await call(values, 'subscription', {
				websiteId: values.website,
				status: values.status,
				...(typeof values.reason === 'string' ? { reason: values.reason } : {}),
			});
			io.out(`${result.type}\n${deliveriesText(result.deliveries)}`);
			return 0;
		}
		case 'resource': {
			const { values } = parse(rest, {
				...common,
				website: { type: 'string' },
				kind: { type: 'string' },
				status: { type: 'string' },
			});
			if (typeof values.website !== 'string' || typeof values.kind !== 'string' || typeof values.status !== 'string')
				return usageError(io, 'dev resource needs --website, --kind and --status');
			const result = await call(values, 'resource', { websiteId: values.website, kind: values.kind, status: values.status });
			io.out(`${JSON.stringify(result.resources)}\n${deliveriesText(result.deliveries)}`);
			return 0;
		}
		case 'identity': {
			const { values } = parse(rest, { ...common, website: { type: 'string' }, decision: { type: 'string' } });
			if (typeof values.website !== 'string') {
				io.out(`${JSON.stringify(await call(values, 'identity', {}), null, 2)}\n`);
				return 0;
			}
			if (values.decision !== 'approve' && values.decision !== 'reject')
				return usageError(io, 'dev identity --website needs --decision approve|reject');
			const result = await call(values, 'identity', { websiteId: values.website, decision: values.decision });
			io.out(`identity issuer request ${result.request.status}\n${deliveriesText(result.deliveries)}`);
			return 0;
		}
		case 'settle': {
			const { values } = parse(rest, { ...common, hours: { type: 'string' }, fixture: { type: 'string' } });
			const hours = typeof values.hours === 'string' ? Number(values.hours) : 1;
			if (!Number.isInteger(hours) || hours < 1) return usageError(io, '--hours must be a positive integer');
			/** @type {any} */
			let run;
			try {
				run = await call(values, 'settle', { hours });
			} catch (error) {
				if (
					/** @type {{ code?: string }} */ (error).code !== 'no_emulator' &&
					/** @type {{ code?: string }} */ (error).code !== 'not_registered'
				)
					throw error;
				const dir = path.resolve(cwd, typeof values.dir === 'string' ? values.dir : '.');
				const loaded = await loadManifest(dir);
				if (!loaded.ok || !isObject(loaded.manifest))
					throw new Error('no running emulator with a registered product and no manifest.json to simulate from');
				const portal = await createPortal({
					fixture: await loadFixture(dir, typeof values.fixture === 'string' ? values.fixture : undefined),
					fetch,
				});
				portal.adoptApp({
					appId: 'app_localsimulation',
					baseUrl: '',
					manifest: /** @type {any} */ (loaded.manifest),
					keys: [],
					thumbprint: '',
					registeredAt: new Date().toISOString(),
				});
				io.err(
					'(no running emulator with a registered product: simulating from manifest.json and ss.dev.json without usage)\n',
				);
				run = portal.settle({ hours });
			}
			io.out(formatSettlement(run));
			return 0;
		}
		case 'state': {
			const { values } = parse(rest, common);
			io.out(`${JSON.stringify(await call(values, 'state', undefined), null, 2)}\n`);
			return 0;
		}
		default:
			return usageError(io, `unknown dev command '${sub}'`);
	}
};

/**
 * @param {Array<{ appId: string, status: number, error?: string }>} deliveries
 * @returns {string}
 */
const deliveriesText = (deliveries) =>
	deliveries.length === 0
		? '(no registered product to notify)\n'
		: deliveries.map((delivery) => `  → ${delivery.appId}: ${delivery.error ?? delivery.status}\n`).join('');

/** @returns {Promise<void>} */
const defaultUntilStopped = () =>
	new Promise((resolve) => {
		process.once('SIGINT', () => resolve());
		process.once('SIGTERM', () => resolve());
	});

/**
 * Run the CLI.
 * @param {string[]} argv arguments after `ss`
 * @param {CliDeps} deps
 * @returns {Promise<number>} exit code
 */
export const main = async (argv, deps) => {
	const io = deps.io;
	const full = { ...deps, cwd: deps.cwd ?? process.cwd(), env: deps.env ?? process.env, fetch: deps.fetch ?? globalThis.fetch };
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
					`Created ${kind} product '${values.slug}' in ${path.relative(full.cwd, result.dir) || '.'} (${result.files.length} files)\nNext: cd ${dir} && ss app validate${kind === 'service' ? ' && ss dev env > .env.local' : ''}\n`,
				);
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
		if (command === 'dev') return await dev(rest, full);
		if (command === 'certify') {
			const { values, positionals } = parse(rest, {
				url: { type: 'string' },
				secret: { type: 'string' },
				'portal-url': { type: 'string' },
				state: { type: 'string' },
				report: { type: 'string' },
				json: { type: 'boolean' },
			});
			const dir = path.resolve(full.cwd, positionals[0] ?? '.');
			const saved = typeof values.state === 'string' ? await readJson(path.resolve(full.cwd, values.state)) : null;
			const secret =
				(typeof values.secret === 'string' ? values.secret : undefined) ??
				full.env.CONNECT_SECRET ??
				(await envFileValue(path.join(dir, '.env.local'), 'CONNECT_SECRET'));
			const report = await runCertification({
				dir,
				...(secret ? { secret } : {}),
				...(typeof values.url === 'string' ? { url: values.url } : {}),
				...(typeof values['portal-url'] === 'string' ? { portalUrl: values['portal-url'] } : {}),
				...(saved?.ok && isObject(saved.value) ? { snapshot: saved.value } : {}),
				fetch: full.fetch,
				log: values.json ? () => {} : (line) => io.err(`${line}\n`),
			});
			const reportPath = path.resolve(
				full.cwd,
				typeof values.report === 'string' ? values.report : path.join(dir, 'ss-certify-report.json'),
			);
			await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
			io.out(
				values.json
					? `${JSON.stringify(report, null, 2)}\n`
					: `${formatReport(report)}JSON report: ${path.relative(full.cwd, reportPath) || reportPath}\n`,
			);
			return report.ok ? 0 : 1;
		}
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
