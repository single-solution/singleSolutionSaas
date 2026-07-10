import { ChatWidgetEmbed } from "@/components/ChatWidgetEmbed";
import { DemoStatusPanel } from "@/components/demo/DemoStatusPanel";
import { DemoStorefront } from "@/components/demo/DemoStorefront";
import { resolvePublicDemo } from "@/lib/demo/resolvePublicDemo";

/**
 * Dedicated guest sandbox. Uses the server-configured public demo token; falls
 * back to a static storefront when the token is absent or invalid.
 */
export const dynamic = "force-dynamic";

export default async function PublicDemoPage() {
  const demo = await resolvePublicDemo();

  return (
    <DemoStorefront badge="Live demo sandbox">
      {demo.status === "ready" && demo.token ? (
        <ChatWidgetEmbed token={demo.token} />
      ) : (
        <DemoStatusPanel status={demo.status} showTokenHint />
      )}
    </DemoStorefront>
  );
}
