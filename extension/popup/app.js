/**
 * Shared UI logic for popup + full dashboard.
 * Mount with: XFCApp.mount({ mode: 'popup' | 'dashboard', pageSize?: number })
 */
(function (root) {
  const C = root.XFC;
  const scoring = root.XFCScoring;

  function mount(opts) {
    const mode = opts?.mode || "popup";
    const isDash = mode === "dashboard";

    const state = {
      offset: 0,
      limit: opts?.pageSize || (isDash ? 50 : 40),
      selected: new Set(),
      scanning: false,
      lastTotal: 0,
      xTabId: null,
      connected: false,
    };

    const $ = (id) => document.getElementById(id);
    const has = (id) => !!$(id);

    async function getXTab() {
      // Prefer remembered tab if still open on x.com
      if (state.xTabId) {
        try {
          const t = await chrome.tabs.get(state.xTabId);
          if (t && /https?:\/\/(x|twitter)\.com\//i.test(t.url || "")) {
            return t;
          }
        } catch (_) {
          state.xTabId = null;
        }
      }

      // Active tab if on X
      const active = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (
        active[0] &&
        /https?:\/\/(x|twitter)\.com\//i.test(active[0].url || "")
      ) {
        state.xTabId = active[0].id;
        return active[0];
      }

      // Any X tab
      const all = await chrome.tabs.query({
        url: ["*://x.com/*", "*://twitter.com/*"],
      });
      if (all.length) {
        // Prefer followers page
        const followers = all.find((t) => /\/followers/i.test(t.url || ""));
        const pick = followers || all[0];
        state.xTabId = pick.id;
        return pick;
      }
      return null;
    }

    async function send(tabId, message) {
      try {
        return await chrome.tabs.sendMessage(tabId, message);
      } catch {
        return null;
      }
    }

    function filtersFromUI() {
      return {
        query: has("q") ? $("q").value.trim() : "",
        category: has("category") ? $("category").value : "all",
        onlyNoPosts: has("fNoPosts") ? $("fNoPosts").checked : false,
        onlyDefaultAvatar: has("fDefaultAvatar")
          ? $("fDefaultAvatar").checked
          : false,
        onlyUnverified: has("fUnverified") ? $("fUnverified").checked : false,
        minRisk: has("minRisk") ? Number($("minRisk").value) || 0 : 0,
      };
    }

    function sortList(list, sort) {
      const arr = list.slice();
      if (sort === "risk")
        arr.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
      else if (sort === "followers")
        arr.sort((a, b) => (b.followersCount || 0) - (a.followersCount || 0));
      else if (sort === "newest")
        arr.sort(
          (a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0),
        );
      else if (sort === "oldest")
        arr.sort(
          (a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0),
        );
      else if (sort === "posts")
        arr.sort((a, b) => (a.statusesCount || 0) - (b.statusesCount || 0));
      else if (sort === "name")
        arr.sort((a, b) =>
          String(a.name || a.screenName || "").localeCompare(
            String(b.name || b.screenName || ""),
          ),
        );
      return arr;
    }

    function setStatus(kind, title, sub) {
      if (has("statusDot")) {
        $("statusDot").className = "status-dot " + (kind || "");
      }
      if (has("statusTitle")) $("statusTitle").textContent = title || "";
      if (has("statusLine")) $("statusLine").textContent = sub || title || "";
    }

    async function refresh() {
      const tab = await getXTab();
      if (!tab) {
        state.connected = false;
        setStatus(
          "err",
          "No X tab found",
          "Open x.com → Profile → Followers, then scan",
        );
        renderEmpty(
          "Open <b>x.com</b>, go to <b>Profile → Followers</b>, then click <b>Start scan</b>. You can keep this dashboard open side-by-side.",
        );
        return;
      }

      const st = await send(tab.id, { type: C.MSG.GET_STATE });
      if (!st) {
        state.connected = false;
        setStatus(
          "warn",
          "Reload the X page",
          "Content script not ready — press F5 on x.com",
        );
        // Still try storage fallback
        await refreshFromStorageOnly();
        return;
      }

      state.connected = true;
      state.scanning = !!st.scanning;
      if (has("btnScan")) {
        $("btnScan").textContent = state.scanning ? "Stop scan" : "Start scan";
        $("btnScan").classList.toggle("primary", !state.scanning);
      }

      const modeLabel = st.pageMode || "page";
      const sub =
        `${modeLabel} · ${st.count || 0} collected` +
        (st.removing ? ` · removing ${st.removeQueue || 0}` : "");
      setStatus(
        state.scanning ? "scan" : "ok",
        state.scanning ? "Scanning…" : "Connected to X",
        sub,
      );

      const sort = has("sort") ? $("sort").value : "risk";
      const res = await send(tab.id, {
        type: "XFC_GET_FOLLOWERS",
        filters: filtersFromUI(),
        sort,
        offset: state.offset,
        limit: state.limit,
      });

      if (!res) {
        await refreshFromStorageOnly();
        return;
      }

      if (res.summary) renderSummary(res.summary);
      state.lastTotal = res.total || 0;
      if (state.offset >= state.lastTotal && state.lastTotal > 0) {
        state.offset = Math.max(0, state.lastTotal - state.limit);
      }
      renderList(res.items || [], res.total || 0);
    }

    async function refreshFromStorageOnly() {
      const stored = await chrome.storage.local.get([C.STORAGE_KEY]);
      const all = stored[C.STORAGE_KEY] || [];
      if (!all.length) {
        renderEmpty(
          "No followers collected yet. Open Followers on X and press <b>Start scan</b>.",
        );
        return;
      }
      let list = scoring.filterFollowers(all, filtersFromUI());
      list = sortList(list, has("sort") ? $("sort").value : "risk");
      renderSummary(scoring.summarize(all));
      const page = list.slice(state.offset, state.offset + state.limit);
      state.lastTotal = list.length;
      renderList(page, list.length);
    }

    function renderSummary(s) {
      if (!s) return;
      if (has("sTotal")) $("sTotal").textContent = s.total;
      if (has("sCrit")) $("sCrit").textContent = s.critical;
      if (has("sHigh")) $("sHigh").textContent = s.high;
      if (has("sMed")) $("sMed").textContent = s.medium;
      if (has("sLow")) $("sLow").textContent = s.low;
      if (has("sNoPosts")) $("sNoPosts").textContent = s.noPosts;
      if (has("sDefaultAv")) $("sDefaultAv").textContent = s.defaultAvatar || 0;
      if (has("sAvg")) $("sAvg").textContent = s.avgRisk || 0;
    }

    function renderEmpty(html) {
      if (!has("list")) return;
      $("list").innerHTML = `<div class="empty">${html}</div>`;
      if (has("listCount")) $("listCount").textContent = "0 shown";
      if (has("pageInfo")) $("pageInfo").textContent = "—";
    }

    function bandClass(score) {
      const b = scoring.riskBand(score || 0);
      return b.key.toLowerCase();
    }

    function ensureScored(u) {
      if (u && Array.isArray(u.contributions) && u.contributions.length)
        return u;
      const scored = scoring.scoreFollower(u || {});
      return { ...u, ...scored };
    }

    function renderList(items, total) {
      const root = $("list");
      if (!root) return;

      if (!items.length) {
        renderEmpty(
          total === 0
            ? "No followers collected yet.<br/>Open your Followers list and press <b>Start scan</b>."
            : "No users match these filters.",
        );
        if (has("listCount")) $("listCount").textContent = `0 / ${total}`;
        updateSelectedCount();
        return;
      }

      // Keep full objects for breakdown clicks
      state.pageItems = items.map(ensureScored);

      root.innerHTML = state.pageItems
        .map((u) => {
          const checked = state.selected.has(u.id) ? "checked" : "";
          const flags = (u.flags || [])
            .slice(0, isDash ? 8 : 5)
            .map((f) => {
              const label = scoring.flagLabel ? scoring.flagLabel(f) : f;
              const detail = scoring.flagDetail ? scoring.flagDetail(f) : "";
              return `<span class="flag" title="${escapeAttr(detail || label)}">${escapeHtml(label)}</span>`;
            })
            .join("");
          const age = scoring.daysSince(u.createdAt);
          const ageLabel =
            age == null
              ? "?"
              : age < 30
                ? age + "d"
                : Math.floor(age / 30) + "mo";
          const statsCol = isDash
            ? `<div class="stats-col">
                <div>${fmt(u.followersCount)} followers</div>
                <div>${fmt(u.followingCount)} following</div>
                <div>${fmt(u.statusesCount)} posts · ${ageLabel}</div>
              </div>`
            : "";
          const statsLine = isDash
            ? ""
            : `<div class="stats-line">${fmt(u.followersCount)} followers · ${fmt(u.followingCount)} following · ${fmt(u.statusesCount)} posts · age ${ageLabel}</div>`;
          const explanation =
            isDash && u.explanation
              ? `<div class="explanation">${escapeHtml(u.explanation)}</div>`
              : "";

          return `
          <div class="user" data-id="${escapeAttr(u.id)}">
            <input type="checkbox" class="sel" data-id="${escapeAttr(u.id)}" ${checked} />
            <img src="${escapeAttr(u.profileImageUrl || "")}" alt="" loading="lazy" />
            <div class="meta">
              <div class="name">${escapeHtml(u.name || "")} ${u.isBlueVerified || u.verified ? "✓" : ""}</div>
              <div class="handle">@${escapeHtml(u.screenName || "")}</div>
              <div class="bio">${escapeHtml(u.description || "")}</div>
              ${statsLine}
              <div class="flags">${flags}</div>
              ${explanation}
            </div>
            ${statsCol}
            <div class="score ${bandClass(u.riskScore)}" data-breakdown="${escapeAttr(u.id)}" title="Click to see score breakdown">
              <div class="num">${u.riskScore ?? 0}</div>
              <div class="label">risk</div>
              ${isDash ? '<span class="hint">details</span>' : ""}
            </div>
          </div>`;
        })
        .join("");

      root.querySelectorAll(".sel").forEach((cb) => {
        cb.addEventListener("change", () => {
          const id = cb.getAttribute("data-id");
          if (cb.checked) state.selected.add(id);
          else state.selected.delete(id);
          updateSelectedCount();
        });
      });

      root.querySelectorAll("[data-breakdown]").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const id = el.getAttribute("data-breakdown");
          const u = (state.pageItems || []).find(
            (x) => String(x.id) === String(id),
          );
          if (u) showBreakdown(u);
        });
      });

      if (has("listCount")) {
        $("listCount").textContent =
          `${items.length} shown · ${total} filtered`;
      }
      const page = Math.floor(state.offset / state.limit) + 1;
      const pages = Math.max(1, Math.ceil(total / state.limit));
      if (has("pageInfo")) $("pageInfo").textContent = `${page} / ${pages}`;
      updateSelectedCount();
    }

    function openDrawer(backdropId, drawerId) {
      if (has(backdropId)) $(backdropId).hidden = false;
      if (has(drawerId)) $(drawerId).hidden = false;
    }
    function closeDrawer(backdropId, drawerId) {
      if (has(backdropId)) $(backdropId).hidden = true;
      if (has(drawerId)) $(drawerId).hidden = true;
    }

    function showBreakdown(user) {
      const u = ensureScored(user);
      if (!has("breakdownBody")) {
        // Popup fallback: simple alert with top drivers
        const lines = (u.contributions || [])
          .filter((c) => c.points !== 0)
          .slice(0, 12)
          .map(
            (c) =>
              `${c.points > 0 ? "+" : ""}${c.points}  ${c.label}${c.detail ? " — " + c.detail : ""}`,
          );
        alert(
          `@${u.screenName} · risk ${u.riskScore}/100\n\n` +
            (lines.join("\n") || "No contributions") +
            `\n\n${u.explanation || ""}`,
        );
        return;
      }

      const band = scoring.riskBand(u.riskScore || 0);
      $("breakdownTitle").textContent =
        `${u.name || u.screenName || "User"} · ${u.riskScore ?? 0}`;
      $("breakdownSub").textContent =
        `@${u.screenName || "—"} · ${band.label}${band.meaning ? " — " + band.meaning : ""}`;

      const rows = (u.contributions || [])
        .map((c) => {
          const cls = c.points > 0 ? "pos" : c.points < 0 ? "neg" : "zero";
          const sign = c.points > 0 ? "+" : "";
          return `<div class="contrib">
            <div>
              <div class="title">${escapeHtml(c.label)}</div>
              <div class="detail">${escapeHtml(c.detail || "")}</div>
            </div>
            <div class="pts ${cls}">${sign}${c.points}</div>
          </div>`;
        })
        .join("");

      $("breakdownBody").innerHTML = `
        <div class="doc-summary">${escapeHtml(u.explanation || "")}</div>
        <div class="contrib-list">${rows || '<div class="empty">No rule contributions</div>'}</div>
        <div class="total-line">
          <span>Final risk (clamped 0–100)</span>
          <span class="big pts ${u.riskScore >= 55 ? "pos" : u.riskScore >= 35 ? "zero" : "neg"}">${u.riskScore}</span>
        </div>
        <p class="drawer-sub" style="margin-top:12px">
          Quality score = 100 − risk = <b>${u.qualityScore}</b> · category <b>${escapeHtml(u.category || "")}</b>
        </p>
      `;
      openDrawer("breakdownBackdrop", "breakdownDrawer");
    }

    function renderScoreHelp() {
      if (!has("scoreHelpBody") || !scoring.getScoreDocs) return;
      const docs = scoring.getScoreDocs();
      const bands = Object.entries(docs.bands || {})
        .map(([key, b]) => {
          return `<div class="band-card" style="border-color:${b.color}55">
            <strong style="color:${b.color}">${escapeHtml(b.label)}</strong>
            <span>${b.min}–${b.max} · ${escapeHtml(b.meaning || "")}</span>
          </div>`;
        })
        .join("");

      const groups = (docs.groups || [])
        .map((g) => {
          const rules = (g.rules || [])
            .map((r) => {
              const label = scoring.flagLabel(r.flag);
              const pts = String(r.points || "");
              const cls =
                pts.includes("−") || pts.includes("-")
                  ? "neg"
                  : pts.includes("+")
                    ? "pos"
                    : "zero";
              return `<div class="rule-row">
                <div>
                  <div><b>${escapeHtml(label)}</b></div>
                  <div class="when">${escapeHtml(r.when || "")}</div>
                </div>
                <div class="pts ${cls}">${escapeHtml(pts)}</div>
              </div>`;
            })
            .join("");
          return `<section class="doc-group">
            <h3>${escapeHtml(g.group)}</h3>
            ${rules}
          </section>`;
        })
        .join("");

      $("scoreHelpBody").innerHTML = `
        <div class="doc-summary">${escapeHtml(docs.summary || "")}</div>
        <h3 style="margin:0 0 8px;font-size:13px;color:#71767b;text-transform:uppercase;letter-spacing:.05em">Risk bands</h3>
        <div class="band-grid">${bands}</div>
        ${groups}
      `;
    }

    function updateSelectedCount() {
      const n = state.selected.size;
      if (has("selectedCount"))
        $("selectedCount").textContent = `${n} selected`;
      if (has("btnRemoveSelected")) $("btnRemoveSelected").disabled = n === 0;
    }

    function fmt(n) {
      n = n || 0;
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(n);
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
    function escapeAttr(s) {
      return escapeHtml(s).replace(/'/g, "&#39;");
    }

    function toCsv(items) {
      const cols = [
        "id",
        "screenName",
        "name",
        "riskScore",
        "qualityScore",
        "category",
        "followersCount",
        "followingCount",
        "statusesCount",
        "createdAt",
        "verified",
        "flags",
        "description",
      ];
      const lines = [cols.join(",")];
      for (const u of items) {
        lines.push(
          cols
            .map((c) => {
              let v = u[c];
              if (Array.isArray(v)) v = v.join("|");
              if (v == null) v = "";
              v = String(v).replace(/"/g, '""');
              return `"${v}"`;
            })
            .join(","),
        );
      }
      return lines.join("\n");
    }

    async function loadAllForExport() {
      const tab = await getXTab();
      if (tab) {
        const res = await send(tab.id, { type: C.MSG.EXPORT });
        if (res?.items) return res.items;
      }
      const stored = await chrome.storage.local.get([C.STORAGE_KEY]);
      return stored[C.STORAGE_KEY] || [];
    }

    function on(id, event, fn) {
      if (has(id)) $(id).addEventListener(event, fn);
    }

    on("btnScan", "click", async () => {
      const tab = await getXTab();
      if (!tab) {
        alert("Open an x.com Followers tab first.");
        return;
      }
      if (state.scanning) await send(tab.id, { type: C.MSG.STOP_SCAN });
      else await send(tab.id, { type: C.MSG.START_SCAN });
      // Bring X tab to front so scroll isn't throttled
      try {
        await chrome.tabs.update(tab.id, { active: true });
      } catch (_) {}
      setTimeout(refresh, 400);
    });

    on("btnFocusX", "click", async () => {
      const tab = await getXTab();
      if (!tab) {
        alert("No X tab open.");
        return;
      }
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) {
        try {
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch (_) {}
      }
    });

    on("btnRescore", "click", async () => {
      const tab = await getXTab();
      if (tab) await send(tab.id, { type: "XFC_RESCORE" });
      refresh();
    });

    on("btnClear", "click", async () => {
      if (!confirm("Clear all collected followers from local storage?")) return;
      state.selected.clear();
      const tab = await getXTab();
      if (tab) await send(tab.id, { type: C.MSG.CLEAR });
      else await chrome.storage.local.remove([C.STORAGE_KEY]);
      refresh();
    });

    on("btnExportJson", "click", async () => {
      const items = await loadAllForExport();
      chrome.runtime.sendMessage({
        type: "XFC_DOWNLOAD",
        filename: `x-followers-${Date.now()}.json`,
        content: JSON.stringify(items, null, 2),
        mime: "application/json",
      });
    });

    on("btnExportCsv", "click", async () => {
      const items = await loadAllForExport();
      chrome.runtime.sendMessage({
        type: "XFC_DOWNLOAD",
        filename: `x-followers-${Date.now()}.csv`,
        content: toCsv(items),
        mime: "text/csv",
      });
    });

    on("btnSelectHigh", "click", async () => {
      const tab = await getXTab();
      let items = [];
      if (tab) {
        const res = await send(tab.id, {
          type: "XFC_GET_FOLLOWERS",
          filters: { ...filtersFromUI(), minRisk: 55 },
          sort: "risk",
          offset: 0,
          limit: 10000,
        });
        items = res?.items || [];
      }
      if (!items.length) {
        const all = await loadAllForExport();
        items = scoring.filterFollowers(all, {
          ...filtersFromUI(),
          minRisk: 55,
        });
      }
      for (const u of items) state.selected.add(u.id);
      updateSelectedCount();
      refresh();
    });

    on("btnSelectPage", "click", () => {
      document.querySelectorAll(".sel").forEach((cb) => {
        cb.checked = true;
        state.selected.add(cb.getAttribute("data-id"));
      });
      updateSelectedCount();
    });

    on("btnDeselect", "click", () => {
      state.selected.clear();
      document.querySelectorAll(".sel").forEach((cb) => {
        cb.checked = false;
      });
      updateSelectedCount();
    });

    on("btnRemoveSelected", "click", async () => {
      const n = state.selected.size;
      if (!n) return;
      if (
        !confirm(
          `Queue ${n} account(s) for "Remove this follower" on the open Followers page?\n\nX tab will be focused. Only users currently visible in the list may succeed.`,
        )
      ) {
        return;
      }
      const tab = await getXTab();
      if (!tab) {
        alert("Open followers page on x.com");
        return;
      }
      await chrome.tabs.update(tab.id, { active: true });
      await send(tab.id, {
        type: C.MSG.REMOVE_BATCH,
        action: "remove",
        ids: Array.from(state.selected),
      });
      state.selected.clear();
      updateSelectedCount();
      refresh();
    });

    on("btnPrev", "click", () => {
      state.offset = Math.max(0, state.offset - state.limit);
      refresh();
    });
    on("btnNext", "click", () => {
      state.offset = state.offset + state.limit;
      refresh();
    });

    on("pageSize", "change", () => {
      state.limit = Number($("pageSize").value) || 50;
      state.offset = 0;
      refresh();
    });

    on("btnOpenDashboard", "click", () => {
      chrome.runtime.sendMessage({ type: "XFC_OPEN_DASHBOARD" });
      // popup can close after open
      window.close();
    });

    [
      "q",
      "category",
      "sort",
      "fNoPosts",
      "fDefaultAvatar",
      "fUnverified",
    ].forEach((id) => {
      on(id, "change", () => {
        state.offset = 0;
        refresh();
      });
      on(id, "input", () => {
        if (id === "q") {
          clearTimeout(window.__xfcQ);
          window.__xfcQ = setTimeout(() => {
            state.offset = 0;
            refresh();
          }, 250);
        }
      });
    });

    on("minRisk", "input", () => {
      if (has("minRiskVal")) $("minRiskVal").textContent = $("minRisk").value;
    });
    on("minRisk", "change", () => {
      state.offset = 0;
      refresh();
    });

    on("btnScoreHelp", "click", () => {
      renderScoreHelp();
      openDrawer("scoreHelpBackdrop", "scoreHelpDrawer");
    });
    on("btnScoreHelpClose", "click", () =>
      closeDrawer("scoreHelpBackdrop", "scoreHelpDrawer"),
    );
    on("scoreHelpBackdrop", "click", () =>
      closeDrawer("scoreHelpBackdrop", "scoreHelpDrawer"),
    );
    on("btnBreakdownClose", "click", () =>
      closeDrawer("breakdownBackdrop", "breakdownDrawer"),
    );
    on("breakdownBackdrop", "click", () =>
      closeDrawer("breakdownBackdrop", "breakdownDrawer"),
    );

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeDrawer("scoreHelpBackdrop", "scoreHelpDrawer");
        closeDrawer("breakdownBackdrop", "breakdownDrawer");
      }
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === C.MSG.STATE) refresh();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[C.STORAGE_KEY]) refresh();
    });

    refresh();
    setInterval(refresh, isDash ? 2500 : 4000);
  }

  root.XFCApp = { mount };
})(typeof globalThis !== "undefined" ? globalThis : window);
