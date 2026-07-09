"use client";

import { useAuth } from "@/components/AuthProvider";
import { AdminOverview } from "@/components/dashboard/AdminOverview";
import { MerchantHome } from "@/components/dashboard/MerchantHome";
import { DetailSkeleton } from "@/components/ui/Skeleton";

export default function DashboardPage() {
  const { user } = useAuth();

  if (!user) {
    return <DetailSkeleton />;
  }

  return user.isPlatformAdmin ? <AdminOverview /> : <MerchantHome />;
}
