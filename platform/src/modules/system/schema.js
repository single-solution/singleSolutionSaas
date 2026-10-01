/**
 * Collections of the `system` module.
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const SETTINGS = 'system_settings';

export const collections = Object.freeze([
	defineCollection({
		module: 'system',
		name: SETTINGS,
		description: 'Platform-wide settings (key → value), e.g. the console notice banner.',
	}),
]);
