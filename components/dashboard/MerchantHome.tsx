"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Building2, ChevronDown } from "lucide-react";

import { useAuth } from "@/components/AuthProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { MerchantDashboard } from "@/components/products/MerchantDashboard";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Select";
import { DashboardMerchantSkeleton } from "@/components/ui/portalSkeletons";
import { platformApi } from "@/lib/api/client";
import type { MerchantSummary } from "@/lib/types";

export function MerchantHome() {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [merchants, setMerchants] = useState<MerchantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedMerchantId = searchParams.get("merchantId") ?? "";

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await platformApi.listMerchants();
      setMerchants(response.items);
    } catch {
      setError("Could not load your workspace. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeMerchant = useMemo(() => {
    if (merchants.length === 0) {
      return null;
    }
    if (
      selectedMerchantId &&
      merchants.some((merchant) => merchant.id === selectedMerchantId)
    ) {
      return merchants.find((merchant) => merchant.id === selectedMerchantId) ?? null;
    }
    return merchants[0] ?? null;
  }, [merchants, selectedMerchantId]);

  useEffect(() => {
    if (!activeMerchant || merchants.length <= 1) {
      return;
    }
    if (selectedMerchantId === activeMerchant.id) {
      return;
    }
    const next = new URLSearchParams(searchParams.toString());
    next.set("merchantId", activeMerchant.id);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [
    activeMerchant,
    merchants.length,
    pathname,
    router,
    searchParams,
    selectedMerchantId,
  ]);

  function handleMerchantChange(merchantId: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (merchantId) {
      next.set("merchantId", merchantId);
    } else {
      next.delete("merchantId");
    }
    router.replace(`${pathname}${next.size ? `?${next.toString()}` : ""}`, {
      scroll: false,
    });
  }

  if (loading) {
    return <DashboardMerchantSkeleton />;
  }

  if (error) {
    return (
      <Alert tone="danger" title="Load failed">
        {error}
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  }

  if (!activeMerchant) {
    return (
      <div className="page-stack">
        <PageHeader
          title="Your workspace"
          description="Sites, products, usage, and keys."
        />
        <EmptyState
          icon={Building2}
          title="No workspace assigned"
          description="Your account is not linked to a merchant yet. Contact your administrator."
        />
      </div>
    );
  }

  return (
    <div className="page-stack">
      {merchants.length > 1 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <label htmlFor="merchant-selector" className="text-sm font-medium text-ink">
            Workspace
          </label>
          <div className="relative max-w-md flex-1">
            <Select
              id="merchant-selector"
              value={activeMerchant.id}
              onChange={(event) => handleMerchantChange(event.target.value)}
              className="min-h-11 w-full pr-10"
            >
              {merchants.map((merchant) => (
                <option key={merchant.id} value={merchant.id}>
                  {merchant.name}
                </option>
              ))}
            </Select>
            <ChevronDown
              className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
              aria-hidden="true"
            />
          </div>
        </div>
      ) : null}
      <MerchantDashboard
        merchantId={activeMerchant.id}
        merchantName={activeMerchant.name}
        userName={user?.name ?? ""}
      />
    </div>
  );
}
