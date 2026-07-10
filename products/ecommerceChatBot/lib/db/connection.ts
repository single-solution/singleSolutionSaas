/**
 * This product is multi-tenant: each subscription has its own database, resolved
 * at request time (see `tenant.ts`). There is no single shared connection to a
 * fixed database; models are always bound to a tenant connection.
 */
export { Types } from "mongoose";
