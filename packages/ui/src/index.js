/**
 * @ss/ui — the consoles' component library (React 19, Tailwind 4 with CSS-variable design tokens). Import the
 * tokens once in the app stylesheet (`@import '@ss/ui/theme.css'`). Interactive components are client components
 * (`'use client'`); layout and display components also render on the server.
 * @module
 */
export { cx } from './cx.js';
export { Icon, ICON_NAMES } from './icons.js';
export { Button, IconButton, ButtonLink, buttonClass } from './Button.js';
export { Spinner } from './Spinner.js';
export {
	Field,
	FieldMessages,
	Input,
	TextArea,
	Select,
	Checkbox,
	Switch,
	RadioGroup,
	CheckboxGroup,
	LABEL_CLASS,
	useFieldIds,
} from './fields.js';
export { Form, FormError, FormActions, useFormState } from './Form.js';
export {
	Card,
	PageHeader,
	Badge,
	StatusBadge,
	Callout,
	EmptyState,
	ErrorState,
	Skeleton,
	Stat,
	Section,
	IconBadge,
	ACCENTS,
	Meter,
	Stepper,
	Breadcrumbs,
	KeyValueList,
	Bar,
} from './display.js';
export { Table } from './Table.js';
export { Tabs, TabNav } from './Tabs.js';
export { Dialog, ConfirmDialog, useFocusTrap, focusableIn } from './overlay.js';
export { TypedConfirmDialog } from './TypedConfirm.js';
export { ToastProvider, useToast } from './Toast.js';
export { CodeBlock, copyText } from './CodeBlock.js';
export { AppShell } from './AppShell.js';
export { THEME_SCRIPT, THEME_STORAGE_KEY, ThemeScript } from './theme-script.js';
export { ThemeToggle, applyThemeChoice, readThemeChoice } from './theme.js';
export { BarChart, ShareBars, HeroCard } from './charts.js';
export { SchemaForm } from './SchemaForm.js';
export * from './schema.js';
export * from './format.js';
export * from './problems.js';

/** @typedef {import('./AppShell.js').NavSection} NavSection */
/** @typedef {import('./AppShell.js').NavItem} NavItem */
/** @typedef {import('./icons.js').IconName} IconName */
/** @typedef {import('./display.js').Accent} Accent */
/** @typedef {import('./theme.js').ThemeChoice} ThemeChoice */
/** @typedef {import('./problems.js').Problem} Problem */
/** @typedef {import('./schema.js').SettingsSchema} SettingsSchema */
/** @typedef {import('./schema.js').SettingNode} SettingNode */
/**
 * @template T
 * @typedef {import('./Table.js').Column<T>} Column
 */
