"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Send } from "lucide-react";

import { adminApi } from "@/lib/admin/adminApiClient";
import type { ChatThread, ChatThreadSummary } from "@/lib/chat/types";
import { NoSiteSelected, PageError, PageHeading, StatusBadge } from "@/components/admin/ui";

const STATUS_FILTERS = ["all", "open", "awaiting-customer", "resolved"] as const;

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
      const updated = await adminApi.replyConversation(siteId, selectedId, reply.trim());
      setThread(updated);
      setReply("");
      void loadList();
    } catch {
      setError("Could not send reply.");
    } finally {
      setSending(false);
    }
  }

  async function patchThread(patch: { status?: string; assistantMuted?: boolean }) {
    if (!siteId || !selectedId) return;
    try {
      const updated = await adminApi.updateConversation(siteId, selectedId, patch);
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
    <div className="space-y-4">
      <PageHeading title="Conversations" subtitle={`${total} total for this site.`} />
      {error ? <PageError message={error} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {STATUS_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setStatus(option)}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                status === option ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-100"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name, message, visitor"
          className="h-9 w-64 rounded-md border border-slate-300 px-3 text-sm focus:border-slate-500 focus:outline-none"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <div className="rounded-xl border border-slate-200 bg-white">
          {loading ? (
            <p className="p-4 text-sm text-slate-500">Loading...</p>
          ) : list.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No conversations found.</p>
          ) : (
            <ul className="max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
              {list.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => void openThread(conversation.id)}
                    className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-slate-50 ${
                      selectedId === conversation.id ? "bg-slate-50" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-slate-800">{conversation.customerName}</span>
                      <StatusBadge status={conversation.status} />
                    </div>
                    <span className="truncate text-xs text-slate-500">{conversation.lastMessagePreview || "No messages yet"}</span>
                    <div className="flex items-center gap-2 text-[11px] text-slate-400">
                      <span>{new Date(conversation.lastMessageAt).toLocaleString()}</span>
                      {conversation.unreadByTeam > 0 ? (
                        <span className="rounded-full bg-slate-900 px-1.5 text-white">{conversation.unreadByTeam}</span>
                      ) : null}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white">
          {!thread ? (
            <p className="p-6 text-sm text-slate-500">{threadLoading ? "Loading thread..." : "Select a conversation."}</p>
          ) : (
            <div className="flex h-[70vh] flex-col">
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 p-4">
                <div>
                  <p className="text-sm font-semibold text-slate-800">{thread.customerName}</p>
                  <p className="text-xs text-slate-400">Visitor conversation</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={thread.status} />
                  <button
                    type="button"
                    onClick={() => void patchThread({ status: thread.status === "resolved" ? "open" : "resolved" })}
                    className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {thread.status === "resolved" ? "Reopen" : "Resolve"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void patchThread({ assistantMuted: !thread.assistantPaused })}
                    className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {thread.assistantPaused ? "Unmute assistant" : "Mute assistant"}
                  </button>
                </div>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {thread.messages.map((message) => (
                  <div
                    key={message.id}
                    className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                      message.author === "customer"
                        ? "bg-slate-100 text-slate-800"
                        : message.author === "assistant"
                          ? "ml-auto bg-indigo-50 text-indigo-900"
                          : "ml-auto bg-slate-900 text-white"
                    }`}
                  >
                    <p className="mb-0.5 text-[10px] uppercase tracking-wide opacity-60">
                      {message.authorName || message.author}
                    </p>
                    <p className="whitespace-pre-wrap">{message.body}</p>
                  </div>
                ))}
              </div>

              <div className="border-t border-slate-100 p-3">
                <div className="flex items-end gap-2">
                  <textarea
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    rows={2}
                    placeholder="Type a reply as an agent..."
                    className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleReply()}
                    disabled={sending || !reply.trim()}
                    className="inline-flex h-10 items-center gap-1.5 rounded-md bg-slate-900 px-3 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
                  >
                    <Send className="h-4 w-4" aria-hidden="true" />
                    Send
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
