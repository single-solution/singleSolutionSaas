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
 * @property {unknown[]} [enum]
 * @property {string} [format]
 * @property {SettingItem} [items]
 * @property {{ widget?: string, group?: string, order?: number, help?: string, placeholder?: string }} [x-ui]
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
 * @property {number} featuresVersion last accepted feature-report version
 * @property {string} validUntil ISO-8601 UTC; cache at most until then
 */

/**
 * @typedef {{ websiteId: string, domain: string, merchantId: string, merchantName: string,
 *   status: import('./constants.js').ProductStatus }} WebsiteRow
 */
/** @typedef {{ items: WebsiteRow[], cursor: string | null }} WebsitesPage */
/** @typedef {{ tokenIds: string[], cursor: string | null }} Revocations */
/** @typedef {{ baseUrl: string }} Directory */
/** @typedef {{ type: import('./constants.js').NoticeType, websiteId?: string, subject?: string }} Notice */

/**
 * business.json, normalised: missing or invalid optional fields are `null`.
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
/** @typedef {{ records: Record<string, unknown> }} DataRightsExport */
/** @typedef {{ deleted: number, anonymised: number }} DataRightsDelete */

/**
 * @typedef {object} ActivityCopy
 * @property {string} websiteId
 * @property {string} productId
 * @property {{ kind: string, id: string, name?: string }} actor
 * @property {string} action
 * @property {string} target
 * @property {string} at ISO-8601 UTC
 */

export {};
