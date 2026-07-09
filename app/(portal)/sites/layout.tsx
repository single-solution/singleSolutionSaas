import { redirect } from "next/navigation";

import { getServerSession } from "@/lib/auth/serverSession";

export default async function SitesSectionLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }
  if (session.user.isPlatformAdmin) {
    redirect("/");
  }
  return <>{children}</>;
}
