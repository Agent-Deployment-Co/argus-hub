import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Activity, ListTodo, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Sun, Users, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { useTheme } from "../lib/theme";
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

export function Layout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [collapsed, setCollapsed] = useState(readCollapsed);
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
                aria-current={pathname === item.to || (item.to === "/users" && pathname.startsWith("/users")) ? "page" : undefined}
              >
                <Ico className="rail-icon" size={18} strokeWidth={1.75} aria-hidden />
                <span className="rail-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="rail-footer">
          <ThemeToggle />
          <a href="/logout" className="rail-icon-btn" title="Sign out" aria-label="Sign out">
            <LogOut size={16} strokeWidth={1.75} />
          </a>
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
    </div>
  );
}
