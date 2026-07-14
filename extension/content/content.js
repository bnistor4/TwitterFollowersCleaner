/**
 * Isolated content script: UI panel, state, auto-scroll, remove/block helpers.
 */
(function () {
  if (window.__XFC_CONTENT__) return;
  window.__XFC_CONTENT__ = true;

  const scoring = globalThis.XFCScoring;
  const C = globalThis.XFC;

  /** @type {Map<string, object>} */
  const followers = new Map();
  let scanning = false;
  let scrollTimer = null;
  let panelEl = null;
  let removeQueue = [];
  let removing = false;
  let pageMode = detectPageMode();
  let xAuthToken = "";
  let xCsrfToken = "";
  let xFollowersQuery = null;
  let xFollowersCursor = null;

  function detectPageMode() {
    const path = location.pathname.toLowerCase();
    if (path.includes("/followers")) return "followers";
    if (path.includes("/following")) return "following";
    if (path.includes("/verified_followers")) return "verified_followers";
    return "other";
  }

  function onPathChange() {
    pageMode = detectPageMode();
    xFollowersQuery = null;
    xFollowersCursor = null;
    updatePanelStats();
    if (panelEl) {
      const modeLabel = panelEl.querySelector("[data-xfc-mode]");
      if (modeLabel) modeLabel.textContent = pageModeLabel();
    }
  }

  function pageModeLabel() {
    if (pageMode === "followers") return "Followers";
    if (pageMode === "following") return "Following";
    if (pageMode === "verified_followers") return "Verified followers";
    return "Navigate to /followers";
  }

  // SPA navigation
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      onPathChange();
    }
  }, 800);

  // Listen to MAIN world interceptor
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || msg.source !== "xfc-interceptor") return;
    if (msg.type === "FOLLOWERS_PAYLOAD" || msg.type === "USER_PAYLOAD") {
      ingestPayload(msg.data?.json, msg.data?.url);
    }
    if (msg.type === "XFC_TOKEN") {
      if (msg.data?.bearer) xAuthToken = msg.data.bearer;
      if (msg.data?.csrf) xCsrfToken = msg.data.csrf;
    }
    if (msg.type === "XFC_FOLLOWERS_REQUEST") {
      const data = msg.data;
      if (data?.queryId && data?.userId) {
        xFollowersQuery = {
          queryId: data.queryId,
          userId: String(data.userId),
          url: data.url,
          variables: data.variables,
        };
        xFollowersCursor = null;
      }
    }
  });

  function mergeUser(prev, next) {
    if (!prev) return next;
    const base = { ...prev };
    const stringFields = [
      "description",
      "name",
      "screenName",
      "location",
      "profileImageUrl",
    ];
    const numericFields = [
      "followersCount",
      "followingCount",
      "statusesCount",
      "favouritesCount",
      "listedCount",
      "mediaCount",
    ];
    for (const key of Object.keys(next)) {
      const v = next[key];
      if (v === undefined || v === null) continue;
      if (
        stringFields.includes(key) &&
        typeof v === "string" &&
        v.trim() === ""
      ) {
        if (base[key] && String(base[key]).trim() !== "") continue;
      }
      if (
        numericFields.includes(key) &&
        typeof v === "number" &&
        v === 0 &&
        base[key] != null &&
        base[key] !== 0
      ) {
        continue;
      }
      base[key] = v;
    }
    if (next.createdAt) base.createdAt = next.createdAt;
    // Never downgrade a graphql record (which has real counts) to a dom row.
    if (next.source === "graphql") {
      base.source = "graphql";
    } else if (base.source !== "graphql" && next.source) {
      base.source = next.source;
    }
    if (next.countsKnown || base.source === "graphql")
      base.countsKnown = true;
    if (scoring) {
      const scored = scoring.scoreFollower(base);
      base.riskScore = scored.riskScore;
      base.qualityScore = scored.qualityScore;
      base.flags = scored.flags;
      base.category = scored.category;
      base.contributions = scored.contributions;
      base.explanation = scored.explanation;
      base.followRatio = scored.followRatio;
      base.followerRatio = scored.followerRatio;
    }
    return base;
  }

  function ingestPayload(json, url) {
    if (!json || !scoring) return;
    const users = scoring.extractUsersFromGraphQL(json);
    if (!users.length) return;

    // Prefer followers list pages for merging; still accept User payloads
    const onListPage =
      pageMode === "followers" ||
      pageMode === "following" ||
      pageMode === "verified_followers";
    const isListEndpoint =
      url &&
      (url.includes("/Followers") ||
        url.includes("BlueVerifiedFollowers") ||
        url.includes("/Following") ||
        url.includes("FollowersYouKnow"));

    if (!onListPage && !isListEndpoint && msgIsOnlyProfile(users)) {
      // still merge for enrichment
    }

    let added = 0;
    for (const u of users) {
      if (!u.id) continue;
      const prev = followers.get(u.id);
      if (prev) {
        followers.set(u.id, mergeUser(prev, u));
      } else {
        followers.set(u.id, u);
        added++;
      }
    }
    if (added || users.length) {
      persist();
      updatePanelStats();
      notifyPopup();
      setBadge(followers.size);
    }
  }

  function msgIsOnlyProfile(users) {
    return users.length <= 2;
  }

  function listArray() {
    return Array.from(followers.values());
  }

  function persist() {
    try {
      const arr = listArray().slice(0, 20000);
      chrome.storage.local
        .set({
          [C.STORAGE_KEY]: arr,
          xfc_updatedAt: Date.now(),
        })
        .catch(() => {});
    } catch (_) {}
  }

  function loadFromStorage() {
    chrome.storage.local.get([C.STORAGE_KEY], (res) => {
      const arr = res[C.STORAGE_KEY] || [];
      for (const u of arr) {
        if (u && u.id) {
          // If we have real counts but the record was marked dom, allow scoring to use them.
          if (
            u.source === "dom" &&
            ((u.followersCount || 0) > 0 || (u.followingCount || 0) > 0)
          ) {
            u.countsKnown = true;
          }
          if (scoring) {
            const scored = scoring.scoreFollower(u);
            Object.assign(u, scored);
          }
          followers.set(u.id, u);
        }
      }
      updatePanelStats();
      notifyPopup();
    });
  }

  function setBadge(n) {
    try {
      chrome.runtime
        .sendMessage({ type: "XFC_BADGE", count: n })
        .catch(() => {});
    } catch (_) {}
  }

  function notifyPopup() {
    try {
      chrome.runtime
        .sendMessage({
          type: C.MSG.STATE,
          state: getState(),
        })
        .catch(() => {});
    } catch (_) {}
  }

  function getState() {
    const list = listArray();
    return {
      count: list.length,
      scanning,
      pageMode,
      summary: scoring ? scoring.summarize(list) : null,
      removing: removing,
      removeQueue: removeQueue.length,
    };
  }

  // --- DOM fallback scrape (visible UserCells) ---
  function scrapeVisibleDom() {
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    let added = 0;
    for (const cell of cells) {
      try {
        const avatar = cell.querySelector(
          '[data-testid^="UserAvatar-Container-"]',
        );
        const testid = avatar?.getAttribute("data-testid") || "";
        const handleFromAvatar = testid.replace("UserAvatar-Container-", "");
        const handleLink = cell.querySelector('a[href^="/"][role="link"]');
        let screenName = handleFromAvatar;
        const href = handleLink?.getAttribute("href") || "";
        const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
        if (m) screenName = m[1];
        if (
          !screenName ||
          /^(home|explore|search|i|settings|compose|notifications)$/i.test(
            screenName,
          )
        ) {
          continue;
        }

        const nameEl = cell.querySelector('a[role="link"] span span');
        const name = (nameEl?.textContent || screenName).trim();
        let description = "";
        cell.querySelectorAll("[dir=auto], [dir='auto']").forEach((el) => {
          const t = (el.textContent || "").trim();
          if (
            t &&
            t !== name &&
            !t.startsWith("@") &&
            t !== "Follows you" &&
            t.length > description.length
          ) {
            description = t;
          }
        });
        const img = cell.querySelector(
          'img[src*="profile_images"], img[src*="default_profile"]',
        );
        const profileImageUrl = img?.src || "";
        const followsYou = !!(
          cell.querySelector('[data-testid="userFollowIndicator"]') ||
          /follows you/i.test(cell.textContent || "")
        );
        const followBtn = cell.querySelector(
          '[data-testid$="-follow"], [data-testid$="-unfollow"]',
        );
        const btnTestId = followBtn?.getAttribute("data-testid") || "";
        const idMatch = btnTestId.match(/^(\d+)-(follow|unfollow)/);
        const id = idMatch ? idMatch[1] : screenName.toLowerCase();
        const following =
          /unfollow/i.test(btnTestId) ||
          /following/i.test(followBtn?.textContent || "");

        const base = {
          id: String(id),
          screenName,
          name,
          description,
          profileImageUrl,
          followersCount: 0,
          followingCount: 0,
          statusesCount: 0,
          favouritesCount: 0,
          listedCount: 0,
          mediaCount: 0,
          createdAt: null,
          verified: !!cell.querySelector('[data-testid="icon-verified"]'),
          isBlueVerified: !!cell.querySelector('[data-testid="icon-verified"]'),
          protected: false,
          defaultProfile: false,
          defaultProfileImage: /default_profile/i.test(profileImageUrl),
          following,
          followedBy: followsYou,
          capturedAt: Date.now(),
          source: "dom",
        };
        const scored = scoring
          ? scoring.scoreFollower(base)
          : {
              riskScore: 0,
              qualityScore: 100,
              flags: [],
              category: "ok",
            };
        const u = { ...base, ...scored };
        const prev = followers.get(u.id);
        if (prev) {
          followers.set(u.id, mergeUser(prev, u));
        } else {
          followers.set(u.id, u);
          added++;
        }
      } catch (_) {}
    }
    if (added) {
      persist();
      updatePanelStats();
      notifyPopup();
      setBadge(followers.size);
    }
  }

  // --- Auto scroll (X virtualized list needs multi-strategy) ---
  let stuckRounds = 0;
  let lastScanCount = 0;
  let scrollPass = 0;

  function isScrollable(el) {
    if (!el || el === document.body || el === document.documentElement)
      return false;
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    if (!(oy === "auto" || oy === "scroll" || oy === "overlay")) return false;
    return el.scrollHeight > el.clientHeight + 20;
  }

  function findScrollRoots() {
    const roots = [];
    const seeds = [
      document.querySelector('[data-testid="primaryColumn"]'),
      document.querySelector('[aria-label="Timeline: Followers"]'),
      document.querySelector('[aria-label^="Timeline:"]'),
      document.querySelector('section[role="region"]'),
      document.querySelector("main[role='main']"),
      document.querySelector('[data-testid="primaryColumn"] section'),
    ].filter(Boolean);

    for (const seed of seeds) {
      let el = seed;
      for (let i = 0; i < 12 && el; i++) {
        if (isScrollable(el) && !roots.includes(el)) roots.push(el);
        el = el.parentElement;
      }
    }

    // Any large scrollable in the main column
    document.querySelectorAll("div").forEach((el) => {
      if (!isScrollable(el)) return;
      if (el.clientHeight < 200) return;
      if (!roots.includes(el)) roots.push(el);
    });

    // Always include window fallbacks
    roots.push(document.scrollingElement || document.documentElement);
    if (document.body) roots.push(document.body);
    return roots;
  }

  function scrollListStep() {
    scrollPass++;
    const step = Math.max(600, Math.floor(window.innerHeight * 0.85));

    // 1) Virtual list: force last / deepest cell into view (most reliable on X)
    const cells = document.querySelectorAll(
      '[data-testid="UserCell"], [data-testid="cellInnerDiv"]',
    );
    if (cells.length) {
      const last = cells[cells.length - 1];
      try {
        last.scrollIntoView({ behavior: "instant", block: "end" });
      } catch {
        try {
          last.scrollIntoView(false);
        } catch (_) {}
      }
      // Nudge a bit further past the last item
      const absBottom =
        last.getBoundingClientRect().bottom + window.scrollY + step;
      window.scrollTo(0, absBottom);
    }

    // 2) Scroll every detected overflow container
    for (const root of findScrollRoots()) {
      try {
        if (root === document.body || root === document.documentElement) {
          root.scrollTop = root.scrollHeight;
          window.scrollBy(0, step);
          window.scrollTo(0, document.documentElement.scrollHeight);
        } else {
          root.scrollTop = Math.min(root.scrollTop + step, root.scrollHeight);
          // jump near end periodically to force timeline load
          if (scrollPass % 3 === 0) {
            root.scrollTop = root.scrollHeight;
          }
        }
      } catch (_) {}
    }

    // 3) Synthetic wheel / page-down (helps some X layouts)
    try {
      const target =
        document.querySelector('[data-testid="primaryColumn"]') ||
        document.querySelector('main[role="main"]') ||
        document.body;
      target.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: step,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "PageDown",
          code: "PageDown",
          keyCode: 34,
          which: 34,
          bubbles: true,
        }),
      );
    } catch (_) {}

    // 4) Focus timeline region so keyboard scroll works next ticks
    try {
      const region =
        document.querySelector('[aria-label^="Timeline"]') ||
        document.querySelector('[data-testid="primaryColumn"]');
      if (region && typeof region.focus === "function") {
        region.setAttribute("tabindex", "-1");
        region.focus({ preventScroll: true });
      }
    } catch (_) {}
  }

  async function startScan() {
    scanning = true;
    stuckRounds = 0;
    lastScanCount = followers.size;
    scrollPass = 0;
    xFollowersCursor = null;
    updatePanelScanBtn();
    if (scrollTimer) clearTimeout(scrollTimer);

    // Try API fetch first if we have the query captured
    if (xFollowersQuery) {
      try {
        const apiOk = await fetchFollowersApi();
        if (apiOk) {
          stopScan();
          toast(`API scan finished — ${followers.size} followers collected`);
          return;
        }
      } catch (e) {
        console.error("[XFC] API scan failed", e);
      }
    }

    // Fallback: auto-scroll
    // Delayed cadence with jitter to avoid X rate limits
    const baseDelay = C?.DEFAULT_SETTINGS?.scrollDelayMs || 1200;

    function tick() {
      if (!scanning) return;
      scrapeVisibleDom();
      scrollListStep();

      const count = followers.size;
      if (count <= lastScanCount) {
        stuckRounds++;
        // Extra aggressive burst when stuck
        if (stuckRounds % 2 === 0) {
          scrollListStep();
          window.scrollBy(0, window.innerHeight * 2);
        }
      } else {
        stuckRounds = 0;
        lastScanCount = count;
      }

      updatePanelStats();

      // Auto-stop after ~40s-50s of no new users
      if (stuckRounds >= 30) {
        stopScan();
        toast(
          "Scan paused — no new followers loaded. Scroll a bit and press Start again if needed.",
        );
        return;
      }

      const delay = baseDelay + Math.floor(Math.random() * 400);
      scrollTimer = setTimeout(tick, delay);
    }

    tick();
    toast(
      "Auto-scroll started — API unavailable, keep this Followers tab visible",
    );
  }

  function stopScan() {
    scanning = false;
    stuckRounds = 0;
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }
    updatePanelScanBtn();
    toast("Scan stopped");
  }

  // --- Remove / block (UI automation, cautious) ---
  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function triggerReactHandler(el, name = "onClick") {
    try {
      for (const key of Object.getOwnPropertyNames(el)) {
        if (
          key.startsWith("__reactEventHandlers$") ||
          key.startsWith("__reactProps$") ||
          key.startsWith("__reactFiber$")
        ) {
          const props = el[key];
          if (props && typeof props[name] === "function") {
            props[name]({
              stopPropagation: () => {},
              preventDefault: () => {},
              target: el,
              currentTarget: el,
              nativeEvent: new Event("click"),
              persist: () => {},
            });
            return true;
          }
          const handler =
            props?.pendingProps?.[name] || props?.memoizedProps?.[name];
          if (typeof handler === "function") {
            handler({
              stopPropagation: () => {},
              preventDefault: () => {},
              target: el,
              currentTarget: el,
              nativeEvent: new Event("click"),
              persist: () => {},
            });
            return true;
          }
        }
      }
    } catch (_) {}
    return false;
  }

  function clickEl(el) {
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch (_) {}
    const events = [
      ["mouseover", MouseEvent],
      ["mouseenter", MouseEvent],
      ["pointerdown", PointerEvent, { isPrimary: true, pointerType: "mouse" }],
      ["mousedown", MouseEvent],
    ];
    for (const [type, Ev, extra = {}] of events) {
      try {
        el.dispatchEvent(
          new Ev(type, { bubbles: true, cancelable: true, ...extra }),
        );
      } catch (_) {}
    }
    triggerReactHandler(el, "onClick");
    try {
      el.click();
    } catch (_) {}
    try {
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    } catch (_) {}
    try {
      el.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
      );
    } catch (_) {}
    try {
      el.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          isPrimary: true,
          pointerType: "mouse",
        }),
      );
    } catch (_) {}
    try {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
        }),
      );
    } catch (_) {}
    try {
      el.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
        }),
      );
    } catch (_) {}
  }

  function closeMenus() {
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
        }),
      );
    } catch (_) {}
    try {
      document.body.click();
    } catch (_) {}
  }

  function findConfirmButton() {
    // X confirmation buttons are usually localized. Keep English + Italian
    // fallbacks so the tool works on both locales.
    return (
      document.querySelector('[data-testid="confirmationSheetConfirm"]') ||
      document.querySelector(
        '[data-testid="confirmationSheetConfirm"][role="button"]',
      ) ||
      Array.from(document.querySelectorAll('[role="button"]')).find((b) => {
        const t = (b.textContent || "").trim();
        return /^(remove|rimuovi|yes|s[ìi])$/i.test(t);
      })
    );
  }

  function getCsrfToken() {
    if (xCsrfToken) return xCsrfToken;
    const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return match ? match[1] : "";
  }

  function requestToken() {
    try {
      window.postMessage({ source: "xfc-content", type: "GET_TOKEN" }, "*");
    } catch (_) {}
  }

  async function waitForToken(timeout = 3000) {
    if (xAuthToken && xCsrfToken) return true;
    requestToken();
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(100);
      if (xAuthToken && xCsrfToken) return true;
    }
    return false;
  }

  function extractCursor(json) {
    const cursors = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (
        node.__typename === "TimelineTimelineCursor" &&
        node.cursorType === "Bottom" &&
        node.value
      ) {
        cursors.push(node.value);
      }
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
      } else {
        for (const k of Object.keys(node)) visit(node[k]);
      }
    }
    visit(json);
    return cursors[0] || "";
  }

  async function fetchFollowersApi() {
    if (!xFollowersQuery || !xFollowersQuery.queryId) return false;
    if (!(await waitForToken())) return false;

    const csrf = getCsrfToken();
    if (!xAuthToken || !csrf) return false;

    const url =
      xFollowersQuery.url ||
      `https://x.com/i/api/graphql/${xFollowersQuery.queryId}/Followers`;
    let nextCursor = xFollowersCursor;
    let sameCountRounds = 0;
    let lastCount = followers.size;

    toast("Loading followers via API…");

    while (scanning && sameCountRounds < 8) {
      const variables = { ...xFollowersQuery.variables };
      if (nextCursor) variables.cursor = nextCursor;
      else if (variables.cursor) delete variables.cursor;

      const body = JSON.stringify({
        variables,
        queryId: xFollowersQuery.queryId,
      });

      try {
        const resp = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + xAuthToken,
            "x-csrf-token": csrf,
            "x-twitter-active-user": "yes",
            "x-twitter-auth-type": "OAuth2Session",
            "x-twitter-client-language": "en",
          },
          body,
        });
        if (!resp.ok) return false;
        const json = await resp.json();
        if (json.errors && json.errors.length) return false;

        ingestPayload(json, url);

        const cursor = extractCursor(json);
        if (!cursor || cursor === nextCursor) {
          toast("API fetch reached end of list");
          break;
        }
        nextCursor = cursor;
        xFollowersCursor = cursor;

        if (followers.size > lastCount) {
          lastCount = followers.size;
          sameCountRounds = 0;
        } else {
          sameCountRounds++;
        }

        updatePanelStats();
        notifyPopup();
        toast(`Loaded ${followers.size} followers…`);
        await sleep(1200 + Math.floor(Math.random() * 400));
      } catch (e) {
        console.error("[XFC] API fetch error", e);
        return false;
      }
    }
    return true;
  }

  async function tryRemoveViaApi(userId, screenName) {
    if (!userId || !/^\d+$/.test(String(userId))) return false;
    if (!(await waitForToken())) return false;

    const csrf = getCsrfToken();
    if (!xAuthToken || !csrf) return false;

    const url =
      "https://x.com/i/api/graphql/QpNfg0kpPRfjROQ_9eOLXA/RemoveFollower";
    const body = JSON.stringify({
      variables: { target_user_id: String(userId) },
      queryId: "QpNfg0kpPRfjROQ_9eOLXA",
    });

    try {
      const resp = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + xAuthToken,
          "x-csrf-token": csrf,
          "x-twitter-active-user": "yes",
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-client-language": "en",
        },
        body,
      });
      if (!resp.ok) return false;
      const json = await resp.json();
      if (json.errors && json.errors.length) return false;

      const lower = (screenName || "").toLowerCase();
      for (const [id, u] of followers) {
        if (
          (u.id && String(u.id) === String(userId)) ||
          (u.screenName && u.screenName.toLowerCase() === lower)
        ) {
          followers.delete(id);
          break;
        }
      }
      persist();
      updatePanelStats();
      notifyPopup();
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Try remove follower via direct API call first, then DOM fallback.
   */
  async function removeFollowerById(userId, screenName) {
    if (await tryRemoveViaApi(userId, screenName)) return true;
    return (
      (await tryRemoveViaDom(screenName)) || (await tryBlockViaDom(screenName))
    );
  }

  async function tryRemoveViaDom(screenName) {
    if (!screenName) return false;
    const lower = screenName.toLowerCase();

    // Find the user's profile link anywhere on the page (case-insensitive)
    const handleRe = new RegExp(
      "^\\/" + lower.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") + "(?:\\/|$)",
      "i",
    );
    let link = null;
    for (const a of document.querySelectorAll('a[href^="/"]')) {
      if (handleRe.test(a.getAttribute("href") || "")) {
        link = a;
        break;
      }
    }
    if (!link) return false;

    link.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(800);

    const cell = link.closest('[data-testid="UserCell"]');
    if (!cell) return false;

    // The "More" menu is usually reachable via the generic aria-haspopup
    // selector, which works across X locales.
    const moreBtn = cell.querySelector('[aria-haspopup="menu"]');
    if (!moreBtn) return false;

    clickEl(moreBtn);
    await sleep(800);

    // Prefer the exact data-testid when present
    let removeItem =
      document.querySelector('[data-testid="removeFollower"]') ||
      document.querySelector(
        '[data-testid="removeFollower"] [role="menuitem"]',
      ) ||
      null;
    if (!removeItem) {
      const items = document.querySelectorAll('[role="menuitem"]');
      // X localizes the "Remove this follower" menu entry. Include English and
      // Italian labels so the tool works on both locales.
      for (const item of items) {
        const t = (item.textContent || "").toLowerCase();
        if (
          /remove this follower|remove from followers|remove @|rimuovi questo follower|rimuovi (?:questo )?follower|rimuovi dai (?:tuoi )?follower/i.test(
            t,
          )
        ) {
          removeItem = item;
          break;
        }
      }
    }
    if (!removeItem) {
      closeMenus();
      return false;
    }

    clickEl(removeItem);

    // Wait for confirmation dialog with retry
    let confirmBtn = null;
    for (let i = 0; i < 8; i++) {
      await sleep(400);
      confirmBtn = findConfirmButton();
      if (confirmBtn) break;
    }
    if (!confirmBtn) {
      closeMenus();
      return false;
    }

    clickEl(confirmBtn);
    await sleep(1000);

    for (const [id, u] of followers) {
      if (u.screenName && u.screenName.toLowerCase() === lower) {
        followers.delete(id);
        break;
      }
    }
    persist();
    updatePanelStats();
    notifyPopup();
    return true;
  }

  async function tryBlockViaDom(screenName) {
    // Fallback: open profile more → block (user must confirm intent from popup)
    return false;
  }

  async function processRemoveQueue(action) {
    if (removing) return;
    removing = true;
    const total = removeQueue.length;
    let success = 0;
    updatePanelStats();
    notifyPopup();
    toast(`Removing ${total} follower(s)…`);
    while (removeQueue.length) {
      const item = removeQueue.shift();
      try {
        if (action === "remove" && item.screenName) {
          if (await removeFollowerById(item.id, item.screenName)) {
            success++;
          }
        }
      } catch (e) {
        console.error("[XFC] remove error", e);
      }
      updatePanelStats();
      notifyPopup();
      if (removeQueue.length) {
        await sleep(2200 + Math.random() * 800);
      }
    }
    removing = false;
    updatePanelStats();
    notifyPopup();
    toast(`Queue finished: ${success}/${total} removed`);
    persist();
  }

  // --- Panel UI ---
  function ensurePanel() {
    if (panelEl && document.body.contains(panelEl)) return panelEl;
    panelEl = document.createElement("div");
    panelEl.id = "xfc-panel";
    panelEl.innerHTML = `
      <div class="xfc-head">
        <div class="xfc-title">Followers Cleaner</div>
        <button type="button" class="xfc-icon-btn" data-xfc-collapse title="Minimize">─</button>
      </div>
      <div class="xfc-body">
        <div class="xfc-mode" data-xfc-mode>${pageModeLabel()}</div>
        <div class="xfc-stats">
          <div><span data-xfc-count>0</span><label>collected</label></div>
          <div><span data-xfc-risk>0</span><label>high risk</label></div>
          <div><span data-xfc-noposts>0</span><label>no posts</label></div>
          <div><span data-xfc-avg>0</span><label>avg risk</label></div>
        </div>
        <div class="xfc-actions">
          <button type="button" class="xfc-btn primary" data-xfc-scan>Start scan</button>
          <button type="button" class="xfc-btn" data-xfc-open>Open dashboard</button>
        </div>
        <p class="xfc-hint">Open your <b>Followers</b> page, press Start scan. Then open the <b>full dashboard</b> for filters, bulk clean, and export.</p>
      </div>
    `;
    document.documentElement.appendChild(panelEl);

    panelEl
      .querySelector("[data-xfc-collapse]")
      .addEventListener("click", () => {
        panelEl.classList.toggle("xfc-collapsed");
      });
    panelEl.querySelector("[data-xfc-scan]").addEventListener("click", () => {
      if (scanning) stopScan();
      else startScan();
    });
    panelEl.querySelector("[data-xfc-open]").addEventListener("click", () => {
      try {
        chrome.runtime
          .sendMessage({ type: "XFC_OPEN_DASHBOARD" })
          .catch(() => {});
      } catch (_) {}
      toast("Opening full dashboard…");
    });

    // drag
    const head = panelEl.querySelector(".xfc-head");
    let dragging = false,
      ox = 0,
      oy = 0;
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const r = panelEl.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panelEl.style.left = Math.max(0, e.clientX - ox) + "px";
      panelEl.style.top = Math.max(0, e.clientY - oy) + "px";
      panelEl.style.right = "auto";
      panelEl.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });

    return panelEl;
  }

  function updatePanelStats() {
    ensurePanel();
    const list = listArray();
    const sum = scoring
      ? scoring.summarize(list)
      : { total: list.length, high: 0, critical: 0, noPosts: 0, avgRisk: 0 };
    const high = (sum.high || 0) + (sum.critical || 0);
    const el = (sel) => panelEl.querySelector(sel);
    if (el("[data-xfc-count]"))
      el("[data-xfc-count]").textContent = String(sum.total || list.length);
    if (el("[data-xfc-risk]")) el("[data-xfc-risk]").textContent = String(high);
    if (el("[data-xfc-noposts]"))
      el("[data-xfc-noposts]").textContent = String(sum.noPosts || 0);
    if (el("[data-xfc-avg]"))
      el("[data-xfc-avg]").textContent = String(sum.avgRisk || 0);
    updatePanelScanBtn();
  }

  function updatePanelScanBtn() {
    if (!panelEl) return;
    const btn = panelEl.querySelector("[data-xfc-scan]");
    if (!btn) return;
    btn.textContent = scanning ? "Stop scan" : "Start scan";
    btn.classList.toggle("danger", scanning);
  }

  function toast(text) {
    let t = document.getElementById("xfc-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "xfc-toast";
      document.documentElement.appendChild(t);
    }
    t.textContent = text;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2800);
  }

  // Messages from popup / background
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === C.MSG.GET_STATE) {
      sendResponse(getState());
      return true;
    }

    if (msg.type === C.MSG.START_SCAN) {
      startScan();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === C.MSG.STOP_SCAN) {
      stopScan();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "XFC_GET_FOLLOWERS") {
      let list = listArray();
      if (msg.filters && scoring)
        list = scoring.filterFollowers(list, msg.filters);
      if (msg.sort === "risk")
        list.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
      else if (msg.sort === "followers")
        list.sort((a, b) => (b.followersCount || 0) - (a.followersCount || 0));
      else if (msg.sort === "ratio")
        list.sort((a, b) => {
          const ra =
            a.followRatio ??
            a.followingCount / Math.max(a.followersCount || 1, 1);
          const rb =
            b.followRatio ??
            b.followingCount / Math.max(b.followersCount || 1, 1);
          return rb - ra;
        });
      else if (msg.sort === "newest")
        list.sort(
          (a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0),
        );
      else if (msg.sort === "oldest")
        list.sort(
          (a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0),
        );
      else if (msg.sort === "posts")
        list.sort((a, b) => (a.statusesCount || 0) - (b.statusesCount || 0));
      const offset = msg.offset || 0;
      const limit = msg.limit || 100;
      sendResponse({
        total: list.length,
        items: list.slice(offset, offset + limit),
        summary: scoring ? scoring.summarize(listArray()) : null,
      });
      return true;
    }

    if (msg.type === C.MSG.CLEAR) {
      followers.clear();
      persist();
      updatePanelStats();
      notifyPopup();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === C.MSG.REMOVE_BATCH) {
      const ids = msg.ids || [];
      for (const id of ids) {
        const u = followers.get(String(id));
        if (u) removeQueue.push({ id: u.id, screenName: u.screenName });
      }
      processRemoveQueue(msg.action || "remove");
      sendResponse({ queued: removeQueue.length });
      return true;
    }

    if (msg.type === C.MSG.EXPORT) {
      const list = listArray();
      sendResponse({ items: list });
      return true;
    }

    if (msg.type === "XFC_RESCORE") {
      for (const [id, u] of followers) {
        // Strip previous score fields so rules re-evaluate cleanly
        const base = { ...u };
        delete base.riskScore;
        delete base.qualityScore;
        delete base.flags;
        delete base.category;
        delete base.contributions;
        delete base.explanation;
        const scored = scoring.scoreFollower(base);
        followers.set(id, { ...base, ...scored });
      }
      persist();
      updatePanelStats();
      sendResponse({ ok: true, count: followers.size });
      return true;
    }
  });

  // Boot
  function boot() {
    if (!document.body) {
      setTimeout(boot, 200);
      return;
    }
    ensurePanel();
    loadFromStorage();
    updatePanelStats();
    requestToken();
  }
  boot();
})();
