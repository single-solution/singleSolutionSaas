// One-time superadmin bootstrap: `node scripts/bootstrap-admin.js <email> [--name "Full Name"]` with the Portal
// environment set. Creates the first staff user (role superadmin, no password) and prints a single-use, 30-minute
// password-setup link; TOTP enrolment is enforced at the first sign-in. Refused once any staff user exists — there
// is never a default password.
import { closeMongoClients } from '../src/infra/db.js';
import { isProblem } from '../src/infra/http.js';
import { getPortal } from '../src/runtime.js';
import { email as parseEmail } from '../src/modules/identity/core/inputs.js';

const args = process.argv.slice(2);
const nameIndex = args.indexOf('--name');
const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
const positional = args.filter((arg, i) => !arg.startsWith('--') && (nameIndex < 0 || i !== nameIndex + 1));
const parsed = parseEmail(positional[0]);

try {
	if (!parsed.ok) {
		process.stderr.write('usage: node scripts/bootstrap-admin.js <email> [--name "Full Name"]\n');
		process.exitCode = 2;
	} else {
		const portal = getPortal();
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
