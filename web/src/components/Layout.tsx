import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Activity, ListTodo, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Sun, Users, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../lib/theme";
import { useUserInfo } from "../lib/users";
import { Modal } from "./Modal";
import archMarkUrl from "../assets/arch-mark.svg";
import wordmarkOnDarkUrl from "../assets/wordmark-on-dark.svg";
import wordmarkOnLightUrl from "../assets/wordmark-on-light.svg";

// The Argus Hub arch mark — just the four colored arcs from the wordmark, with no text. Shown
// alone when the rail is collapsed; the full wordmark (arch + "ARGUS HUB") is shown expanded.
const ArchMark = () => <img className="brand-mark" src={archMarkUrl} alt="Argus Hub" />;

function Wordmark() {
  const { theme } = useTheme();
  const src = theme === "dark" ? wordmarkOnDarkUrl : wordmarkOnLightUrl;
  return <img className="brand-wordmark" src={src} alt="Argus Hub" />;
}

const RAIL_KEY = "argus-hub-rail-collapsed";

function readCollapsed(): boolean {
  try { return localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; }
}

const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/", label: "Activity", icon: Activity },
  { to: "/tasks", label: "Tasks", icon: ListTodo },
  { to: "/tools", label: "Tools", icon: Wrench },
  { to: "/users", label: "Team", icon: Users },
];

const ROUTE_TITLES: Record<string, string> = {
  "/": "Argus Hub",
  "/tasks": "Tasks · Argus Hub",
  "/tools": "Tools · Argus Hub",
  "/users": "Team · Argus Hub",
};

/** Route-aware document.title: per-route labels, plus the loaded display name for a user's
 *  activity page (read from the react-query cache rather than re-fetching here). */
function useDocumentTitle() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const params = useRouterState({ select: (s) => s.matches.at(-1)?.params as { userId?: string } | undefined });
  const userId = params?.userId;
  const userInfo = useUserInfo(userId ?? "", !!userId);
  useEffect(() => {
    if (userId) {
      document.title = `${userInfo.data?.displayName ?? userId} · Argus Hub`;
      return;
    }
    document.title = ROUTE_TITLES[pathname] ?? "Argus Hub";
  }, [pathname, userId, userInfo.data]);
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const choice = (value: "light" | "dark", Ico: LucideIcon, label: string) => (
    <button
      className="theme-choice"
      type="button"
      aria-pressed={theme === value}
      onClick={() => setTheme(value)}
      title={label}
      aria-label={label}
    >
      <Ico size={15} strokeWidth={1.75} aria-hidden />
    </button>
  );
  return (
    <div className="theme-switcher" role="group" aria-label="Color theme">
      {choice("light", Sun, "Light theme")}
      {choice("dark", Moon, "Dark theme")}
    </div>
  );
}

function LogoutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Sign out?" onClose={onClose}>
      <p className="modal-copy">You'll need to sign in again to access the Hub.</p>
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <a href="/logout" className="btn-danger">Sign out</a>
      </div>
    </Modal>
  );
}

export function Layout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useDocumentTitle();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const toggleRail = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(RAIL_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  return (
    <div className={`app-shell${collapsed ? " rail-collapsed" : ""}`}>
      <aside className="rail">
        <div className="rail-brand">
          <ArchMark />
          <Wordmark />
        </div>
        <nav className="rail-nav" aria-label="Hub sections">
          {NAV.map((item) => {
            const Ico = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className="rail-link"
                activeOptions={{ exact: item.to === "/" }}
                aria-current={
                  pathname === item.to ||
                  (item.to === "/users" && pathname.startsWith(item.to))
                    ? "page"
                    : undefined
                }
              >
                <Ico className="rail-icon" size={18} strokeWidth={1.75} aria-hidden />
                <span className="rail-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="rail-footer">
          <ThemeToggle />
          <button
            type="button"
            className="rail-icon-btn"
            title="Sign out"
            aria-label="Sign out"
            onClick={() => setConfirmingLogout(true)}
          >
            <LogOut size={16} strokeWidth={1.75} />
          </button>
          <button
            className="rail-icon-btn rail-toggle"
            type="button"
            onClick={toggleRail}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen size={18} strokeWidth={1.75} /> : <PanelLeftClose size={18} strokeWidth={1.75} />}
          </button>
        </div>
      </aside>
      <div className="content">
        <main>
          <Outlet />
        </main>
      </div>
      {confirmingLogout && <LogoutDialog onClose={() => setConfirmingLogout(false)} />}
    </div>
  );
}
