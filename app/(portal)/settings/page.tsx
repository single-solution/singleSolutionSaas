import { AccountSettings } from "@/components/account/AccountSettings";
import { PageHeader } from "@/components/layout/PageHeader";

export default function SettingsPage() {
  return (
    <div className="page-stack">
      <PageHeader title="Account settings" description="Manage your name and password." />
      <AccountSettings />
    </div>
  );
}
