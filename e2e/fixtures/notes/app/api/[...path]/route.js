/**
 * The product's API function: every kit route (`/.well-known/ss-connect`, `/.well-known/ss-events`, `/sso`,
 * `/v1/tickets`, `/v1/data-rights/*`, `/v1/dashboard/*`) and every product route (`/widget.js`, `/docs`, `/v1/*`),
 * reached through the rewrites in next.config.js. The kit strips the `/api` prefix and finishes its work after the
 * response with Next.js `after`.
 */
import { after } from 'next/server.js';
import { configFromEnv, toNextRoute } from '@ss/app-kit';
import { createProductInstance } from '../../../adapters/product.js';
import { createRoutes } from '../../../server/routes.js';

// a missing or invalid variable is named (never its value) and every route answers 503 until it is fixed
const { config, problems } = configFromEnv();
const product = createProductInstance({ config, problems });

export const dynamic = 'force-dynamic';
export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextRoute(product.handler(createRoutes(product)), { after });
