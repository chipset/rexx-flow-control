const crypto = require("node:crypto");

const MAX_WEBVIEW_PAYLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UI_ERROR_CHARS = 180;
const MAX_PERSISTED_STATE_BYTES = 64 * 1024;
const MAX_PERSISTED_NODE_POSITIONS = 1000;

function normalizePersistedNodePositions(nodePositions) {
  if (!nodePositions || typeof nodePositions !== "object" || Array.isArray(nodePositions)) {
    return undefined;
  }

  const normalized = {};
  for (const [nodeId, coords] of Object.entries(nodePositions).slice(0, MAX_PERSISTED_NODE_POSITIONS)) {
    if (
      typeof nodeId !== "string" ||
      !coords ||
      typeof coords !== "object" ||
      Array.isArray(coords)
    ) {
      continue;
    }

    const x = Math.round(Number(coords.x));
    const y = Math.round(Number(coords.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    normalized[nodeId] = { x, y };
  }

  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizePersistedGraphState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return {};
  }

  const normalized = {};
  if (typeof state.selectedCaller === "string") {
    normalized.selectedCaller = state.selectedCaller;
  }
  if (typeof state.zoomScale === "number" && Number.isFinite(state.zoomScale)) {
    normalized.zoomScale = state.zoomScale;
  }
  if (typeof state.nodeSearch === "string") {
    normalized.nodeSearch = state.nodeSearch.slice(0, 200);
  }
  if (typeof state.groupMode === "string") {
    normalized.groupMode = state.groupMode;
  }
  if (Array.isArray(state.collapsedGroupIds)) {
    normalized.collapsedGroupIds = state.collapsedGroupIds
      .filter((item) => typeof item === "string")
      .slice(0, 500);
  }
  if (state.filters && typeof state.filters === "object" && !Array.isArray(state.filters)) {
    normalized.filters = {
      call: state.filters.call !== false,
      signal: state.filters.signal !== false,
      external: state.filters.external !== false,
      tso: state.filters.tso !== false,
      dynamic: state.filters.dynamic !== false
    };
  }
  if (Array.isArray(state.navigationHistory)) {
    normalized.navigationHistory = state.navigationHistory
      .filter((item) => typeof item === "string")
      .slice(-100);
  }
  if (typeof state.navigationIndex === "number" && Number.isFinite(state.navigationIndex)) {
    normalized.navigationIndex = state.navigationIndex;
  }
  if (typeof state.focusModeEnabled === "boolean") {
    normalized.focusModeEnabled = state.focusModeEnabled;
  }
  if (state.viewMode === "graph" || state.viewMode === "detailed") {
    normalized.viewMode = state.viewMode;
  }
  const nodePositions = normalizePersistedNodePositions(state.nodePositions);
  if (nodePositions) {
    normalized.nodePositions = nodePositions;
  }
  if (Array.isArray(state.pinnedNodeIds)) {
    normalized.pinnedNodeIds = state.pinnedNodeIds
      .filter((item) => typeof item === "string")
      .slice(0, MAX_PERSISTED_NODE_POSITIONS);
  }
  if (typeof state.snapToGrid === "boolean") {
    normalized.snapToGrid = state.snapToGrid;
  }
  return normalized;
}

function createNonce() {
  return crypto.randomBytes(16).toString("base64").replace(/[^a-z0-9]/gi, "");
}

function createGraphWebviewOptions() {
  return {
    enableScripts: true,
    localResourceRoots: []
  };
}

function buildWebviewCsp(scriptNonce) {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "img-src data: blob:",
    "media-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${scriptNonce}'`
  ].join("; ");
}

function normalizeGraphWebviewMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  switch (message.type) {
    case "revealLine": {
      const line = Math.trunc(Number(message.line));
      const uri =
        typeof message.uri === "string" && /^file:\/\//.test(message.uri) ? message.uri : "";
      return { type: "revealLine", line: Number.isFinite(line) && line > 0 ? line : 1, uri };
    }
    case "exportGraphJson":
    case "exportDot":
    case "exportExcalidraw":
      return { type: message.type };
    case "exportSvg":
      if (
        typeof message.svg === "string" &&
        Buffer.byteLength(message.svg, "utf8") <= MAX_WEBVIEW_PAYLOAD_BYTES
      ) {
        return { type: "exportSvg", svg: message.svg };
      }
      return null;
    case "exportPng":
      if (
        typeof message.png === "string" &&
        /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(message.png) &&
        Buffer.byteLength(message.png, "utf8") <= MAX_WEBVIEW_PAYLOAD_BYTES
      ) {
        return { type: "exportPng", png: message.png };
      }
      return null;
    case "exportPngError":
      if (typeof message.error === "string" && message.error.trim()) {
        return {
          type: "exportPngError",
          error: message.error.trim().slice(0, MAX_UI_ERROR_CHARS)
        };
      }
      return null;
    case "persistUiState":
      if (Buffer.byteLength(JSON.stringify(message.state || {}), "utf8") > MAX_PERSISTED_STATE_BYTES) {
        return null;
      }
      return {
        type: "persistUiState",
        state: normalizePersistedGraphState(message.state)
      };
    default:
      return null;
  }
}

module.exports = {
  normalizePersistedGraphState,
  createNonce,
  createGraphWebviewOptions,
  buildWebviewCsp,
  normalizeGraphWebviewMessage
};
