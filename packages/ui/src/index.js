/**
 * @ss/ui — the consoles' component library (React 19, Tailwind 4 with CSS-variable design tokens). Import the
 * tokens once in the app stylesheet (`@import '@ss/ui/theme.css'`). Interactive components are client components
 * (`'use client'`); layout and display components also render on the server.
 * @module
 */
export { cx } from './cx.js';
export { Icon } from './icons.js';
export { Button, IconButton, ButtonLink, FormBusyContext } from './Button.js';
export { Spinner } from './Spinner.js';
export { useNavigationProgress, RouteProgress, PendingHint, PageTransition, SwapTransition } from './motion.js';
export {
	Input,
	TextArea,
	Select,
	Checkbox,
	CheckboxInput,
	Switch,
	RadioGroup,
	CheckboxGroup,
	ChoicePicker,
	FieldGrid,
	SuggestInput,
} from './fields.js';
export { Form, FormError } from './Form.js';
export { ListEditor, LIST_EDITOR_TEXTS, moveItem } from './ListEditor.js';
export {
	Card,
	PageHeader,
	Badge,
	StatusBadge,
	Callout,
	EmptyState,
	ErrorState,
	Skeleton,
	SkeletonBlock,
	Stat,
	StatGrid,
	STAT_GRID,
	SoftBreaks,
	Section,
	IconBadge,
	Stepper,
	KeyValueList,
	Masonry,
} from './display.js';
export { Table } from './Table.js';
export { Dialog, ConfirmDialog } from './overlay.js';
export { ActionMenu } from './Menu.js';
export { TypedConfirmDialog } from './TypedConfirm.js';
export { ToastProvider, useToast } from './Toast.js';
export { CodeBlock, copyText } from './CodeBlock.js';
export { AppShell } from './AppShell.js';
export { ThemeScript } from './theme-script.js';
export { DisplayLocale, LocalTime, useDisplayLocale, useViewerTimeZone } from './time.js';
export { BarChart, isEmptySeries } from './charts.js';
export { NeedsList, SetupChecklist, Timeline, RecentChanges, ProductOverview, OverviewSkeleton, initialsOf } from './overview.js';
// plain data, not a client module: a product's `texts.js` also gives its server `app/layout.js` the page title
export { DASHBOARD_TEXTS, dashboardTexts } from './dashboard-texts.js';
export { SchemaForm } from './SchemaForm.js';
export {
	formatCredits,
	formatCreditsPerHour,
	formatDate,
	formatDateTime,
	formatNumber,
	humanize,
	parseCredits,
	supportContact,
	symbolRowsOf,
	symbolsOf,
} from './format.js';
export { describeProblem, fieldErrors, problemCode } from './problems.js';

/** @typedef {import('./AppShell.js').NavSection} NavSection */
/** @typedef {import('./icons.js').IconName} IconName */
/** @typedef {import('./display.js').Kind} Kind */
/** @typedef {import('./Menu.js').MenuItem} MenuItem */
/** @typedef {import('./problems.js').Problem} Problem */
/** @typedef {import('./overview.js').Need} Need */
/** @typedef {import('./overview.js').OverviewTab} OverviewTab */
