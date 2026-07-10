"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Inbox, MessagesSquare, RefreshCw, Send } from "lucide-react";

import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConversationsSkeleton } from "@/components/ui/portalSkeletons";
import { cn } from "@/lib/cn";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type {
  ProductConversation,
  ProductConversationStatus,
  ProductConversationSummary,
} from "@/lib/types";

const THREAD_POLL_MS = 6000;

const STATUS_FILTERS: {
  value: ProductConversationStatus | "all";
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "awaiting-customer", label: "Waiting" },
  { value: "resolved", label: "Resolved" },
];

const STATUS_TONE: Record<
  ProductConversationStatus,
  "brand" | "neutral" | "success"
> = {
  open: "brand",
  "awaiting-customer": "neutral",
  resolved: "success",
};

const STATUS_LABELS: Record<ProductConversationStatus, string> = {
  open: "Open",
  "awaiting-customer": "Waiting on customer",
  resolved: "Resolved",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ProductConversations({
  siteId,
  productSlug,
  canReply,
}: {
  siteId: string;
  productSlug: string;
  canReply: boolean;
}) {
  const toast = useToast();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [conversations, setConversations] = useState<
    ProductConversationSummary[]
  >([]);
  const statusFilter = (searchParams.get("status") as ProductConversationStatus | "all" | null) ?? "all";
  const selectedId = searchParams.get("conversation") ?? null;
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [thread, setThread] = useState<ProductConversation | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    setListError(null);
    setLoadingList(true);
    try {
      const response = await platformApi.listProductConversations(
        siteId,
        productSlug,
        {
          status: statusFilter === "all" ? undefined : statusFilter,
          pageSize: 50,
        },
      );
      setConversations(response.conversations);
    } catch (caughtError) {
      setListError(
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Could not load conversations.",
      );
    } finally {
      setLoadingList(false);
    }
  }, [siteId, productSlug, statusFilter]);

  function updateQuery(key: "status" | "conversation", value: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (!value || (key === "status" && value === "all")) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    router.replace(`${pathname}${next.size ? `?${next.toString()}` : ""}`, {
      scroll: false,
    });
  }

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadThread = useCallback(
    async (
      conversationId: string,
      { silent = false }: { silent?: boolean } = {},
    ) => {
      if (!silent) {
        setLoadingThread(true);
        setThreadError(null);
      }
      try {
        const response = await platformApi.getProductConversation(
          siteId,
          productSlug,
          conversationId,
        );
        setThread(response.conversation);
      } catch (caughtError) {
        if (!silent) {
          setThreadError(
            caughtError instanceof PlatformApiError
              ? caughtError.message
              : "Could not load conversation.",
          );
        }
      } finally {
        if (!silent) setLoadingThread(false);
      }
    },
    [siteId, productSlug],
  );

  useEffect(() => {
    if (!selectedId) {
      setThread(null);
      return;
    }
    void loadThread(selectedId);
  }, [selectedId, loadThread]);

  useEffect(() => {
    if (!selectedId) return;
    const interval = setInterval(() => {
      if (document.hidden) return;
      void loadThread(selectedId, { silent: true });
    }, THREAD_POLL_MS);
    return () => clearInterval(interval);
  }, [selectedId, loadThread]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread?.messages.length]);

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    const body = reply.trim();
    if (!body || !selectedId) return;
    setSending(true);
    try {
      const response = await platformApi.sendProductConversationMessage(
        siteId,
        productSlug,
        selectedId,
        body,
      );
      setThread(response.conversation);
      setReply("");
      void loadList();
    } catch (caughtError) {
      const message =
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again in a moment.";
      toast.showError("Could not send reply", message);
    } finally {
      setSending(false);
    }
  }

  if (loadingList && conversations.length === 0) {
    return <ConversationsSkeleton />;
  }

  return (
    <Card className="overflow-hidden border-line bg-surface p-0 shadow-sm">
      <div className="grid min-h-[32rem] grid-cols-1 md:grid-cols-[20rem_1fr]">
        <aside className="flex flex-col border-b border-line md:border-b-0 md:border-r">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="flex flex-wrap gap-1">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => updateQuery("status", filter.value)}
                  className={cn(
                    "min-h-11 rounded-md px-3 py-2 text-xs font-medium transition-colors",
                    statusFilter === filter.value
                      ? "bg-brand-600 text-white"
                      : "text-ink-muted hover:bg-surface-subtle",
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void loadList()}
              className="grid size-11 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-subtle"
              aria-label="Refresh conversations"
            >
              <RefreshCw
                className={cn("h-4 w-4", loadingList && "animate-spin")}
                aria-hidden="true"
              />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loadingList ? (
              <p
                className="px-4 py-6 text-sm text-ink-muted"
                aria-live="polite"
              >
                Loading conversations...
              </p>
            ) : listError ? (
              <Alert tone="danger" title="Load failed" className="m-3">
                {listError}
                <div className="mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadList()}
                  >
                    Retry
                  </Button>
                </div>
              </Alert>
            ) : conversations.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="No conversations"
                description="Customer chats will appear here."
              />
            ) : (
              <ul className="divide-y divide-line">
                {conversations.map((conversation) => (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      onClick={() => updateQuery("conversation", conversation.id)}
                      className={cn(
                        "flex min-h-11 w-full flex-col gap-1 px-4 py-3 text-left transition-colors",
                        selectedId === conversation.id
                          ? "bg-surface-subtle"
                          : "hover:bg-surface-subtle",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-ink">
                          {conversation.customerName}
                        </span>
                        {conversation.unreadByTeam > 0 ? (
                          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white">
                            {conversation.unreadByTeam}
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-[13px] text-ink-muted">
                        {conversation.lastMessagePreview}
                      </p>
                      <div className="flex items-center gap-2">
                        <Badge tone={STATUS_TONE[conversation.status]}>
                          {STATUS_LABELS[conversation.status]}
                        </Badge>
                        <span className="text-xs text-ink-faint">
                          {formatTime(conversation.lastMessageAt)}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section className="flex min-h-[32rem] flex-col">
          {!selectedId ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                icon={MessagesSquare}
                title="Select a conversation"
                description="Choose a chat on the left to read and reply."
              />
            </div>
          ) : loadingThread ? (
            <p className="p-6 text-sm text-ink-muted" aria-live="polite">
              Loading conversation...
            </p>
          ) : threadError ? (
            <Alert tone="danger" title="Load failed" className="m-4">
              {threadError}
              <div className="mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => selectedId && void loadThread(selectedId)}
                >
                  Retry
                </Button>
              </div>
            </Alert>
          ) : thread ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">
                    {thread.customerName}
                  </p>
                  {thread.assistantPaused ? (
                    <p className="text-xs text-ink-muted">
                      Assistant paused - handed to a human
                    </p>
                  ) : null}
                </div>
                <Badge tone={STATUS_TONE[thread.status]}>
                  {STATUS_LABELS[thread.status]}
                </Badge>
              </div>

              <div
                ref={scrollRef}
                className="flex-1 space-y-3 overflow-y-auto bg-surface-subtle/40 px-5 py-4"
              >
                {thread.messages.map((message) => {
                  const fromCustomer = message.author === "customer";
                  return (
                    <div
                      key={message.id}
                      className={cn(
                        "flex",
                        fromCustomer ? "justify-start" : "justify-end",
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm",
                          fromCustomer
                            ? "rounded-bl-sm bg-surface text-ink"
                            : message.author === "assistant"
                              ? "rounded-br-sm bg-surface text-ink-secondary ring-1 ring-line"
                              : "rounded-br-sm bg-brand-600 text-white",
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">
                          {message.body}
                        </p>
                        <p
                          className={cn(
                            "mt-1 text-[11px]",
                            fromCustomer || message.author === "assistant"
                              ? "text-ink-faint"
                              : "text-white/70",
                          )}
                        >
                          {message.authorName ??
                            (fromCustomer ? "Customer" : message.author)}{" "}
                          / {formatTime(message.createdAt)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {canReply ? (
                <form
                  className="flex items-end gap-2 border-t border-line px-4 py-3"
                  onSubmit={handleSend}
                  noValidate
                >
                  <label htmlFor="conversation-reply" className="sr-only">
                    Reply to customer
                  </label>
                  <textarea
                    id="conversation-reply"
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void handleSend(event as unknown as FormEvent);
                      }
                    }}
                    rows={2}
                    placeholder="Type a reply... (Enter to send, Shift+Enter for a new line)"
                    className="min-h-11 flex-1 resize-none rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors focus:border-brand-600 focus:outline-none"
                    aria-label="Reply to customer"
                  />
                  <Button
                    type="submit"
                    loading={sending}
                    disabled={!reply.trim()}
                    className="min-h-11"
                  >
                    <Send className="h-4 w-4" aria-hidden="true" />
                    Send
                  </Button>
                </form>
              ) : (
                <p className="border-t border-line px-5 py-4 text-sm text-ink-muted">
                  You have read-only access. Owners and admins can reply.
                </p>
              )}
            </>
          ) : null}
        </section>
      </div>
    </Card>
  );
}
