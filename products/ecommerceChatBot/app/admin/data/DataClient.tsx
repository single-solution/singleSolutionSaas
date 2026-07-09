"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { adminApi } from "@/lib/admin/adminApiClient";
import { NoSiteSelected, PageError, PageHeading } from "@/components/admin/ui";

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

  return (
    <div className="space-y-4">
      <PageHeading title="Raw data" subtitle="Read-only browser for stored records." />
      {error ? <PageError message={error} /> : null}

      <div className="flex gap-1">
        {RESOURCES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setResource(option);
              setPage(1);
            }}
            className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
              resource === option ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-100"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <tr>
              {columns.map((column) => (
                <th key={column} className="whitespace-nowrap px-4 py-2">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td className="px-4 py-6 text-center text-slate-400" colSpan={Math.max(1, columns.length)}>
                  Loading...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-slate-400" colSpan={Math.max(1, columns.length)}>
                  No records.
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td key={column} className="max-w-xs truncate px-4 py-2.5 text-slate-600">
                      {String(row[column] ?? "")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={page <= 1}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
        >
          Previous
        </button>
        <span className="text-sm text-slate-500">Page {page}</span>
        <button
          type="button"
          onClick={() => setPage((current) => current + 1)}
          disabled={rows.length === 0}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
