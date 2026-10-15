/**
 * The dashboard's words (US English, kept in this file; the dashboard is not translated, PLAN 0.6): Payments' title
 * and its own words over the words every product dashboard shares (`@ss/ui`).
 * @module
 */
import { dashboardTexts } from '@ss/ui';

export const TEXTS = dashboardTexts({
	title: 'Payments',
	overview: {
		gateways: 'Gateways ready',
		gatewaysHelp:
			'Switched-on gateways with their keys connected (bank transfer: the account holder and the account number or IBAN set; with Require bank details off, instructions or an account number or IBAN).',
		bankStep: 'Finish the bank transfer details',
		noBank: {
			title: 'Bank transfer is on, but payers do not see it yet',
			action: 'Open Settings',
		},
		bankHelpDetails:
			'Set {missing} in Settings, or turn off Require bank details and write instructions that tell payers how to pay.',
		bankHelpInstructions: 'Write instructions in Settings that tell payers how to pay, or set the account number or IBAN.',
		bankMissing: { accountHolder: 'the account holder name', accountNumber: 'the account number or IBAN' },
		and: '{first} and {second}',
	},
	settings: {
		looksHelp:
			'Every word of the pay button, the admin widgets and the hosted payment pages, their theme, and how money and dates look.',
		textsHelp: 'Every word the widgets and hosted pages show. A text must keep the same {placeholders} as the English text.',
		formatHelp: 'How money and dates look in the pay button, the admin widgets and the hosted payment pages.',
		localeHelp: "A tag such as en-US or fr-FR; empty uses each visitor's browser (en-US on the hosted pages).",
	},
	connections: {
		fields: {
			endpoint: 'Endpoint (empty for AWS S3)',
			region: 'Region',
			bucket: 'Bucket',
			accessKeyId: 'Access key id',
			secretAccessKey: 'Secret access key',
			prefix: 'Key prefix (optional)',
			secretKey: 'Secret key (sk_… or rk_…)',
			webhookSecret: 'Webhook signing secret (whsec_…)',
			clientId: 'Client id',
			secret: 'Secret',
			webhookId: 'Webhook id',
			sandbox: 'Sandbox (the gateway’s own test environment)',
			merchantId: 'Merchant id',
			merchantKey: 'Merchant key',
			passphrase: 'Passphrase',
			securedKey: 'Secured key',
			merchantName: 'Merchant name (as registered with PayFast)',
			rapidSecretKey: 'Secret key',
			rapidWebhookSecret: 'Webhook secret',
			password: 'Password',
			integritySalt: 'Integrity salt',
			storeId: 'Store id',
			hashKey: 'Hash key (16 characters)',
			username: 'API user name',
			accountNum: 'Account number',
			name: 'Name payers see',
			url: 'Checkout address (https)',
			refundUrl: 'Refund address (https, optional)',
			currencies: 'Currencies (comma-separated, empty for any)',
		},
	},
	developers: {
		api: 'Payment API',
		apiHelp:
			'Your server (or Ecommerce, with this website’s Payments token) creates payments and verifies them before marking an order paid.',
		callbacks: 'Gateway addresses',
		callbacksHelp: 'Register these addresses with each gateway (webhook, notice or return URL), for this website.',
		events: 'Webhooks',
		eventsHelp:
			'Paste the Notifications token in Connections and turn on its Outgoing webhooks; check the SS-Signature header of every event.',
		more: 'Links, refunds and subscriptions',
		moreHelp:
			'Payment links for any amount, full and partial refunds, the bank details for your checkout, gateway-managed subscriptions.',
		widgets: 'Widget snippets',
		widgetsHelp:
			'The pay button on your website, and the admin widgets in your own admin: payments, payment links and subscriptions.',
		ticket: 'Ticket snippet',
		ticketHelp: 'Your server asks for a ticket for the admin widgets after checking its user.',
	},
});
