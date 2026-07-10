import Link from "next/link";

import { buildPublicDemoPath } from "@/lib/demo/config";

interface TryLiveDemoLinkProps {
  className?: string;
  children?: React.ReactNode;
}

export function TryLiveDemoLink({ className, children }: TryLiveDemoLinkProps) {
  return (
    <Link href={buildPublicDemoPath()} className={className}>
      {children ?? "Try live demo"}
    </Link>
  );
}
