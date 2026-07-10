import { permanentRedirect } from "next/navigation";

export default async function AdminSiteRedirectPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;

  permanentRedirect(`/sites/${siteId}`);
}
