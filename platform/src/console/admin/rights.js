/**
 * The admin's rights in the consoles (pure; usable on the server and in the browser): the infra rights table of PLAN
 * 0.2. Menus and buttons follow it; the API checks every request again.
 * @module
 */
import { can } from '../../infra/rbac.js';

/**
 * Does the signed-in admin's role hold `permission`?
 * @param {any} admin `{ adminId, role }`
 * @param {string} permission
 */
export const adminCan = (admin, permission) =>
	Boolean(admin) && can({ type: 'admin', id: String(admin.adminId ?? 'admin'), role: admin.role ?? null }, permission);
