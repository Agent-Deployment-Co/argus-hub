import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { fmt, usd } from "../lib/format";

interface HubUser {
  userId: string;
  displayName: string;
  email: string | null;
  lastSyncMs: number;
  sessionCount: number;
  clientCount: number;
  totalTokens: number;
  cost: number;
}

async function fetchUsers(): Promise<HubUser[]> {
  const res = await fetch("/api/users");
  if (!res.ok) throw new Error(`Failed to load users (${res.status})`);
  const body = await res.json() as { users: HubUser[] };
  return body.users;
}

/** Every team member the Hub has heard from, with a link into their individual activity page. */
export function Team() {
  const query = useQuery({ queryKey: ["users"], queryFn: fetchUsers, staleTime: 30_000 });

  return (
    <>
      <div className="page-head">
        <h1>Team</h1>
      </div>
      {query.isPending ? (
        <div className="center-state">Loading…</div>
      ) : query.isError ? (
        <div className="center-state">Couldn't load data: {(query.error as Error).message}</div>
      ) : query.data.length === 0 ? (
        <p className="muted">No users yet. Run <code>argus sync</code> from a client to ingest data.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th className="num">Clients</th>
                <th className="num">Sessions</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th>Last synced</th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((u) => (
                <tr key={u.userId}>
                  <td>
                    <Link to="/users/$userId" params={{ userId: u.userId }} className="table-link">
                      {u.displayName}
                    </Link>
                  </td>
                  <td className="num">{u.clientCount}</td>
                  <td className="num">{u.sessionCount}</td>
                  <td className="num">{fmt(u.totalTokens)}</td>
                  <td className="num">{usd(u.cost)}</td>
                  <td className="nowrap">{new Date(u.lastSyncMs).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
