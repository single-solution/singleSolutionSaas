"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Database } from "lucide-react";

import { adminApi } from "@/lib/admin/adminApiClient";
import {
  Button,
  DataTableSkeleton,
  EmptyState,
  FilterGroup,
  NoSiteSelected,
  PageError,
  PageHeading,
  TableEmptyRow,
} from "@/components/admin/ui";

const RESOURCES = ["conversations", "visitors", "messages"] as const;
type Resource = (typeof RESOURCES)[number];

export function DataClient() {
  const siteId = useSearchParams().get("siteId") ?? "";
  const [resource, setResource] = useState<Resource>("conversations");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!siteId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await adminApi.browseData(siteId, resource, page);
      setRows(result.rows);
    } catch {
      setError("Could not load data.");
    } finally {
      setLoading(false);
    }
  }, [siteId, resource, page]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!siteId) {
    return <NoSiteSelected />;
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const skeletonColumnCount = Math.max(columns.length, 5);

  return (
    <div className="admin-page-stack">
      <PageHeading
        title="Raw data"
        subtitle="Read-only browser for stored records."
      />
      {error ? <PageError message={error} onRetry={() => void load()} /> : null}

      <FilterGroup
        label="Select resource"
        options={RESOURCES}
        value={resource}
        onChange={(value) => {
          setResource(value);
          setPage(1);
        }}
      />

      <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
        <table className="admin-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} className="whitespace-nowrap">
                  {column}
                </th>
              ))}
              {columns.length === 0 ? <th>Records</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <DataTableSkeleton columns={skeletonColumnCount} />
            ) : rows.length === 0 ? (
              <TableEmptyRow colSpan={Math.max(1, columns.length)} compact>
                <EmptyState
                  compact
                  icon={Database}
                  title="No records"
                  description="This resource has no stored rows for the selected site."
                />
              </TableEmptyRow>
            ) : (
              rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td key={column} className="max-w-xs truncate">
                      {String(row[column] ?? "")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={page <= 1}
        >
          Previous
        </Button>
        <span className="text-[13px] text-[var(--ink-muted)]">Page {page}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage((current) => current + 1)}
          disabled={rows.length === 0}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
