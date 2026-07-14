/**
 * MAIN-world interceptor: patches fetch + XHR to capture X GraphQL follower payloads
 * and authorization headers (Bearer + csrf).
 * Communicates with the isolated content script via window.postMessage.
 */
(function () {
  if (window.__XFC_INTERCEPTOR__) return;
  window.__XFC_INTERCEPTOR__ = true;

  const SOURCE = "xfc-interceptor";

  function post(type, data) {
    try {
      window.postMessage({ source: SOURCE, type, data }, "*");
    } catch (_) {}
  }

  function isFollowerUrl(url) {
    if (!url) return false;
    const u = String(url);
    return (
      u.includes("/graphql/") &&
      (u.includes("/Followers") ||
        u.includes("BlueVerifiedFollowers") ||
        u.includes("FollowersYouKnow") ||
        u.includes("/Following") ||
        u.includes("UserByScreenName") ||
        u.includes("UserByRestId"))
    );
  }

  function isListUrl(url) {
    if (!url) return false;
    const u = String(url);
    return (
      u.includes("/graphql/") &&
      (u.includes("/Followers") ||
        u.includes("BlueVerifiedFollowers") ||
        u.includes("FollowersYouKnow") ||
        u.includes("/Following"))
    );
  }

  async function handleResponse(url, response) {
    try {
      const clone = response.clone();
      const text = await clone.text();
      if (!text || text.length < 20) return;
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }
      post(isListUrl(url) ? "FOLLOWERS_PAYLOAD" : "USER_PAYLOAD", {
        url: String(url),
        json,
      });
    } catch (_) {}
  }

  function extractAuth(init) {
    try {
      const headers = init?.headers;
      if (!headers) return null;
      let auth = null;
      let csrf = null;
      if (headers instanceof Headers) {
        auth = headers.get("authorization") || headers.get("Authorization");
        csrf =
          headers.get("x-csrf-token") ||
          headers.get("X-Csrf-Token") ||
          headers.get("x-csrf-token");
      } else if (Array.isArray(headers)) {
        for (const [k, v] of headers) {
          if (k.toLowerCase() === "authorization") auth = v;
          if (k.toLowerCase() === "x-csrf-token") csrf = v;
        }
      } else if (typeof headers === "object") {
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === "authorization") auth = v;
          if (k.toLowerCase() === "x-csrf-token") csrf = v;
        }
      }
      return { auth, csrf };
    } catch (_) {
      return null;
    }
  }

  let currentBearer = "";
  let currentCsrf = "";

  function postTokenIfPresent(authData) {
    if (!authData || (!authData.auth && !authData.csrf)) return;
    if (authData.auth) {
      currentBearer = String(authData.auth).replace(/^Bearer\s+/i, "");
    }
    if (authData.csrf) {
      currentCsrf = authData.csrf;
    }
    post("XFC_TOKEN", { bearer: currentBearer, csrf: currentCsrf });
  }

  function postFollowersRequest(url, rawBody) {
    try {
      if (!rawBody || !isFollowerUrl(url)) return;
      const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
      if (!body || !body.queryId || !body.variables) return;
      const variables = body.variables;
      const userId = variables.userId || variables.user_id || variables.restId;
      post("XFC_FOLLOWERS_REQUEST", {
        url: String(url),
        queryId: body.queryId,
        variables,
        userId,
      });
    } catch (_) {}
  }

  window.addEventListener("message", (ev) => {
    try {
      const msg = ev.data;
      if (msg && msg.source === "xfc-content" && msg.type === "GET_TOKEN") {
        post("XFC_TOKEN", { bearer: currentBearer, csrf: currentCsrf });
      }
    } catch (_) {}
  });

  // --- fetch ---
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    const init = args[1] || {};
    postTokenIfPresent(extractAuth(init));
    postFollowersRequest(url, init?.body);
    const p = origFetch.apply(this, args);
    if (isFollowerUrl(url)) {
      p.then((res) => {
        if (res && res.ok) handleResponse(url, res);
      }).catch(() => {});
    }
    return p;
  };

  // --- XHR ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xfcUrl = url;
    this.__xfcHeaders = {};
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    try {
      this.__xfcHeaders = this.__xfcHeaders || {};
      this.__xfcHeaders[header.toLowerCase()] = value;
    } catch (_) {}
    return origSetHeader.call(this, header, value);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.__xfcBody = args[0];
    this.addEventListener("load", function () {
      try {
        const url = this.__xfcUrl || "";
        if (isFollowerUrl(url)) {
          if (this.status < 200 || this.status >= 300) return;
          const text = this.responseText;
          if (!text) return;
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            return;
          }
          post(isListUrl(url) ? "FOLLOWERS_PAYLOAD" : "USER_PAYLOAD", {
            url: String(url),
            json,
          });
        }
      } catch (_) {}
    });
    postTokenIfPresent({
      auth: this.__xfcHeaders?.authorization,
      csrf: this.__xfcHeaders?.["x-csrf-token"],
    });
    postFollowersRequest(this.__xfcUrl, this.__xfcBody);
    return origSend.apply(this, args);
  };

  // Capture cursor / page info for manual pagination if needed later
  post("READY", { ts: Date.now() });
})();
