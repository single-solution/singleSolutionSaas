"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import type { ProductPlanQuota, SubscriptionSummary } from "@/lib/types";

export function ProductSubscriptionOverrides({
  product,
  saving,
  onSave,
}: {
  product: SubscriptionSummary;
  saving: boolean;
  onSave: (input: {
    scopeOverrides: string[] | null;
    quotaOverrides: ProductPlanQuota[] | null;
  }) => void;
}) {
  const plan = useMemo(
    () => product.availablePlans.find((candidate) => candidate.code === product.planCode),
    [product.availablePlans, product.planCode],
  );
  const planScopes = useMemo(() => plan?.scopes ?? [], [plan]);
  const planQuotas = useMemo(() => plan?.quotas ?? [], [plan]);
  const allScopes = useMemo(() => {
    const scopeSet = new Set(planScopes);
    for (const scope of product.scopeOverrides ?? product.scopes) {
      scopeSet.add(scope);
    }
    return [...scopeSet].sort();
  }, [planScopes, product.scopeOverrides, product.scopes]);

  const [selectedScopes, setSelectedScopes] = useState<string[]>(product.scopes);
  const [quotaLimits, setQuotaLimits] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setSelectedScopes(product.scopes);
    const nextQuotas: Record<string, string> = {};
    const effectiveQuotas =
      product.quotaOverrides && product.quotaOverrides.length > 0
        ? product.quotaOverrides
        : product.quotas;
    for (const quota of effectiveQuotas) {
      nextQuotas[quota.metric] = String(quota.limit);
    }
    for (const quota of planQuotas) {
      if (nextQuotas[quota.metric] === undefined) {
        nextQuotas[quota.metric] = String(quota.limit);
      }
    }
    setQuotaLimits(nextQuotas);
    setDirty(false);
  }, [product, planQuotas]);

  function toggleScope(scope: string) {
    setSelectedScopes((current) => {
      const next = current.includes(scope)
        ? current.filter((entry) => entry !== scope)
        : [...current, scope];
      setDirty(true);
      return next;
    });
  }

  function handleQuotaChange(metric: string, value: string) {
    setQuotaLimits((current) => ({ ...current, [metric]: value }));
    setDirty(true);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const scopesMatchPlan =
      planScopes.length === selectedScopes.length &&
      planScopes.every((scope) => selectedScopes.includes(scope));
    const scopeOverrides = scopesMatchPlan ? null : [...selectedScopes].sort();

    const quotaOverrides = planQuotas.map((quota) => {
      const raw = quotaLimits[quota.metric] ?? String(quota.limit);
      const limit = Number(raw);
      return {
        metric: quota.metric,
        limit: Number.isFinite(limit) && limit >= 0 ? limit : quota.limit,
        unit: quota.unit,
      };
    });
    const quotasMatchPlan = planQuotas.every(
      (quota, index) => quotaOverrides[index]?.limit === quota.limit,
    );

    onSave({
      scopeOverrides,
      quotaOverrides: quotasMatchPlan ? null : quotaOverrides,
    });
    setDirty(false);
  }

  function resetToPlan() {
    setSelectedScopes(planScopes);
    const nextQuotas: Record<string, string> = {};
    for (const quota of planQuotas) {
      nextQuotas[quota.metric] = String(quota.limit);
    }
    setQuotaLimits(nextQuotas);
    setDirty(true);
  }

  if (!plan) {
    return null;
  }

  return (
    <Card className="h-fit border-line bg-surface shadow-sm">
      <CardHeader
        title="Scope & quota overrides"
        description="Adjust entitlements for this site without changing the catalog plan."
      />
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        {allScopes.length === 0 ? (
          <p className="text-sm text-ink-muted">This plan has no configurable scopes.</p>
        ) : (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
              Scopes
            </p>
            <ul className="space-y-2">
              {allScopes.map((scope) => (
                <li key={scope}>
                  <label className="inline-flex items-center gap-2 text-sm text-ink">
                    <Checkbox
                      checked={selectedScopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                    />
                    {scope}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {planQuotas.length > 0 ? (
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
              Quotas
            </p>
            {planQuotas.map((quota) => (
              <Field
                key={quota.metric}
                label={`${quota.metric}${quota.unit ? ` (${quota.unit})` : ""}`}
                htmlFor={`quota-${product.productSlug}-${quota.metric}`}
              >
                <Input
                  id={`quota-${product.productSlug}-${quota.metric}`}
                  type="number"
                  min={0}
                  value={quotaLimits[quota.metric] ?? String(quota.limit)}
                  onChange={(event) =>
                    handleQuotaChange(quota.metric, event.target.value)
                  }
                />
              </Field>
            ))}
          </div>
        ) : null}

        {product.scopeOverrides || product.quotaOverrides ? (
          <Alert tone="info" title="Overrides active">
            Custom values differ from the catalog plan. Reset to plan defaults to clear them.
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" loading={saving} disabled={!dirty} className="min-h-11">
            Save overrides
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11"
            onClick={resetToPlan}
          >
            Reset to plan
          </Button>
        </div>
      </form>
    </Card>
  );
}
