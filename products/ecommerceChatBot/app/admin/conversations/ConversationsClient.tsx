"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MessageSquare, Send } from "lucide-react";

import { adminApi } from "@/lib/admin/adminApiClient";
import type { ChatThread, ChatThreadSummary } from "@/lib/chat/types";
import { cn } from "@/components/admin/cn";
import {
  Button,
  Card,
  ConversationListSkeleton,
  ConversationThreadSkeleton,
  EmptyState,
  FilterGroup,
  Input,
  NoSiteSelected,
  PageError,
  PageHeading,
  StatusBadge,
  Textarea,
} from "@/components/admin/ui";

const STATUS_FILTERS = [
  "all",
  "open",
  "awaiting-customer",
  "resolved",
] as const;

export function ConversationsClient() {
  const siteId = useSearchParams().get("siteId") ?? "";
  const [list, setList] = useState<ChatThreadSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const loadList = useCallback(async () => {
    if (!siteId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await adminApi.listConversations(siteId, {
        status: status === "all" ? undefined : status,
        search: search || undefined,
      });
      setList(result.conversations);
      setTotal(result.total);
    } catch {
      setError("Could not load conversations.");
    } finally {
      setLoading(false);
    }
  }, [siteId, status, search]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openThread = useCallback(
    async (id: string) => {
      if (!siteId) return;
      setSelectedId(id);
      setThreadLoading(true);
      try {
        setThread(await adminApi.getConversation(siteId, id));
      } catch {
        setThread(null);
      } finally {
        setThreadLoading(false);
      }
    },
    [siteId],
  );

  async function handleReply() {
    if (!siteId || !selectedId || !reply.trim()) return;
    setSending(true);
    try {
      const updated = await adminApi.replyConversation(
        siteId,
        selectedId,
        reply.trim(),
      );
      setThread(updated);
      setReply("");
      void loadList();
    } catch {
      setError("Could not send reply.");
    } finally {
      setSending(false);
    }
  }

  async function patchThread(patch: {
    status?: string;
    assistantMuted?: boolean;
  }) {
    if (!siteId || !selectedId) return;
    try {
      const updated = await adminApi.updateConversation(
        siteId,
        selectedId,
        patch,
      );
      setThread(updated);
      void loadList();
    } catch {
      setError("Could not update conversation.");
    }
  }

  if (!siteId) {
    return <NoSiteSelected />;
  }

  return (
    <div className="admin-page-stack">
      <PageHeading
        title="Conversations"
        subtitle={`${total} total for this site.`}
      />
      {error ? (
        <PageError message={error} onRetry={() => void loadList()} />
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <FilterGroup
          label="Filter by status"
          options={STATUS_FILTERS}
          value={status}
          onChange={setStatus}
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name, message, visitor"
          className="h-9 w-full sm:w-64"
          aria-label="Search conversations"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card className="overflow-hidden p-0">
          {loading ? (
            <ConversationListSkeleton />
          ) : list.length === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                icon={MessageSquare}
                title="No conversations"
                description="No conversations match the current filters."
              />
            </div>
          ) : (
            <ul className="max-h-[70vh] divide-y divide-[var(--line)] overflow-y-auto">
              {list.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => void openThread(conversation.id)}
                    className={cn(
                      "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-subtle)] motion-reduce:transition-none",
                      selectedId === conversation.id
                        ? "bg-[var(--accent-soft)]"
                        : "",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-[var(--ink)]">
                        {conversation.customerName}
                      </span>
                      <StatusBadge status={conversation.status} />
                    </div>
                    <span className="truncate text-xs text-[var(--ink-muted)]">
                      {conversation.lastMessagePreview || "No messages yet"}
                    </span>
                    <div className="flex items-center gap-2 text-[11px] text-[var(--ink-faint)]">
                      <span>
                        {new Date(conversation.lastMessageAt).toLocaleString()}
                      </span>
                      {conversation.unreadByTeam > 0 ? (
                        <span className="rounded-full bg-[var(--brand-800)] px-1.5 text-white">
                          {conversation.unreadByTeam}
                        </span>
                      ) : null}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden p-0">
          {!thread ? (
            threadLoading ? (
              <ConversationThreadSkeleton
                messageCount={Math.min(3, Math.max(1, list.length))}
              />
            ) : (
              <div className="p-4">
                <EmptyState
                  compact
                  icon={MessageSquare}
                  title="Select a conversation"
                  description="Choose a thread from the list to view messages and reply."
                />
              </div>
            )
          ) : (
            <div className="flex max-h-[70vh] flex-col">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] p-4">
                <div>
                  <p className="text-sm font-semibold text-[var(--ink)]">
                    {thread.customerName}
                  </p>
                  <p className="text-xs text-[var(--ink-faint)]">
                    Visitor conversation
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={thread.status} />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void patchThread({
                        status:
                          thread.status === "resolved" ? "open" : "resolved",
                      })
                    }
                  >
                    {thread.status === "resolved" ? "Reopen" : "Resolve"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void patchThread({
                        assistantMuted: !thread.assistantPaused,
                      })
                    }
                  >
                    {thread.assistantPaused
                      ? "Unmute assistant"
                      : "Mute assistant"}
                  </Button>
                </div>
              </div>

              <div className="space-y-3 overflow-y-auto p-4">
                {thread.messages.map((message) => (
                  <div
                    key={message.id}
                    className={cn(
                      "max-w-[75%] rounded-lg px-3 py-2 text-sm",
                      message.author === "customer"
                        ? "bg-[var(--surface-subtle)] text-[var(--ink)]"
                        : message.author === "assistant"
                          ? "ml-auto bg-[var(--accent-soft)] text-[var(--brand-900)]"
                          : "ml-auto bg-[var(--brand-800)] text-white",
                    )}
                  >
                    <p className="mb-0.5 text-[10px] uppercase tracking-wide opacity-60">
                      {message.authorName || message.author}
                    </p>
                    <p className="whitespace-pre-wrap">{message.body}</p>
                  </div>
                ))}
              </div>

              <div className="border-t border-[var(--line)] p-3">
                <div className="flex items-end gap-2">
                  <Textarea
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    rows={2}
                    placeholder="Type a reply as an agent..."
                    className="flex-1 resize-none"
                    aria-label="Reply message"
                  />
                  <Button
                    onClick={() => void handleReply()}
                    disabled={sending || !reply.trim()}
                    loading={sending}
                  >
                    <Send className="h-4 w-4" aria-hidden="true" />
                    Send
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
