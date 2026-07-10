"use client";

/**
 * Embeddable live chat widget.
 *
 * Anonymous by design: each browser gets a persistent `visitorId` and exactly
 * ONE conversation, so there is no thread list - the widget opens straight into
 * it. Polls the API on a focus/blur cadence and sends optimistically.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { MessageSquare, X } from "lucide-react";

import {
  issueFromChatError,
  describeDemoWidgetIssue,
} from "@/lib/demo/chatErrors";
import { classNames } from "./cn";
import {
  ChatShell,
  ComposeConversation,
  ChatWidgetBootstrapSkeleton,
  ChatWidgetThreadSkeleton,
  StartingConversation,
  SupportHintFooter,
  ThreadConversation,
  statusLabel,
} from "./liveChatWidgetViews";
import { initChatSession } from "@/lib/chat/session";
import { createChatTransport } from "@/lib/chat/chatTransport";
import { mergeChatMessagesById } from "@/lib/chat/messagePagination";
import {
  ChatRequestError,
  fetchChatBootstrap,
  fetchChatThread,
  fetchOlderChatMessages,
  makeOptimisticMessage,
  markChatThreadRead,
  pollChatThread,
  sendChatMessage,
  startChatThread,
} from "@/lib/chat/transport";
import type { ChatSettings } from "@/lib/chat/settings";
import type { ChatMessage, ChatThread } from "@/lib/chat/types";

type WidgetView = "thread" | "starting" | "compose";

function newestServerCreatedAt(messages: ChatMessage[]): string | null {
  let newest: string | null = null;
  for (const message of messages) {
    if (message.id.startsWith("local-")) continue;
    if (!newest || new Date(message.createdAt) > new Date(newest)) {
      newest = message.createdAt;
    }
  }
  return newest;
}

export function LiveChatWidget({
  productToken,
  previewSettings,
}: {
  productToken?: string;
  previewSettings?: ChatSettings;
}) {
  const isPreview = Boolean(previewSettings);
  const [isOpen, setIsOpen] = useState(isPreview);
  const [bootstrapLoaded, setBootstrapLoaded] = useState(isPreview);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ChatSettings | null>(
    previewSettings ?? null,
  );
  const [enabled, setEnabled] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);
  const [view, setView] = useState<WidgetView>("compose");
  const [pendingFirstMessage, setPendingFirstMessage] =
    useState<ChatMessage | null>(null);
  const [composerDraft, setComposerDraft] = useState("");
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [unread, setUnread] = useState(0);

  const activeThreadIdRef = useRef<string | null>(null);
  const activeThreadRef = useRef<ChatThread | null>(null);
  const pollCursorRef = useRef<string | null>(null);

  const refreshBootstrap = useCallback(async () => {
    try {
      const data = await fetchChatBootstrap();
      setEnabled(data.enabled);
      setSettings(data.settings);
      setBootstrapError(null);
      return data;
    } catch (error) {
      const issue = issueFromChatError(error);
      setBootstrapError(describeDemoWidgetIssue(issue).detail);
      return null;
    }
  }, []);

  useEffect(() => {
    if (isPreview || !productToken) return;
    let cancelled = false;
    void (async () => {
      try {
        await initChatSession(productToken);
        if (cancelled) return;
        const data = await refreshBootstrap();
        setBootstrapLoaded(true);
        if (!data) return;
        if (data.threads.length === 0) {
          setView("compose");
        } else {
          setActiveThreadId(data.threads[0].id);
          setUnread(data.threads[0].unreadByCustomer);
          setView("thread");
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Could not start chat.";
        setBootstrapError(message);
        setBootstrapLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productToken, isPreview, refreshBootstrap]);

  // When hosted inside the embed iframe, tell the loader how big to make the
  // frame so a closed widget doesn't cover (and block clicks on) the host page.
  useEffect(() => {
    if (typeof window === "undefined" || window.parent === window) return;
    window.parent.postMessage(
      { source: "ecommerce-chatbot", type: "resize", open: isOpen },
      "*",
    );
  }, [isOpen]);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
    activeThreadRef.current = activeThread;
  }, [activeThreadId, activeThread]);

  useEffect(() => {
    if (isPreview || !activeThreadId) return;
    let cancelled = false;
    void (async () => {
      try {
        const thread = await fetchChatThread(activeThreadId);
        if (!cancelled) {
          pollCursorRef.current = newestServerCreatedAt(thread.messages);
          setActiveThread(thread);
        }
      } catch {
        if (!cancelled) setActiveThread(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, isPreview]);

  useEffect(() => {
    if (isPreview || !settings) return;
    const transport = createChatTransport({
      pollIntervalMsFocused: settings.pollIntervalMsFocused,
      pollIntervalMsBlurred: settings.pollIntervalMsBlurred,
      onError: () => setIsReconnecting(true),
      onTick: async () => {
        setIsReconnecting(false);
        const threadId = activeThreadIdRef.current;
        if (!threadId) return;
        const since = pollCursorRef.current;
        if (!since) {
          const fresh = await fetchChatThread(threadId);
          pollCursorRef.current = newestServerCreatedAt(fresh.messages);
          setActiveThread(fresh);
          return;
        }
        const fresh = await pollChatThread(threadId, since, `"${since}"`);
        if (!fresh) return;
        pollCursorRef.current =
          newestServerCreatedAt(fresh.messages) ?? pollCursorRef.current;
        transport.touch();
        setActiveThread((prev) => {
          if (!prev) return fresh;
          return {
            ...fresh,
            messages: mergeChatMessagesById(prev.messages, fresh.messages),
            hasMoreOlder: prev.hasMoreOlder ?? fresh.hasMoreOlder,
          };
        });
        if (isOpen) {
          markChatThreadRead(threadId).catch(() => undefined);
          setUnread(0);
        } else {
          setUnread(fresh.unreadByCustomer);
        }
      },
    });
    transport.start();
    function onVisible() {
      if (document.visibilityState === "visible") transport.pollNow();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      transport.stop();
    };
  }, [settings, isOpen, isPreview]);

  async function handlePreviewSend() {
    setBootstrapError(
      "Preview mode - this shows how the widget looks. Publish to go live.",
    );
  }

  async function handleComposeSend(body: string) {
    setBootstrapError(null);
    setPendingFirstMessage(makeOptimisticMessage({ body }));
    setView("starting");
    try {
      const thread = await startChatThread();
      const fresh = await sendChatMessage(thread.id, body);
      pollCursorRef.current = newestServerCreatedAt(fresh.messages);
      setActiveThreadId(fresh.id);
      setActiveThread({
        ...fresh,
        messages: fresh.messages.filter(
          (message) => message.author === "customer",
        ),
      });
      setView("thread");
      setPendingFirstMessage(null);
      requestAnimationFrame(() => setActiveThread(fresh));
    } catch (error) {
      const issue = issueFromChatError(error);
      setBootstrapError(describeDemoWidgetIssue(issue).detail);
      setPendingFirstMessage(null);
      setView("compose");
      throw error;
    }
  }

  async function handleSend(body: string) {
    if (!activeThread) return;
    const optimistic = makeOptimisticMessage({
      body,
      authorName: activeThread.customerName,
    });
    setActiveThread({
      ...activeThread,
      messages: [...activeThread.messages, optimistic],
      lastMessageAt: optimistic.createdAt,
      lastMessagePreview: body.slice(0, 280),
      lastMessageAuthor: "customer",
    });
    try {
      const fresh = await sendChatMessage(activeThread.id, body);
      pollCursorRef.current =
        newestServerCreatedAt(fresh.messages) ?? pollCursorRef.current;
      setActiveThread((prev) => {
        const base = prev ?? fresh;
        const withoutOptimistic = base.messages.filter(
          (message) => message.id !== optimistic.id,
        );
        return {
          ...fresh,
          messages: mergeChatMessagesById(withoutOptimistic, fresh.messages),
          hasMoreOlder: base.hasMoreOlder ?? fresh.hasMoreOlder,
        };
      });
    } catch (error) {
      setActiveThread((prev) =>
        prev
          ? {
              ...prev,
              messages: prev.messages.filter(
                (message) => message.id !== optimistic.id,
              ),
            }
          : prev,
      );
      if (error instanceof ChatRequestError) {
        const issue = issueFromChatError(error);
        setBootstrapError(describeDemoWidgetIssue(issue).detail);
      }
      throw error;
    }
  }

  const loadOlderMessages = useCallback(async () => {
    const thread = activeThreadRef.current;
    if (!thread?.hasMoreOlder || thread.messages.length === 0) return;
    const oldestId = thread.messages[0].id;
    setIsLoadingOlder(true);
    try {
      const older = await fetchOlderChatMessages(thread.id, oldestId);
      setActiveThread((prev) =>
        prev
          ? {
              ...prev,
              messages: mergeChatMessagesById(older.messages, prev.messages),
              hasMoreOlder: older.hasMoreOlder,
            }
          : prev,
      );
    } catch {
      // retry on next scroll
    } finally {
      setIsLoadingOlder(false);
    }
  }, []);

  function openWidget() {
    setIsOpen(true);
    setUnread(0);
    const threadId = activeThreadIdRef.current;
    if (threadId) {
      markChatThreadRead(threadId).catch(() => undefined);
    }
  }

  const assistantEnabled = settings?.assistantEnabled ?? false;
  const welcomeMessage =
    settings?.welcomeMessage ?? "Hi! How can we help you today?";
  const title = settings?.assistantName ?? "Chat Support";

  return (
    <div
      className="ecommerce-chatbot-widget fixed bottom-4 right-4 z-[2147483000] flex flex-col items-end gap-3"
      style={
        settings?.themeColor
          ? ({ "--color-accent-500": settings.themeColor } as CSSProperties)
          : undefined
      }
    >
      {isOpen ? (
        <div className="h-[520px] w-[370px] max-w-[calc(100vw-2rem)]">
          <ChatShell
            title={title}
            subtitle={
              isReconnecting
                ? "Reconnecting..."
                : view === "thread" && activeThread?.assistantPaused
                  ? "Team is reviewing - you can still message us"
                  : view === "thread" && activeThread
                    ? statusLabel(activeThread.status)
                    : assistantEnabled
                      ? "Support chat - replies in seconds"
                      : "We typically reply within an hour"
            }
            onClose={() => setIsOpen(false)}
          >
            {!bootstrapLoaded ? (
              <ChatWidgetBootstrapSkeleton />
            ) : !enabled ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-[length:var(--chat-font-body)] text-[var(--color-ink-500)]">
                Chat is currently disabled.
              </div>
            ) : (
              <>
                {bootstrapError && (
                  <div className="border-b border-[var(--color-danger-200)] bg-[var(--color-danger-50)] px-4 py-2 text-[length:var(--chat-font-small)] text-[var(--color-danger-700)]">
                    {bootstrapError}
                  </div>
                )}
                {view === "starting" && pendingFirstMessage && (
                  <StartingConversation message={pendingFirstMessage} />
                )}
                {view === "compose" && (
                  <ComposeConversation
                    draft={composerDraft}
                    onDraftChange={setComposerDraft}
                    onSend={isPreview ? handlePreviewSend : handleComposeSend}
                    welcomeMessage={welcomeMessage}
                  />
                )}
                {view === "thread" && activeThread ? (
                  <ThreadConversation
                    thread={activeThread}
                    onSend={handleSend}
                    initialDraft={composerDraft}
                    onDraftConsumed={() => setComposerDraft("")}
                    welcomeMessage={welcomeMessage}
                    assistantEnabled={assistantEnabled}
                    hasMoreOlder={activeThread.hasMoreOlder ?? false}
                    isLoadingOlder={isLoadingOlder}
                    onLoadOlder={loadOlderMessages}
                  />
                ) : null}
                {view === "thread" && !activeThread ? (
                  <ChatWidgetThreadSkeleton />
                ) : null}
                <SupportHintFooter
                  assistantEnabled={assistantEnabled}
                  assistantPaused={
                    view === "thread" &&
                    (activeThread?.assistantPaused ?? false)
                  }
                />
              </>
            )}
          </ChatShell>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => (isOpen ? setIsOpen(false) : openWidget())}
        className={classNames(
          "relative grid size-14 place-items-center rounded-full bg-[var(--color-ink-900)] text-[var(--color-accent-500)] shadow-[var(--shadow-lg)] transition-transform hover:scale-105 active:scale-95",
        )}
        aria-label={isOpen ? "Close chat" : "Open chat"}
      >
        {isOpen ? <X size={24} /> : <MessageSquare size={24} />}
        {!isOpen && unread > 0 && (
          <span className="absolute -right-1 -top-1 grid min-h-5 min-w-5 place-items-center rounded-full bg-[var(--color-danger-600)] px-1 text-[11px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
    </div>
  );
}
