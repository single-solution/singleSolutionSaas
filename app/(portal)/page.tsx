import { redirect } from "next/navigation";

import { getServerSession } from "@/lib/auth/serverSession";

export default async function PortalIndexPage() {
  const session = await getServerSession();

  redirect(session ? "/dashboard" : "/login");
}
