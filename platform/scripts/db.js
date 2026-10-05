// Operational entry point: `node scripts/db.js <indexes|migrate> [--dry-run]` with the Portal environment set.
// Run `indexes` then `migrate` in the deploy pipeline before traffic moves (the "migration gate", PLAN §13).
import { closeMongoClients } from '../src/infra/db.js';
import { getPortal } from '../src/runtime.js';

const [command, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
/** @param {unknown} value */
const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

try {
	const portal = getPortal();
	if (command === 'indexes') print(await portal.ensureIndexes({ dryRun }));
	else if (command === 'migrate') print(await portal.migrate({ dryRun }));
	else {
		process.stderr.write('usage: node scripts/db.js <indexes|migrate> [--dry-run]\n');
		process.exitCode = 2;
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
} finally {
	await closeMongoClients();
}
