/** @type {import('tailwindcss').Config} */
module.exports = {
	content: [
		'./portal/app/**/*.{js,jsx}',
		'./portal/components/**/*.{js,jsx}',
		'./portal/context/**/*.{js,jsx}',
		'./apps/*/app/**/*.{js,jsx}',
		'./apps/*/src/**/*.{js,jsx}',
		'./shared/ui/**/*.{js,jsx}',
	],
	theme: {
		extend: {},
	},
	plugins: [],
};
