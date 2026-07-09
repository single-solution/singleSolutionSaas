import { ChatWidgetEmbed } from "@/components/ChatWidgetEmbed";

/**
 * Live test storefront. Open with a real product access token to see the widget
 * embedded exactly as it would run on a merchant site:
 *   /demo?token=pk_live_xxx
 * Served from the product's own origin, so the per-token framing gate passes and
 * the widget's API calls are same-origin allowed.
 */
export const dynamic = "force-dynamic";

const PRODUCTS = [
  { name: "Trail Runner Jacket", price: "$189", tag: "New" },
  { name: "Merino Base Layer", price: "$79", tag: "Bestseller" },
  { name: "Summit 45L Backpack", price: "$149", tag: null },
  { name: "All-Weather Boots", price: "$219", tag: "Low stock" },
  { name: "Insulated Flask 1L", price: "$34", tag: null },
  { name: "Packable Down Vest", price: "$129", tag: "New" },
];

export default async function DemoStore({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="text-lg font-bold tracking-tight">Northwind Outfitters</div>
          <nav className="hidden gap-6 text-sm text-slate-600 sm:flex">
            <span>New Arrivals</span>
            <span>Men</span>
            <span>Women</span>
            <span>Gear</span>
            <span>Sale</span>
          </nav>
          <div className="text-sm text-slate-500">Cart (0)</div>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-10">
        <div className="rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 px-8 py-12 text-white">
          <p className="text-sm uppercase tracking-widest text-white/70">Autumn Collection</p>
          <h1 className="mt-2 max-w-lg text-3xl font-bold sm:text-4xl">Gear built for the long way round.</h1>
          <p className="mt-3 max-w-md text-white/80">
            Questions about sizing, shipping, or returns? Tap the chat bubble in the corner - our assistant replies
            instantly.
          </p>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {PRODUCTS.map((product) => (
            <article key={product.name} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex aspect-[4/3] items-center justify-center rounded-lg bg-slate-100 text-slate-300">
                <span className="text-4xl">◈</span>
              </div>
              <div className="mt-3 flex items-start justify-between">
                <h2 className="text-sm font-semibold">{product.name}</h2>
                {product.tag ? (
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                    {product.tag}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-slate-500">{product.price}</p>
            </article>
          ))}
        </div>
      </section>

      {token ? (
        <ChatWidgetEmbed token={token} />
      ) : (
        <div className="mx-auto max-w-5xl px-6 pb-16">
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Append a product access token to activate the chat widget:{" "}
            <code>/demo?token=pk_live_...</code> (issue one from the platform portal).
          </p>
        </div>
      )}
    </main>
  );
}
