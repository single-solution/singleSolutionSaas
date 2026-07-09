"use client";

import type { ReactNode } from "react";

import { classNames, CHAT_SUPPORT_DISPLAY_NAME } from "./cn";
import type { ChatMessage } from "@/lib/chat/types";

const CHAT_LINK_CLASS = "font-medium text-[var(--color-accent-700)] underline underline-offset-2 hover:text-[var(--color-accent-800)]";

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g;
const BOLD_PATTERN = /\*\*([^*]+)\*\*/g;
const TABLE_ROW_PATTERN = /^\|.+\|$/;
const BULLET_LINE_PATTERN = /^\s*[-*]\s+(.+)$/;

function externalLink(href: string, label: string, key: number): ReactNode {
  return (
    <a key={`chat-link-${key}`} href={href} target="_blank" rel="noopener noreferrer" className={CHAT_LINK_CLASS}>
      {label}
    </a>
  );
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")));
}

function renderInlineSegments(text: string, keyPrefix: string): ReactNode[] {
  const segments: ReactNode[] = [];
  let tokenKey = 0;
  let cursor = 0;

  while (cursor < text.length) {
    MARKDOWN_LINK_PATTERN.lastIndex = cursor;
    BOLD_PATTERN.lastIndex = cursor;

    const linkMatch = MARKDOWN_LINK_PATTERN.exec(text);
    const boldMatch = BOLD_PATTERN.exec(text);

    const linkIndex = linkMatch?.index ?? Number.POSITIVE_INFINITY;
    const boldIndex = boldMatch?.index ?? Number.POSITIVE_INFINITY;
    const nextIndex = Math.min(linkIndex, boldIndex);

    if (nextIndex === Number.POSITIVE_INFINITY) {
      segments.push(text.slice(cursor));
      break;
    }
    if (nextIndex > cursor) {
      segments.push(text.slice(cursor, nextIndex));
    }
    if (nextIndex === linkIndex && linkMatch) {
      segments.push(externalLink(linkMatch[2]?.trim() ?? "", linkMatch[1] ?? "", tokenKey++));
      cursor = nextIndex + linkMatch[0].length;
      continue;
    }
    if (boldMatch) {
      segments.push(
        <strong key={`${keyPrefix}-bold-${tokenKey++}`} className="font-semibold text-[var(--color-ink-900)]">
          {boldMatch[1]}
        </strong>,
      );
      cursor = nextIndex + boldMatch[0].length;
    }
  }
  return segments;
}

function ChatMarkdownTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-ink-100)]">
      <table className="w-full min-w-[280px] border-collapse text-left text-[length:var(--chat-font-body)] leading-snug">
        <thead>
          <tr className="border-b border-[var(--color-ink-100)] bg-[var(--color-canvas-deep)]">
            {headers.map((header, index) => (
              <th key={`header-${index}`} className="px-2 py-1.5 font-semibold text-[var(--color-ink-700)]">
                {renderInlineSegments(header, `header-${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`} className="border-b border-[var(--color-ink-50)] last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={`cell-${rowIndex}-${cellIndex}`} className="px-2 py-1.5 align-top text-[var(--color-ink-800)]">
                  {renderInlineSegments(cell, `cell-${rowIndex}-${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderRichMessageBody(body: string): ReactNode {
  const lines = body.trim().split("\n");
  const blocks: ReactNode[] = [];
  let blockKey = 0;
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor]?.trim() ?? "";
    if (!line) {
      cursor += 1;
      continue;
    }

    if (TABLE_ROW_PATTERN.test(line)) {
      const tableLines: string[] = [];
      while (cursor < lines.length && TABLE_ROW_PATTERN.test(lines[cursor]?.trim() ?? "")) {
        tableLines.push(lines[cursor]?.trim() ?? "");
        cursor += 1;
      }
      const parsedRows = tableLines.map(parseMarkdownTableRow);
      const headerRow = parsedRows[0];
      const bodyRows = parsedRows.slice(1).filter((row) => !isTableSeparatorRow(row));
      if (headerRow?.length) {
        blocks.push(<ChatMarkdownTable key={`table-${blockKey++}`} headers={headerRow} rows={bodyRows} />);
      }
      continue;
    }

    if (BULLET_LINE_PATTERN.test(lines[cursor] ?? "")) {
      const items: string[] = [];
      while (cursor < lines.length && BULLET_LINE_PATTERN.test(lines[cursor] ?? "")) {
        const match = lines[cursor]?.match(BULLET_LINE_PATTERN);
        if (match?.[1]) {
          items.push(match[1]);
        }
        cursor += 1;
      }
      blocks.push(
        <ul key={`list-${blockKey++}`} className="list-disc space-y-1 pl-4 text-[var(--color-ink-800)]">
          {items.map((item, index) => (
            <li key={`item-${index}`}>{renderInlineSegments(item, `item-${index}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (cursor < lines.length) {
      const current = lines[cursor]?.trim() ?? "";
      if (!current || TABLE_ROW_PATTERN.test(current) || BULLET_LINE_PATTERN.test(lines[cursor] ?? "")) {
        break;
      }
      paragraphLines.push(current);
      cursor += 1;
    }
    if (paragraphLines.length > 0) {
      blocks.push(
        <p key={`para-${blockKey++}`} className="text-[var(--color-ink-800)]">
          {renderInlineSegments(paragraphLines.join("\n"), `para-${blockKey}`)}
        </p>,
      );
    }
  }

  if (blocks.length === 0) {
    return renderInlineSegments(body.trim(), "fallback");
  }
  return <div className="space-y-2">{blocks}</div>;
}

export interface ChatMessageDayGroup {
  day: string;
  messages: ChatMessage[];
}

export function formatChatDayLabel(iso: string): string {
  const messageDate = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (left: Date, right: Date) => left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
  if (sameDay(messageDate, today)) return "Today";
  if (sameDay(messageDate, yesterday)) return "Yesterday";
  return messageDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function groupChatMessagesByDay(messages: ChatMessage[]): ChatMessageDayGroup[] {
  const groups: ChatMessageDayGroup[] = [];
  let current: ChatMessageDayGroup | undefined;
  for (const message of messages) {
    const day = formatChatDayLabel(message.createdAt);
    if (!current || current.day !== day) {
      current = { day, messages: [] };
      groups.push(current);
    }
    current.messages.push(message);
  }
  return groups;
}

export function ChatMessageDayDivider({ label }: { label: string }) {
  return (
    <div className="flex justify-center py-1">
      <span className="rounded-full bg-[var(--color-surface)] px-3 py-1 text-[length:var(--chat-font-meta)] font-medium uppercase tracking-[0.18em] text-[var(--color-ink-500)] shadow-[var(--shadow-sm)]">
        {label}
      </span>
    </div>
  );
}

export function ChatTypingIndicator({ label }: { label?: string }) {
  return (
    <div className="chat-msg-in flex justify-start">
      <div className="flex items-center gap-2 rounded-[var(--radius-lg)] rounded-tl-sm border border-[var(--color-ink-100)] bg-[var(--color-surface)] px-3.5 py-3 shadow-[var(--shadow-sm)]">
        <span className="text-[length:var(--chat-font-body)] font-medium text-[var(--color-ink-500)]">{label ?? `${CHAT_SUPPORT_DISPLAY_NAME} is typing`}</span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-ink-400)] [animation-delay:-0.3s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-ink-400)] [animation-delay:-0.15s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-[var(--color-ink-400)]" />
        </span>
      </div>
    </div>
  );
}

export function ChatMessageBubble({ message }: { message: ChatMessage }) {
  const isCustomer = message.author === "customer";
  const isAssistant = message.author === "assistant";
  const teamLabel = isAssistant ? CHAT_SUPPORT_DISPLAY_NAME : message.authorName;

  return (
    <div className={classNames("chat-msg-in flex", isCustomer ? "justify-end" : "justify-start")}>
      <div
        className={classNames(
          "max-w-[78%] whitespace-pre-line rounded-[var(--radius-lg)] px-3.5 py-2.5 text-[length:var(--chat-font-body)] leading-relaxed shadow-[var(--shadow-sm)]",
          isCustomer
            ? "rounded-tr-sm border border-[var(--color-accent-300)] bg-[var(--color-accent-50)] text-[var(--color-ink-800)]"
            : "rounded-tl-sm border border-[var(--color-ink-100)] bg-[var(--color-surface)] text-[var(--color-ink-800)]",
        )}
      >
        {teamLabel && !isCustomer && (
          <p className="mb-1 text-[length:var(--chat-font-caption)] font-semibold uppercase tracking-wide text-[var(--color-ink-500)]">{teamLabel}</p>
        )}
        {message.body.trim().length > 0 && <div>{renderRichMessageBody(message.body)}</div>}
        <p className="mt-1 text-[length:var(--chat-font-meta)] text-[var(--color-ink-500)]">
          {new Date(message.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}
