/**
 * A dashboard piece inside the dashboard's provider (Ecommerce's words and feature names), as the page renders it.
 * @module
 */
import { createElement } from 'react';
import { DashboardProvider } from '@ss/ui/dashboard';
import manifest from '../manifest.json' with { type: 'json' };
import { TEXTS } from '../app/dashboard/texts.js';

/** @param {import('react').ReactNode} node */
export const inDashboard = (node) => createElement(DashboardProvider, { manifest, texts: TEXTS }, node);
