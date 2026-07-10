import type { PublicDemoRuntimeStatus } from "@/lib/demo/resolvePublicDemo";
import {
  describeDemoWidgetIssue,
  type DemoWidgetIssue,
} from "@/lib/demo/chatErrors";

interface DemoStatusPanelProps {
  status: PublicDemoRuntimeStatus | DemoWidgetIssue;
  showTokenHint?: boolean;
}

function panelTone(status: PublicDemoRuntimeStatus | DemoWidgetIssue): string {
  if (status === "ready" || status === "loading") {
    return "border-blue-200 bg-blue-50 text-blue-900";
  }
  if (status === "unconfigured") {
    return "border-slate-200 bg-white text-slate-700";
  }
  return "border-amber-200 bg-amber-50 text-amber-900";
}

function copyForStatus(status: PublicDemoRuntimeStatus | DemoWidgetIssue): {
  title: string;
  detail: string;
} {
  if (status === "unconfigured") {
    return {
      title: "Preview storefront only",
      detail:
        "Live chat is not configured for this environment. Operators can still open a manual demo with /demo?token=pk_live_… after issuing a product access token.",
    };
  }
  if (status === "invalid") {
    return describeDemoWidgetIssue("expired");
  }
  if (status === "unavailable") {
    return describeDemoWidgetIssue("unavailable");
  }
  return describeDemoWidgetIssue(status);
}

export function DemoStatusPanel({
  status,
  showTokenHint = false,
}: DemoStatusPanelProps) {
  const copy = copyForStatus(status);
  return (
    <div className="mx-auto max-w-5xl px-6 pb-16">
      <div
        className={`rounded-lg border px-4 py-4 text-sm ${panelTone(status)}`}
        role="status"
      >
        <p className="font-semibold">{copy.title}</p>
        <p className="mt-1 leading-6">{copy.detail}</p>
        {showTokenHint && status === "unconfigured" ? (
          <p className="mt-3 text-xs text-slate-500">
            Set{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5">
              PUBLIC_DEMO_PRODUCT_TOKEN
            </code>{" "}
            on the server to enable the guest sandbox.
          </p>
        ) : null}
      </div>
    </div>
  );
}
