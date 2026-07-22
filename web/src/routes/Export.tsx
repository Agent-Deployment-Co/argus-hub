import { Download } from "lucide-react";

const EXPORT_TABLES = [
  "organizations", "groups", "users", "clients", "client_fingerprint", "client_syncs",
  "resolved_sessions", "resolved_usage", "resolved_tasks", "resolved_interactions",
  "resolved_invocations", "resolved_session_labels",
];

/** Data export page: download the whole Hub dataset as a .zip of Snowflake-ready JSONL. */
export function Export() {
  // Trigger a native, streaming download via a transient anchor rather than fetching the blob:
  // the browser streams the archive straight to disk, so even a multi-GB export never has to sit
  // in the tab's memory. An empty `download` attribute makes the browser honor the server's
  // Content-Disposition filename.
  const download = () => {
    const anchor = document.createElement("a");
    anchor.href = "/api/export";
    anchor.download = "";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
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
          <button type="button" className="btn-primary export-btn" onClick={download}>
            <Download size={16} strokeWidth={1.75} aria-hidden />
            Download .zip
          </button>
        </div>
      </section>
    </>
  );
}
