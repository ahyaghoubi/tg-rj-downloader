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
    tbody tr:last-child td { border-bottom: 0; }
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
      <p class="section-desc">Stored in KV — no redeploy needed. Queue delay is a base gap; the bot speeds up after clean sends and slows only after Telegram rate limits. Allowlist and VIP are separate flags.</p>
      <div class="row actions">
        <button type="button" id="btnAllowlistOn">Allowlist on</button>
        <button type="button" class="secondary" id="btnAllowlistOff">Allowlist off</button>
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
      <h2>Known users</h2>
      <p class="section-desc">Click a row to load that chat into jobs and user tools.</p>
      <div class="row actions">
        <button type="button" id="btnLoadUsers">Refresh list</button>
        <button type="button" class="secondary" id="btnLoadBanned">Banned only</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="mono">chatId</th>
              <th>Name</th>
              <th class="mono">Last seen</th>
              <th>Status</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody id="usersBody"><tr><td colspan="5" class="muted">Load the list to see users.</td></tr></tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Chat jobs</h2>
      <p class="section-desc">Inspect active/pending artist deliveries and intervene.</p>
      <div class="row">
        <div class="field"><label for="jobChatId">chatId</label><input id="jobChatId" placeholder="224032101" class="mono" /></div>
        <button type="button" id="btnLoadChat">Load</button>
        <button type="button" class="danger" id="btnCancel">Cancel active</button>
        <button type="button" class="secondary" id="btnClearPending">Clear pending</button>
        <button type="button" id="btnPromotePending">Promote pending now</button>
      </div>
      <pre id="jobOut" class="muted">Enter a chatId or pick a user from the table.</pre>
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

    <section>
      <h2>User · message · VIP · allowlist · quota</h2>
      <p class="section-desc">VIP skips download quota. Allowlist only matters when allowlist mode is on. Admins are unlimited separately.</p>
      <div class="row">
        <div class="field"><label for="userChatId">chatId</label><input id="userChatId" placeholder="224032101" /></div>
        <button type="button" id="btnLoadUser">Load</button>
        <button type="button" class="danger" id="btnBan">Ban</button>
        <button type="button" class="secondary" id="btnUnban">Unban</button>
        <button type="button" id="btnVipOn">VIP</button>
        <button type="button" class="secondary" id="btnVipOff">Normal</button>
        <button type="button" id="btnAllowOn">Allowlist</button>
        <button type="button" class="secondary" id="btnAllowOff">Remove allowlist</button>
      </div>
      <div class="row actions">
        <button type="button" class="secondary" id="btnClearRecents">Clear recents</button>
        <button type="button" class="danger" id="btnWipeUser">Wipe user</button>
      </div>
      <div class="row">
        <div class="field" style="flex:1;min-width:180px">
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
      <pre id="userOut" class="muted"></pre>
      <div class="split split-2" style="margin-top:0.85rem">
        <div>
          <div class="field">
            <label for="msgText">Message to user</label>
            <textarea id="msgText" placeholder="Send a notice via the bot…"></textarea>
          </div>
          <div class="row actions" style="margin-top:0.55rem">
            <button type="button" id="btnMessage">Send message</button>
          </div>
          <pre id="msgOut" class="muted"></pre>
        </div>
      </div>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
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
      $("jobChatId").value = value;
      $("userChatId").value = value;
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
        ["Allowlist mode", String(c.runtime?.allowlistMode ?? false)],
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
    function renderUsers(users) {
      if (!users.length) {
        $("usersBody").innerHTML = '<tr><td colspan="5" class="muted">No users found.</td></tr>';
        return;
      }
      $("usersBody").innerHTML = users.map((u) => {
        const name = u.username ? "@"+u.username : (u.firstName || "—");
        const flags = [];
        if (u.banned) flags.push('<span class="pill bad">banned</span>');
        if (u.vip) flags.push('<span class="pill ok">vip</span>');
        if (u.allowlisted) flags.push('<span class="pill ok">allow</span>');
        const status = flags.length ? flags.join(" ") : '<span class="pill neutral">ok</span>';
        return '<tr data-chat="'+u.chatId+'"><td class="mono">'+u.chatId+'</td><td>'+name+'</td><td class="mono">'+(u.lastSeenAt || "—")+'</td><td>'+status+'</td><td>'+u.source+'</td></tr>';
      }).join("");
      [...$("usersBody").querySelectorAll("tr[data-chat]")].forEach((tr) => {
        tr.onclick = () => {
          syncChatIds(tr.getAttribute("data-chat"));
          loadChat().catch((e) => { $("jobOut").textContent = e.message; });
        };
      });
    }
    async function loadOverview() {
      const data = await api("/admin/api/overview");
      renderSystem(data);
    }
    async function loadUsers(bannedOnly) {
      const q = bannedOnly ? "?bannedOnly=1" : "";
      const data = await api("/admin/api/users" + q);
      renderUsers(data.users || []);
    }
    async function loadChat() {
      const chatId = $("jobChatId").value.trim() || $("userChatId").value.trim();
      if (!chatId) throw new Error("chatId required");
      syncChatIds(chatId);
      const data = await api("/admin/api/chat?chatId=" + encodeURIComponent(chatId));
      $("jobOut").textContent = JSON.stringify({ active: data.active, pending: data.pending, cancel: data.cancel }, null, 2);
      $("userOut").textContent = JSON.stringify({ user: data.user, recents: data.recents }, null, 2);
      if (data.user?.note) $("userNote").value = data.user.note;
      if (data.user?.dailyDownloadLimit != null) $("userDailyLimit").value = data.user.dailyDownloadLimit;
      else $("userDailyLimit").value = "";
      return data;
    }
    $("btnLoadUsers").onclick = async () => { try { await loadUsers(false); } catch (e) { $("usersBody").innerHTML = '<tr><td colspan="5">'+e.message+'</td></tr>'; } };
    $("btnLoadBanned").onclick = async () => { try { await loadUsers(true); } catch (e) { $("usersBody").innerHTML = '<tr><td colspan="5">'+e.message+'</td></tr>'; } };
    $("btnLoadChat").onclick = async () => { try { await loadChat(); } catch (e) { $("jobOut").textContent = e.message; } };
    $("btnCancel").onclick = async () => {
      try {
        const data = await api("/admin/api/chat/cancel", { method: "POST", body: JSON.stringify({ chatId: $("jobChatId").value.trim() }) });
        $("jobOut").textContent = JSON.stringify(data, null, 2);
        await loadChat();
      } catch (e) { $("jobOut").textContent = e.message; }
    };
    $("btnClearPending").onclick = async () => {
      try {
        const data = await api("/admin/api/chat/clear-pending", { method: "POST", body: JSON.stringify({ chatId: $("jobChatId").value.trim() }) });
        $("jobOut").textContent = JSON.stringify(data, null, 2);
        await loadChat();
      } catch (e) { $("jobOut").textContent = e.message; }
    };
    $("btnPromotePending").onclick = async () => {
      try {
        const data = await api("/admin/api/chat/promote-pending", { method: "POST", body: JSON.stringify({ chatId: $("jobChatId").value.trim() }) });
        $("jobOut").textContent = JSON.stringify(data, null, 2);
        await loadChat();
      } catch (e) { $("jobOut").textContent = e.message; }
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
      try { $("jobChatId").value = $("userChatId").value.trim(); await loadChat(); }
      catch (e) { $("userOut").textContent = e.message; }
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
      $("userOut").textContent = JSON.stringify(data, null, 2);
      await loadUsers(false);
    }
    $("btnBan").onclick = async () => { try { await patchUser({ banned: true }); } catch (e) { $("userOut").textContent = e.message; } };
    $("btnUnban").onclick = async () => { try { await patchUser({ banned: false }); } catch (e) { $("userOut").textContent = e.message; } };
    $("btnVipOn").onclick = async () => { try { await patchUser({ vip: true }); } catch (e) { $("userOut").textContent = e.message; } };
    $("btnVipOff").onclick = async () => { try { await patchUser({ vip: false }); } catch (e) { $("userOut").textContent = e.message; } };
    $("btnAllowOn").onclick = async () => { try { await patchUser({ allowlisted: true }); } catch (e) { $("userOut").textContent = e.message; } };
    $("btnAllowOff").onclick = async () => { try { await patchUser({ allowlisted: false }); } catch (e) { $("userOut").textContent = e.message; } };
    $("btnClearRecents").onclick = async () => {
      try {
        if (!confirm("Clear recent history for this user?")) return;
        const data = await api("/admin/api/user/clear-recents", { method: "POST", body: JSON.stringify({ chatId: $("userChatId").value.trim() }) });
        $("userOut").textContent = JSON.stringify(data, null, 2);
        await loadChat();
      } catch (e) { $("userOut").textContent = e.message; }
    };
    $("btnWipeUser").onclick = async () => {
      try {
        if (!confirm("Wipe profile, recents, and jobs for this chatId?")) return;
        const data = await api("/admin/api/user/wipe", { method: "POST", body: JSON.stringify({ chatId: $("userChatId").value.trim() }) });
        $("userOut").textContent = JSON.stringify(data, null, 2);
        await loadUsers(false);
      } catch (e) { $("userOut").textContent = e.message; }
    };
    async function patchRuntime(extra) {
      const data = await api("/admin/api/runtime", { method: "POST", body: JSON.stringify(extra) });
      $("runtimeOut").textContent = JSON.stringify(data.runtime || data, null, 2);
      await loadOverview();
      return data;
    }
    $("btnAllowlistOn").onclick = async () => { try { await patchRuntime({ allowlistMode: true }); } catch (e) { $("runtimeOut").textContent = e.message; } };
    $("btnAllowlistOff").onclick = async () => { try { await patchRuntime({ allowlistMode: false }); } catch (e) { $("runtimeOut").textContent = e.message; } };
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
      } catch (e) { $("msgOut").textContent = e.message; }
    };
    Promise.all([loadOverview(), loadUsers(false)]).catch((e) => { $("headerStatus").textContent = e.message; });
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
