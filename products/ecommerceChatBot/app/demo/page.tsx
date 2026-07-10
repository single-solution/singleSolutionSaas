import { ChatWidgetEmbed } from "@/components/ChatWidgetEmbed";
import { DemoStatusPanel } from "@/components/demo/DemoStatusPanel";
import { DemoStorefront } from "@/components/demo/DemoStorefront";
import { resolvePublicDemo } from "@/lib/demo/resolvePublicDemo";

/**
 * Live test storefront using the server-configured public demo sandbox.
 */
export const dynamic = "force-dynamic";

export default async function DemoStore() {
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
