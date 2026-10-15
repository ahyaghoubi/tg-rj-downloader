function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLoginPage({ error = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ورود ادمین · RJ Downloader</title>
  <style>
    :root { color-scheme: dark; --bg:#0f1419; --panel:#1a222c; --text:#e7ecf1; --muted:#8b9aab; --accent:#3d8bfd; --danger:#e35d6a; --border:#2a3542; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); }
    form { width:min(360px,92vw); background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:1.5rem; }
    h1 { margin:0 0 .25rem; font-size:1.15rem; }
    p { margin:0 0 1rem; color:var(--muted); font-size:.9rem; }
    label { display:block; font-size:.85rem; margin-bottom:.35rem; color:var(--muted); }
    input { width:100%; padding:.65rem .75rem; border-radius:8px; border:1px solid var(--border); background:#0f1419; color:var(--text); margin-bottom:1rem; }
    button { width:100%; padding:.7rem; border:0; border-radius:8px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }
    .err { color:var(--danger); font-size:.85rem; margin-bottom:.75rem; min-height:1.2em; }
  </style>
</head>
<body>
  <form method="POST" action="/admin/login">
    <h1>پنل ادمین</h1>
    <p>Radio Javan Telegram Bot</p>
    <div class="err">${escapeHtml(error)}</div>
    <label for="password">رمز ادمین</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">ورود</button>
  </form>
</body>
</html>`;
}

function renderAdminPage() {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ادمین · RJ Downloader</title>
  <style>
    :root { color-scheme: dark; --bg:#0f1419; --panel:#1a222c; --text:#e7ecf1; --muted:#8b9aab; --accent:#3d8bfd; --ok:#3dd68c; --danger:#e35d6a; --border:#2a3542; --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family: ui-sans-serif, system-ui, sans-serif; }
    header { display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:1rem 1.25rem; border-bottom:1px solid var(--border); background:var(--panel); position:sticky; top:0; z-index:2; }
    header h1 { margin:0; font-size:1rem; }
    header .meta { color:var(--muted); font-size:.85rem; }
    main { display:grid; gap:1rem; padding:1rem 1.25rem 2rem; max-width:980px; margin:0 auto; }
    section { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:1rem; }
    section h2 { margin:0 0 .75rem; font-size:.95rem; }
    .row { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; margin-bottom:.5rem; }
    label { font-size:.8rem; color:var(--muted); }
    input, textarea, select { background:#0f1419; color:var(--text); border:1px solid var(--border); border-radius:8px; padding:.55rem .7rem; font: inherit; }
    input { min-width:140px; }
    textarea { width:100%; min-height:72px; resize:vertical; }
    button { border:0; border-radius:8px; padding:.55rem .85rem; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; font-size:.85rem; }
    button.secondary { background:#2a3542; }
    button.danger { background:var(--danger); }
    .grid { display:grid; gap:.35rem; font-family:var(--mono); font-size:.82rem; }
    .grid div { display:flex; gap:.5rem; justify-content:space-between; border-bottom:1px dashed var(--border); padding:.25rem 0; }
    .grid span:last-child { color:var(--muted); text-align:left; direction:ltr; }
    .ok { color:var(--ok); }
    .bad { color:var(--danger); }
    .muted { color:var(--muted); }
    pre { white-space:pre-wrap; word-break:break-word; background:#0f1419; border:1px solid var(--border); border-radius:8px; padding:.75rem; font-size:.78rem; direction:ltr; text-align:left; max-height:240px; overflow:auto; }
    table { width:100%; border-collapse:collapse; font-size:.8rem; }
    th, td { border-bottom:1px solid var(--border); padding:.4rem .35rem; text-align:right; }
    td.ltr, th.ltr { direction:ltr; text-align:left; font-family:var(--mono); }
    tr:hover td { background:#121820; cursor:pointer; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>RJ Downloader · Admin</h1>
      <div class="meta" id="headerStatus">در حال بارگذاری…</div>
    </div>
    <form method="POST" action="/admin/logout"><button class="secondary" type="submit">خروج</button></form>
  </header>
  <main>
    <section>
      <h2>سیستم و آمار امروز</h2>
      <div class="grid" id="systemGrid"></div>
      <pre id="statsOut" class="muted" style="margin-top:.75rem"></pre>
    </section>

    <section>
      <h2>تنظیمات عملیاتی (runtime)</h2>
      <p class="muted" style="margin:0 0 .75rem;font-size:.85rem">جدا از vars دپلوی — در KV ذخیره می‌شود. Allowlist ≠ VIP.</p>
      <div class="row">
        <button type="button" id="btnAllowlistOn">Allowlist روشن</button>
        <button type="button" class="secondary" id="btnAllowlistOff">Allowlist خاموش</button>
        <button type="button" class="danger" id="btnQueuePause">توقف صف</button>
        <button type="button" class="secondary" id="btnQueueResume">ادامه صف</button>
      </div>
      <div class="row">
        <label>delay (s)</label>
        <input id="cfgDelay" type="number" min="1" max="60" style="min-width:90px" />
        <label>progress every</label>
        <input id="cfgProgress" type="number" min="1" max="50" style="min-width:90px" />
        <label>max URL attempts</label>
        <input id="cfgAttempts" type="number" min="1" max="8" style="min-width:90px" />
      </div>
      <div class="row">
        <label>daily limit</label>
        <input id="cfgDailyLimit" type="number" min="0" max="5000" style="min-width:100px" />
        <label>bulk cache</label>
        <select id="cfgBulkCache"><option value="">env</option><option value="true">on</option><option value="false">off</option></select>
        <button type="button" id="btnSaveRuntime">ذخیره overrides</button>
        <button type="button" class="secondary" id="btnClearRuntimeNums">پاک‌کردن overrides عددی</button>
      </div>
      <pre id="runtimeOut" class="muted"></pre>
    </section>

    <section>
      <h2>کاربران شناخته‌شده</h2>
      <div class="row">
        <button type="button" id="btnLoadUsers">بارگذاری لیست</button>
        <button type="button" class="secondary" id="btnLoadBanned">فقط بن‌شده‌ها</button>
      </div>
      <div style="overflow:auto">
        <table>
          <thead><tr><th class="ltr">chatId</th><th>نام</th><th>آخرین بازدید</th><th>وضعیت</th><th>منبع</th></tr></thead>
          <tbody id="usersBody"><tr><td colspan="5" class="muted">لیست را بارگذاری کنید.</td></tr></tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>جاب‌های چت</h2>
      <div class="row">
        <label>chatId</label>
        <input id="jobChatId" placeholder="224032101" />
        <button type="button" id="btnLoadChat">بارگذاری</button>
        <button type="button" class="danger" id="btnCancel">لغو فعال</button>
        <button type="button" class="secondary" id="btnClearPending">پاک کردن pending</button>
        <button type="button" id="btnPromotePending">شروع pending الان</button>
      </div>
      <pre id="jobOut" class="muted">chatId را وارد کنید یا از جدول کاربران انتخاب کنید.</pre>
    </section>

    <section>
      <h2>رویدادهای DLQ / خطا / Audit</h2>
      <div class="row">
        <button type="button" id="btnLoadDlq">DLQ</button>
        <button type="button" class="secondary" id="btnLoadErrors">خطاها</button>
        <button type="button" class="secondary" id="btnLoadAudit">Audit</button>
        <a class="muted" id="exportErrors" href="/admin/api/export?kind=errors" style="margin-inline-start:auto;font-size:.85rem">Export errors</a>
        <a class="muted" id="exportDlq" href="/admin/api/export?kind=dlq" style="font-size:.85rem">Export DLQ</a>
      </div>
      <pre id="dlqOut" class="muted"></pre>
    </section>

    <section>
      <h2>کاربر / پیام / VIP / Allowlist / سهمیه</h2>
      <div class="row">
        <label>chatId</label>
        <input id="userChatId" placeholder="224032101" />
        <button type="button" id="btnLoadUser">بارگذاری</button>
        <button type="button" class="danger" id="btnBan">بن</button>
        <button type="button" class="secondary" id="btnUnban">آن‌بن</button>
        <button type="button" id="btnVipOn">VIP</button>
        <button type="button" class="secondary" id="btnVipOff">عادی</button>
        <button type="button" id="btnAllowOn">Allowlist</button>
        <button type="button" class="secondary" id="btnAllowOff">بدون Allowlist</button>
      </div>
      <div class="row">
        <button type="button" class="secondary" id="btnClearRecents">پاک کردن recents</button>
        <button type="button" class="danger" id="btnWipeUser">Wipe کاربر</button>
      </div>
      <div class="row">
        <label>سقف روزانه (خالی=پیش‌فرض)</label>
        <input id="userDailyLimit" type="number" min="0" placeholder="مثلاً 20" style="min-width:120px" />
        <button type="button" class="secondary" id="btnSaveQuota">ذخیره سهمیه</button>
      </div>
      <div class="row" style="align-items:stretch">
        <textarea id="userNote" placeholder="یادداشت ادمین…"></textarea>
      </div>
      <div class="row">
        <button type="button" class="secondary" id="btnSaveNote">ذخیره یادداشت</button>
      </div>
      <pre id="userOut" class="muted"></pre>
      <div class="row" style="margin-top:.75rem">
        <textarea id="msgText" placeholder="پیام به کاربر…"></textarea>
      </div>
      <div class="row">
        <button type="button" id="btnMessage">ارسال پیام</button>
      </div>
      <pre id="msgOut" class="muted"></pre>
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
        ? '<span class="ok">ok</span> · ' + botLabel
        : '<span class="bad">down</span> · ' + (data.error || "");
      const rows = [
        ["bot", botLabel],
        ["webhook", data.webhook?.url || "(none)"],
        ["webhook pending", String(data.webhook?.pendingUpdateCount ?? "?")],
        ["webhook last error", data.webhook?.lastErrorMessage || "(none)"],
        ["queue", c.artistQueue],
        ["dlq", c.artistDlq],
        ["bulk cache writes", String(c.bulkCacheWrites)],
        ["queue delay", c.queueDelaySeconds + "s"],
        ["progress every", String(c.progressEvery)],
        ["admin ids", (c.adminUserIds || []).join(", ") || "(none)"],
        ["daily download limit", String(c.defaultDailyDownloadLimit)],
        ["allowlist mode", String(c.runtime?.allowlistMode ?? false)],
        ["queue paused", String(c.runtime?.queuePaused ?? false)],
        ["today songs", String(t.songs || 0)],
        ["today artists", String(t.artists || 0)],
        ["today searches", String(t.searches || 0)],
        ["today messages", String(t.messages || 0)],
      ];
      $("systemGrid").innerHTML = rows.map(([k,v]) => "<div><span>"+k+"</span><span>"+String(v)+"</span></div>").join("");
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
      $("cfgBulkCache").value = r.overrides?.enableBulkCacheWrites == null ? "" : String(r.overrides.enableBulkCacheWrites);
      $("runtimeOut").textContent = JSON.stringify(r, null, 2);
    }
    function renderUsers(users) {
      if (!users.length) {
        $("usersBody").innerHTML = '<tr><td colspan="5" class="muted">کاربری پیدا نشد.</td></tr>';
        return;
      }
      $("usersBody").innerHTML = users.map((u) => {
        const name = u.username ? "@"+u.username : (u.firstName || "—");
        const flags = [];
        if (u.banned) flags.push('<span class="bad">banned</span>');
        if (u.vip) flags.push('<span class="ok">vip</span>');
        if (u.allowlisted) flags.push('<span class="ok">allow</span>');
        const status = flags.length ? flags.join(" ") : '<span class="ok">ok</span>';
        return '<tr data-chat="'+u.chatId+'"><td class="ltr">'+u.chatId+'</td><td>'+name+'</td><td class="ltr">'+(u.lastSeenAt || "—")+'</td><td>'+status+'</td><td>'+u.source+'</td></tr>';
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
        if (!confirm("پاک کردن recents این کاربر؟")) return;
        const data = await api("/admin/api/user/clear-recents", { method: "POST", body: JSON.stringify({ chatId: $("userChatId").value.trim() }) });
        $("userOut").textContent = JSON.stringify(data, null, 2);
        await loadChat();
      } catch (e) { $("userOut").textContent = e.message; }
    };
    $("btnWipeUser").onclick = async () => {
      try {
        if (!confirm("Wipe کامل پروفایل، recents و جاب‌های این chatId؟")) return;
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
        const bulk = $("cfgBulkCache").value;
        await patchRuntime({
          artistQueueDelaySeconds: $("cfgDelay").value.trim() === "" ? null : Number($("cfgDelay").value),
          artistProgressEvery: $("cfgProgress").value.trim() === "" ? null : Number($("cfgProgress").value),
          maxAudioUrlAttempts: $("cfgAttempts").value.trim() === "" ? null : Number($("cfgAttempts").value),
          defaultDailyDownloadLimit: $("cfgDailyLimit").value.trim() === "" ? null : Number($("cfgDailyLimit").value),
          enableBulkCacheWrites: bulk === "" ? null : bulk === "true",
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
          enableBulkCacheWrites: null,
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
