import { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface DataTableColumn<Row> {
  key: string;
  header: string;
  render: (row: Row) => ReactNode;
  align?: "left" | "center" | "right";
  className?: string;
}

interface DataTableProps<Row> {
  caption: string;
  columns: Array<DataTableColumn<Row>>;
  rows: Row[];
  getRowKey: (row: Row) => string;
  empty?: ReactNode;
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  empty,
}: DataTableProps<Row>) {
  if (rows.length === 0) {
    return (
      <>
        {empty ?? <p className="text-sm text-ink-muted">No records found.</p>}
      </>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-surface-subtle">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-faint",
                  column.align === "right"
                    ? "text-right"
                    : column.align === "center"
                      ? "text-center"
                      : "text-left",
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr
              key={getRowKey(row)}
              className="transition-colors hover:bg-surface-subtle/60"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    "px-3 py-2.5 text-ink-secondary",
                    column.align === "right"
                      ? "text-right"
                      : column.align === "center"
                        ? "text-center"
                        : "text-left",
                    column.className,
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
