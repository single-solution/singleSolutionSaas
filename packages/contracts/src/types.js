/**
 * JSDoc type definitions for the v1 contracts. This module has no runtime exports; import the types with
 * `@typedef {import('@ss/contracts').Manifest} Manifest`.
 * @module
 */

/**
 * @typedef {object} ValidationProblem
 * @property {string} path JSON Pointer into the validated value (`''` = root)
 * @property {string} message human-readable explanation
 * @property {string} keyword schema keyword or semantic rule id (`RULES`)
 */

/**
 * @template T
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly problems: ReadonlyArray<ValidationProblem> }} ValidationResult
 */

/** @typedef {'string' | 'integer' | 'number' | 'boolean' | 'array'} SettingType */

/**
 * A list item of a list setting.
 * @typedef {object} SettingItem
 * @property {'string' | 'integer' | 'number' | 'boolean'} type
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {number} [maxLength]
 * @property {string} [pattern] a regular expression (Unicode mode) a text must match
 * @property {unknown[]} [enum]
 * @property {string} [format]
 */

/**
 * One setting of a feature.
 * @typedef {object} SettingNode
 * @property {SettingType} type
 * @property {string} title
 * @property {unknown} default
 * @property {string} [description]
 * @property {number} [minimum]
 * @property {number} [maximum] the hard maximum of a limit
 * @property {number} [maxLength]
 * @property {string} [pattern] a regular expression (Unicode mode) a text must match
 * @property {unknown[]} [enum]
 * @property {string} [format]
 * @property {SettingItem} [items]
 * @property {{ widget?: string, group?: string, placeholder?: string, labels?: 'country', wide?: boolean }} [x-ui]
 *   `labels: 'country'` shows ISO country codes by their names; `wide` sets whether it spans the whole row
 */

/**
 * @typedef {object} SettingsSchema
 * @property {'object'} type
 * @property {Record<string, SettingNode>} properties
 * @property {false} [additionalProperties]
 */

/**
 * @typedef {object} ManifestFeature
 * @property {string} key permanent feature key
 * @property {string} name
 * @property {string} description one line
 * @property {string[]} dependsOn keys of the features it needs
 * @property {SettingsSchema} settings
 * @property {string[]} [recommendFor] rules of business profile tags the feature suits (`@ss/contracts/profile`)
 */

/** @typedef {{ key: string, name: string, feature: string }} ManifestPermission */
/** @typedef {{ key: string, feature: string | string[], kind: 'visitor' | 'admin' }} ManifestWidget */

/**
 * @typedef {object} Manifest
 * @property {string} id product id
 * @property {string} name
 * @property {string} version semver
 * @property {{ base: string, dashboard: string }} endpoints
 * @property {string | null} widgetScriptUrl null exactly when there are no widgets
 * @property {string} docsUrl
 * @property {ManifestFeature[]} features
 * @property {ManifestPermission[]} permissions
 * @property {ManifestWidget[]} widgets
 */

/**
 * @typedef {object} PriceListFeature
 * @property {string} key
 * @property {string} name
 * @property {string} description
 * @property {string[]} dependsOn
 * @property {number} millicreditsPerHour integer ≥ 0
 */

/**
 * Price list; also the price report body (`PUT /v1/product/prices`).
 * @typedef {{ version: number, features: PriceListFeature[] }} PriceList
 */

/** @typedef {{ version: number, on: string[], adminId: string, adminName: string }} FeatureReport */

/**
 * @typedef {object} StatusResponse
 * @property {string} websiteId
 * @property {string} merchantId
 * @property {string} merchantName
 * @property {string} domain
 * @property {import('./constants.js').ProductStatus} status
 * @property {string | null} graceEndsAt ISO-8601 UTC, null outside grace
 * @property {number} todayMillicredits
 * @property {number} featuresVersion last accepted feature-report version, raised by one when the product is added to
 *   the website again (every feature off): a product whose switches are older turns them off
 * @property {string} validUntil ISO-8601 UTC; cache at most until then
 */

/**
 * @typedef {{ websiteId: string, domain: string, merchantId: string, merchantName: string,
 *   status: import('./constants.js').ProductStatus }} WebsiteRow
 */
/** @typedef {{ items: WebsiteRow[], cursor: string | null }} WebsitesPage */
/** @typedef {{ tokenIds: string[], cursor: string | null }} Revocations */
/** @typedef {{ baseUrl: string }} Directory */
/** @typedef {{ items: Array<{ productId: string, name: string, baseUrl: string }> }} DirectoryList every connected product, by id */

/**
 * business.json, normalized: missing or invalid optional fields are `null`.
 * @typedef {object} BusinessInfo
 * @property {string} name
 * @property {string | null} logo https URL
 * @property {string | null} email
 * @property {string | null} phone
 * @property {string | null} address
 * @property {string | null} country ISO 3166-1 alpha-2, upper case
 * @property {string | null} timeZone IANA name
 */

/** @typedef {{ user: { id?: string, email?: string, phone?: string } }} DataRightsRequest */

/**
 * @typedef {object} ActivityCopy
 * @property {string} websiteId
 * @property {string} productId
 * @property {{ kind: string, id: string, name?: string, role?: string }} actor
 * @property {string} action
 * @property {string} target
 * @property {string} [label] what the target is called (for example an order number), at most 200 characters
 * @property {string} [detail] plain text, at most 2,000 characters; never message contents, secrets or addresses
 * @property {Record<string, string | number | boolean>} [values] what changed as codes, numbers and yes/no (at most 20,
 *   text at most 200 characters), which the product's texts put into words (A8): no sentence in one language is stored
 * @property {string} at ISO-8601 UTC
 */

/**
 * One message a product sends through Notifications, with its default words (parity P1).
 * @typedef {object} DeclaredMessage
 * @property {string} key the template key, `<productId>.<name>`
 * @property {string} name what the message is, for the merchant (at most 80 characters)
 * @property {string} [description] when it is sent (at most 500 characters)
 * @property {string[]} values the values every send carries (the placeholders its words may use)
 * @property {string[]} [longValues] the values that hold long text (up to 50,000 characters each), used only in a
 *   message's text: email sends them whole, a channel with a shorter limit cut to fit
 * @property {boolean} [required] sent to people who unsubscribed too (default false)
 * @property {boolean} [urgent] not held by quiet hours (default false)
 * @property {boolean} [sensitive] its values are hidden in the delivery log (default false)
 * @property {{ email?: { subject: string, text: string }, sms?: { text: string }, whatsapp?: null,
 *   push?: { subject: string, text: string }, staff_push?: { subject: string, text: string } }} channels every channel
 *   it is sent on, with its default words; `whatsapp: null`: sent on WhatsApp too, which has no default (a template
 *   approved at Meta)
 */
/** @typedef {{ productId?: string, messages: DeclaredMessage[] }} MessageDefaults */

/**
 * One setting in a Setup sheet; `value` is absent in a shared copy without values, and replaced by `set: true` when it
 * holds a secret saved in the website's Connections.
 * @typedef {{ key: string, title: string, value?: unknown, set?: boolean, default: boolean }} BlueprintSetting
 */
/** @typedef {{ name: string, title: string, summary: string, count: number | null }} BlueprintList */
/**
 * A product's part of the Setup sheet (`GET /v1/blueprint` of the kit).
 * @typedef {object} ProductBlueprint
 * @property {string} productId
 * @property {string} name
 * @property {string} version
 * @property {import('./constants.js').ProductStatus} status
 * @property {{ guide: string, openapi: string | null }} docs
 * @property {{ found: boolean, fetchedAt: string | null, name: string | null, country: string | null,
 *   timeZone: string | null }} business the product's copy of business.json
 * @property {{ scriptUrl: string | null, installed: boolean | null, lastSeenAt: string | null, browserToken?: string,
 *   snippet?: string | null }} install `browserToken` and `snippet` are added by the Portal
 * @property {Array<{ key: string, title: string, description: string, on: boolean, dependsOn: string[],
 *   recommendFor: string[], settings: BlueprintSetting[], lists: BlueprintList[] }>} features settings and lists only
 *   while on
 * @property {Array<{ key: string, title: string, features: string[], settings: BlueprintSetting[] }>} shared shared
 *   settings in use
 * @property {Array<{ key: string, title: string, kind: 'database' | 'storage' | 'secret' | 'token', neededBy: string[],
 *   needed: boolean, set: boolean, state: 'connected' | 'not_connected' | 'test_failed', testedAt: string | null }>} connections
 * @property {Array<{ key: string, kind: 'visitor' | 'admin', features: string[], on: boolean, ready: boolean }>} widgets
 * @property {Array<{ key: string, name: string, feature: string, on: boolean }>} staffPermissions
 * @property {string[]} events
 * @property {Array<{ key: string, done: boolean, text: string }>} checklist
 * @property {Array<{ title: string, text: string }>} summaries
 * @property {Array<{ feature: string, what: string, docs: string }>} build what the website builds for each feature
 *   that is on, with the guide's section
 */
/**
 * The advisor's view of a reachable product in a Setup sheet.
 * @typedef {object} BlueprintAdvice
 * @property {Array<{ feature: string, on: boolean, because: string[], why: string }>} recommended
 * @property {Array<{ feature: string, missing: string[], why: string }>} notRecommended features that are on although
 *   the profile rules them out
 */
/**
 * The Setup sheet of a website, `ss.blueprint/1`.
 * @typedef {object} Blueprint
 * @property {'ss.blueprint/1'} schema
 * @property {string} generatedAt
 * @property {{ id: string, domain: string, status: 'active' | 'grace' | 'stopped' | 'suspended', business: { found: boolean,
 *   name: string | null, country: string | null, timeZone: string | null },
 *   profile: import('./profile.js').BusinessProfile | null }} website `status`: the status of the website's products
 * @property {{ allowedOrigins: string[], testingOrigins: string[], serverTokens: string }} access
 * @property {Array<(ProductBlueprint & BlueprintAdvice & { reachable: true, apiBase: string, serverToken: { issued: boolean } })
 *   | { productId: string, name: string, reachable: false, reason: 'timeout' | 'unreachable' | 'refused' | 'invalid' }>} products
 * @property {{ expiresAt: string, values: boolean, install: boolean }} [share] a copy opened from a share link
 */

export {};
