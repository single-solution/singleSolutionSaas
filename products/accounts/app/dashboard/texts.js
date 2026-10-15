/**
 * The dashboard's own texts (US English, kept in this file; the dashboard is not translated, PLAN 0.6), laid over the
 * words every product dashboard shares (`@ss/ui/dashboard` `DASHBOARD_TEXTS`).
 * @module
 */
import { dashboardTexts } from '@ss/ui';

export const TEXTS = dashboardTexts({
	title: 'Accounts',
	overview: {
		fields: 'Custom fields',
		fieldsNone: 'Connect the database first',
		fieldsStep: 'Add a custom field',
		noFields: {
			title: 'Custom fields is on, but no field is set up yet',
			effect: 'It is charged, but sign-up and My account ask for nothing more until a field is added in Settings.',
			action: 'Add a field',
		},
	},
	settings: {
		fieldsTitle: 'Custom fields',
		fieldsHelp:
			'Your own profile fields. They are shown at sign-up (required ones must be filled) and in My account, and need the Custom fields feature.',
		looksHelp:
			'Every word of the sign-in, My account, role request and admin widgets, their theme, and how money and dates look.',
		field: {
			key: 'Key (lower-case letters, digits or _)',
			label: 'Label',
			type: 'Type',
			options: 'Options (comma-separated or one per line)',
			required: 'Required at sign-up',
			add: 'New field',
			editTitle: 'Edit field',
			edit: 'Edit',
			delete: 'Delete',
			none: 'No custom fields yet.',
			required_badge: 'Required',
			needsDatabase: 'Custom fields live in your database: connect it in Connections first.',
		},
		fieldTypes: {
			text: 'Text',
			number: 'Number',
			date: 'Date',
			choice: 'Choice',
		},
	},
	connections: {
		fields: {
			clientId: 'Client ID',
			clientSecret: 'Client secret',
			servicesId: 'Services ID',
			teamId: 'Team ID (10 characters)',
			keyId: 'Key ID (10 characters)',
			privateKey: 'Private key (the contents of the .p8 file)',
			appId: 'App ID',
			appSecret: 'App secret',
		},
		hints: {
			database: 'A MongoDB connection string (mongodb+srv://…). Users, roles and custom fields live here.',
			token: "Paste the website's {product} server token from the Portal.",
			imported_password_pepper:
				'Only for passwords imported from another system as pbkdf2$… hashes: the secret (pepper) that system mixed into them. Each imported password is saved the Accounts way at its first sign-in.',
		},
		products: {
			notifications: 'Notifications',
			ecommerce: 'Ecommerce',
			chat: 'Chat',
			payments: 'Payments',
			growth: 'Growth',
		},
		returnAddress: 'Return address to register with the provider',
	},
	developers: {
		verification: 'Sign-in verification',
		verificationHelp:
			"Your server checks a sign-in offline with the public keys below: sign-ins last 15 minutes, are signed with EdDSA and their aud is this website's id. A sign-in never authorizes admin actions: admin widgets use tickets.",
		keysUrl: 'Public keys address',
		widgets: 'Widget snippets',
		widgetsHelp:
			'The sign-in, My account and role request widgets on your website, calls for a signed-in user, and the Users, Roles and Activity admin widgets in your own admin.',
		ticket: 'Ticket snippet',
		ticketHelp: 'Your server asks for a ticket for the admin widgets after checking its user and role.',
		returns: 'Social sign-in return addresses',
		returnsHelp: 'Register these with Google, Apple and Facebook as the allowed redirect addresses.',
		templates: 'Message templates',
		templatesHelp:
			'Accounts sends codes, links and invites through Notifications, with its own default words until you write these templates in the Notifications dashboard; each can use the values shown. WhatsApp needs your template approved at Meta.',
	},
});
