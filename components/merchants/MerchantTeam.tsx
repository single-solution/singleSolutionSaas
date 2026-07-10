"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Mail, Shield, Trash2, UserPlus } from "lucide-react";

import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type { MerchantMemberSummary } from "@/lib/types";

const ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
} as const;

export function MerchantTeam({
  merchantId,
  ownerEmail,
  pendingInvite,
}: {
  merchantId: string;
  ownerEmail?: string;
  pendingInvite?: boolean;
}) {
  const toast = useToast();
  const [members, setMembers] = useState<MerchantMemberSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [resendingInvite, setResendingInvite] = useState(false);
  const [recoveringOwner, setRecoveringOwner] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<MerchantMemberSummary | null>(null);
  const [removing, setRemoving] = useState(false);
  const [roleSavingId, setRoleSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await platformApi.listMerchantMembers(merchantId);
      setMembers(response.items);
    } catch {
      setError("Could not load team members.");
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    setInviteError(null);
    if (!inviteName.trim() || !inviteEmail.trim()) {
      setInviteError("Name and email are required.");
      return;
    }
    setInviting(true);
    try {
      const response = await platformApi.inviteMerchantMember(merchantId, {
        name: inviteName.trim(),
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      toast.showSuccess("Invitation sent", `${response.member.email} was invited.`);
      setInviteName("");
      setInviteEmail("");
      setShowInvite(false);
      await load();
    } catch (caughtError) {
      setInviteError(
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Could not send invitation.",
      );
    } finally {
      setInviting(false);
    }
  }

  async function handleResendInvite() {
    setResendingInvite(true);
    try {
      await platformApi.resendMerchantInvite(merchantId);
      toast.showSuccess("Invitation resent", ownerEmail ?? "Owner invite refreshed.");
    } catch (caughtError) {
      toast.showError(
        "Could not resend",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again.",
      );
    } finally {
      setResendingInvite(false);
    }
  }

  async function handleOwnerRecovery() {
    setRecoveringOwner(true);
    try {
      const result = await platformApi.sendOwnerRecovery(merchantId);
      toast.showSuccess(
        result.emailQueued ? "Recovery queued" : "Recovery prepared",
        `Sent to ${result.ownerEmail}.`,
      );
    } catch (caughtError) {
      toast.showError(
        "Recovery failed",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again.",
      );
    } finally {
      setRecoveringOwner(false);
    }
  }

  async function handleRoleChange(member: MerchantMemberSummary, role: MerchantMemberSummary["role"]) {
    setRoleSavingId(member.userId);
    try {
      await platformApi.updateMerchantMemberRole(merchantId, member.userId, role);
      toast.showSuccess("Role updated");
      await load();
    } catch (caughtError) {
      toast.showError(
        "Could not update role",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again.",
      );
    } finally {
      setRoleSavingId(null);
    }
  }

  async function confirmRemove() {
    if (!pendingRemoval) {
      return;
    }
    setRemoving(true);
    try {
      await platformApi.removeMerchantMember(merchantId, pendingRemoval.userId);
      toast.showSuccess("Member removed");
      setPendingRemoval(null);
      await load();
    } catch (caughtError) {
      toast.showError(
        "Could not remove member",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again.",
      );
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-ink-muted">
            Owner: {ownerEmail ?? "Unknown"}
            {pendingInvite ? " · invite pending" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {pendingInvite ? (
            <Button
              variant="outline"
              size="sm"
              loading={resendingInvite}
              onClick={() => void handleResendInvite()}
            >
              <Mail className="h-4 w-4" aria-hidden="true" />
              Resend owner invite
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              loading={recoveringOwner}
              onClick={() => void handleOwnerRecovery()}
            >
              <Shield className="h-4 w-4" aria-hidden="true" />
              Recover owner access
            </Button>
          )}
          <Button size="sm" className="min-h-11" onClick={() => setShowInvite(true)}>
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            Invite member
          </Button>
        </div>
      </div>

      {error ? (
        <Alert tone="danger" title="Load failed">
          {error}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </Alert>
      ) : null}

      {loading ? (
        <p className="text-sm text-ink-muted" aria-live="polite">
          Loading team...
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {members.map((member) => (
            <li
              key={member.userId}
              className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-medium text-ink">{member.name}</p>
                <p className="truncate text-sm text-ink-muted">{member.email}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge tone={member.invited ? "neutral" : "success"}>
                    {member.invited ? "Invited" : "Active"}
                  </Badge>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {member.role === "owner" ? (
                  <Badge tone="brand">{ROLE_LABELS.owner}</Badge>
                ) : (
                  <Select
                    aria-label={`Role for ${member.name}`}
                    value={member.role}
                    disabled={roleSavingId === member.userId}
                    onChange={(event) =>
                      void handleRoleChange(
                        member,
                        event.target.value as MerchantMemberSummary["role"],
                      )
                    }
                    className="min-h-11"
                  >
                    <option value="admin">{ROLE_LABELS.admin}</option>
                    <option value="member">{ROLE_LABELS.member}</option>
                  </Select>
                )}
                {member.role !== "owner" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={() => setPendingRemoval(member)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Remove
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={showInvite}
        title="Invite team member"
        description="Owners and admins can manage sites. Members have read-only portal access."
        onClose={() => setShowInvite(false)}
        dirty={Boolean(inviteName || inviteEmail)}
      >
        {inviteError ? (
          <Alert tone="danger" title="Could not invite" className="mb-4">
            {inviteError}
          </Alert>
        ) : null}
        <form className="grid gap-4" onSubmit={handleInvite} noValidate>
          <Field label="Name" htmlFor="invite-name" required>
            <Input
              id="invite-name"
              value={inviteName}
              onChange={(event) => setInviteName(event.target.value)}
            />
          </Field>
          <Field label="Email" htmlFor="invite-email" required>
            <Input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
            />
          </Field>
          <Field label="Role" htmlFor="invite-role" required>
            <Select
              id="invite-role"
              value={inviteRole}
              onChange={(event) =>
                setInviteRole(event.target.value as "admin" | "member")
              }
            >
              <option value="admin">Admin</option>
              <option value="member">Member</option>
            </Select>
          </Field>
          <Button type="submit" loading={inviting} className="min-h-11">
            Send invitation
          </Button>
        </form>
      </Modal>

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove team member?"
        description={
          pendingRemoval
            ? `${pendingRemoval.name} will lose access to this merchant immediately.`
            : ""
        }
        confirmLabel="Remove member"
        loading={removing}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  );
}
