"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { AlertTriangle, MessageSquare, Send, X } from "lucide-react";

import { classNames, CHAT_SUPPORT_DISPLAY_NAME } from "./cn";
import {
  ChatMessageBubble,
  ChatMessageDayDivider,
  groupChatMessagesByDay,
} from "./chatMessageUi";
import {
  CHAT_MESSAGE_BODY_MAX,
  type ChatMessage,
  type ChatThread,
} from "@/lib/chat/types";
import { scheduleStateUpdate } from "@/lib/chat/scheduleStateUpdate";

const CHAT_COMPOSER_FORM_CLASS =
  "flex items-end gap-2 border-t border-[var(--color-ink-100)] bg-[var(--color-surface)] px-3 py-2.5";
const CHAT_COMPOSER_TEXTAREA_CLASS =
  "box-border max-h-[120px] min-h-[40px] min-w-0 flex-1 resize-none rounded-[var(--radius-md)] bg-[var(--color-canvas-deep)] px-3 py-2 text-[length:var(--chat-font-body)] leading-normal text-[var(--color-ink-800)] placeholder:text-[var(--color-ink-400)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-500)] disabled:opacity-60";
const CHAT_COMPOSER_SEND_CLASS =
  "grid h-[40px] w-[40px] shrink-0 place-items-center self-end rounded-[var(--radius-md)] bg-[var(--color-ink-900)] text-[var(--color-on-dark)] transition-colors enabled:hover:bg-[var(--color-ink-800)] disabled:opacity-40";

const CHAT_COMPOSER_MAX_HEIGHT_PX = 120;

interface ChatComposerProps {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  sending: boolean;
  placeholder: string;
}

function ChatComposer({
  draft,
  onDraftChange,
  onSubmit,
  sending,
  placeholder,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, CHAT_COMPOSER_MAX_HEIGHT_PX)}px`;
  }, [draft]);

  async function handleFormSubmit(event: React.FormEvent) {
    event.preventDefault();
    await onSubmit();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void onSubmit();
  }

  return (
    <form onSubmit={handleFormSubmit} className={CHAT_COMPOSER_FORM_CLASS}>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={CHAT_MESSAGE_BODY_MAX}
        rows={1}
        disabled={sending}
        className={CHAT_COMPOSER_TEXTAREA_CLASS}
      />
      <button
        type="submit"
        aria-label="Send message"
        disabled={sending || draft.trim().length === 0}
        className={CHAT_COMPOSER_SEND_CLASS}
      >
        {sending ? (
          <span className="block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
        ) : (
          <Send className="size-3.5" strokeWidth={2.2} />
        )}
      </button>
    </form>
  );
}

const STAGGER_GAP_MS = 125;
const TYPING_MS_PER_CHAR = 10;
const READING_MS_PER_CHAR = 50;
const MAX_TYPING_MS = 2500;
const MAX_READING_MS = 1200;

function estimateTypingDelayMs(body: string): number {
  if (/^\|/m.test(body.trim())) {
    return Math.min(1500, 300 + body.length * 4);
  }
  return Math.min(MAX_TYPING_MS, body.length * TYPING_MS_PER_CHAR);
}

function estimateReadingDelayMs(customerBody: string): number {
  return Math.min(MAX_READING_MS, customerBody.length * READING_MS_PER_CHAR);
}

function ChatWidgetPulse({ className }: { className?: string }) {
  return (
    <div
      className={classNames(
        "animate-pulse rounded-[var(--radius-md)] bg-[var(--color-ink-200)] motion-reduce:animate-none",
        className,
      )}
      aria-hidden="true"
    />
  );
}

export function ChatWidgetBootstrapSkeleton() {
  return (
    <>
      <div
        className="flex-1 space-y-3 bg-[var(--color-canvas-deep)] px-3 py-3"
        role="status"
        aria-busy="true"
        aria-label="Loading chat"
      >
        <ChatWidgetPulse className="h-[4.5rem] w-[85%] rounded-[var(--radius-lg)]" />
        <ChatWidgetPulse className="ml-auto h-10 w-[58%] rounded-[var(--radius-lg)]" />
        <ChatWidgetPulse className="h-[3.25rem] w-[72%] rounded-[var(--radius-lg)]" />
      </div>
      <div className="border-t border-[var(--color-ink-100)] bg-[var(--color-surface)] px-3 py-2.5">
        <ChatWidgetPulse className="h-10 w-full rounded-[var(--radius-md)]" />
      </div>
    </>
  );
}

export function ChatWidgetThreadSkeleton() {
  return (
    <>
      <div
        className="flex-1 space-y-3 bg-[var(--color-canvas-deep)] px-3 py-3"
        role="status"
        aria-busy="true"
        aria-label="Loading messages"
      >
        <ChatWidgetPulse className="h-12 w-[78%] rounded-[var(--radius-lg)]" />
        <ChatWidgetPulse className="ml-auto h-10 w-[62%] rounded-[var(--radius-lg)]" />
      </div>
      <div className="border-t border-[var(--color-ink-100)] bg-[var(--color-surface)] px-3 py-2.5">
        <ChatWidgetPulse className="h-10 w-full rounded-[var(--radius-md)]" />
      </div>
    </>
  );
}

function ChatStatusLine({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="text-[length:var(--chat-font-small)] text-[var(--color-ink-500)]"
    >
      {children}
    </p>
  );
}

export function StartingConversation({ message }: { message: ChatMessage }) {
  return (
    <div className="flex-1 space-y-3 overflow-y-auto bg-[var(--color-canvas-deep)] px-3 py-3">
      <ChatMessageBubble message={message} />
      <ChatStatusLine>Connecting you with someone...</ChatStatusLine>
    </div>
  );
}

export function statusLabel(status: ChatThread["status"]): string {
  switch (status) {
    case "open":
      return "Open - we'll reply soon";
    case "awaiting-customer":
      return "Waiting on you";
    case "resolved":
      return "Resolved - message us anytime to reopen";
  }
}

interface ChatShellProps {
  title: string;
  subtitle: string;
  onClose?: () => void;
  children: React.ReactNode;
}

export function ChatShell({
  title,
  subtitle,
  onClose,
  children,
}: ChatShellProps) {
  return (
    <div
      role="dialog"
      aria-label={`Chat with ${title}`}
      className="chat-widget flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-ink-100)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)]"
    >
      <header className="flex items-center gap-3 border-b border-[var(--color-accent-200)] bg-[var(--color-accent-50)] px-3 py-3 text-[var(--color-ink-900)]">
        <span className="grid size-10 place-items-center rounded-full bg-[var(--color-ink-900)] text-base font-semibold text-[var(--color-accent-500)]">
          <MessageSquare size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--chat-font-body)] font-semibold leading-tight">
            {title}
          </p>
          <p className="truncate text-[length:var(--chat-font-small)] leading-tight text-[var(--color-ink-700)]">
            {subtitle}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            aria-label="Close chat"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-[var(--radius-md)] text-[var(--color-ink-700)] hover:bg-[var(--color-ink-900)]/10 hover:text-[var(--color-ink-900)]"
          >
            <X size={16} />
          </button>
        )}
      </header>
      {children}
    </div>
  );
}

interface ThreadConversationProps {
  thread: ChatThread;
  onSend: (body: string) => Promise<void>;
  initialDraft?: string;
  onDraftConsumed?: () => void;
  welcomeMessage: string;
  assistantEnabled: boolean;
  hasMoreOlder: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
}

const LOAD_OLDER_SCROLL_THRESHOLD_PX = 80;

export function ThreadConversation({
  thread,
  onSend,
  initialDraft = "",
  onDraftConsumed,
  welcomeMessage,
  assistantEnabled,
  hasMoreOlder,
  isLoadingOlder,
  onLoadOlder,
}: ThreadConversationProps) {
  const messageListRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(initialDraft);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialDraft) {
      scheduleStateUpdate(() => {
        setDraft(initialDraft);
        onDraftConsumed?.();
      });
    }
  }, [initialDraft, onDraftConsumed]);

  const messagesRef = useRef(thread.messages);
  const revealedIdsRef = useRef<Set<string>>(
    new Set(thread.messages.map((message) => message.id)),
  );

  useEffect(() => {
    messagesRef.current = thread.messages;
  });
  const queueRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readDelayRef = useRef(0);
  const [, bumpReveal] = useReducer((count: number) => count + 1, 0);
  const [botActivity, setBotActivity] = useState<"reading" | "typing" | false>(
    false,
  );

  const visibleMessages = thread.messages.filter((message) =>
    revealedIdsRef.current.has(message.id),
  );
  const lastVisibleId = visibleMessages[visibleMessages.length - 1]?.id;
  const firstVisibleId = visibleMessages[0]?.id;

  const pump = useCallback(function doPump() {
    const nextId = queueRef.current[0];
    if (nextId === undefined) {
      timerRef.current = null;
      setBotActivity(false);
      return;
    }
    const nextBody =
      messagesRef.current.find((message) => message.id === nextId)?.body ?? "";
    const startGap = readDelayRef.current;
    readDelayRef.current = 0;

    const typeAndReveal = () => {
      setBotActivity("typing");
      timerRef.current = setTimeout(() => {
        queueRef.current.shift();
        revealedIdsRef.current.add(nextId);
        bumpReveal();
        setBotActivity(false);
        timerRef.current = setTimeout(() => doPump(), STAGGER_GAP_MS);
      }, estimateTypingDelayMs(nextBody));
    };

    if (startGap > 0) {
      setBotActivity("reading");
      timerRef.current = setTimeout(typeAndReveal, startGap);
    } else {
      typeAndReveal();
    }
  }, []);

  useEffect(() => {
    const newOnes = thread.messages.filter(
      (message) =>
        !revealedIdsRef.current.has(message.id) &&
        !queueRef.current.includes(message.id),
    );
    if (newOnes.length === 0) return;

    let latestRevealedAt = 0;
    for (const message of messagesRef.current) {
      if (revealedIdsRef.current.has(message.id)) {
        latestRevealedAt = Math.max(
          latestRevealedAt,
          new Date(message.createdAt).getTime(),
        );
      }
    }

    let revealedAny = false;
    for (const message of newOnes) {
      const isHistorical =
        new Date(message.createdAt).getTime() < latestRevealedAt;
      if (message.author === "assistant" && !isHistorical) {
        queueRef.current.push(message.id);
      } else {
        revealedIdsRef.current.add(message.id);
        revealedAny = true;
      }
    }
    if (revealedAny) bumpReveal();
    if (queueRef.current.length > 0 && !timerRef.current) {
      const lastCustomer = [...messagesRef.current]
        .reverse()
        .find((message) => message.author === "customer");
      readDelayRef.current = estimateReadingDelayMs(lastCustomer?.body ?? "");
      pump();
    }
  }, [thread.messages, pump]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const stickToBottomRef = useRef(true);
  const olderAnchorRef = useRef<{ height: number; top: number } | null>(null);

  function handleMessageListScroll() {
    const el = messageListRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (
      el.scrollTop < LOAD_OLDER_SCROLL_THRESHOLD_PX &&
      hasMoreOlder &&
      !isLoadingOlder
    ) {
      olderAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
      onLoadOlder();
    }
  }

  useEffect(() => {
    const el = messageListRef.current;
    if (!el || !stickToBottomRef.current) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [lastVisibleId, sending, botActivity]);

  useLayoutEffect(() => {
    const el = messageListRef.current;
    const anchor = olderAnchorRef.current;
    if (!el || !anchor) return;
    el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
    olderAnchorRef.current = null;
  }, [firstVisibleId]);

  useEffect(() => {
    revealedIdsRef.current = new Set(
      messagesRef.current.map((message) => message.id),
    );
    queueRef.current = [];
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setBotActivity(false);
    bumpReveal();
    const el = messageListRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [thread.id]);

  const groupedMessages = groupChatMessagesByDay(visibleMessages);

  async function sendDraft() {
    if (draft.trim().length === 0 || sending) return;
    const body = draft.trim();
    setSending(true);
    setError(null);
    setDraft("");
    try {
      await onSend(body);
    } catch (err) {
      setDraft(body);
      setError(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {thread.assistantPaused ? <AssistantPausedNotice /> : null}
      <div
        ref={messageListRef}
        onScroll={handleMessageListScroll}
        className="flex-1 space-y-3 overflow-y-auto bg-[var(--color-canvas-deep)] px-3 py-3"
      >
        {isLoadingOlder ? (
          <div
            className="flex justify-center py-1"
            role="status"
            aria-label="Loading earlier messages"
          >
            <span className="block size-4 animate-spin rounded-full border-2 border-[var(--color-ink-300)] border-r-transparent motion-reduce:animate-none" />
          </div>
        ) : null}
        {groupedMessages.map((group) => (
          <div key={group.day} className="space-y-2">
            <ChatMessageDayDivider label={group.day} />
            {group.messages.map((message) => (
              <ChatMessageBubble key={message.id} message={message} />
            ))}
          </div>
        ))}
        {assistantEnabled && !thread.assistantPaused && botActivity ? (
          <ChatStatusLine>
            {botActivity === "reading"
              ? "Just a moment..."
              : `${CHAT_SUPPORT_DISPLAY_NAME} is replying...`}
          </ChatStatusLine>
        ) : null}
        {thread.messages.length === 0 && (
          <div className="rounded-[var(--radius-lg)] border border-[var(--color-ink-100)] bg-[var(--color-surface)] px-4 py-3.5 text-[length:var(--chat-font-body)] leading-relaxed text-[var(--color-ink-600)] shadow-[var(--shadow-sm)]">
            {welcomeMessage}
          </div>
        )}
      </div>
      {error && (
        <div className="border-t border-[var(--color-danger-200)] bg-[var(--color-danger-50)] px-3 py-1.5 text-[length:var(--chat-font-small)] text-[var(--color-danger-700)]">
          {error}
        </div>
      )}
      <ChatComposer
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={sendDraft}
        sending={sending}
        placeholder="Type a message"
      />
    </>
  );
}

interface ComposeConversationProps {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (body: string) => Promise<void>;
  welcomeMessage: string;
}

export function ComposeConversation({
  draft,
  onDraftChange,
  onSend,
  welcomeMessage,
}: ComposeConversationProps) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendDraft() {
    if (draft.trim().length === 0 || sending) return;
    const body = draft.trim();
    setSending(true);
    setError(null);
    onDraftChange("");
    try {
      await onSend(body);
    } catch (err) {
      onDraftChange(body);
      setError(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="flex-1 space-y-3 overflow-y-auto bg-[var(--color-canvas-deep)] px-3 py-3">
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-ink-100)] bg-[var(--color-surface)] px-4 py-3.5 text-[length:var(--chat-font-body)] leading-relaxed text-[var(--color-ink-600)] shadow-[var(--shadow-sm)]">
          {welcomeMessage}
        </div>
      </div>
      {error ? (
        <div className="border-t border-[var(--color-danger-200)] bg-[var(--color-danger-50)] px-3 py-1.5 text-[length:var(--chat-font-small)] text-[var(--color-danger-700)]">
          {error}
        </div>
      ) : null}
      <ChatComposer
        draft={draft}
        onDraftChange={onDraftChange}
        onSubmit={sendDraft}
        sending={sending}
        placeholder="Type your first message"
      />
    </>
  );
}

function AssistantPausedNotice() {
  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-[var(--color-warn-200)] bg-[var(--color-warn-50)] px-3 py-2.5 text-[length:var(--chat-font-small)] leading-relaxed text-[var(--color-warn-900)]"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        <strong className="font-semibold">
          Your chat needs personal attention.
        </strong>{" "}
        Automated help is paused for now - you can still send messages here and
        our team will follow up as soon as we can.
      </span>
    </div>
  );
}

export function SupportHintFooter({
  assistantEnabled,
  assistantPaused = false,
}: {
  assistantEnabled: boolean;
  assistantPaused?: boolean;
}) {
  return (
    <p className="mx-auto border-t border-[var(--color-ink-100)] bg-[var(--color-canvas-deep)] px-4 py-2.5 text-center text-[length:var(--chat-font-small)] leading-relaxed text-[var(--color-ink-600)]">
      <span className="mx-auto block max-w-prose">
        {assistantPaused
          ? "Leave your message below - a teammate will read this chat and reply here."
          : assistantEnabled
            ? 'Need to speak with our team? Type "speak to someone" and we will join this chat.'
            : "A teammate will reply here as soon as possible."}
      </span>
    </p>
  );
}
