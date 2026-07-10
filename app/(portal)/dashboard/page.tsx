"use client";

import { useAuth } from "@/components/AuthProvider";
import { AdminOverview } from "@/components/dashboard/AdminOverview";
import { MerchantHome } from "@/components/dashboard/MerchantHome";
import { DashboardMerchantSkeleton } from "@/components/ui/portalSkeletons";

export default function DashboardPage() {
  const { user } = useAuth();

  if (!user) {
    return <DashboardMerchantSkeleton />;
  }

  return user.isPlatformAdmin ? (
    <AdminOverview mode="dashboard" />
  ) : (
    <MerchantHome />
  );
}
