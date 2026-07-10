import { TryLiveDemoLink } from "@/components/demo/TryLiveDemoLink";

export function PublicDemoLanding() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex max-w-3xl flex-col items-center px-6 py-16 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-blue-600">
          Ecommerce Chatbot
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
          Embeddable live chat for storefronts
        </h1>
        <p className="mt-4 max-w-xl text-base leading-7 text-slate-600">
          Add a floating assistant to any shop. Visitors get instant answers;
          your team can take over when a human is needed.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <TryLiveDemoLink className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700">
            Try live demo
          </TryLiveDemoLink>
          <span className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-500">
            No sign-in required
          </span>
        </div>

        <ul className="mt-12 grid w-full gap-4 text-left text-sm text-slate-600 sm:grid-cols-3">
          <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="font-semibold text-slate-900">One-line embed</p>
            <p className="mt-1">
              Drop a script tag on the merchant site with a domain-bound product
              token.
            </p>
          </li>
          <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="font-semibold text-slate-900">Automated assistant</p>
            <p className="mt-1">
              Answers common questions before escalating to a human agent.
            </p>
          </li>
          <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="font-semibold text-slate-900">
              Portal-managed config
            </p>
            <p className="mt-1">
              Draft, preview, and publish widget settings from the platform
              portal.
            </p>
          </li>
        </ul>
      </div>
    </main>
  );
}
