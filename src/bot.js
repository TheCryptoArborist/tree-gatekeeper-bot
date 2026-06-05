import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(path.join(rootDir, ".env"));

const config = {
  telegramBotToken: env("TELEGRAM_BOT_TOKEN"),
  telegramGroupChatId: env("TELEGRAM_GROUP_CHAT_ID"),
  adminTelegramIds: new Set(splitCsv(env("ADMIN_TELEGRAM_IDS", ""))),
  suiRpcUrl: env("SUI_RPC_URL", "https://fullnode.mainnet.sui.io:443"),
  nftreePackageId: env("NFTREE_PACKAGE_ID", "0xf6c6d439ea0da2f3e9ba79e4992a7a4c113215fbf54c442ac9020c315f953705").toLowerCase(),
  nftreeModuleName: env("NFTREE_MODULE_NAME", "collection").toLowerCase(),
  nftreeStructType: env("NFTREE_STRUCT_TYPE", "0xf6c6d439ea0da2f3e9ba79e4992a7a4c113215fbf54c442ac9020c315f953705::collection::NFT").toLowerCase(),
  nftreeNamePattern: env("NFTREE_NAME_PATTERN", "nftree"),
  enableWebApp: env("ENABLE_WEBAPP", "false").toLowerCase() === "true",
  webAppUrl: env("ENABLE_WEBAPP", "false").toLowerCase() === "true" ? env("WEBAPP_URL", "") : "",
  webAppPort: Number(env("PORT", env("WEBAPP_PORT", "8787"))),
  whaleChatInviteUrl: env("WHALE_CHAT_INVITE_URL", ""),
  telegramPollMs: Math.max(5, Number(env("TELEGRAM_POLL_SECONDS", "25"))) * 1000,
  auditIntervalMs: Math.max(1, Number(env("AUDIT_INTERVAL_MINUTES", "30"))) * 60 * 1000,
  memberStorePath: path.resolve(rootDir, env("MEMBER_STORE_PATH", "data/members.json"))
};

let state = loadState();
let auditInProgress = false;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  validateConfig();

  console.log("NFTree gatekeeper Telegram bot started.");
  console.log(`NFTree package: ${config.nftreePackageId}`);
  console.log(`Group chat: ${config.telegramGroupChatId}`);

  startHttpServer();
  pollTelegramOnce().catch((error) => console.error("Telegram poll failed:", error));
  setInterval(() => pollTelegramOnce().catch((error) => console.error("Telegram poll failed:", error)), config.telegramPollMs);
  setInterval(() => auditMembers("scheduled").catch((error) => console.error("Audit failed:", error)), config.auditIntervalMs);
}

async function pollTelegramOnce() {
  const params = new URLSearchParams({
    timeout: String(Math.floor(config.telegramPollMs / 1000)),
    allowed_updates: JSON.stringify(["message", "chat_join_request"])
  });

  if (state.telegramOffset) params.set("offset", String(state.telegramOffset));

  const payload = await telegram("getUpdates", params, "GET");
  for (const update of payload.result ?? []) {
    state.telegramOffset = update.update_id + 1;
    await processUpdate(update);
  }

  saveState();
}

async function processUpdate(update) {
  if (update.chat_join_request) {
    await processJoinRequest(update.chat_join_request);
    return;
  }

  const message = update.message;
  if (!message) return;

  for (const member of message.new_chat_members ?? []) {
    await processNewChatMember(message.chat, member);
  }

  const text = message.text?.trim();
  if (!text?.startsWith("/")) return;

  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();

  if (command === "/verify") {
    await handleVerify(message, args);
  } else if (command === "/status") {
    await handleStatus(message);
  } else if (command === "/audit") {
    await handleAudit(message);
  } else if (command === "/start" || command === "/help") {
    await sendHelp(message.chat.id);
  }
}

async function handleVerify(message, args) {
  const wallet = normalizeSuiAddress(args[0]);
  if (!wallet) {
    await sendMessage(message.chat.id, "Send `/verify 0x...` with your Sui wallet address.", { markdown: true });
    return;
  }

  const user = message.from;
  const report = await getEligibilityReport(wallet);

  state.members[String(user.id)] = {
    telegramUserId: user.id,
    username: user.username ?? "",
    firstName: user.first_name ?? "",
    wallet,
    ...memberExposureFields(report)
  };
  saveState();

  if (report.eligible) {
    await sendMessage(
      message.chat.id,
      `Verified. ${formatUser(user)} owns an NFTree. Eligible for campaign rewards.`
    );
  } else {
    await sendMessage(
      message.chat.id,
      "Not eligible yet. This wallet does not currently show an NFTree owned directly in the wallet."
    );

    if (String(message.chat.id) === String(config.telegramGroupChatId)) {
      await removeFromGroup(user.id, "no NFTree found during verification");
    }
  }
}

async function handleStatus(message) {
  const member = state.members[String(message.from.id)];
  if (!member) {
    await sendMessage(message.chat.id, "No wallet is registered for you yet. Use `/verify 0x...`.", { markdown: true });
    return;
  }

  const report = await getEligibilityReport(member.wallet);
  Object.assign(member, memberExposureFields(report));
  saveState();

  await sendMessage(
    message.chat.id,
    `${report.eligible ? "Eligible" : "Not eligible"}: ${report.nftreeCount} NFTree${report.nftreeCount === 1 ? "" : "s"} found in ${shorten(member.wallet)}.`
  );
}

async function handleAudit(message) {
  if (!(await isAdmin(message.from.id))) {
    await sendMessage(message.chat.id, "Only a group admin can run an audit.");
    return;
  }

  await sendMessage(message.chat.id, "Starting NFTree whale audit now.");
  const result = await auditMembers("manual");
  await sendMessage(message.chat.id, `Audit complete. Checked ${result.checked}, removed ${result.removed}.`);
}

async function processJoinRequest(request) {
  const member = state.members[String(request.from.id)];
  if (!member) {
    await telegram("declineChatJoinRequest", {
      chat_id: request.chat.id,
      user_id: request.from.id
    });
    return;
  }

  const report = await getEligibilityReport(member.wallet);
  Object.assign(member, memberExposureFields(report));
  saveState();

  await telegram(report.eligible ? "approveChatJoinRequest" : "declineChatJoinRequest", {
    chat_id: request.chat.id,
    user_id: request.from.id
  });
}

async function processNewChatMember(chat, member) {
  if (member.is_bot) return;

  const record = state.members[String(member.id)];
  if (!record) {
    await removeFromGroup(member.id, "joined without NFTree verification");
    return;
  }

  const report = await getEligibilityReport(record.wallet);
  Object.assign(record, memberExposureFields(report));
  saveState();

  if (!report.eligible) {
    await removeFromGroup(member.id, "no NFTree found on join");
  } else if (String(chat.id) === String(config.telegramGroupChatId)) {
    await sendMessage(chat.id, `${formatUser(member)} verified: ${record.nftreeCount} NFTree${record.nftreeCount === "1" ? "" : "s"}.`);
  }
}

async function auditMembers(reason) {
  if (auditInProgress) return { checked: 0, removed: 0 };
  auditInProgress = true;

  let checked = 0;
  let removed = 0;
  try {
    for (const [telegramUserId, member] of Object.entries(state.members)) {
      checked += 1;
      const report = await getEligibilityReport(member.wallet);
      Object.assign(member, memberExposureFields(report));

      if (!report.eligible) {
        removed += 1;
        await removeFromGroup(telegramUserId, `${reason} audit found no NFTree`);
      }
    }

    saveState();
    console.log(`[${new Date().toISOString()}] Audit checked ${checked}, removed ${removed}.`);
    return { checked, removed };
  } finally {
    auditInProgress = false;
  }
}

async function getEligibilityReport(wallet) {
  const nftrees = await getNftreeOwnership(wallet);
  return {
    wallet,
    nftrees,
    nftreeCount: nftrees.length,
    eligible: nftrees.length > 0
  };
}

async function removeFromGroup(telegramUserId, reason) {
  await telegram("banChatMember", {
    chat_id: config.telegramGroupChatId,
    user_id: telegramUserId,
    revoke_messages: false
  });

  await telegram("unbanChatMember", {
    chat_id: config.telegramGroupChatId,
    user_id: telegramUserId,
    only_if_banned: true
  });

  console.log(`Removed Telegram user ${telegramUserId}: ${reason}`);
}

async function isAdmin(telegramUserId) {
  if (config.adminTelegramIds.has(String(telegramUserId))) return true;
  if (!config.telegramGroupChatId) return false;

  try {
    const payload = await telegram("getChatMember", {
      chat_id: config.telegramGroupChatId,
      user_id: telegramUserId
    });
    return ["creator", "administrator"].includes(payload.result?.status);
  } catch {
    return false;
  }
}

async function sendHelp(chatId) {
  const replyMarkup = config.webAppUrl ? {
    inline_keyboard: [[
      {
        text: "Verify NFTree",
        web_app: { url: config.webAppUrl }
      }
    ]]
  } : undefined;

  await sendMessage(chatId, [
    "NFTree whale chat verification",
    "",
    config.webAppUrl ? "Tap the button below to verify in the app." : "Use:",
    "/verify 0x...",
    "/status",
    "",
    "Requirement: own at least 1 NFTree."
  ].join("\n"), { replyMarkup });
}

async function sendMessage(chatId, text, options = {}) {
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  };

  if (options.markdown) body.parse_mode = "Markdown";
  if (options.replyMarkup) body.reply_markup = options.replyMarkup;
  return telegram("sendMessage", body);
}

async function telegram(method, bodyOrParams = {}, httpMethod = "POST") {
  const url = new URL(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`);
  const options = { method: httpMethod };

  if (httpMethod === "GET") {
    for (const [key, value] of bodyOrParams.entries()) url.searchParams.set(key, value);
  } else {
    options.headers = { "content-type": "application/json" };
    options.body = JSON.stringify(bodyOrParams);
  }

  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.ok === false) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${text}`);
  }

  return payload;
}

async function suiRpc(method, params) {
  const response = await fetch(config.suiRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
  });

  if (!response.ok) {
    throw new Error(`Sui RPC returned ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(`Sui RPC error for ${method}: ${json.error.message}`);
  }

  return json;
}

function startHttpServer() {
  const publicDir = path.join(rootDir, "public");
  const server = http.createServer((request, response) => {
    handleWebRequest(request, response, publicDir).catch((error) => {
      console.error("Web app request failed:", error);
      sendJson(response, 500, { ok: false, error: "Server error" });
    });
  });

  server.listen(config.webAppPort, () => {
    console.log(`HTTP server listening on http://127.0.0.1:${config.webAppPort}`);
    if (config.enableWebApp && !config.webAppUrl) {
      console.log("Set WEBAPP_URL to an HTTPS /app URL before using the Telegram Web App button.");
    }
  });
}

async function handleWebRequest(request, response, publicDir) {
  const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/verify") {
    if (!config.enableWebApp) {
      sendJson(response, 404, { ok: false, error: "Mini App verification is disabled. Use /verify in Telegram." });
      return;
    }

    const body = await readJsonBody(request);
    const telegramUser = validateTelegramWebAppInitData(body.initData);
    const wallet = normalizeSuiAddress(body.wallet);
    if (!wallet) {
      sendJson(response, 400, { ok: false, error: "Enter a valid Sui wallet address." });
      return;
    }

    const report = await getEligibilityReport(wallet);
    state.members[String(telegramUser.id)] = {
      telegramUserId: telegramUser.id,
      username: telegramUser.username ?? "",
      firstName: telegramUser.first_name ?? "",
      wallet,
      ...memberExposureFields(report)
    };
    saveState();

    sendJson(response, 200, {
      ok: true,
      eligible: report.eligible,
      requirement: "Own at least 1 NFTree",
      wallet,
      nftreeCount: report.nftreeCount,
      nftrees: report.nftrees.slice(0, 10),
      warnings: [],
      inviteUrl: report.eligible ? config.whaleChatInviteUrl : ""
    });
    return;
  }

  if (!config.enableWebApp && (url.pathname === "/" || url.pathname === "/app")) {
    response.writeHead(200, { ...corsHeaders(), "content-type": "text/plain; charset=utf-8" });
    response.end("Tree Gatekeeper is running. Use /verify in Telegram.");
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const routePath = url.pathname === "/" || url.pathname === "/app" ? "/index.html" : url.pathname;
  const filePath = path.resolve(publicDir, `.${routePath}`);
  if (!filePath.startsWith(publicDir)) {
    sendJson(response, 403, { ok: false, error: "Forbidden" });
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(response, 404, { ok: false, error: "Not found" });
    return;
  }

  response.writeHead(200, {
    ...corsHeaders(),
    "content-type": contentTypeFor(filePath)
  });
  fs.createReadStream(filePath).pipe(response);
}

function validateTelegramWebAppInitData(initData) {
  if (!initData || typeof initData !== "string") {
    throw new Error("Telegram app data is missing. Open this screen from Telegram.");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("Telegram app data is missing its signature.");

  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(config.telegramBotToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  if (!/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw new Error("Telegram app data signature is malformed.");
  }
  if (!crypto.timingSafeEqual(Buffer.from(calculatedHash, "hex"), Buffer.from(receivedHash, "hex"))) {
    throw new Error("Telegram app data signature is invalid.");
  }

  const authDate = Number(params.get("auth_date") ?? "0");
  const maxAgeSeconds = 24 * 60 * 60;
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > maxAgeSeconds) {
    throw new Error("Telegram app data is too old. Reopen the app from Telegram.");
  }

  const user = JSON.parse(params.get("user") ?? "{}");
  if (!user.id) throw new Error("Telegram user data is missing.");
  return user;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64_000) reject(new Error("Request body is too large."));
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...corsHeaders(),
    "content-type": "application/json"
  });
  response.end(JSON.stringify(payload));
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".js")) return "text/javascript";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "text/html";
}

async function getNftreeOwnership(wallet) {
  const exactTypeMatches = config.nftreeStructType
    ? await getOwnedObjectsByFilter(wallet, { StructType: config.nftreeStructType })
    : [];

  if (exactTypeMatches.length > 0) return exactTypeMatches;

  return getOwnedObjectsByFilter(wallet, { Package: config.nftreePackageId });
}

async function getOwnedObjectsByFilter(wallet, filter) {
  let cursor = null;
  const matches = [];
  const seen = new Set();

  do {
    const json = await suiRpc("suix_getOwnedObjects", [
      wallet,
      {
        filter,
        options: {
          showType: true,
          showContent: true,
          showDisplay: true
        }
      },
      cursor,
      50
    ]);

    const rows = json.result?.data ?? [];
    for (const row of rows) {
      const object = row.data;
      if (object && !seen.has(object.objectId) && isNftreeObject(object)) {
        seen.add(object.objectId);
        matches.push({
          objectId: object.objectId,
          type: object.type,
          name: extractObjectName(object)
        });
      }
    }

    cursor = json.result?.hasNextPage ? json.result.nextCursor : null;
  } while (cursor);

  return matches;
}

function isNftreeObject(object) {
  const type = String(object.type ?? "").toLowerCase();
  if (config.nftreeStructType && type === config.nftreeStructType) return true;

  const expectedPrefix = `${config.nftreePackageId}::${config.nftreeModuleName}::`;
  if (!type.startsWith(expectedPrefix)) return false;

  const searchable = [
    type,
    object.display?.data?.name,
    object.display?.data?.description,
    object.content?.fields?.name,
    object.content?.fields?.description
  ].filter(Boolean).join(" ").toLowerCase();

  return searchable.includes(config.nftreeNamePattern.toLowerCase());
}

function extractObjectName(object) {
  return object.display?.data?.name
    ?? object.content?.fields?.name
    ?? object.content?.fields?.number
    ?? shorten(object.objectId);
}

function walletFromMessage(message, args) {
  return normalizeSuiAddress(args[0]) ?? state.members[String(message.from.id)]?.wallet ?? null;
}

function memberExposureFields(report) {
  return {
    nftreeCount: String(report.nftreeCount),
    nftreeObjectIds: report.nftrees.map((nftree) => nftree.objectId),
    eligible: report.eligible,
    lastCheckedAt: new Date().toISOString()
  };
}

function normalizeSuiAddress(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(trimmed) ? trimmed : null;
}

function formatUser(user) {
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || String(user.id);
}

function shorten(value) {
  if (typeof value !== "string" || value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function splitCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function loadState() {
  if (!fs.existsSync(config.memberStorePath)) {
    return { telegramOffset: 0, members: {} };
  }

  return JSON.parse(fs.readFileSync(config.memberStorePath, "utf8"));
}

function saveState() {
  fs.mkdirSync(path.dirname(config.memberStorePath), { recursive: true });
  fs.writeFileSync(config.memberStorePath, JSON.stringify(state, null, 2));
}

function validateConfig() {
  if (!config.telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is required.");
  if (!config.telegramGroupChatId) throw new Error("TELEGRAM_GROUP_CHAT_ID is required.");
  if (!config.nftreePackageId.startsWith("0x")) throw new Error("NFTREE_PACKAGE_ID must be a Sui package id.");
  if (config.nftreeStructType && !config.nftreeStructType.includes("::")) {
    throw new Error("NFTREE_STRUCT_TYPE must be a full Sui struct type.");
  }
}

function env(name, fallback = undefined) {
  return process.env[name] ?? fallback;
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^[']|[']$/g, "").replace(/^[\"]|[\"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
