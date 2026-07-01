import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Moon, Sun, type LucideIcon } from "lucide-react";
import { SnapshotProvider, useSnapshotQuery, type SnapshotFilters } from "../lib/snapshot";
import { useTheme } from "../lib/theme";
import { useScope } from "../lib/scope";
import { Activity } from "../routes/Activity";
import wordmarkOnDarkUrl from "../assets/wordmark-on-dark.svg";
import wordmarkOnLightUrl from "../assets/wordmark-on-light.svg";

interface UserInfo { userId: string; email: string; orgId: string; orgName: string }

async function fetchUserInfo(userId: string): Promise<UserInfo> {
  const res = await fetch(`/api/user/${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error(`Failed to load user (${res.status})`);
  return res.json();
}

function Wordmark() {
  const { theme } = useTheme();
  const src = theme === "dark" ? wordmarkOnDarkUrl : wordmarkOnLightUrl;
  return <img className="brand-wordmark" src={src} alt="Argus Hub" />;
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
