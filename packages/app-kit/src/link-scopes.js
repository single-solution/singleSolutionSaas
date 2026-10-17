/**
 * The link scopes of the kit's own routes. A product offers them in its manifest (`links.offers`) when other products
 * call these routes: Accounts reads every product's permissions and asks it to export or erase a person's data, and
 * Ecommerce reads Growth's settings. A kit route takes link keys only when its product offers the scope.
 * @module
 */
export const KIT_LINK_SCOPES = Object.freeze({
	permissionsRead: 'permissions.read',
	dataRightsExport: 'data_rights.export',
	dataRightsErase: 'data_rights.erase',
	settingsRead: 'settings.read',
});
