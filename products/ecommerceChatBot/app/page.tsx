import { LiveChatWidget } from "@/components/chat/LiveChatWidget";

const DEMO_TOKEN = process.env.NEXT_PUBLIC_DEMO_PRODUCT_TOKEN ?? "";

export default function Home() {
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-2xl font-bold text-slate-900">Merchant Storefront Demo</h1>
        <p className="text-slate-600">The chat widget is floating in the bottom-right corner.</p>
        {!DEMO_TOKEN && (
          <p className="mx-auto mt-4 max-w-sm rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Set <code>NEXT_PUBLIC_DEMO_PRODUCT_TOKEN</code> to a valid product access token (issued from the platform) to activate the widget locally.
          </p>
        )}
      </div>

      {/* On a real merchant site this component is mounted from a bundled embed
          script, initialized with the merchant's product access token. */}
      {DEMO_TOKEN ? <LiveChatWidget productToken={DEMO_TOKEN} /> : null}
    </main>
  );
}
