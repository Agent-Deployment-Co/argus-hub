import { Download } from "lucide-react";
import { useState } from "react";

const EXPORT_TABLES = [
  "organizations", "groups", "users", "clients", "client_fingerprint", "client_syncs",
  "resolved_sessions", "resolved_usage", "resolved_tasks", "resolved_interactions",
  "resolved_invocations", "resolved_session_labels",
];

/** Pull the server-supplied filename out of a Content-Disposition header, if present. */
function filenameFrom(disposition: string | null): string | null {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match ? match[1]! : null;
}

/** Data export page: download the whole Hub dataset as a .zip of Snowflake-ready JSONL. Fetches
 *  as a blob (rather than a bare anchor) so we can show progress and surface server errors. */
export function Export() {
  const [status, setStatus] = useState<"idle" | "downloading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setStatus("downloading");
    setError(null);
    try {
      const res = await fetch("/api/export");
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const name = filenameFrom(res.headers.get("Content-Disposition")) ?? "argus-hub-export.zip";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
      setStatus("error");
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Export</h1>
      </div>
      <section>
        <div className="panel">
          <h3>Download dataset</h3>
          <p className="export-copy">
            Download the full Hub dataset as a <code>.zip</code> archive. It contains one JSONL file
            per table plus a <code>manifest.json</code> and a <code>load.sql</code> for loading the
            snapshot into Snowflake — the same bundle produced by{" "}
            <code>argus-hub export snowflake</code>.
          </p>
          <p className="export-copy">
            Included tables: {EXPORT_TABLES.join(", ")}. Ingestion credentials
            (<code>api_keys</code>) are never exported.
          </p>
          <button type="button" className="btn-primary export-btn" onClick={download} disabled={status === "downloading"}>
            <Download size={16} strokeWidth={1.75} aria-hidden />
            {status === "downloading" ? "Preparing…" : "Download .zip"}
          </button>
          {status === "error" && <p className="note export-error">Couldn't export: {error}</p>}
        </div>
      </section>
    </>
  );
}
