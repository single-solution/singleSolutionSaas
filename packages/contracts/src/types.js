/**
 * JSDoc type definitions for the v1 contracts. This module has no runtime exports besides an empty marker; import the
 * types with `@typedef {import('@ss/contracts/src/types.js').Manifest} Manifest` or via the package index.
 * @module
 */

/**
 * @typedef {object} ValidationProblem
 * @property {string} path JSON Pointer into the validated value (`''` = root)
 * @property {string} message human-readable explanation
 * @property {string} keyword schema keyword or semantic rule id
 */

/**
 * @template T
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly problems: ReadonlyArray<ValidationProblem> }} ValidationResult
 */

/** @typedef {'A' | 'B' | 'C'} Mode */
/** @typedef {'database' | 'storage' | 'ai' | 'messaging' | 'payments' | 'analytics'} ResourceKind */
/** @typedef {'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object'} FeatureType */

/**
 * @typedef {object} FeatureNode
 * @property {FeatureType} type
 * @property {string} [title]
 * @property {string} [description]
 * @property {unknown} [default]
 * @property {unknown[]} [enum]
 * @property {unknown} [const]
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {number} [exclusiveMinimum]
 * @property {number} [exclusiveMaximum]
 * @property {number} [multipleOf]
 * @property {number} [minLength]
 * @property {number} [maxLength]
 * @property {string} [pattern]
 * @property {string} [format]
 * @property {FeatureNode} [items]
 * @property {number} [minItems]
 * @property {number} [maxItems]
 * @property {boolean} [uniqueItems]
 * @property {Record<string, FeatureNode>} [properties]
 * @property {string[]} [required]
 * @property {false} [additionalProperties]
 * @property {Record<string, unknown>} [x-ui]
 * @property {Record<string, { default?: unknown, max?: number | boolean }>} [x-plan]
 * @property {boolean} [x-lock]
 * @property {boolean} [x-experiment]
 * @property {'flag' | 'quota' | 'limit' | 'rate' | 'config'} [x-kind]
 * @property {'hour' | 'day' | 'week' | 'month'} [x-period] quota reset period (required for quotas)
 * @property {boolean} [x-hardStop] quota: block at the limit (true) or allow overage (false)
 * @property {string} [x-unit] quota/rate: counted unit, e.g. `redemption`
 * @property {'second' | 'minute' | 'hour'} [x-per] rate window (required for rates)
 */

/**
 * @typedef {object} FeatureSchema
 * @property {'object'} type
 * @property {string} [title]
 * @property {string} [description]
 * @property {Record<string, FeatureNode>} properties
 * @property {string[]} [required]
 * @property {false} [additionalProperties]
 */

/**
 * @typedef {object} MeteredPrice
 * @property {string} unit
 * @property {number} perUnit integer millicredits per `per` units
 * @property {number} [per] units priced together (default 1)
 * @property {Record<string, number>} [included] included units per plan code
 */

/**
 * @typedef {object} ManifestElement
 * @property {string} key
 * @property {string} name
 * @property {string} [description]
 * @property {Mode[]} modes
 * @property {boolean} [stateful]
 * @property {{ hourly: number, metered?: MeteredPrice[] }} price hourly in integer millicredits
 * @property {{ js: number }} [budget] KB
 * @property {string[]} [dependsOn]
 * @property {{ resources?: ResourceKind[] }} [requires]
 * @property {FeatureSchema} [features]
 * @property {string} [strings]
 * @property {boolean} [placement]
 * @property {string[]} [rules]
 * @property {string[]} [hooks]
 * @property {string[]} [customFields]
 * @property {boolean} [experiments]
 * @property {{ resources?: string[] }} [api]
 * @property {string | null} [headless]
 * @property {string | null} [renderer]
 * @property {string[]} [variants]
 * @property {string[]} [slots]
 * @property {{ role?: string, labels?: boolean, keyboard?: boolean, reducedMotion?: boolean }} [a11y]
 */

/**
 * @typedef {object} ManifestPlan
 * @property {string} code
 * @property {string} [name]
 * @property {string[]} elements included and on by default
 * @property {string[]} [addons] allowed, off by default
 * @property {string} [description]
 */

/**
 * @typedef {object} Manifest
 * @property {'1'} ssps
 * @property {{ slug: string, name: string, kind: 'service' | 'pack', version: string, category: string, description?: string }} product
 * @property {{ base: string, dashboard?: string, demo?: string, events?: string, register?: string }} [endpoints]
 * @property {{ adminLaunch?: boolean, identityIssuer?: boolean, sandbox?: boolean, localEnforcement?: string[], offlineGrace?: string }} [capabilities]
 * @property {string[]} [scopes]
 * @property {{ resources?: ResourceKind[] }} [requires]
 * @property {{ consumes?: string[], publishes?: string[] }} [events]
 * @property {ManifestElement[]} elements
 * @property {ManifestPlan[]} [plans]
 * @property {{ version: string, effectiveFrom: string }} priceBook
 * @property {number} [trialHours]
 * @property {Record<string, string>} [retention] ISO-8601 durations per collection
 */

/**
 * @typedef {'active' | 'paused' | 'suspended' | 'spend_cap' | 'quota_exhausted' | 'resource_missing'} RuntimeState
 */

/**
 * @typedef {object} EntitlementDocument
 * @property {string} subscriptionId
 * @property {string} websiteId
 * @property {string} merchantId
 * @property {string} domain
 * @property {boolean} allowSubdomains
 * @property {'live' | 'test'} env
 * @property {string} productSlug
 * @property {string} [planCode]
 * @property {string} priceBookVersion
 * @property {number} version
 * @property {string} issuedAt ISO-8601 UTC
 * @property {string} validFrom ISO-8601 UTC
 * @property {string} validUntil ISO-8601 UTC
 * @property {Record<string, { enabled: boolean, reason?: string }>} elements
 * @property {Record<string, { value: unknown, source: string, locked: boolean, reason?: string }>} features keyed `<element>.<feature>`
 * @property {Record<string, Record<string, unknown>>} config
 * @property {{ state: RuntimeState, reason?: string }} runtime
 * @property {Array<{ kind: ResourceKind, ref: string, status: 'connected' | 'missing' | 'failing' | 'revoked' }>} resources
 * @property {{ prefix: string }} dataScope
 * @property {IdentitySection} [identity] the website's own customer identity issuer (bring-your-own identity)
 * @property {WebsiteSection} [website] website defaults filled by the Portal (time zone, language, currency)
 * @property {Array<{ element: string, variant: string }>} experiments
 */

/**
 * @typedef {object} WebsiteSection website settings copied into every document of the website (all optional)
 * @property {string} [timeZone] IANA time zone name, e.g. `Europe/Berlin`
 * @property {string} [language] BCP-47 language tag, e.g. `en` or `pt-BR`
 * @property {string} [currency] ISO-4217 code, e.g. `EUR`
 */

/**
 * @typedef {object} IdentityJwk public signature key of an identity issuer
 * @property {'OKP' | 'EC' | 'RSA'} kty
 * @property {string} kid
 * @property {'EdDSA' | 'ES256' | 'RS256'} [alg]
 * @property {'sig'} [use]
 * @property {'Ed25519' | 'P-256'} [crv]
 * @property {string} [x]
 * @property {string} [y]
 * @property {string} [n]
 * @property {string} [e]
 */

/**
 * @typedef {object} IdentitySection
 * @property {string} issuer `iss` of customer tokens
 * @property {IdentityJwk[]} jwks issuer public keys (≤ 5)
 * @property {string} [audience] required `aud` when set
 * @property {{ subject: string, email?: string, phone?: string }} claimMap claim names
 */

/**
 * @typedef {object} EventEnvelope
 * @property {string} id
 * @property {string} type `name@version`
 * @property {'website'} [scope] default `website` (see {@link PlatformEventEnvelope} for platform-scoped events)
 * @property {string} websiteId
 * @property {'live' | 'test'} env
 * @property {string} occurredAt
 * @property {string} idempotencyKey
 * @property {{ type: string, id?: string }} actor
 * @property {Record<string, unknown>} data
 * @property {{ element?: string, keyKind?: 'pk' | 'sk' } & Record<string, unknown>} [context] `keyKind` is set by the
 *   Portal Event Hub on delivery (the kind of website key the event was ingested with); producers never set it
 */

/**
 * A platform-scoped event (e.g. `manifest.accepted@1`): `scope: 'platform'` and no `websiteId`.
 * @typedef {Omit<EventEnvelope, 'scope' | 'websiteId'> & { scope: 'platform', websiteId?: undefined }} PlatformEventEnvelope
 */

/** @typedef {EventEnvelope | PlatformEventEnvelope} AnyEventEnvelope */

/**
 * @typedef {object} Placement
 * @property {{ include?: string[], exclude?: string[] }} [paths]
 * @property {Array<{ selector: string, position?: string }>} [selectors]
 * @property {string[]} [pageTypes]
 * @property {string[]} [devices]
 * @property {{ include?: string[], exclude?: string[] }} [referrers]
 * @property {{ timezone: string, from?: string, until?: string, windows?: Array<{ days?: string[], start: string, end: string }> }} [schedule]
 * @property {string[]} [consent]
 * @property {Array<Record<string, unknown> & { type: string }>} [triggers]
 * @property {Record<string, number | string>} [frequency]
 * @property {string} [audience]
 */

export {};
