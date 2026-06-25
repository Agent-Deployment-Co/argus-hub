/** Minimal HTML pages served by the Hub. No build step — embedded strings.
 *  Palette matches the SPA's light theme (web/src/styles.css): antique-white background,
 *  porcelain surfaces, dark-coffee text, tiger-orange accent. */

const SHARED_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #f9ebdc;
    color: #341f09;
    font: 15px/1.55 Georgia, serif;
    min-height: 100vh;
    padding: 24px;
  }
  .page {
    max-width: 860px;
    margin: 0 auto;
  }
  .card {
    background: #fefaf5;
    border: 1px solid rgba(52, 31, 9, .16);
    border-top: 3px solid #ef8920;
    border-radius: 12px;
    padding: 36px 40px;
    width: 100%;
    max-width: 380px;
    margin: 0 auto;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 32px;
    padding-bottom: 16px;
    border-bottom: 1px solid rgba(52, 31, 9, .12);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .brand-mark {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
  }
  .brand-name {
    font-family: "Avenir Next", Arial, sans-serif;
    font-size: 18px;
    font-weight: 700;
    color: #1c1105;
    letter-spacing: -.3px;
    text-decoration: none;
  }
  .brand-sub {
    font-size: 11px;
    color: #6b5238;
    letter-spacing: .5px;
    text-transform: uppercase;
  }
  .nav-links { display: flex; gap: 16px; align-items: center; }
  .nav-links a {
    color: #6b5238;
    font-size: 13px;
    text-decoration: none;
  }
  .nav-links a:hover { color: #ef8920; }
  h1 {
    font-family: "Avenir Next", Arial, sans-serif;
    font-size: 22px;
    font-weight: 700;
    color: #1c1105;
    margin-bottom: 20px;
  }
  h2 {
    font-family: "Avenir Next", Arial, sans-serif;
    font-size: 16px;
    font-weight: 600;
    color: #1c1105;
    margin: 28px 0 12px;
  }
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #6b5238;
    text-transform: uppercase;
    letter-spacing: .5px;
    margin-bottom: 6px;
  }
  input[type="password"] {
    width: 100%;
    background: #f9ebdc;
    border: 1px solid rgba(52, 31, 9, .25);
    border-radius: 6px;
    color: #341f09;
    font: 15px/1 Georgia, serif;
    padding: 10px 12px;
    outline: none;
    transition: border-color .15s;
  }
  input[type="password"]:focus { border-color: #ef8920; }
  button[type="submit"] {
    width: 100%;
    margin-top: 20px;
    background: #ef8920;
    border: none;
    border-radius: 6px;
    color: #fefaf5;
    cursor: pointer;
    font: 600 14px/1 "Avenir Next", Arial, sans-serif;
    padding: 11px 16px;
    transition: opacity .15s;
  }
  button[type="submit"]:hover { opacity: .88; }
  .error {
    background: rgba(226, 48, 44, .12);
    border: 1px solid rgba(226, 48, 44, .35);
    border-radius: 6px;
    color: #b51a16;
    font-size: 13px;
    margin-bottom: 16px;
    padding: 10px 12px;
  }
  .stat-val {
    font-family: "Avenir Next", Arial, sans-serif;
    font-size: 20px;
    font-weight: 700;
    color: #ef8920;
    line-height: 1.1;
  }
  .stat-lbl {
    font-size: 11px;
    color: #6b5238;
    text-transform: uppercase;
    letter-spacing: .4px;
    margin-top: 2px;
  }
  /* org detail */
  .detail-stats {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 14px;
    margin-bottom: 28px;
  }
  .detail-stat {
    background: #fefaf5;
    border: 1px solid rgba(52, 31, 9, .14);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .detail-stat .stat-val { font-size: 24px; }
  .user-list {
    border: 1px solid rgba(52, 31, 9, .14);
    border-radius: 8px;
    overflow: hidden;
    background: #fefaf5;
  }
  .user-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(52, 31, 9, .08);
    gap: 12px;
    color: inherit;
    text-decoration: none;
    transition: background .15s;
  }
  a.user-row:hover { background: rgba(52, 31, 9, .045); }
  .user-row:last-child { border-bottom: none; }
  .user-id { font-size: 14px; color: #341f09; word-break: break-all; flex: 1; }
  .user-meta { font-size: 12px; color: #6b5238; white-space: nowrap; }
  .empty { color: #6b5238; font-size: 14px; padding: 20px 0; }
`;

const BRAND_SVG = `<svg class="brand-mark" xmlns="http://www.w3.org/2000/svg" viewBox="6 0 128 100" role="img" aria-label="Argus Hub">
  <polyline points="6,50 38,18 70,50 102,18 134,50" fill="none" stroke="#ef8920" stroke-width="14" stroke-linejoin="round" stroke-linecap="round"/>
  <polyline points="6,68 38,36 70,68 102,36 134,68" fill="none" stroke="#ef8920" stroke-width="14" stroke-linejoin="round" stroke-linecap="round" opacity=".45"/>
</svg>`;

function topbar(subtitle: string): string {
  return `<div class="topbar">
    <div class="brand">
      ${BRAND_SVG}
      <div>
        <a href="/" class="brand-name">Argus Hub</a>
        <div class="brand-sub">${subtitle}</div>
      </div>
    </div>
    <nav class="nav-links">
      <a href="/logout">Sign out</a>
    </nav>
  </div>`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export const LOGIN_PAGE = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Argus Hub — Sign in</title>
  <style>
    ${SHARED_CSS}
    body { display: grid; place-items: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand" style="margin-bottom:28px">
      ${BRAND_SVG}
      <div>
        <div class="brand-name">Argus Hub</div>
        <div class="brand-sub">Sign in</div>
      </div>
    </div>
    <h1>Enter admin password</h1>
    {{ERROR}}
    <form method="POST" action="/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus autocomplete="current-password" />
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;

export interface OrgDetail {
  orgId: string;
  name: string;
  createdAt: number;
  userCount: number;
  sessionCount: number;
  totalTokens: number;
  totalCost: number;
  users: Array<{ userId: string; displayName: string; email: string | null; lastSyncMs: number; sessionCount: number; clientCount: number; totalTokens: number; cost: number }>;
}

export function orgDetailPage(org: OrgDetail): string {
  const userRows = org.users.length === 0
    ? `<p class="empty">No users yet.</p>`
    : `<div class="user-list">${org.users.map((u) => `
    <a class="user-row" href="/users/${encodeURIComponent(u.userId)}/">
      <span class="user-id">${escHtml(u.displayName)}</span>
      <span class="user-meta">${u.clientCount.toLocaleString()} client${u.clientCount === 1 ? "" : "s"} · ${u.sessionCount.toLocaleString()} sessions · ${fmtTokens(u.totalTokens)} tokens · $${u.cost.toFixed(2)} · synced ${fmtDate(u.lastSyncMs)}</span>
    </a>`).join("")}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Argus Hub — ${escHtml(org.name)}</title>
  <style>${SHARED_CSS}</style>
</head>
<body>
  <div class="page">
    ${topbar(escHtml(org.name))}
    <h1>${escHtml(org.name)}</h1>
    <div class="detail-stats">
      <div class="detail-stat">
        <div class="stat-val">${org.userCount}</div>
        <div class="stat-lbl">Users</div>
      </div>
      <div class="detail-stat">
        <div class="stat-val">${org.sessionCount.toLocaleString()}</div>
        <div class="stat-lbl">Sessions</div>
      </div>
      <div class="detail-stat">
        <div class="stat-val">${fmtTokens(org.totalTokens)}</div>
        <div class="stat-lbl">Tokens</div>
      </div>
      <div class="detail-stat">
        <div class="stat-val">$${org.totalCost.toFixed(2)}</div>
        <div class="stat-lbl">Cost</div>
      </div>
      <div class="detail-stat">
        <div class="stat-val">${fmtDate(org.createdAt)}</div>
        <div class="stat-lbl">Created</div>
      </div>
    </div>
    <h2>Users</h2>
    ${userRows}
  </div>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
