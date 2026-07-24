import { Link, useParams, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ListTodo } from "lucide-react";
import { useSettingsBackHref } from "../components/Layout";

export function Settings() {
  const { category } = useParams({ from: "/settings/$category" });
  const router = useRouter();
  const backHref = useSettingsBackHref();
  const goBack = () => router.history.push(backHref);

  return (
    <div className="settings-shell">
      <aside className="settings-rail">
        <button type="button" className="settings-back" onClick={goBack}>
          <ArrowLeft size={17} aria-hidden />
          <span>Back to app</span>
        </button>
        <h1>Settings</h1>
        <nav aria-label="Settings categories">
          <Link
            to="/settings/$category"
            params={{ category: "tasks" }}
            className="settings-nav-link"
            aria-current={category === "tasks" ? "page" : undefined}
          >
            <ListTodo size={17} aria-hidden />
            <span>Tasks</span>
          </Link>
        </nav>
      </aside>
      <main className="settings-main">
        {category === "tasks" ? (
          <div className="settings-pane" data-settings-pane="tasks">
            <h2>Tasks</h2>
            <p className="settings-pane-intro">
              Configure the LLM connection for organization task features.
            </p>
          </div>
        ) : (
          <div className="settings-not-found" role="status">
            <h2>Settings category not found</h2>
            <p>There is no settings category named “{category}”.</p>
            <Link to="/settings/$category" params={{ category: "tasks" }}>Open Tasks settings</Link>
          </div>
        )}
      </main>
    </div>
  );
}
