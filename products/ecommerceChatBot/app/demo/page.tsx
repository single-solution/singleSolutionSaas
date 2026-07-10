import { ChatWidgetEmbed } from "@/components/ChatWidgetEmbed";
import { DemoStatusPanel } from "@/components/demo/DemoStatusPanel";
import { DemoStorefront } from "@/components/demo/DemoStorefront";
import { resolvePublicDemo } from "@/lib/demo/resolvePublicDemo";

/**
 * Live test storefront. Open with a real product access token to see the widget
 * embedded exactly as it would run on a merchant site:
 *   /demo?token=pk_live_xxx
 * Without a query token, falls back to the configured public demo sandbox.
 */
export const dynamic = "force-dynamic";

export default async function DemoStore({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token: queryToken } = await searchParams;
  const demo = await resolvePublicDemo(queryToken);

  return (
    <DemoStorefront badge={queryToken ? "Token demo" : "Live demo sandbox"}>
      {demo.status === "ready" && demo.token ? (
        <ChatWidgetEmbed token={demo.token} />
      ) : (
        <DemoStatusPanel status={demo.status} showTokenHint={!queryToken} />
      )}
    </DemoStorefront>
  );
}
