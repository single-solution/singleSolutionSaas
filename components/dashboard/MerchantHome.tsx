"use client";

import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";

import { useAuth } from "@/components/AuthProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { MerchantDashboard } from "@/components/products/MerchantDashboard";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { platformApi } from "@/lib/api/client";
import type { MerchantSummary } from "@/lib/types";

export function MerchantHome() {
  const { user } = useAuth();
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    setLoading(true);
    try {
      const response = await platformApi.listMerchants();
      setMerchant(response.items[0] ?? null);
    } catch {
      setError("Could not load your workspace. Try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) {
    return <DetailSkeleton />;
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

  if (!merchant) {
    return (
      <div className="page-stack">
        <PageHeader title="Your workspace" description="Sites, products, usage, and keys." />
        <EmptyState
          icon={Building2}
          title="No workspace assigned"
          description="Your account is not linked to a merchant yet. Contact your administrator."
        />
      </div>
    );
  }

  return <MerchantDashboard merchantId={merchant.id} merchantName={merchant.name} userName={user?.name ?? ""} />;
}
