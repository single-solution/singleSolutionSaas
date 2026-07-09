"use client";

import { FormEvent, KeyboardEvent, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { slugify } from "@/lib/slugify";
import type { ProductPlan, ProductSummary } from "@/lib/types";

export interface ProductFormValues {
  slug?: string;
  name: string;
  description?: string;
  baseUrl?: string;
  availableScopes: string[];
  plans: ProductPlan[];
}

interface QuotaDraft {
  metric: string;
  limit: string;
}

interface PlanDraft {
  key: string;
  code: string | null;
  name: string;
  priceMonthly: string;
  currency: string;
  scopes: string[];
  quotas: QuotaDraft[];
  advanced: boolean;
}

let planKeySeed = 0;
function newPlan(overrides: Partial<PlanDraft> = {}): PlanDraft {
  planKeySeed += 1;
  return {
    key: `plan-${planKeySeed}`,
    code: null,
    name: "",
    priceMonthly: "0",
    currency: "USD",
    scopes: [],
    quotas: [],
    advanced: false,
    ...overrides,
  };
}

function planFromSummary(plan: ProductPlan): PlanDraft {
  return newPlan({
    code: plan.code,
    name: plan.name,
    priceMonthly: String(plan.priceMonthly),
    currency: plan.currency,
    scopes: [...plan.scopes],
    quotas: plan.quotas.map((quota) => ({ metric: quota.metric, limit: String(quota.limit) })),
    advanced: plan.scopes.length > 0 || plan.quotas.length > 0,
  });
}

function ChipsInput({ values, onChange, placeholder }: { values: string[]; onChange: (next: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");

  function add() {
    const candidate = draft.trim().toLowerCase().replace(/\s+/g, "-");
    if (candidate && !values.includes(candidate)) {
      onChange([...values, candidate]);
    }
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      {values.map((value) => (
        <span key={value} className="inline-flex items-center gap-1 rounded bg-surface-subtle px-2 py-0.5 text-xs text-ink-secondary">
          {value}
          <button type="button" onClick={() => onChange(values.filter((entry) => entry !== value))} aria-label={`Remove ${value}`}>
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={add}
        placeholder={values.length === 0 ? placeholder : ""}
        className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-[13px] text-ink outline-none placeholder:text-ink-faint"
      />
    </div>
  );
}

export function ProductForm({
  mode,
  initial,
  submitting,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  initial?: ProductSummary;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (values: ProductFormValues) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [showProductAdvanced, setShowProductAdvanced] = useState(false);
  const [plans, setPlans] = useState<PlanDraft[]>(
    initial && initial.plans.length > 0 ? initial.plans.map(planFromSummary) : [],
  );

  function updatePlan(key: string, patch: Partial<PlanDraft>) {
    setPlans((current) => current.map((plan) => (plan.key === key ? { ...plan, ...patch } : plan)));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const preparedPlans: ProductPlan[] = plans
      .filter((plan) => plan.name.trim())
      .map((plan) => ({
        code: plan.code ?? slugify(plan.name),
        name: plan.name.trim(),
        priceMonthly: Number(plan.priceMonthly) || 0,
        currency: (plan.currency.trim() || "USD").toUpperCase(),
        scopes: plan.scopes,
        quotas: plan.quotas
          .filter((quota) => quota.metric.trim() && quota.limit.trim() !== "")
          .map((quota) => ({ metric: quota.metric.trim(), limit: Math.max(0, Number(quota.limit) || 0) })),
      }));

    const availableScopes = [...new Set(preparedPlans.flatMap((plan) => plan.scopes))];

    void onSubmit({
      ...(mode === "create" ? { slug: slug.trim() || slugify(name) } : {}),
      name: name.trim(),
      description: description.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      availableScopes,
      plans: preparedPlans,
    });
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit} noValidate>
      <Field label="Name" htmlFor="product-name" required>
        <Input id="product-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ecommerce Chatbot" />
      </Field>
      <Field label="Description" htmlFor="product-description" optional>
        <Input id="product-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this product does" />
      </Field>
      <Field
        label="Base URL"
        htmlFor="product-base-url"
        optional
        hint="Where the running product app is hosted. This is the connection the portal manages, tests, and previews against."
      >
        <Input id="product-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://chatbot.example.com" />
      </Field>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-ink">Plans</p>
            <p className="text-[12px] text-ink-muted">Add at least one so merchants can subscribe.</p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setPlans((current) => [...current, newPlan()])}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add plan
          </Button>
        </div>

        {plans.map((plan) => (
          <div key={plan.key} className="space-y-3 rounded-md border border-line p-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
              <Field label="Plan name" htmlFor={`plan-name-${plan.key}`}>
                <Input id={`plan-name-${plan.key}`} value={plan.name} onChange={(event) => updatePlan(plan.key, { name: event.target.value })} placeholder="Free" />
              </Field>
              <Field label="Price / mo" htmlFor={`plan-price-${plan.key}`} className="sm:w-28">
                <Input id={`plan-price-${plan.key}`} type="number" min="0" value={plan.priceMonthly} onChange={(event) => updatePlan(plan.key, { priceMonthly: event.target.value })} />
              </Field>
              <Field label="Currency" htmlFor={`plan-currency-${plan.key}`} className="sm:w-24">
                <Input id={`plan-currency-${plan.key}`} value={plan.currency} onChange={(event) => updatePlan(plan.key, { currency: event.target.value })} placeholder="USD" />
              </Field>
            </div>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => updatePlan(plan.key, { advanced: !plan.advanced })}
                className="inline-flex items-center gap-1 text-[13px] text-ink-secondary transition-colors hover:text-ink"
              >
                <ChevronDown className={cn("h-4 w-4 transition-transform", plan.advanced && "rotate-180")} aria-hidden="true" />
                Advanced (scopes & quotas)
              </button>
              <button
                type="button"
                onClick={() => setPlans((current) => current.filter((entry) => entry.key !== plan.key))}
                className="text-[13px] text-ink-muted transition-colors hover:text-danger"
              >
                Remove
              </button>
            </div>

            {plan.advanced ? (
              <div className="space-y-4 border-t border-line pt-3">
                <Field label="Access scopes" htmlFor={`plan-scopes-${plan.key}`} optional hint="Type a scope and press Enter. Example: chat:read">
                  <ChipsInput values={plan.scopes} onChange={(next) => updatePlan(plan.key, { scopes: next })} placeholder="chat:read" />
                </Field>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-sm font-medium text-ink">Usage quotas</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => updatePlan(plan.key, { quotas: [...plan.quotas, { metric: "", limit: "" }] })}
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      Add quota
                    </Button>
                  </div>
                  {plan.quotas.length === 0 ? (
                    <p className="text-[12px] text-ink-muted">No quotas means unlimited usage on this plan.</p>
                  ) : (
                    <div className="space-y-2">
                      {plan.quotas.map((quota, quotaIndex) => (
                        <div key={quotaIndex} className="flex items-center gap-2">
                          <Input
                            value={quota.metric}
                            onChange={(event) =>
                              updatePlan(plan.key, {
                                quotas: plan.quotas.map((entry, index) =>
                                  index === quotaIndex ? { ...entry, metric: event.target.value } : entry,
                                ),
                              })
                            }
                            placeholder="messages"
                          />
                          <Input
                            type="number"
                            min="0"
                            value={quota.limit}
                            onChange={(event) =>
                              updatePlan(plan.key, {
                                quotas: plan.quotas.map((entry, index) =>
                                  index === quotaIndex ? { ...entry, limit: event.target.value } : entry,
                                ),
                              })
                            }
                            placeholder="1000"
                            className="w-32"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              updatePlan(plan.key, { quotas: plan.quotas.filter((_, index) => index !== quotaIndex) })
                            }
                            className="grid size-9 shrink-0 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-subtle hover:text-danger"
                            aria-label="Remove quota"
                          >
                            <X className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowProductAdvanced((current) => !current)}
          className="inline-flex items-center gap-1 text-[13px] text-ink-secondary transition-colors hover:text-ink"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", showProductAdvanced && "rotate-180")} aria-hidden="true" />
          Advanced settings
        </button>
        {showProductAdvanced && mode === "create" ? (
          <div className="mt-3 space-y-4">
            <Field label="Slug" htmlFor="product-slug" optional hint="Auto-generated from the name. Must match the product application.">
              <Input id="product-slug" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder={slugify(name) || "ecommerce-chatbot"} />
            </Field>
            <p className="text-[12px] text-ink-muted">
              Configuration fields and test actions are declared by the product itself and synced from its detail page.
            </p>
          </div>
        ) : null}
        {showProductAdvanced && mode !== "create" ? (
          <p className="mt-3 text-[12px] text-ink-muted">
            Configuration fields and test actions are declared by the product and synced from its detail page.
          </p>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Button type="submit" loading={submitting}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
