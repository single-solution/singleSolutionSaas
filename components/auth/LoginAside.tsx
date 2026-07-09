export function LoginAside() {
  return (
    <section className="flex min-h-[40vh] flex-col justify-between border-b border-line bg-surface-subtle px-8 py-10 md:min-h-screen md:border-b-0 md:border-r md:px-12 md:py-12">
      <div className="animate-fade-in-up">
        <p className="text-sm font-medium text-ink-muted">Single Solution</p>
        <h1 className="mt-3 max-w-md text-3xl font-semibold tracking-tight text-ink">Operations portal</h1>
        <p className="mt-4 max-w-md text-sm leading-6 text-ink-secondary">
          Manage merchants, sites, and product subscriptions. SaaS products connect from separate applications.
        </p>
      </div>

      <ul className="mt-10 space-y-3 text-sm text-ink-secondary md:mt-0 animate-fade-in" style={{ animationDelay: "0.2s" }}>
        <li className="flex gap-3">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" aria-hidden="true" />
          Platform admins manage all merchants
        </li>
        <li className="flex gap-3">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" aria-hidden="true" />
          Merchants manage their own sites and products
        </li>
        <li className="flex gap-3">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" aria-hidden="true" />
          Product apps authenticate via issued access tokens
        </li>
      </ul>
    </section>
  );
}
