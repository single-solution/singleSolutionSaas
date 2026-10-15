/**
 * The dashboard's words (English, kept in this file; the dashboard is not translated, PLAN 0.6): the product's title
 * over the words every product dashboard shares (`DASHBOARD_TEXTS`). A product adds its own sections' words here, and
 * may reword a shared one.
 * @module
 */
import { dashboardTexts } from '@ss/ui';

export const TEXTS = dashboardTexts({ title: '{{name}}' });
