import { permanentRedirect } from "next/navigation";

export default async function AdminConversationsRedirectPage({
  params,
}: {
  params: Promise<{ siteId: string; productSlug: string }>;
}) {
  const { siteId, productSlug } = await params;

  permanentRedirect(`/sites/${siteId}/products/${productSlug}/conversations`);
}
