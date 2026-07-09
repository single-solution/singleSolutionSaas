import { AcceptInviteForm } from "@/components/auth/AcceptInviteForm";
import { LoginAside } from "@/components/auth/LoginAside";

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-2">
      <LoginAside />
      <AcceptInviteForm token={token ?? ""} />
    </div>
  );
}
