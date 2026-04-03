(function () {
  'use strict';

  const DAEMON_PORT = 19825;
  const DAEMON_HOST = "localhost";
  const DAEMON_WS_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}/ext`;
  const WS_RECONNECT_DELAY = 3e3;

  async function evaluateAsync(tabId, expression) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (code) => {
        return await (0, eval)(code);
      },
      args: [expression],
      world: "MAIN"
    });
    if (!results || results.length === 0) {
      throw new Error("Script execution returned no results");
    }
    const result = results[0];
    if (result.error) {
      throw new Error(result.error.message || "Script execution failed");
    }
    return result.result;
  }

  let ws = null;
  let reconnectTimer = null;
  function connect() {
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
    try {
      ws = new WebSocket(DAEMON_WS_URL);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      console.log("[opencli] Connected to daemon");
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
    ws.onmessage = async (event) => {
      try {
        const command = JSON.parse(event.data);
        const result = await handleCommand(command);
        ws?.send(JSON.stringify(result));
      } catch (err) {
        console.error("[opencli] Message handling error:", err);
      }
    };
    ws.onclose = () => {
      console.log("[opencli] Disconnected from daemon");
      ws = null;
      scheduleReconnect();
    };
    ws.onerror = () => {
      ws?.close();
    };
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, WS_RECONNECT_DELAY);
  }
  function initialize() {
    chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
    connect();
    console.log("[opencli] Browser Bridge extension initialized");
  }
  chrome.runtime.onInstalled.addListener(() => {
    initialize();
  });
  chrome.runtime.onStartup.addListener(() => {
    initialize();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") connect();
  });
  async function handleCommand(cmd) {
    try {
      switch (cmd.action) {
        case "exec":
          return await handleExec(cmd);
        case "navigate":
          return await handleNavigate(cmd);
        case "tabs":
          return await handleTabs(cmd);
        case "cookies":
          return await handleCookies(cmd);
        default:
          return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
      }
    } catch (err) {
      return {
        id: cmd.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
  async function resolveTabId(tabId) {
    if (tabId !== void 0) return tabId;
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id && activeTab.url && !activeTab.url.startsWith("chrome://") && !activeTab.url.startsWith("chrome-extension://")) {
      return activeTab.id;
    }
    const allTabs = await chrome.tabs.query({ currentWindow: true });
    const webTab = allTabs.find((t) => t.id && t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"));
    if (webTab?.id) {
      await chrome.tabs.update(webTab.id, { active: true });
      return webTab.id;
    }
    const newTab = await chrome.tabs.create({ url: "about:blank", active: true });
    if (!newTab.id) throw new Error("Failed to create new tab");
    return newTab.id;
  }
  async function handleExec(cmd) {
    if (!cmd.code) return { id: cmd.id, ok: false, error: "Missing code" };
    const tabId = await resolveTabId(cmd.tabId);
    const data = await evaluateAsync(tabId, cmd.code);
    return { id: cmd.id, ok: true, data };
  }
  async function handleNavigate(cmd) {
    if (!cmd.url) return { id: cmd.id, ok: false, error: "Missing url" };
    const tabId = await resolveTabId(cmd.tabId);
    await chrome.tabs.update(tabId, { url: cmd.url });
    await new Promise((resolve) => {
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 3e4);
    });
    const tab = await chrome.tabs.get(tabId);
    return { id: cmd.id, ok: true, data: { title: tab.title, url: tab.url, tabId } };
  }
  async function handleTabs(cmd) {
    switch (cmd.op) {
      case "list": {
        const tabs = await chrome.tabs.query({});
        const data = tabs.filter((t) => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://")).map((t, i) => ({
          index: i,
          tabId: t.id,
          url: t.url,
          title: t.title,
          active: t.active
        }));
        return { id: cmd.id, ok: true, data };
      }
      case "new": {
        const tab = await chrome.tabs.create({ url: cmd.url, active: true });
        return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
      }
      case "close": {
        if (cmd.index !== void 0) {
          const tabs = await chrome.tabs.query({});
          const target = tabs[cmd.index];
          if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
          await chrome.tabs.remove(target.id);
          return { id: cmd.id, ok: true, data: { closed: target.id } };
        }
        const tabId = await resolveTabId(cmd.tabId);
        await chrome.tabs.remove(tabId);
        return { id: cmd.id, ok: true, data: { closed: tabId } };
      }
      case "select": {
        if (cmd.index === void 0 && cmd.tabId === void 0)
          return { id: cmd.id, ok: false, error: "Missing index or tabId" };
        if (cmd.tabId !== void 0) {
          await chrome.tabs.update(cmd.tabId, { active: true });
          return { id: cmd.id, ok: true, data: { selected: cmd.tabId } };
        }
        const tabs = await chrome.tabs.query({});
        const target = tabs[cmd.index];
        if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
        await chrome.tabs.update(target.id, { active: true });
        return { id: cmd.id, ok: true, data: { selected: target.id } };
      }
      default:
        return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
    }
  }
  async function handleCookies(cmd) {
    const details = {};
    if (cmd.domain) details.domain = cmd.domain;
    if (cmd.url) details.url = cmd.url;
    const cookies = await chrome.cookies.getAll(details);
    const data = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expirationDate
    }));
    return { id: cmd.id, ok: true, data };
  }

})();
