"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Monitor,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
} from "lucide-react";

import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";
import { ProductConfigEditorSkeleton } from "@/components/ui/portalSkeletons";
import { useToast } from "@/components/providers/ToastProvider";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type {
  ProductConfigField,
  ProductConfigSection,
  ProductTestAction,
} from "@/lib/types";

type ValueMap = Record<string, unknown>;

/** Where the config is edited: a merchant site (overrides) or the product catalog (defaults). */
export type ConfigScope =
  { kind: "site"; siteId: string } | { kind: "product" };

/** Unified shape both site-config and product-defaults summaries normalize into. */
interface EditorConfig {
  schema: ProductConfigSection[];
  testActions: ProductTestAction[];
  draft: ValueMap;
  published: ValueMap;
  lockedFields: string[];
  inheritedDefaults: ValueMap;
  enforcedFields: string[];
  overriddenFields: string[];
  previewAvailable: boolean;
  version: number;
  hasUnpublishedChanges: boolean;
  publishedAt: string | null;
}

function listToText(value: unknown): string {
  return Array.isArray(value)
    ? value.join("\n")
    : typeof value === "string"
      ? value
      : "";
}

/** Coerce an editor value to its canonical form so inherited vs overridden compares correctly. */
function normalizeForCompare(
  field: ProductConfigField,
  value: unknown,
): unknown {
  switch (field.type) {
    case "boolean":
      return Boolean(value);
    case "number":
      return Number(value) || 0;
    case "list":
      if (Array.isArray(value)) {
        return value.map((entry) => String(entry).trim()).filter(Boolean);
      }
      if (typeof value === "string") {
        return value
          .split(/[\n,]/)
          .map((entry) => entry.trim())
          .filter(Boolean);
      }
      return [];
    default:
      return value === null || value === undefined ? "" : String(value);
  }
}

function valuesEqual(
  field: ProductConfigField,
  a: unknown,
  b: unknown,
): boolean {
  return (
    JSON.stringify(normalizeForCompare(field, a)) ===
    JSON.stringify(normalizeForCompare(field, b))
  );
}

const sectionKindLabel: Record<ProductConfigSection["kind"], string> = {
  settings: "Settings",
  connection: "Connection",
  integration: "Integration",
};

export function ProductConfigEditor({
  scope,
  productSlug,
  canManage,
  isPlatformAdmin,
}: {
  scope: ConfigScope;
  productSlug: string;
  canManage: boolean;
  isPlatformAdmin: boolean;
}) {
  const toast = useToast();
  const isProductScope = scope.kind === "product";

  const [config, setConfig] = useState<EditorConfig | null>(null);
  const [values, setValues] = useState<ValueMap>({});
  const [locked, setLocked] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showPublishConfirmation, setShowPublishConfirmation] = useState(false);
  const [resettingKey, setResettingKey] = useState<string | null>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);

  const [testAction, setTestAction] = useState("");
  const [testInput, setTestInput] = useState("");
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const fetchConfig = useCallback(async (): Promise<EditorConfig> => {
    if (scope.kind === "product") {
      const response = await platformApi.getProductDefaults(productSlug);
      return {
        ...response.config,
        inheritedDefaults: {},
        enforcedFields: [],
        overriddenFields: [],
        previewAvailable: false,
      };
    }
    const response = await platformApi.getProductConfig(
      scope.siteId,
      productSlug,
    );
    return { ...response.config };
  }, [scope, productSlug]);

  const initialValues = useCallback(
    (source: EditorConfig): ValueMap => {
      const next: ValueMap = {};
      for (const section of source.schema) {
        for (const field of section.fields) {
          if (field.secret) {
            next[field.key] = "";
            continue;
          }
          if (!isProductScope && source.enforcedFields.includes(field.key)) {
            next[field.key] =
              source.inheritedDefaults[field.key] ?? field.default ?? "";
            continue;
          }
          if (!isProductScope && !source.overriddenFields.includes(field.key)) {
            next[field.key] =
              source.inheritedDefaults[field.key] ?? field.default ?? "";
            continue;
          }
          next[field.key] = source.draft[field.key] ?? field.default ?? "";
        }
      }
      return next;
    },
    [isProductScope],
  );
  const hasUnsavedLocalChanges = config
    ? JSON.stringify(values) !== JSON.stringify(initialValues(config)) ||
      JSON.stringify([...locked].sort()) !==
        JSON.stringify([...config.lockedFields].sort())
    : false;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchConfig();
      setConfig(next);
      setValues(initialValues(next));
      setLocked(next.lockedFields);
      if (next.testActions.length > 0) {
        setTestAction((current) => current || next.testActions[0].key);
      }
    } catch {
      setError("Could not load configuration.");
    } finally {
      setLoading(false);
    }
  }, [fetchConfig, initialValues]);

  useEffect(() => {
    void load();
  }, [load]);

  function setValue(key: string, value: unknown) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function toggleLock(key: string) {
    setLocked((current) =>
      current.includes(key)
        ? current.filter((entry) => entry !== key)
        : [...current, key],
    );
  }

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    try {
      if (isProductScope) {
        const payloadValues: ValueMap = {};
        for (const field of config.schema.flatMap(
          (section) => section.fields,
        )) {
          const value = values[field.key];
          if (field.secret) {
            if (typeof value === "string" && value.trim().length > 0) {
              payloadValues[field.key] = value.trim();
            }
            continue;
          }
          payloadValues[field.key] = value;
        }
        const response = await platformApi.saveProductDefaults(productSlug, {
          values: payloadValues,
          lockedFields: locked,
        });
        const next: EditorConfig = {
          ...response.config,
          inheritedDefaults: {},
          enforcedFields: [],
          overriddenFields: [],
          previewAvailable: false,
        };
        setConfig(next);
        setValues(initialValues(next));
        setLocked(next.lockedFields);
        toast.showSuccess(
          "Draft saved",
          "Publish to apply the default to inheriting sites.",
        );
        return;
      }

      // Site scope: only send fields that differ from the inherited default; clear
      // ones that now match the default so they inherit again.
      const payloadValues: ValueMap = {};
      const clearKeys: string[] = [];
      for (const field of config.schema.flatMap((section) => section.fields)) {
        if (config.enforcedFields.includes(field.key)) {
          continue;
        }
        const value = values[field.key];
        if (field.secret) {
          if (typeof value === "string" && value.trim().length > 0) {
            payloadValues[field.key] = value.trim();
          }
          continue;
        }
        const inherited = config.inheritedDefaults[field.key];
        if (valuesEqual(field, value, inherited)) {
          if (config.overriddenFields.includes(field.key)) {
            clearKeys.push(field.key);
          }
          continue;
        }
        payloadValues[field.key] = value;
      }
      const response = await platformApi.saveProductConfigDraft(
        scope.siteId,
        productSlug,
        {
          values: payloadValues,
          clearKeys,
          ...(isPlatformAdmin ? { lockedFields: locked } : {}),
        },
      );
      setConfig({ ...response.config });
      setValues(initialValues({ ...response.config }));
      setLocked(response.config.lockedFields);
      toast.showSuccess("Draft saved", "Publish to make it live.");
    } catch (caughtError) {
      toast.showError(
        "Could not save draft",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleResetToDefault(key: string) {
    if (isProductScope || scope.kind !== "site") return;
    setResettingKey(key);
    try {
      const response = await platformApi.saveProductConfigDraft(
        scope.siteId,
        productSlug,
        { clearKeys: [key] },
      );
      setConfig({ ...response.config });
      setValues(initialValues({ ...response.config }));
      toast.showSuccess(
        "Reset to default",
        "This field now inherits the product default.",
      );
    } catch (caughtError) {
      toast.showError(
        "Could not reset",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again.",
      );
    } finally {
      setResettingKey(null);
    }
  }

  async function handlePublish() {
    setPublishing(true);
    try {
      let next: EditorConfig;
      if (scope.kind === "product") {
        const response = await platformApi.publishProductDefaults(productSlug);
        next = {
          ...response.config,
          inheritedDefaults: {},
          enforcedFields: [],
          overriddenFields: [],
          previewAvailable: false,
        };
      } else {
        const response = await platformApi.publishProductConfig(
          scope.siteId,
          productSlug,
        );
        next = { ...response.config };
      }
      setConfig(next);
      setValues(initialValues(next));
      toast.showSuccess(
        "Published",
        isProductScope
          ? "Inheriting sites now use this default."
          : "The product now uses these values.",
      );
      setShowPublishConfirmation(false);
    } catch (caughtError) {
      toast.showError(
        "Could not publish",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again.",
      );
    } finally {
      setPublishing(false);
    }
  }

  async function openPreview() {
    if (scope.kind !== "site") return;
    if (hasUnsavedLocalChanges) {
      toast.showInfo(
        "Save the draft first",
        "Preview uses the last saved draft, not unsaved field changes.",
      );
      return;
    }
    setPreviewLoading(true);
    try {
      const response = await platformApi.previewProduct(
        scope.siteId,
        productSlug,
      );
      setPreviewUrl(response.embedUrl);
      setPreviewNonce((current) => current + 1);
    } catch (caughtError) {
      toast.showError(
        "Could not open preview",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Preview is unavailable.",
      );
    } finally {
      setPreviewLoading(false);
    }
  }

  async function runTest() {
    if (!testAction || scope.kind !== "site") return;
    setTestRunning(true);
    setTestResult(null);
    try {
      const response = await platformApi.runProductTest(
        scope.siteId,
        productSlug,
        testAction,
        testInput,
      );
      setTestResult(JSON.stringify(response.result, null, 2));
    } catch (caughtError) {
      toast.showError(
        "Test failed",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again.",
      );
    } finally {
      setTestRunning(false);
    }
  }

  const title = isProductScope ? "Default configuration" : "Customize";
  const description = isProductScope
    ? "Product-wide defaults. Sites inherit these unless they override. Enforce a field to lock it across all sites."
    : "Managed from the portal. Inherited values come from the product default; override per site as needed.";

  if (loading) {
    return <ProductConfigEditorSkeleton />;
  }

  if (error || !config) {
    return (
      <Card className="shadow-sm border-line bg-surface">
        <CardHeader title={title} />
        <Alert tone="danger" title="Load failed">
          {error ?? "Configuration unavailable."}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </Alert>
      </Card>
    );
  }

  if (config.schema.length === 0) {
    return (
      <Card className="shadow-sm border-line bg-surface">
        <CardHeader
          title={title}
          description="This product has no configurable settings."
        />
        <p className="text-sm text-ink-muted">
          The product hasn&apos;t declared a config schema yet. Run &quot;Test
          connection&quot; on the product to sync it.
        </p>
      </Card>
    );
  }

  const disabled = !canManage;
  const activeConfig = config;

  function renderField(field: ProductConfigField) {
    const enforced =
      !isProductScope && activeConfig.enforcedFields.includes(field.key);
    const overridden =
      !isProductScope && activeConfig.overriddenFields.includes(field.key);
    const inherited = !isProductScope && !enforced && !overridden;
    const fieldLocked = locked.includes(field.key);
    const editableForCaller =
      !disabled && !enforced && (isPlatformAdmin || !fieldLocked);
    const secretSet = Boolean(
      (activeConfig.draft?.[field.key] as { set?: boolean } | undefined)?.set,
    );

    const control = (() => {
      if (field.secret) {
        return (
          <Input
            id={`cfg-${field.key}`}
            type="password"
            value={String(values[field.key] ?? "")}
            disabled={!editableForCaller}
            placeholder={
              secretSet ? "value set - leave blank to keep" : "Not set"
            }
            onChange={(event) => setValue(field.key, event.target.value)}
          />
        );
      }
      switch (field.type) {
        case "boolean":
          return (
            <label className="inline-flex items-center gap-2 text-[13px] text-ink">
              <Checkbox
                checked={Boolean(values[field.key])}
                disabled={!editableForCaller}
                onChange={(event) => setValue(field.key, event.target.checked)}
              />
              {field.label}
            </label>
          );
        case "text":
        case "list":
          return (
            <Textarea
              id={`cfg-${field.key}`}
              value={
                field.type === "list"
                  ? listToText(values[field.key])
                  : String(values[field.key] ?? "")
              }
              disabled={!editableForCaller}
              rows={field.type === "list" ? 4 : 3}
              onChange={(event) => setValue(field.key, event.target.value)}
            />
          );
        case "select":
          return (
            <Select
              id={`cfg-${field.key}`}
              value={String(values[field.key] ?? "")}
              disabled={!editableForCaller}
              onChange={(event) => setValue(field.key, event.target.value)}
            >
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          );
        case "color":
          return (
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={String(values[field.key] ?? "#000000")}
                disabled={!editableForCaller}
                onChange={(event) => setValue(field.key, event.target.value)}
                className="h-9 w-12 cursor-pointer rounded border border-line bg-surface disabled:opacity-50"
              />
              <Input
                value={String(values[field.key] ?? "")}
                disabled={!editableForCaller}
                onChange={(event) => setValue(field.key, event.target.value)}
                className="w-32"
              />
            </div>
          );
        case "number":
          return (
            <Input
              id={`cfg-${field.key}`}
              type="number"
              value={String(values[field.key] ?? "")}
              disabled={!editableForCaller}
              onChange={(event) =>
                setValue(field.key, Number(event.target.value))
              }
            />
          );
        default:
          return (
            <Input
              id={`cfg-${field.key}`}
              type={field.type === "url" ? "url" : "text"}
              value={String(values[field.key] ?? "")}
              disabled={!editableForCaller}
              onChange={(event) => setValue(field.key, event.target.value)}
            />
          );
      }
    })();

    const labelSuffix = (
      <span className="inline-flex items-center gap-1.5">
        {enforced ? <Badge tone="danger">Enforced by product</Badge> : null}
        {inherited ? <Badge tone="neutral">Inherited</Badge> : null}
        {overridden ? <Badge tone="brand">Overridden</Badge> : null}
        {overridden && canManage ? (
          <button
            type="button"
            onClick={() => void handleResetToDefault(field.key)}
            disabled={resettingKey === field.key}
            className="inline-flex items-center gap-1 text-[11px] text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
            title="Reset to product default"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Reset
          </button>
        ) : null}
        {fieldLocked ? (
          <Badge tone="neutral">{isProductScope ? "Enforced" : "Locked"}</Badge>
        ) : null}
        {isPlatformAdmin && !enforced ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
            {isProductScope ? "Enforce" : "Admin only"}
            <Switch
              checked={fieldLocked}
              onClick={() => toggleLock(field.key)}
              aria-label={
                fieldLocked
                  ? `Stop enforcing ${field.label}`
                  : `Enforce ${field.label}`
              }
            />
          </span>
        ) : null}
      </span>
    );

    if (field.type === "boolean") {
      return (
        <div
          key={field.key}
          className="flex items-center justify-between gap-3 py-1"
        >
          {control}
          {labelSuffix}
        </div>
      );
    }

    return (
      <div key={field.key} className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor={`cfg-${field.key}`}
            className="text-[13px] font-medium text-ink"
          >
            {field.label}
          </label>
          {labelSuffix}
        </div>
        {control}
        {field.help ? (
          <p className="text-[12px] text-ink-muted">{field.help}</p>
        ) : null}
      </div>
    );
  }

  return (
    <Card className="shadow-sm border-line bg-surface">
      <CardHeader title={title} description={description} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone="brand">v{config.version}</Badge>
        {config.hasUnpublishedChanges ? (
          <Badge tone="danger">Unpublished changes</Badge>
        ) : (
          <Badge tone="success">Published</Badge>
        )}
        {config.publishedAt ? (
          <span className="text-[12px] text-ink-faint">
            Last published {new Date(config.publishedAt).toLocaleString()}
          </span>
        ) : (
          <span className="text-[12px] text-ink-faint">Never published</span>
        )}
      </div>
      {hasUnsavedLocalChanges ? (
        <Alert tone="warning" title="Unsaved changes" className="mb-4">
          Save the draft before previewing or publishing.
        </Alert>
      ) : null}

      <div className="space-y-5">
        {config.schema.map((section) => (
          <section
            key={section.key}
            className="rounded-md border border-line p-4"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-ink">
                  {section.title}
                </h4>
                {section.description ? (
                  <p className="text-[12px] text-ink-muted">
                    {section.description}
                  </p>
                ) : null}
              </div>
              {section.kind !== "settings" ? (
                <Badge>{sectionKindLabel[section.kind]}</Badge>
              ) : null}
            </div>
            <div className="space-y-3">{section.fields.map(renderField)}</div>
          </section>
        ))}
      </div>

      {canManage ? (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button
            type="button"
            size="sm"
            loading={saving}
            onClick={() => void handleSave()}
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            Save draft
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={publishing}
            disabled={!config.hasUnpublishedChanges}
            onClick={() => setShowPublishConfirmation(true)}
          >
            <Rocket className="h-4 w-4" aria-hidden="true" />
            Publish
          </Button>
          {config.previewAvailable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={previewLoading}
              onClick={() => void openPreview()}
            >
              <Monitor className="h-4 w-4" aria-hidden="true" />
              {previewUrl ? "Refresh preview" : "Live preview"}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 border-t border-line pt-4 text-[13px] text-ink-muted">
          You have read-only access to this configuration.
        </p>
      )}

      <ConfirmDialog
        open={showPublishConfirmation}
        title={
          isProductScope
            ? "Publish product defaults?"
            : "Publish site configuration?"
        }
        description={
          isProductScope
            ? "Every inheriting site will receive these values immediately. Enforced fields will override site-specific values."
            : "The running product will receive this draft for the selected tenant on its next configuration request."
        }
        confirmLabel="Publish configuration"
        loading={publishing}
        onConfirm={() => void handlePublish()}
        onCancel={() => setShowPublishConfirmation(false)}
      />

      {previewUrl ? (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[12px] font-medium uppercase tracking-wide text-ink-faint">
              Live preview (draft)
            </p>
            <button
              type="button"
              onClick={() => void openPreview()}
              className="inline-flex items-center gap-1 text-[12px] text-ink-muted transition-colors hover:text-ink"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Reload
            </button>
          </div>
          <iframe
            key={previewNonce}
            src={previewUrl}
            title="Product preview"
            className="h-[560px] w-full rounded-md border border-line bg-surface-subtle"
          />
          <p className="mt-1.5 text-[12px] text-ink-faint">
            Preview reflects your last saved draft, not the published version.
          </p>
        </div>
      ) : null}

      {canManage && !isProductScope && config.testActions.length > 0 ? (
        <div className="mt-4 rounded-md border border-line p-4">
          <h4 className="mb-3 text-sm font-semibold text-ink">Test harness</h4>
          <div className="space-y-3">
            {config.testActions.length > 1 ? (
              <Field label="Action" htmlFor="test-action">
                <Select
                  id="test-action"
                  value={testAction}
                  onChange={(event) => setTestAction(event.target.value)}
                >
                  {config.testActions.map((action) => (
                    <option key={action.key} value={action.key}>
                      {action.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {(() => {
              const action =
                config.testActions.find((entry) => entry.key === testAction) ??
                config.testActions[0];
              return (
                <Field
                  label={action?.inputLabel || "Sample input"}
                  htmlFor="test-input"
                  hint={action?.description || undefined}
                >
                  <Textarea
                    id="test-input"
                    value={testInput}
                    rows={3}
                    placeholder={action?.inputPlaceholder}
                    onChange={(event) => setTestInput(event.target.value)}
                  />
                </Field>
              );
            })()}
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={testRunning}
              onClick={() => void runTest()}
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              Run test
            </Button>
            {testResult ? (
              <pre className="max-h-64 overflow-auto rounded-md border border-line bg-surface-subtle p-3 text-[12px] text-ink">
                {testResult}
              </pre>
            ) : null}
            <p className="text-[12px] text-ink-faint">
              Runs against your saved draft config. Nothing is persisted.
            </p>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
