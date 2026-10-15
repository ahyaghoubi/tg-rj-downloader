function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SHARED_STYLES = `
  @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap");
  :root {
    color-scheme: dark;
    --bg: #0b0f14;
    --bg-glow: radial-gradient(1200px 500px at 10% -10%, rgba(45, 212, 191, 0.12), transparent 55%),
               radial-gradient(900px 420px at 90% 0%, rgba(96, 165, 250, 0.10), transparent 50%),
               var(--bg);
    --panel: rgba(17, 24, 33, 0.88);
    --panel-solid: #111821;
    --text: #e8eef5;
    --muted: #8b9aab;
    --accent: #2dd4bf;
    --accent-hover: #5eead4;
    --accent-ink: #042f2e;
    --ok: #34d399;
    --warn: #fbbf24;
    --danger: #f87171;
    --border: rgba(148, 163, 184, 0.16);
    --border-strong: rgba(148, 163, 184, 0.28);
    --shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
    --radius: 14px;
    --radius-sm: 10px;
    --font: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: var(--font);
    background: var(--bg-glow);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
  }
  button, input, textarea, select { font: inherit; }
  button {
    border: 0;
    border-radius: 999px;
    padding: 0.55rem 0.95rem;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
    font-size: 0.84rem;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.12s ease, box-shadow 0.15s ease;
  }
  button:hover { background: var(--accent-hover); }
  button:active { transform: translateY(1px); }
  button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  button.secondary {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border-strong);
  }
  button.secondary:hover { background: rgba(255,255,255,0.04); }
  button.danger {
    background: rgba(248, 113, 113, 0.14);
    color: #fecaca;
    border: 1px solid rgba(248, 113, 113, 0.35);
  }
  button.danger:hover { background: rgba(248, 113, 113, 0.22); }
  input, textarea, select {
    background: rgba(11, 15, 20, 0.75);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.55rem 0.75rem;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  input:hover, textarea:hover, select:hover { border-color: var(--border-strong); }
  input { min-width: 140px; }
  textarea { width: 100%; min-height: 80px; resize: vertical; line-height: 1.45; }
  label { font-size: 0.78rem; color: var(--muted); font-weight: 500; letter-spacing: 0.01em; }
  .ok { color: var(--ok); }
  .bad { color: var(--danger); }
  .muted { color: var(--muted); }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .pill.ok { background: rgba(52, 211, 153, 0.12); color: var(--ok); }
  .pill.bad { background: rgba(248, 113, 113, 0.12); color: var(--danger); }
  .pill.neutral { background: rgba(148, 163, 184, 0.12); color: var(--muted); }
`;

function renderLoginPage({ error = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin sign in · RJ Downloader</title>
  <style>
    ${SHARED_STYLES}
    body { display: grid; place-items: center; padding: 1.5rem; }
    .login {
      width: min(400px, 100%);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) + 4px);
      padding: 1.75rem;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.35rem;
    }
    .brand-mark {
      width: 2.4rem;
      height: 2.4rem;
      border-radius: 12px;
      background: linear-gradient(135deg, #2dd4bf, #60a5fa);
      box-shadow: 0 8px 24px rgba(45, 212, 191, 0.25);
    }
    h1 { margin: 0; font-size: 1.2rem; font-weight: 700; letter-spacing: -0.02em; }
    .sub { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.88rem; }
    label { display: block; margin-bottom: 0.4rem; }
    input {
      width: 100%;
      margin-bottom: 1rem;
      padding: 0.7rem 0.85rem;
    }
    button { width: 100%; padding: 0.75rem; border-radius: var(--radius-sm); }
    .err {
      color: var(--danger);
      font-size: 0.85rem;
      margin: 0 0 0.85rem;
      min-height: 1.2em;
    }
  </style>
</head>
<body>
  <form class="login" method="POST" action="/admin/login">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true"></div>
      <div>
        <h1>Admin access</h1>
        <p class="sub">Radio Javan Telegram bot</p>
      </div>
    </div>
    <div class="err">${escapeHtml(error)}</div>
    <label for="password">Admin password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required placeholder="ADMIN_TOKEN" />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

function renderAdminPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin · RJ Downloader</title>
  <style>
    ${SHARED_STYLES}
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      padding: 0.95rem 1.35rem;
      border-bottom: 1px solid var(--border);
      background: rgba(11, 15, 20, 0.82);
      backdrop-filter: blur(14px);
      position: sticky;
      top: 0;
      z-index: 5;
    }
    .brand-row { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
    .brand-mark {
      width: 2rem;
      height: 2rem;
      border-radius: 10px;
      flex: 0 0 auto;
      background: linear-gradient(135deg, #2dd4bf, #60a5fa);
    }
    header h1 {
      margin: 0;
      font-size: 0.98rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    header .meta {
      color: var(--muted);
      font-size: 0.8rem;
      margin-top: 0.15rem;
      font-family: var(--mono);
    }
    header form { margin: 0; }
    main {
      display: grid;
      gap: 1rem;
      padding: 1.15rem 1.35rem 2.5rem;
      max-width: 1040px;
      margin: 0 auto;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.1rem 1.15rem 1.2rem;
      box-shadow: 0 1px 0 rgba(255,255,255,0.03) inset;
      backdrop-filter: blur(10px);
    }
    section h2 {
      margin: 0 0 0.35rem;
      font-size: 0.92rem;
      font-weight: 650;
      letter-spacing: -0.01em;
    }
    .section-desc {
      margin: 0 0 0.9rem;
      color: var(--muted);
      font-size: 0.82rem;
      line-height: 1.4;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
      margin-bottom: 0.55rem;
    }
    .row:last-child { margin-bottom: 0; }
    .field {
      display: flex;
      flex-direction: column;
      gap: 0.28rem;
    }
    .actions { gap: 0.45rem; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 0.55rem;
    }
    .stat {
      background: rgba(11, 15, 20, 0.55);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0.7rem 0.8rem;
      min-height: 64px;
    }
    .stat .k {
      display: block;
      color: var(--muted);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 0.35rem;
    }
    .stat .v {
      font-family: var(--mono);
      font-size: 0.84rem;
      word-break: break-word;
      color: var(--text);
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: rgba(11, 15, 20, 0.7);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0.85rem;
      font-family: var(--mono);
      font-size: 0.75rem;
      line-height: 1.45;
      max-height: 260px;
      overflow: auto;
      margin: 0.75rem 0 0;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: rgba(11, 15, 20, 0.35);
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th, td { padding: 0.55rem 0.7rem; text-align: left; border-bottom: 1px solid var(--border); }
    th {
      color: var(--muted);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 600;
      background: rgba(255,255,255,0.02);
      position: sticky;
      top: 0;
    }
    td.mono, th.mono { font-family: var(--mono); }
    tbody tr { cursor: pointer; transition: background 0.12s ease; }
    tbody tr:hover td { background: rgba(45, 212, 191, 0.06); }
    tbody tr.selected td { background: rgba(45, 212, 191, 0.12); }
    tbody tr:last-child td { border-bottom: 0; }
    .pager {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.55rem;
      margin-top: 0.65rem;
      color: var(--muted);
      font-size: 0.8rem;
    }
    .detail-head {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem;
      align-items: center;
      margin-bottom: 0.75rem;
    }
    .detail-head .title {
      font-weight: 650;
      font-size: 0.95rem;
    }
    .detail-head .mono { font-family: var(--mono); color: var(--muted); font-size: 0.82rem; }
    .quota-bar {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      margin: 0.35rem 0 0.85rem;
      font-family: var(--mono);
      font-size: 0.82rem;
    }
    .timeline, .simple-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.45rem;
    }
    .timeline li, .simple-list li {
      background: rgba(11, 15, 20, 0.55);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0.55rem 0.7rem;
      font-size: 0.8rem;
    }
    .timeline .when, .simple-list .when {
      display: block;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 0.72rem;
      margin-bottom: 0.2rem;
    }
    details.raw {
      margin-top: 0.75rem;
      color: var(--muted);
      font-size: 0.8rem;
    }
    details.raw summary { cursor: pointer; margin-bottom: 0.35rem; }
    .users-layout {
      display: grid;
      gap: 1rem;
    }
    @media (min-width: 960px) {
      .users-layout { grid-template-columns: 1.15fr 1fr; align-items: start; }
    }
    .links { display: flex; gap: 0.85rem; margin-left: auto; align-items: center; }
    .links a {
      color: var(--muted);
      font-size: 0.8rem;
      text-decoration: none;
      border-bottom: 1px dashed transparent;
    }
    .links a:hover { color: var(--accent-hover); border-bottom-color: var(--accent); }
    .split {
      display: grid;
      gap: 0.75rem;
    }
    @media (min-width: 860px) {
      .split-2 { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 640px) {
      header { padding: 0.85rem 1rem; }
      main { padding: 1rem; }
      input { min-width: 0; flex: 1 1 120px; }
      .links { width: 100%; margin-left: 0; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand-row">
      <div class="brand-mark" aria-hidden="true"></div>
      <div>
        <h1>RJ Downloader · Admin</h1>
        <div class="meta" id="headerStatus">Loading…</div>
      </div>
    </div>
    <form method="POST" action="/admin/logout"><button class="secondary" type="submit">Sign out</button></form>
  </header>
  <main>
    <section>
      <h2>System &amp; today</h2>
      <p class="section-desc">Live bot health, webhook state, and daily usage counters.</p>
      <div class="grid" id="systemGrid"></div>
      <pre id="statsOut" class="muted"></pre>
    </section>

    <section>
      <h2>Runtime settings</h2>
      <p class="section-desc">Stored in KV — no redeploy needed. Queue delay is a base gap; the bot speeds up after clean sends and slows only after Telegram rate limits.</p>
      <div class="row actions">
        <button type="button" class="danger" id="btnQueuePause">Pause queue</button>
        <button type="button" class="secondary" id="btnQueueResume">Resume queue</button>
      </div>
      <div class="row">
        <div class="field"><label for="cfgDelay">Base delay (s)</label><input id="cfgDelay" type="number" min="0" max="60" /></div>
        <div class="field"><label for="cfgProgress">Progress every</label><input id="cfgProgress" type="number" min="1" max="50" /></div>
        <div class="field"><label for="cfgAttempts">Max URL attempts</label><input id="cfgAttempts" type="number" min="1" max="8" /></div>
        <div class="field"><label for="cfgDailyLimit">Daily limit</label><input id="cfgDailyLimit" type="number" min="0" max="5000" /></div>
      </div>
      <div class="row actions">
        <button type="button" id="btnSaveRuntime">Save overrides</button>
        <button type="button" class="secondary" id="btnClearRuntimeNums">Clear numeric overrides</button>
      </div>
      <pre id="runtimeOut" class="muted"></pre>
    </section>

    <section>
      <h2>Users</h2>
      <p class="section-desc">Search, filter, and manage users. Select a row for quota, history, jobs, and messaging. VIP skips download quota; admins are unlimited separately.</p>
      <div class="users-layout">
        <div>
          <div class="row">
            <div class="field" style="flex:1;min-width:160px">
              <label for="userSearch">Search</label>
              <input id="userSearch" placeholder="chatId, @username, name" />
            </div>
            <div class="field">
              <label for="userFilter">Filter</label>
              <select id="userFilter">
                <option value="all">All</option>
                <option value="vip">VIP</option>
                <option value="banned">Banned</option>
                <option value="normal">Normal</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div class="field">
              <label for="userSort">Sort</label>
              <select id="userSort">
                <option value="lastSeen">Last seen</option>
                <option value="downloads">Downloads today</option>
              </select>
            </div>
          </div>
          <div class="row actions">
            <button type="button" id="btnLoadUsers">Refresh</button>
            <button type="button" class="secondary" id="btnPrevUsers">Prev</button>
            <button type="button" class="secondary" id="btnNextUsers">Next</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="mono">chatId</th>
                  <th>Name</th>
                  <th class="mono">Last seen</th>
                  <th class="mono">Today</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="usersBody"><tr><td colspan="5" class="muted">Load the list to see users.</td></tr></tbody>
            </table>
          </div>
          <div class="pager" id="usersPager">Showing 0</div>
        </div>
        <div>
          <div class="row">
            <div class="field" style="flex:1;min-width:140px">
              <label for="userChatId">chatId</label>
              <input id="userChatId" placeholder="224032101" class="mono" />
            </div>
            <button type="button" id="btnLoadUser">Load</button>
          </div>
          <div id="userDetailEmpty" class="muted" style="font-size:0.85rem;margin:0.5rem 0 0.85rem">Select a user or enter a chatId.</div>
          <div id="userDetail" style="display:none">
            <div class="detail-head" id="userDetailHead"></div>
            <div class="quota-bar" id="userQuota"></div>
            <div class="row actions">
              <button type="button" class="danger" id="btnBan">Ban</button>
              <button type="button" class="secondary" id="btnUnban">Unban</button>
              <button type="button" id="btnVipOn">VIP</button>
              <button type="button" class="secondary" id="btnVipOff">Normal</button>
              <button type="button" class="secondary" id="btnClearRecents">Clear recents</button>
              <button type="button" class="danger" id="btnWipeUser">Wipe</button>
            </div>
            <div class="row">
              <div class="field" style="flex:1;min-width:160px">
                <label for="userDailyLimit">Daily limit (empty = default)</label>
                <input id="userDailyLimit" type="number" min="0" placeholder="e.g. 20" />
              </div>
              <button type="button" class="secondary" id="btnSaveQuota">Save quota</button>
            </div>
            <div class="row" style="align-items:stretch">
              <div class="field" style="flex:1;width:100%">
                <label for="userNote">Admin note</label>
                <textarea id="userNote" placeholder="Optional note…"></textarea>
              </div>
            </div>
            <div class="row actions">
              <button type="button" class="secondary" id="btnSaveNote">Save note</button>
            </div>
            <div class="field" style="margin-top:0.65rem">
              <label for="msgText">Message to user</label>
              <textarea id="msgText" placeholder="Send a notice via the bot…"></textarea>
            </div>
            <div class="row actions" style="margin-top:0.55rem">
              <button type="button" id="btnMessage">Send message</button>
            </div>
            <pre id="msgOut" class="muted"></pre>
            <h2 style="margin-top:1rem">Jobs</h2>
            <div class="row actions">
              <button type="button" class="danger" id="btnCancel">Cancel active</button>
              <button type="button" class="secondary" id="btnClearPending">Clear pending</button>
              <button type="button" id="btnPromotePending">Promote pending</button>
            </div>
            <ul class="simple-list" id="userJobsList"></ul>
            <h2 style="margin-top:1rem">Activity</h2>
            <ul class="timeline" id="userActivityList"></ul>
            <h2 style="margin-top:1rem">Recents</h2>
            <ul class="simple-list" id="userRecentsList"></ul>
            <details class="raw"><summary>Raw JSON</summary><pre id="userOut" class="muted"></pre></details>
          </div>
        </div>
      </div>
    </section>

    <section>
      <h2>DLQ / errors / audit</h2>
      <p class="section-desc">Recent operational events. Export downloads a JSON file.</p>
      <div class="row actions">
        <button type="button" id="btnLoadDlq">DLQ</button>
        <button type="button" class="secondary" id="btnLoadErrors">Errors</button>
        <button type="button" class="secondary" id="btnLoadAudit">Audit</button>
        <div class="links">
          <a id="exportErrors" href="/admin/api/export?kind=errors">Export errors</a>
          <a id="exportDlq" href="/admin/api/export?kind=dlq">Export DLQ</a>
        </div>
      </div>
      <pre id="dlqOut" class="muted"></pre>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const usersState = { offset: 0, limit: 25, total: 0, selected: null };
    async function api(path, options = {}) {
      const res = await fetch(path, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText || "request failed");
      return data;
    }
    function syncChatIds(value) {
      if (!value) return;
      $("userChatId").value = value;
      usersState.selected = value;
    }
    function esc(s) {
      return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }
    function statusPills(u) {
      const flags = [];
      if (u.banned) flags.push('<span class="pill bad">banned</span>');
      if (u.vip) flags.push('<span class="pill ok">vip</span>');
      if (u.isAdmin) flags.push('<span class="pill ok">admin</span>');
      return flags.length ? flags.join(" ") : '<span class="pill neutral">ok</span>';
    }
    function renderSystem(data) {
      const c = data.config || {};
      const t = data.today || {};
      const botLabel = data.bot?.username ? "@" + data.bot.username : "(unknown)";
      $("headerStatus").innerHTML = data.ok
        ? '<span class="pill ok">ok</span> · ' + botLabel
        : '<span class="pill bad">down</span> · ' + (data.error || "");
      const rows = [
        ["Bot", botLabel],
        ["Webhook", data.webhook?.url || "(none)"],
        ["Webhook pending", String(data.webhook?.pendingUpdateCount ?? "?")],
        ["Webhook last error", data.webhook?.lastErrorMessage || "(none)"],
        ["Queue", c.artistQueue],
        ["DLQ", c.artistDlq],
        ["Base queue delay", c.queueDelaySeconds + "s"],
        ["Progress every", String(c.progressEvery)],
        ["Admin IDs", (c.adminUserIds || []).join(", ") || "(none)"],
        ["Daily download limit", String(c.defaultDailyDownloadLimit)],
        ["Queue paused", String(c.runtime?.queuePaused ?? false)],
        ["Today songs", String(t.songs || 0)],
        ["Today artists", String(t.artists || 0)],
        ["Today searches", String(t.searches || 0)],
        ["Today messages", String(t.messages || 0)],
      ];
      $("systemGrid").innerHTML = rows.map(([k,v]) =>
        '<div class="stat"><span class="k">'+k+'</span><span class="v">'+String(v)+'</span></div>'
      ).join("");
      $("statsOut").textContent = JSON.stringify({
        recentStats: data.recentStats || [],
        recentErrors: data.recentErrors || [],
        recentAudit: data.recentAudit || [],
      }, null, 2);
      const r = c.runtime || {};
      $("cfgDelay").value = r.overrides?.artistQueueDelaySeconds ?? r.artistQueueDelaySeconds ?? "";
      $("cfgProgress").value = r.overrides?.artistProgressEvery ?? r.artistProgressEvery ?? "";
      $("cfgAttempts").value = r.overrides?.maxAudioUrlAttempts ?? r.maxAudioUrlAttempts ?? "";
      $("cfgDailyLimit").value = r.overrides?.defaultDailyDownloadLimit ?? r.defaultDailyDownloadLimit ?? "";
      $("runtimeOut").textContent = JSON.stringify(r, null, 2);
    }
    function renderUsers(data) {
      const users = data.users || [];
      usersState.total = data.total || 0;
      usersState.offset = data.offset || 0;
      usersState.limit = data.limit || 25;
      const start = users.length ? usersState.offset + 1 : 0;
      const end = usersState.offset + users.length;
      $("usersPager").textContent = "Showing " + start + "–" + end + " of " + usersState.total;
      if (!users.length) {
        $("usersBody").innerHTML = '<tr><td colspan="5" class="muted">No users found.</td></tr>';
        return;
      }
      $("usersBody").innerHTML = users.map((u) => {
        const name = u.username ? "@"+u.username : (u.firstName || "—");
        const today = u.downloadsToday?.count ?? 0;
        const selected = String(u.chatId) === String(usersState.selected) ? " selected" : "";
        return '<tr class="'+selected.trim()+'" data-chat="'+esc(u.chatId)+'"><td class="mono">'+esc(u.chatId)+'</td><td>'+esc(name)+'</td><td class="mono">'+(u.lastSeenAt || "—")+'</td><td class="mono">'+today+'</td><td>'+statusPills(u)+'</td></tr>';
      }).join("");
      [...$("usersBody").querySelectorAll("tr[data-chat]")].forEach((tr) => {
        tr.onclick = () => {
          syncChatIds(tr.getAttribute("data-chat"));
          loadUserDetail().catch((e) => { $("userOut").textContent = e.message; });
        };
      });
    }
    function renderDetail(data) {
      $("userDetailEmpty").style.display = "none";
      $("userDetail").style.display = "block";
      const u = data.user || {};
      const name = u.username ? "@" + u.username : (u.firstName || "User");
      const pills = statusPills({ ...u, isAdmin: data.isAdmin });
      $("userDetailHead").innerHTML = '<span class="title">'+esc(name)+'</span><span class="mono">'+esc(data.chatId)+'</span>'+pills;
      const q = data.quota || {};
      $("userQuota").textContent = q.unlimited
        ? "Quota: unlimited · used today " + (q.used ?? 0)
        : "Quota: " + (q.used ?? 0) + " / " + (q.limit ?? "?") + " today";
      $("userNote").value = u.note || "";
      if (u.dailyDownloadLimit != null) $("userDailyLimit").value = u.dailyDownloadLimit;
      else $("userDailyLimit").value = "";
      const jobs = [];
      if (data.active) jobs.push({ when: "active", text: JSON.stringify(data.active) });
      if (data.pending) jobs.push({ when: "pending", text: JSON.stringify(data.pending) });
      if (data.cancel) jobs.push({ when: "cancel", text: JSON.stringify(data.cancel) });
      $("userJobsList").innerHTML = jobs.length
        ? jobs.map((j) => '<li><span class="when">'+esc(j.when)+'</span>'+esc(j.text)+'</li>').join("")
        : '<li class="muted">No active or pending jobs.</li>';
      const activity = data.activity || [];
      $("userActivityList").innerHTML = activity.length
        ? activity.map((e) => '<li><span class="when">'+esc(e.at || "")+' · '+esc(e.type)+'</span>'+esc(e.detail || "—")+'</li>').join("")
        : '<li class="muted">No activity yet.</li>';
      const recents = data.recents || [];
      $("userRecentsList").innerHTML = recents.length
        ? recents.map((r) => '<li><span class="when">'+esc(r.at || "")+' · '+esc(r.type)+'</span>'+esc(r.label || r.value || "—")+'</li>').join("")
        : '<li class="muted">No recents.</li>';
      $("userOut").textContent = JSON.stringify({
        user: data.user,
        quota: data.quota,
        isAdmin: data.isAdmin,
        activity: data.activity,
        recents: data.recents,
        active: data.active,
        pending: data.pending,
        cancel: data.cancel,
      }, null, 2);
    }
    async function loadOverview() {
      const data = await api("/admin/api/overview");
      renderSystem(data);
    }
    async function loadUsers() {
      const params = new URLSearchParams({
        q: $("userSearch").value.trim(),
        filter: $("userFilter").value,
        sort: $("userSort").value,
        offset: String(usersState.offset),
        limit: String(usersState.limit),
      });
      const data = await api("/admin/api/users?" + params.toString());
      renderUsers(data);
    }
    async function loadUserDetail() {
      const chatId = $("userChatId").value.trim();
      if (!chatId) throw new Error("chatId required");
      syncChatIds(chatId);
      const data = await api("/admin/api/chat?chatId=" + encodeURIComponent(chatId));
      renderDetail(data);
      return data;
    }
    $("btnLoadUsers").onclick = async () => {
      try { usersState.offset = 0; await loadUsers(); }
      catch (e) { $("usersBody").innerHTML = '<tr><td colspan="5">'+esc(e.message)+'</td></tr>'; }
    };
    $("btnPrevUsers").onclick = async () => {
      try {
        usersState.offset = Math.max(0, usersState.offset - usersState.limit);
        await loadUsers();
      } catch (e) { $("usersPager").textContent = e.message; }
    };
    $("btnNextUsers").onclick = async () => {
      try {
        if (usersState.offset + usersState.limit >= usersState.total) return;
        usersState.offset += usersState.limit;
        await loadUsers();
      } catch (e) { $("usersPager").textContent = e.message; }
    };
    let searchTimer = null;
    $("userSearch").oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        usersState.offset = 0;
        loadUsers().catch(() => {});
      }, 250);
    };
    $("userFilter").onchange = () => { usersState.offset = 0; loadUsers().catch(() => {}); };
    $("userSort").onchange = () => { usersState.offset = 0; loadUsers().catch(() => {}); };
    $("btnCancel").onclick = async () => {
      try {
        await api("/admin/api/chat/cancel", { method: "POST", body: JSON.stringify({ chatId: $("userChatId").value.trim() }) });
        await loadUserDetail();
      } catch (e) { $("userOut").textContent = e.message; }
    };
    $("btnClearPending").onclick = async () => {
      try {
        await api("/admin/api/chat/clear-pending", { method: "POST", body: JSON.stringify({ chatId: $("userChatId").value.trim() }) });
        await loadUserDetail();
      } catch (e) { $("userOut").textContent = e.message; }
    };
    $("btnPromotePending").onclick = async () => {
      try {
        await api("/admin/api/chat/promote-pending", { method: "POST", body: JSON.stringify({ chatId: $("userChatId").value.trim() }) });
        await loadUserDetail();
      } catch (e) { $("userOut").textContent = e.message; }
    };
    $("btnLoadDlq").onclick = async () => {
      try {
        const data = await api("/admin/api/dlq");
        $("dlqOut").textContent = JSON.stringify(data.events || [], null, 2);
      } catch (e) { $("dlqOut").textContent = e.message; }
    };
    $("btnLoadErrors").onclick = async () => {
      try {
        const data = await api("/admin/api/errors");
        $("dlqOut").textContent = JSON.stringify(data.events || [], null, 2);
      } catch (e) { $("dlqOut").textContent = e.message; }
    };
    $("btnLoadAudit").onclick = async () => {
      try {
        const data = await api("/admin/api/audit");
        $("dlqOut").textContent = JSON.stringify(data.events || [], null, 2);
      } catch (e) { $("dlqOut").textContent = e.message; }
    };
    $("btnLoadUser").onclick = async () => {
      try { await loadUserDetail(); await loadUsers(); }
      catch (e) { $("userOut").textContent = e.message; $("userDetailEmpty").textContent = e.message; }
    };
    async function patchUser(extra) {
      const data = await api("/admin/api/user", {
        method: "POST",
        body: JSON.stringify({
          chatId: $("userChatId").value.trim(),
          note: $("userNote").value,
          ...extra,
        }),
      });
      await loadUserDetail();
      await loadUsers();
      return data;
    }
    $("btnBan").onclick = async () => { try { await patchUser({ banned: true }); } catch (e) { $("userOut").textContent = e.message; } };
    $("btnUnban").onclick = async () => { try { await patchUser({ banned: false }); } catch (e) { $("userOut").textContent = e.message; } };
    $("btnVipOn").onclick = async () => { try { await patchUser({ vip: true }); } catch (e) { $("userOut").textContent = e.message; } };
    $("btnVipOff").onclick = async () => { try { await patchUser({ vip: false }); } catch (e) { $("userOut").textContent = e.message; } };
    $("btnClearRecents").onclick = async () => {
      try {
        if (!confirm("Clear recent history for this user?")) return;
        await api("/admin/api/user/clear-recents", { method: "POST", body: JSON.stringify({ chatId: $("userChatId").value.trim() }) });
        await loadUserDetail();
      } catch (e) { $("userOut").textContent = e.message; }
    };
    $("btnWipeUser").onclick = async () => {
      try {
        if (!confirm("Wipe profile, recents, activity, and jobs for this chatId?")) return;
        await api("/admin/api/user/wipe", { method: "POST", body: JSON.stringify({ chatId: $("userChatId").value.trim() }) });
        $("userDetail").style.display = "none";
        $("userDetailEmpty").style.display = "block";
        $("userDetailEmpty").textContent = "User wiped.";
        await loadUsers();
      } catch (e) { $("userOut").textContent = e.message; }
    };
    async function patchRuntime(extra) {
      const data = await api("/admin/api/runtime", { method: "POST", body: JSON.stringify(extra) });
      $("runtimeOut").textContent = JSON.stringify(data.runtime || data, null, 2);
      await loadOverview();
      return data;
    }
    $("btnQueuePause").onclick = async () => { try { await patchRuntime({ queuePaused: true }); } catch (e) { $("runtimeOut").textContent = e.message; } };
    $("btnQueueResume").onclick = async () => { try { await patchRuntime({ queuePaused: false }); } catch (e) { $("runtimeOut").textContent = e.message; } };
    $("btnSaveRuntime").onclick = async () => {
      try {
        await patchRuntime({
          artistQueueDelaySeconds: $("cfgDelay").value.trim() === "" ? null : Number($("cfgDelay").value),
          artistProgressEvery: $("cfgProgress").value.trim() === "" ? null : Number($("cfgProgress").value),
          maxAudioUrlAttempts: $("cfgAttempts").value.trim() === "" ? null : Number($("cfgAttempts").value),
          defaultDailyDownloadLimit: $("cfgDailyLimit").value.trim() === "" ? null : Number($("cfgDailyLimit").value),
        });
      } catch (e) { $("runtimeOut").textContent = e.message; }
    };
    $("btnClearRuntimeNums").onclick = async () => {
      try {
        await patchRuntime({
          artistQueueDelaySeconds: null,
          artistProgressEvery: null,
          maxAudioUrlAttempts: null,
          defaultDailyDownloadLimit: null,
        });
      } catch (e) { $("runtimeOut").textContent = e.message; }
    };
    $("btnSaveQuota").onclick = async () => {
      try {
        const raw = $("userDailyLimit").value.trim();
        await patchUser({ dailyDownloadLimit: raw === "" ? null : Number(raw) });
      } catch (e) { $("userOut").textContent = e.message; }
    };
    $("btnSaveNote").onclick = async () => {
      try { await patchUser({}); } catch (e) { $("userOut").textContent = e.message; }
    };
    $("btnMessage").onclick = async () => {
      try {
        const data = await api("/admin/api/message", { method: "POST", body: JSON.stringify({ chatId: $("userChatId").value.trim(), text: $("msgText").value.trim() }) });
        $("msgOut").textContent = JSON.stringify(data, null, 2);
        await loadUserDetail();
      } catch (e) { $("msgOut").textContent = e.message; }
    };
    Promise.all([loadOverview(), loadUsers()]).catch((e) => { $("headerStatus").textContent = e.message; });
    setInterval(() => { loadOverview().catch(() => {}); }, 10000);
    document.addEventListener("keydown", (ev) => {
      if (ev.target && /^(INPUT|TEXTAREA|SELECT)$/i.test(ev.target.tagName)) return;
      if (ev.key === "r") loadOverview().catch(() => {});
    });
  </script>
</body>
</html>`;
}

export { renderLoginPage, renderAdminPage, escapeHtml };
