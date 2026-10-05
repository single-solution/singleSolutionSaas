#!/usr/bin/env node
/* v8 ignore start — process wiring only; everything else is tested through main(). */
import { main } from './cli.js';

const io = {
	out: (/** @type {string} */ text) => {
		process.stdout.write(text);
	},
	err: (/** @type {string} */ text) => {
		process.stderr.write(text);
	},
};

process.exitCode = await main(process.argv.slice(2), { io });
/* v8 ignore stop */
