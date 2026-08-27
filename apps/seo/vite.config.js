import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			'@saas/ui': path.resolve(__dirname, '../../shared/ui'),
			'@shared/ui': path.resolve(__dirname, '../../shared/ui'),
			'react-router-dom': path.resolve(__dirname, 'node_modules/react-router-dom'),
			react: path.resolve(__dirname, 'node_modules/react'),
			'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
		},
	},
	server: {
		port: 5003,
	},
});
