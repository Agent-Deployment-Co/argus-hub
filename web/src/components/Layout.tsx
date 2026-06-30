import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Moon, Sun, type LucideIcon } from "lucide-react";
import { SnapshotProvider, useSnapshotQuery, type SnapshotFilters } from "../lib/snapshot";
import { useTheme } from "../lib/theme";
import { useScope } from "../lib/scope";
import { Activity } from "../routes/Activity";

interface UserInfo { userId: string; email: string; orgId: string; orgName: string }

async function fetchUserInfo(userId: string): Promise<UserInfo> {
  const res = await fetch(`/api/user/${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error(`Failed to load user (${res.status})`);
  return res.json();
}

const Wordmark = () => {
  const { theme } = useTheme();
  const textFill = theme === "dark" ? "#f3d7ba" : "#000";
  return (
    <svg className="brand-wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 146.6 18.35" overflow="visible" role="img" aria-label="Argus Hub">
      <g>
        <path fill="#e2302c" d="M0,18.09v-8.82C0,4.4,3.95.46,8.82.46s8.82,3.95,8.82,8.82v8.82h-1.68v-8.82c0-3.94-3.2-7.14-7.14-7.14S1.68,5.33,1.68,9.27v8.82H0Z"/>
        <path fill="#ef8920" d="M1.93,18.09v-8.82c0-3.8,3.08-6.88,6.88-6.88s6.88,3.08,6.88,6.88v8.82h-1.68v-8.82c0-2.87-2.33-5.21-5.21-5.21s-5.21,2.33-5.21,5.21v8.82h-1.68Z"/>
        <path fill="#5dbcdf" d="M3.86,18.09v-8.82c0-2.74,2.22-4.95,4.95-4.95s4.95,2.22,4.95,4.95v8.82h-1.68v-8.82c0-1.81-1.47-3.27-3.27-3.27s-3.27,1.47-3.27,3.27v8.82h-1.68Z"/>
        <path fill="#286992" d="M5.79,18.09v-8.82c0-1.67,1.35-3.02,3.02-3.02s3.02,1.35,3.02,3.02v8.82h-1.68v-8.82c0-.74-.6-1.34-1.34-1.34s-1.34.6-1.34,1.34v8.82h-1.68Z"/>
      </g>
      <text
        fill={textFill}
        style={{ fontFamily: "Poppins, 'Avenir Next', Arial, sans-serif", fontSize: "24.69px", fontWeight: 600, letterSpacing: "-0.08em" }}
        transform="translate(20.02 17.9)"
      >
        <tspan x="0" y="0">ARGUS HUB</tspan>
      </text>
    </svg>
  );
};

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

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function Layout() {
  const scope = useScope();
  const [filters] = useState<SnapshotFilters>(() => ({ since: daysAgo(30), until: daysAgo(0) }));
  const query = useSnapshotQuery(filters);
  const userInfo = useQuery({
    queryKey: ["user-info", scope.userId],
    queryFn: () => fetchUserInfo(scope.userId),
    staleTime: 60_000,
  });
  const snap = query.data;
  const displayName = userInfo.data?.email ?? scope.userId;

  useEffect(() => {
    document.title = `${displayName} · Argus Hub`;
  }, [displayName]);

  return (
    <div className="hub-shell">
      <header className="hub-header">
        <div className="hub-brand">
          <Wordmark />
          <div>
            <a href="/" className="hub-org-link">← {userInfo.data?.orgName ?? "Users"}</a>
            <h1 className="hub-user">{displayName}</h1>
          </div>
        </div>
        <div className="hub-header-actions">
          <span className="hub-range">{filters.since} → {filters.until}</span>
          <ThemeToggle />
        </div>
      </header>
      <main className="hub-main">
        {query.isPending ? (
          <div className="center-state">Loading…</div>
        ) : query.isError ? (
          <div className="center-state">Couldn't load data: {(query.error as Error).message}</div>
        ) : (
          <SnapshotProvider value={snap!}>
            <Activity />
          </SnapshotProvider>
        )}
      </main>
    </div>
  );
}
