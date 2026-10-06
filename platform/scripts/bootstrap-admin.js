// CLI alternative to /setup: `node scripts/bootstrap-admin.js <email> [--name "Full Name"] [--url https://portal.example.com]`
// with the Portal environment set. Before setup, `--url` records the Portal URL. Creates the first staff user (role
// superadmin, no password) and prints a single-use, 30-minute password-setup link; TOTP enrolment is enforced at the
// first sign-in. Refused once any staff user exists — there is never a default password.
import { checkPortalUrl } from '../src/infra/config.js';
import { closeMongoClients } from '../src/infra/db.js';
import { isProblem } from '../src/infra/http.js';
import { getPortal, resetPortal } from '../src/runtime.js';
import { email as parseEmail } from '../src/modules/identity/core/inputs.js';

const args = process.argv.slice(2);
/** @param {string} flag */
const option = (flag) => {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
};
const name = option('--name');
const url = option('--url');
const positional = args.filter((arg, i) => !arg.startsWith('--') && !['--name', '--url'].includes(args[i - 1] ?? ''));
const parsed = parseEmail(positional[0]);

try {
	if (!parsed.ok) {
		process.stderr.write('usage: node scripts/bootstrap-admin.js <email> [--name "Full Name"] [--url <portal url>]\n');
		process.exitCode = 2;
	} else {
		let portal = await getPortal();
		if (url !== undefined || !portal.config.setUp) {
			const checked = checkPortalUrl(url, { production: portal.config.isProduction });
			if (!checked.ok) throw new Error(`--url: ${checked.message}`);
			await /** @type {import('../src/infra/system.js').SystemStore} */ (portal.shared.system).update({
				portalUrl: checked.url,
				setup: true,
			});
			resetPortal();
			portal = await getPortal();
		}
		const identity = /** @type {any} */ (portal.modules.service('identity'));
		const { staffId, link } = await identity.bootstrapSuperadmin({ email: parsed.value, ...(name ? { name } : {}) });
		process.stdout.write(`Superadmin ${staffId} created for ${parsed.value}.\n`);
		process.stdout.write(`Set the password within 30 minutes (single use):\n${link}\n`);
	}
} catch (error) {
	const message = isProblem(error) ? (error.detail ?? error.code) : error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
} finally {
	await closeMongoClients();
}
