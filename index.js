require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const fs = require("fs");
const path = require("path");

// Use persistent storage on Railway (set DATA_DIR=/data and add a Volume mounted at /data)
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const LOGGED_USERS_FILE = path.join(DATA_DIR, "logged_users.json");

function ensureDataDir() {
  if (DATA_DIR !== __dirname && !fs.existsSync(DATA_DIR)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log(`  → Created data dir: ${DATA_DIR}`);
    } catch (e) {
      console.error("  → Failed to create data dir:", e.message);
    }
  }
}
ensureDataDir(); // Run at startup so saves work

// The archived self-bot lib can leak a REST rejection (e.g. Discord 503 on
// POST /interactions) out of its awaited promise. Without these guards a single
// transient interaction error crashes the whole notifier.
process.on("unhandledRejection", (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error("⚠️ Unhandled rejection (ignored, staying up):", msg);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught exception (ignored, staying up):", err && err.message ? err.message : err);
});

function normalizeUsername(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .replace(/#\d+$/, "")           // Remove #1234 discriminator
    .replace(/\s*\([^)]*\)\s*$/g, "")  // Remove trailing (Discord) or similar
    .replace(/\.+$/, "")
    .trim()
    .toLowerCase();
}

function loadLoggedUsers() {
  try {
    const data = fs.readFileSync(LOGGED_USERS_FILE, "utf8");
    const parsed = JSON.parse(data);
    const ids = new Set(Array.isArray(parsed) ? parsed : (parsed.ids || []));
    const raw = Array.isArray(parsed) ? [] : (parsed.usernames || []);
    const usernames = new Set(raw.map((u) => normalizeUsername(u)).filter(Boolean));
    const claimed = new Set((parsed.claimed || []).map((u) => normalizeUsername(u)).filter(Boolean));
    return { ids, usernames, claimed };
  } catch (e) {
    return { ids: new Set(), usernames: new Set(), claimed: new Set() };
  }
}

function saveLoggedUser(userId, username) {
  try {
    loggedUserData.ids.add(userId);
    checkedUsers.add(userId); // Keep in sync so we never re-process this user
    const normalized = username ? normalizeUsername(username) : "";
    if (normalized) loggedUserData.usernames.add(normalized);
    fs.writeFileSync(LOGGED_USERS_FILE, JSON.stringify({
      ids: [...loggedUserData.ids],
      usernames: [...loggedUserData.usernames],
      claimed: [...loggedUserData.claimed],
    }));
  } catch (e) {
    console.error("  → Failed to save logged user:", e.message);
  }
}

function parseIdList(value) {
  return String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseId(value) {
  const v = String(value || "").trim();
  return v || null;
}

function getEnv(name, fallback = "") {
  const value = process.env[name];
  if (value == null) return fallback;
  return String(value).trim();
}

const BLOXLINK_APPLICATION_ID = "426537812993638400";

const token = getEnv("DISCORD_TOKEN");
const channelIds = parseIdList(getEnv("CHANNEL_IDS"));
const roverChannelId = parseId(getEnv("ROVER_CHANNEL_ID"));
/** rover | bloxlink — Rolimons-style servers often use Bloxlink now */
const verifyBot = getEnv("VERIFY_BOT", "bloxlink").toLowerCase();
const verifyAppId =
  verifyBot === "bloxlink"
    ? parseId(getEnv("ROVER_APP_ID")) || BLOXLINK_APPLICATION_ID
    : parseId(getEnv("ROVER_APP_ID"));
/** First argument to sendSlash after app id, e.g. `getinfo` or `whois discord` */
const verifySlashCommand =
  getEnv("VERIFY_SLASH_COMMAND") ||
  (verifyBot === "bloxlink" ? "getinfo" : "whois discord");
const webhookUrl = getEnv("WEBHOOK_URL");
const claimChannelId = parseId(getEnv("CLAIM_CHANNEL_ID"));
const targetGroupChatId = parseId(getEnv("TARGET_GROUP_CHAT_ID"));
const secondToken = getEnv("DISCORD_TOKEN_2");

// Preferred: resolve Discord→Roblox via Bloxlink's official API instead of scraping
// the flaky /getinfo slash reply. Get a key at https://blox.link/dashboard/user/developer.
// Guild id is optional — without it we use Bloxlink's global endpoint.
const BLOXLINK_API_KEY = getEnv("BLOXLINK_API_KEY");
const BLOXLINK_GUILD_ID = parseId(getEnv("BLOXLINK_GUILD_ID"));

const VERIFY_SLASH_MAX_RETRIES = Math.min(
  12,
  Math.max(1, parseInt(String(getEnv("VERIFY_SLASH_MAX_RETRIES", "5")), 10) || 5)
);
const VERIFY_SLASH_BASE_DELAY_MS = Math.min(
  60000,
  Math.max(250, parseInt(String(getEnv("VERIFY_SLASH_BASE_DELAY_MS", "2000")), 10) || 2000)
);
const VERIFY_SLASH_MIN_INTERVAL_MS = Math.min(
  10000,
  Math.max(0, parseInt(String(getEnv("VERIFY_SLASH_MIN_INTERVAL_MS", "600")), 10) || 600)
);

let lastVerificationSlashAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restStatusFromError(err) {
  if (!err) return null;
  const s = err.status ?? err.statusCode ?? err.httpStatus;
  if (typeof s === "number" && s > 0) return s;
  const msg = String(err.message || err);
  if (/503|service unavailable/i.test(msg)) return 503;
  if (/502|bad gateway/i.test(msg)) return 502;
  if (/504|gateway time-?out/i.test(msg)) return 504;
  if (/429|rate ?limit/i.test(msg)) return 429;
  return null;
}

function isRetryableDiscordInteractionError(err) {
  const s = restStatusFromError(err);
  if (s === 502 || s === 503 || s === 504 || s === 429) return true;
  const code = err && err.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") return true;
  return false;
}

async function maybeThrottleVerificationSlash() {
  if (VERIFY_SLASH_MIN_INTERVAL_MS <= 0) return;
  const now = Date.now();
  const wait = lastVerificationSlashAt + VERIFY_SLASH_MIN_INTERVAL_MS - now;
  if (wait > 0) await sleep(wait);
  lastVerificationSlashAt = Date.now();
}

/** Discord /interactions sometimes returns 503/502/504; selfbots also hit rate limits (429). */
async function sendVerificationSlash(verifyChannel, appId, command, userId) {
  let lastErr = null;
  for (let attempt = 1; attempt <= VERIFY_SLASH_MAX_RETRIES; attempt++) {
    await maybeThrottleVerificationSlash();
    try {
      const res = await verifyChannel.sendSlash(appId, command, userId);
      if (attempt > 1) console.log(`  → Slash succeeded on attempt ${attempt}`);
      return res;
    } catch (e) {
      lastErr = e;
      const s = restStatusFromError(e);
      const retryable = isRetryableDiscordInteractionError(e);
      if (!retryable || attempt >= VERIFY_SLASH_MAX_RETRIES) {
        throw e;
      }
      let delay = VERIFY_SLASH_BASE_DELAY_MS * 2 ** (attempt - 1);
      if (s === 429) {
        const ra = e?.rawError?.retry_after ?? e?.retry_after;
        if (typeof ra === "number" && ra > 0) {
          delay = Math.max(delay, ra * 1000);
        }
      }
      delay = Math.min(delay, 60000);
      console.warn(
        `  → Slash transient (${s ?? "network"}), retry ${attempt}/${VERIFY_SLASH_MAX_RETRIES} in ${delay}ms: ${e.message}`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

function parseBloxlinkResolve(data) {
  const robloxId =
    (data && data.robloxID) ||
    (data && data.resolved && data.resolved.roblox && data.resolved.roblox.id) ||
    null;
  if (!robloxId) return { ok: true, notLinked: true };
  const roblox = (data && data.resolved && data.resolved.roblox) || {};
  return { ok: true, robloxId: String(robloxId), robloxName: roblox.name || roblox.displayName || null };
}

/**
 * Resolve a Discord user id to a Roblox id via Bloxlink's official public API.
 * Returns { ok, robloxId?, robloxName?, notLinked? }. ok=false means a transient
 * API failure (caller should not treat it as "unlinked").
 */
async function bloxlinkDiscordToRoblox(discordUserId, guildId) {
  if (!BLOXLINK_API_KEY) return { ok: false };
  const gid = BLOXLINK_GUILD_ID || guildId || null;
  const base = "https://api.blox.link/v4/public";
  const url = gid
    ? `${base}/guilds/${gid}/discord-to-roblox/${discordUserId}`
    : `${base}/discord-to-roblox/${discordUserId}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: BLOXLINK_API_KEY } });
      if (res.status === 404) return { ok: true, notLinked: true };
      if (res.status === 429 || res.status === 503 || res.status === 502) {
        if (attempt < 3) {
          await sleep(1500 * attempt);
          continue;
        }
        console.warn(`  → Bloxlink API ${res.status} (giving up) for ${discordUserId}`);
        return { ok: false };
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`  → Bloxlink API ${res.status} for ${discordUserId} | body: ${String(body).slice(0, 200)}`);
        return { ok: false };
      }
      const data = await res.json().catch(() => null);
      // Bloxlink sometimes returns 200 with { error: "...not linked..." }
      if (data && data.error && !data.robloxID) return { ok: true, notLinked: true };
      return parseBloxlinkResolve(data);
    } catch (e) {
      if (attempt < 3) {
        await sleep(1500 * attempt);
        continue;
      }
      console.warn(`  → Bloxlink API error for ${discordUserId}: ${e.message}`);
      return { ok: false };
    }
  }
  return { ok: false };
}

const pendingChecks = new Map(); // userId -> { message, channelId, ... }
const loggedUserData = loadLoggedUsers(); // { ids, usernames } - persisted
const checkedUsers = new Set([...loggedUserData.ids]); // Includes persisted + session
const userActivity = new Map(); // userId -> timestamp[] (for activity filtering)
const recentWebhooks = new Map(); // userId -> timestamp (prevent duplicate embeds)

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const THIRTY_FIVE_DAYS_MS = 35 * 24 * 60 * 60 * 1000; // Keep ~1 month for novice filter
const ONE_MINUTE_MS = 60 * 1000;
const WEBHOOK_DEBOUNCE_MS = 90 * 1000; // Prevent duplicate webhooks for same user
const MIN_RAP = 200000; // Minimum RAP to send webhook embed
const MIN_RAP_WL = 150000; // For w/l messages: send only if N/A (privated) or above 150k
const NOVICE_MAX_TOTAL_MESSAGES = 50; // Novices must have <50 messages to qualify (unless inactive 30+ days)
const NOVICE_MAX_MESSAGES_IF_ACTIVE_2W = 5; // If active in past 2 weeks, max 3-5 messages in that period
const BYPASS_PHRASES = ["is this good", "dm", "help", "lf", "looking for"]; // Bypass RAP 200k min when message contains these (w/l has its own rules)
const NOVICE_BYPASS_PHRASES = ["help", "support", "who is good at trading", "how is this item doing", "need help", "trading help", "any tips", "advice", "how do i", "what should i"]; // Bypass novice message limit - inactive users seeking trade help

function messageHasBypassPhrase(content) {
  const lower = (content || "").toLowerCase();
  return BYPASS_PHRASES.some((p) => lower.includes(p));
}

function messageHasWL(content) {
  return (content || "").toLowerCase().includes("w/l");
}

function messageHasNoviceBypassPhrase(content) {
  const lower = (content || "").toLowerCase();
  return NOVICE_BYPASS_PHRASES.some((p) => lower.includes(p));
}

function recordMessageActivity(userId) {
  const now = Date.now();
  if (!userActivity.has(userId)) userActivity.set(userId, []);
  userActivity.get(userId).push(now);
  const cutoff = now - THIRTY_FIVE_DAYS_MS; // Keep ~1 month for novice filter
  userActivity.set(userId, userActivity.get(userId).filter((t) => t > cutoff));
}

// Roles that always qualify (even above Novice) and skip novice activity rules — match server role names (case-insensitive)
const ELEVATED_TRACKED_ROLE_NAMES = [
  "rover verified",
  "verified",
  "blox-link verified",
  "bloxlink verified",
  "nitro booster",
];

function memberHasElevatedTrackedRole(member, guild) {
  if (!member || !guild) return false;
  for (const name of ELEVATED_TRACKED_ROLE_NAMES) {
    const r = guild.roles?.cache?.find((role) => role.name.toLowerCase() === name);
    if (r && member.roles?.cache?.has(r.id)) return true;
  }
  return false;
}

function isNoviceExcludingVerified(member, guild) {
  if (!member || !guild) return false;
  const noviceRole = guild.roles?.cache?.find((r) => r.name.toLowerCase() === "novice");
  if (!noviceRole) return false;
  if (memberHasElevatedTrackedRole(member, guild)) return false; // Not treated as novice
  const memberHighest = member.roles?.highest;
  if (!memberHighest) return true;
  return memberHighest.position <= noviceRole.position; // Novice or lower
}

/** Novice activity requirements: <50 msgs total; inactive 2+ weeks OR if active in 2w then ≤5 msgs; if ≥50 msgs then inactive 30+ days */
function meetsNoviceActivityRequirements(userId) {
  const timestamps = userActivity.get(userId) || [];
  const now = Date.now();
  const totalMessages = timestamps.length;
  const lastMessageTime = timestamps.length ? Math.max(...timestamps) : 0;
  const messagesInLast2Weeks = timestamps.filter((t) => now - t <= TWO_WEEKS_MS).length;
  const inactive2Weeks = lastMessageTime === 0 || now - lastMessageTime > TWO_WEEKS_MS;
  const inactive30Days = lastMessageTime === 0 || now - lastMessageTime > THIRTY_DAYS_MS;

  if (totalMessages >= NOVICE_MAX_TOTAL_MESSAGES) {
    return inactive30Days; // ≥50 msgs: must be inactive 30+ days
  }
  // <50 msgs: must be inactive 2+ weeks, OR if active in 2w then ≤5 msgs
  return inactive2Weeks || messagesInLast2Weeks <= NOVICE_MAX_MESSAGES_IF_ACTIVE_2W;
}

function isTooActive(userId) {
  const timestamps = userActivity.get(userId) || [];
  const now = Date.now();
  const inLastMinute = timestamps.filter((t) => now - t < ONE_MINUTE_MS).length;
  const inLast10Days = timestamps.filter((t) => now - t <= TEN_DAYS_MS).length;
  return inLastMinute >= 2 || inLast10Days >= 2;
}

function collectEmbedText(embed) {
  const parts = [
    embed.title,
    embed.description,
    embed.footer?.text,
    ...(embed.fields || []).flatMap((f) => [f.name, f.value]),
  ];
  return parts.filter(Boolean).join("\n");
}

function stripInlineMarkdown(value) {
  return String(value || "")
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/[*_`]/g, "")
    .trim();
}

/** RoVer + Bloxlink embeds: fields, roblox.com/users/ID, numeric Roblox id fields */
function parseRobloxUserIdFromVerificationEmbed(embed) {
  // Bloxlink /getinfo puts the Roblox display name + id in the embed author/title,
  // e.g. "Mace (311378850)". Roblox ids are <= 12 digits (Discord snowflakes are 17+).
  for (const header of [embed.author?.name, embed.title]) {
    if (!header) continue;
    const m = String(header).match(/\((\d{4,12})\)/);
    if (m) return m[1];
  }
  for (const field of embed.fields || []) {
    const name = (field.name || "").toLowerCase();
    const raw = stripInlineMarkdown(String(field.value || "").trim());
    if (!raw) continue;
    const digits = raw.replace(/\D/g, "");
    if (
      digits &&
      (name.includes("roblox") || name.includes("rblx")) &&
      (name.includes("user id") || name.includes("userid") || /\bid\b/.test(name) || name.includes("account"))
    ) {
      return digits;
    }
    if ((name === "roblox id" || name === "user id") && digits.length >= 5) {
      return digits;
    }
  }
  const blob = [embed.author?.name, collectEmbedText(embed)].filter(Boolean).join("\n");
  const urlMatch = blob.match(/roblox\.com\/users\/(\d+)/i);
  if (urlMatch) return urlMatch[1];
  return null;
}

function parseDiscordUserFromVerificationEmbed(embed) {
  let discordUser = embed.title || null;
  if (!discordUser && embed.description) {
    const m = embed.description.match(/\*\*([^*]+)\*\*/);
    if (m) discordUser = m[1];
  }
  if (!discordUser && embed.description) {
    const notVerifiedMatch = embed.description.match(/^([^\-]+)\s*[-–]\s*[Tt]his user is not verified/i);
    if (notVerifiedMatch) discordUser = notVerifiedMatch[1].trim();
  }
  if (!discordUser && embed.description) {
    const boldNotVerified = embed.description.match(/\*\*([^*]+)\*\*\s*[—–-]\s*[Tt]his user is not verified/i);
    if (boldNotVerified) discordUser = boldNotVerified[1].trim();
  }
  if (!discordUser && embed.fields) {
    for (const f of embed.fields) {
      const n = (f.name || "").toLowerCase();
      if (n.includes("discord") && !n.includes("id")) {
        discordUser = stripInlineMarkdown(f.value);
        break;
      }
    }
  }
  return discordUser;
}

function isUnlinkedVerificationEmbed(embed) {
  const desc = (embed.description || "").toLowerCase();
  const title = (embed.title || "").toLowerCase();
  const blob = collectEmbedText(embed).toLowerCase();
  const phrases = [
    "not verified",
    "isn't verified",
    "is not verified",
    "not linked",
    "isn't linked",
    "is not linked",
    "no account linked",
    "no roblox account",
    "does not have a roblox",
    "doesn't have a roblox",
    "not linked to roblox",
    "unable to find",
    "couldn't find",
    "could not find",
  ];
  return phrases.some((p) => desc.includes(p) || title.includes(p) || blob.includes(p));
}

const client = new Client({ checkUpdate: false });
const client2 = new Client({ checkUpdate: false }); // Second client for sending messages
let isShuttingDown = false;

client.on("ready", () => {
  ensureDataDir();
  console.log(`Monitoring channels ${channelIds.join(", ")} for messages...`);
  if (BLOXLINK_API_KEY) {
    console.log(
      `Verification: Bloxlink API (${BLOXLINK_GUILD_ID ? `guild ${BLOXLINK_GUILD_ID}` : "global endpoint"})`
    );
  } else {
    console.log(`Verification bot: ${verifyBot} (slash: /${verifySlashCommand.replace(/\s+/g, " ")})`);
    console.log(`Verification channel: ${roverChannelId}`);
    console.log("  → Tip: set BLOXLINK_API_KEY to use the reliable Bloxlink API instead of slash scraping.");
  }
  if (!channelIds.length) {
    console.warn("  → CHANNEL_IDS is empty after parsing. Check your .env formatting.");
  }
  if (!token || !secondToken || !roverChannelId || !verifyAppId || !webhookUrl) {
    console.warn("  → One or more required env vars are missing/blank after parsing.");
    console.warn(
      `  → token:${!!token} token2:${!!secondToken} verifyChannel:${!!roverChannelId} verifyApp:${!!verifyAppId} webhook:${!!webhookUrl}`
    );
  }
  console.log(
    `Filters active: activity(1m>=2 or 10d>=2), novice(${NOVICE_MAX_TOTAL_MESSAGES} total, ${NOVICE_MAX_MESSAGES_IF_ACTIVE_2W} in 2w if active)`
  );
  console.log(`Data dir: ${DATA_DIR} (logged users: ${loggedUserData.ids.size})`);
});

async function fetchRobloxRAP(robloxUserId) {
  try {
    console.log(`  → Fetching inventory for Roblox user ${robloxUserId}...`);
    
    // Fetch user's inventory from Roblox API
    const inventoryUrl = `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles?sortOrder=Asc&limit=100`;
    const res = await fetch(inventoryUrl);
    
    if (!res.ok) {
      console.log(`  → Roblox API returned status: ${res.status}`);
      return { rap: null };
    }
    
    const inventoryData = await res.json();
    
    if (!inventoryData.data || !Array.isArray(inventoryData.data)) {
      console.log(`  → No inventory data found`);
      return { rap: null };
    }
    
    let totalRAP = 0;
    let itemCount = 0;
    
    // Calculate total RAP from all collectible items
    for (const item of inventoryData.data) {
      if (item.recentAveragePrice != null && item.recentAveragePrice > 0) {
        totalRAP += item.recentAveragePrice;
        itemCount++;
      }
    }
    
    // Handle pagination if there are more items
    let nextCursor = inventoryData.nextPageCursor;
    while (nextCursor) {
      const nextUrl = `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles?sortOrder=Asc&limit=100&cursor=${nextCursor}`;
      const nextRes = await fetch(nextUrl);
      
      if (!nextRes.ok) break;
      
      const nextData = await nextRes.json();
      
      if (!nextData.data) break;
      
      for (const item of nextData.data) {
        if (item.recentAveragePrice != null && item.recentAveragePrice > 0) {
          totalRAP += item.recentAveragePrice;
          itemCount++;
        }
      }
      
      nextCursor = nextData.nextPageCursor;
    }
    
    console.log(`  → Found ${itemCount} collectibles with total RAP: ${totalRAP}`);
    
    return { rap: totalRAP > 0 ? totalRAP : null };
  } catch (e) {
    console.error("  → Roblox API error:", e.message);
    return { rap: null };
  }
}

async function fetchRobloxHeadshotUrl(robloxUserId) {
  try {
    const url =
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(robloxUserId)}` +
      "&size=150x150&format=Png&isCircular=false";
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.[0]?.imageUrl || null;
  } catch {
    return null;
  }
}

function buildDiscordMessageJumpUrl(guildId, channelId, messageId) {
  if (guildId) {
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
  }
  return `https://discord.com/channels/@me/${channelId}/${messageId}`;
}

/** Escape * and _ so user text can sit inside italics without breaking Discord markdown */
function escapeForDiscordItalics(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_");
}

async function sendWebhook(data) {
  const {
    robloxUserId,
    discordUser,
    discordUserId,
    rap,
    message,
    channelId,
    messageId,
    avatarUrl,
    guildId,
  } = data;
  const jumpUrl = buildDiscordMessageJumpUrl(guildId, channelId, messageId);

  const cleanDiscordUser = discordUser ? discordUser.replace(/#0$/, "") : "Unknown";
  const rapDisplay = rap != null ? rap.toLocaleString() : "N/A";
  const rolimonsUrl = robloxUserId
    ? `https://www.rolimons.com/player/${robloxUserId}`
    : null;

  let thumb = null;
  if (robloxUserId) {
    thumb = await fetchRobloxHeadshotUrl(robloxUserId);
  }
  if (!thumb && avatarUrl) thumb = avatarUrl;
  if (!thumb) thumb = "https://via.placeholder.com/150";

  const snippet = message?.trim() ? `*${escapeForDiscordItalics(message)}*` : "*(no message)*";
  const linksLine = rolimonsUrl
    ? `[Jump to Message](${jumpUrl}) • [Rolimons](${rolimonsUrl})`
    : `[Jump to Message](${jumpUrl})`;

  const embed = {
    description:
      `**${cleanDiscordUser}** • RAP: **${rapDisplay}**\n` +
      `${snippet}\n\n` +
      linksLine,
    color: 0x00ff00,
    thumbnail: { url: thumb },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (res.ok || res.status === 204) {
      const cleanName = normalizeUsername(discordUser);
      saveLoggedUser(discordUserId, cleanName || undefined);
      console.log("  → Webhook sent");
    } else {
      console.error("  → Webhook failed:", res.status);
    }
  } catch (e) {
    console.error("  → Webhook error:", e.message);
  }
}

function isVerifiedOrNoviceOrLower(member, guild) {
  if (!member || !guild) return true;
  // Elevated roles always qualify — often stacked with Member, Trader, etc.
  if (memberHasElevatedTrackedRole(member, guild)) return true;
  const noviceRole = guild.roles?.cache?.find((r) => r.name.toLowerCase() === "novice");
  if (!noviceRole) return true;
  const memberHighest = member.roles?.highest;
  if (!memberHighest) return true;
  return memberHighest.position <= noviceRole.position; // Novice or lower (no elevated role)
}

/**
 * sendSlash returns the bot's reply. Bloxlink /getinfo replies ephemerally and
 * often "defers" first (LOADING flag) then edits in the real embed, which arrives
 * via messageUpdate — never as a normal messageCreate. Resolve to the final reply.
 */
async function resolveSlashResponse(message, verifyChannel, { tries = 8, intervalMs = 900 } = {}) {
  if (!message) return null;
  if (message.embeds && message.embeds.length) return message;
  const id = message.id;
  if (!id || !verifyChannel) return message;
  // Bloxlink defers (LOADING, no embeds) then edits the embeds in. The messageUpdate
  // event only delivers a partial (embeds=0) and caches it, so force a fresh API fetch
  // (bypassing cache) until the embeds are populated.
  let lastFetchErr = null;
  for (let i = 0; i < tries; i++) {
    await sleep(intervalMs);
    try {
      const fresh = await verifyChannel.messages.fetch(id, { force: true });
      if (fresh && fresh.embeds && fresh.embeds.length) return fresh;
    } catch (e) {
      lastFetchErr = e;
    }
  }
  if (lastFetchErr) console.log(`  → [resolve] fetch error for ${id}: ${lastFetchErr.message}`);
  return message;
}

/** Parse a verification reply embed, then run filters + webhook via finalizeAndSendWebhook. */
async function processVerificationResult(embed, discordUserId, pending) {
  if (!embed || !pending) return;

  const discordUser =
    pending.discordUsername ||
    pending.displayName ||
    parseDiscordUserFromVerificationEmbed(embed) ||
    String(discordUserId);
  const robloxUserId = parseRobloxUserIdFromVerificationEmbed(embed);

  // Diagnostic: show exactly what the verification bot returned so we can confirm parsing
  console.log(
    `  → [verify embed] parsedDiscord="${discordUser || ""}" parsedRobloxId=${robloxUserId || "none"} | ` +
      `title="${embed.title || ""}" desc="${(embed.description || "").slice(0, 160)}" ` +
      `fields=[${(embed.fields || []).map((f) => `${f.name}=${String(f.value || "").slice(0, 40)}`).join(" | ")}]`
  );

  await finalizeAndSendWebhook({
    robloxUserId,
    discordUser,
    discordUserId,
    pending,
    avatarUrl: embed.thumbnail?.url || embed.image?.url,
    isNotLinked: isUnlinkedVerificationEmbed(embed),
  });
}

/** Apply RAP/activity/novice filters to a resolved (discord→roblox) result and send the webhook. */
async function finalizeAndSendWebhook({ robloxUserId, discordUser, discordUserId, pending, avatarUrl, isNotLinked }) {
  if (!pending) return;

  const discordIdStr = String(discordUserId);
  if (loggedUserData.ids.has(discordIdStr)) {
    console.log(`  → Skipped (already logged: ${discordUser || discordUserId})`);
    return;
  }

  function shouldLogWithoutRobloxId() {
    if (robloxUserId || !discordUser) return false;
    const t = (discordUser || "").trim().toLowerCase();
    if (["error", "oops", "failed", "invalid", "warning"].includes(t)) return false;
    return isNotLinked || !!discordUser;
  }

  let rapNum = null;
  let finalRobloxUserId = robloxUserId;

  if (robloxUserId) {
    console.log(`  → Roblox ID: ${robloxUserId}, Discord: ${discordUser || discordUserId}`);
    const { rap } = await fetchRobloxRAP(robloxUserId);
    rapNum = rap != null ? Number(rap) : NaN;

    const hasBypassPhrase = messageHasBypassPhrase(pending.message);
    const hasWL = messageHasWL(pending.message);

    if (hasWL) {
      if (!Number.isNaN(rapNum) && rapNum < MIN_RAP_WL) {
        console.log(`  → Skipped (w/l: RAP ${rapNum.toLocaleString()} < ${MIN_RAP_WL.toLocaleString()})`);
        return;
      }
    } else if (!hasBypassPhrase) {
      if (Number.isNaN(rapNum) || rapNum < MIN_RAP) {
        console.log(`  → Skipped (RAP ${rap ?? "N/A"} < ${MIN_RAP.toLocaleString()})`);
        return;
      }
    }
    rapNum = Number.isNaN(rapNum) ? null : rapNum;
  } else if (shouldLogWithoutRobloxId()) {
    console.log(
      `  → ${verifyBot}: no Roblox link for ${discordUser || discordUserId} (${isNotLinked ? "unlinked / not verified" : "no ID in embed"}), logging anyway (RAP: N/A)`
    );
    finalRobloxUserId = null;
    rapNum = null;
  } else {
    console.log("  → No Roblox User ID found in embed, skipping");
    return;
  }

  if (isTooActive(discordUserId)) {
    console.log(`  → Skipped (too active in Rolimons)`);
    return;
  }

  try {
    const channel = await client.channels.fetch(pending.channelId).catch(() => null);
    const guild = channel?.guild;
    const member = guild ? await guild.members.fetch(discordUserId).catch(() => null) : null;
    if (isNoviceExcludingVerified(member, guild)) {
      if (!messageHasNoviceBypassPhrase(pending.message)) {
        if (!meetsNoviceActivityRequirements(discordUserId)) {
          const timestamps = userActivity.get(discordUserId) || [];
          const now = Date.now();
          const in2w = timestamps.filter((t) => now - t <= TWO_WEEKS_MS).length;
          console.log(`  → Skipped (novice doesn't meet activity: ${timestamps.length} total msgs, ${in2w} in past 2w)`);
          return;
        }
      }
    }
  } catch (e) {
    console.error("  → Novice check error:", e.message);
  }

  const now = Date.now();
  if (recentWebhooks.has(discordIdStr) && now - recentWebhooks.get(discordIdStr) < WEBHOOK_DEBOUNCE_MS) {
    console.log(`  → Skipped (duplicate, sent for ${discordUser} recently)`);
    return;
  }
  recentWebhooks.set(discordIdStr, now);

  await sendWebhook({
    robloxUserId: finalRobloxUserId,
    discordUser,
    discordUserId: discordIdStr,
    rap: rapNum,
    message: pending.message,
    channelId: pending.channelId,
    messageId: pending.messageId,
    guildId: pending.guildId,
    avatarUrl,
  });
}

client.on("messageCreate", async (message) => {
  const channelId = message.channel?.id;
  const authorId = message.author?.id;

  if (channelId === roverChannelId && authorId === verifyAppId) {
    console.log(`  → [MC verify] id=${message.id} embeds=${message.embeds?.length ?? 0}`);
  }

  // Handle RoVer / Bloxlink embed response (same channel + verification bot application id)
  if (channelId === roverChannelId && authorId === verifyAppId && message.embeds?.length) {
    const embed = message.embeds[0];
    const discordUser = parseDiscordUserFromVerificationEmbed(embed);
    const cleanUsername = normalizeUsername(discordUser);
    if (cleanUsername && loggedUserData.usernames.has(cleanUsername)) {
      console.log(`  → Skipped (username "${discordUser}" already logged)`);
      return;
    }
    const pendingUserId = [...pendingChecks.keys()][0];
    if (pendingUserId && loggedUserData.ids.has(pendingUserId)) {
      pendingChecks.delete(pendingUserId);
      console.log(`  → Skipped (pending user ${pendingUserId} already logged)`);
      return;
    }

    const robloxUserId = parseRobloxUserIdFromVerificationEmbed(embed);

    // Diagnostic: show exactly what the verification bot returned so we can confirm parsing
    console.log(
      `  → [verify embed] parsedDiscord="${discordUser || ""}" parsedRobloxId=${robloxUserId || "none"} | ` +
        `title="${embed.title || ""}" desc="${(embed.description || "").slice(0, 160)}" ` +
        `fields=[${(embed.fields || []).map((f) => `${f.name}=${String(f.value || "").slice(0, 40)}`).join(" | ")}]`
    );

    // Match this embed to the correct pending check by Discord username (bot can respond out of order)
    let discordUserId = null;
    let pending = null;
    for (const [userId, data] of pendingChecks.entries()) {
      const storedUsername = normalizeUsername(data.discordUsername || "");
      const storedDisplay = normalizeUsername(data.displayName || "");
      if (cleanUsername && (storedUsername === cleanUsername || storedDisplay === cleanUsername || cleanUsername === storedUsername || cleanUsername === storedDisplay)) {
        discordUserId = userId;
        pending = data;
        break;
      }
    }
    if (!pending && pendingChecks.size > 0) {
      const first = pendingChecks.entries().next();
      if (!first.done) {
        const [firstId, firstData] = first.value;
        discordUserId = firstId;
        pending = firstData;
        console.log(`  → No username match for "${discordUser}" - using first pending as fallback`);
      }
    }
    if (!pending) {
      console.log("  → No pending check found for this embed");
      return;
    }

    // Skip if already logged (check ID early to avoid redundant work)
    const discordIdStr = String(discordUserId);
    if (loggedUserData.ids.has(discordIdStr)) {
      pendingChecks.delete(discordUserId);
      console.log(`  → Skipped (already logged: ${discordUser || discordUserId})`);
      return;
    }
    pendingChecks.delete(discordUserId);

    // Try to get avatar from embed thumbnail or image
    const avatarUrl = embed.thumbnail?.url || embed.image?.url;

    const isNotLinked = isUnlinkedVerificationEmbed(embed);

    /** Embed has no Roblox user id — still log Discord user when clearly unlinked / we have a display name */
    function shouldLogWithoutRobloxId() {
      if (robloxUserId || !cleanUsername) return false;
      const t = (discordUser || "").trim().toLowerCase();
      if (["error", "oops", "failed", "invalid", "warning"].includes(t)) return false;
      return isNotLinked || !!discordUser;
    }

    let rapNum = null;
    let finalRobloxUserId = robloxUserId;

    if (robloxUserId) {
      console.log(`  → Roblox ID: ${robloxUserId}, Discord: ${discordUser || discordUserId}`);
      const { rap } = await fetchRobloxRAP(robloxUserId);
      rapNum = rap != null ? Number(rap) : NaN;

      const hasBypassPhrase = messageHasBypassPhrase(pending.message);
      const hasWL = messageHasWL(pending.message);

      if (hasWL) {
        if (!Number.isNaN(rapNum) && rapNum < MIN_RAP_WL) {
          console.log(`  → Skipped (w/l: RAP ${rapNum.toLocaleString()} < ${MIN_RAP_WL.toLocaleString()})`);
          return;
        }
      } else if (!hasBypassPhrase) {
        if (Number.isNaN(rapNum) || rapNum < MIN_RAP) {
          console.log(`  → Skipped (RAP ${rap ?? "N/A"} < ${MIN_RAP.toLocaleString()})`);
          return;
        }
      }
      rapNum = Number.isNaN(rapNum) ? null : rapNum;
    } else if (shouldLogWithoutRobloxId()) {
      console.log(
        `  → ${verifyBot}: no Roblox link for ${discordUser || discordUserId} (${isNotLinked ? "unlinked / not verified" : "no ID in embed"}), logging anyway (RAP: N/A)`
      );
      finalRobloxUserId = null;
      rapNum = null;
    } else {
      console.log("  → No Roblox User ID found in embed, skipping");
      return;
    }

    // Skip if user is too active (multiple msgs/min or talked multiple times in 10 days)
    if (isTooActive(discordUserId)) {
      console.log(`  → Skipped (too active in Rolimons)`);
      return;
    }

    // Novice filter: skip novice users who don't meet activity requirements
    // Bypass if message is about needing trade help (help, support, etc.)
    try {
      const channel = await client.channels.fetch(pending.channelId).catch(() => null);
      const guild = channel?.guild;
      const member = guild ? await guild.members.fetch(discordUserId).catch(() => null) : null;
      if (isNoviceExcludingVerified(member, guild)) {
        if (!messageHasNoviceBypassPhrase(pending.message)) {
          if (!meetsNoviceActivityRequirements(discordUserId)) {
            const timestamps = userActivity.get(discordUserId) || [];
            const now = Date.now();
            const in2w = timestamps.filter((t) => now - t <= TWO_WEEKS_MS).length;
            console.log(`  → Skipped (novice doesn't meet activity: ${timestamps.length} total msgs, ${in2w} in past 2w)`);
            return;
          }
        }
      }
    } catch (e) {
      console.error("  → Novice check error:", e.message);
    }

    // Debounce: prevent duplicate webhooks for same user (set before async sendWebhook)
    const now = Date.now();
    if (recentWebhooks.has(discordIdStr) && now - recentWebhooks.get(discordIdStr) < WEBHOOK_DEBOUNCE_MS) {
      console.log(`  → Skipped (duplicate, sent for ${discordUser} recently)`);
      return;
    }
    recentWebhooks.set(discordIdStr, now);

    // Send webhook
    await sendWebhook({
      robloxUserId: finalRobloxUserId,
      discordUser,
      discordUserId: discordIdStr,
      rap: rapNum,
      message: pending.message,
      channelId: pending.channelId,
      messageId: pending.messageId,
      guildId: pending.guildId,
      avatarUrl,
    });
    return;
  }

  // Handle user messages in monitored channels
  if (!channelIds.includes(channelId)) return;
  const userId = authorId;
  if (!userId) return;

  // Track message activity for activity filtering
  if (!message.author?.bot) {
    recordMessageActivity(userId);
  }

  const userIdStr = String(userId);
  if (checkedUsers.has(userIdStr) || loggedUserData.ids.has(userIdStr)) {
    return;
  }

  const content = message.content || "";

  const member = message.member ?? (await message.guild?.members?.fetch(userId).catch(() => null));
  if (member && message.guild && !isVerifiedOrNoviceOrLower(member, message.guild)) {
    console.log(`User ID: ${userId} (skipped - not Novice-or-below and missing elevated role)`);
    return;
  }

  // Novice activity filter: skip novices who don't meet activity requirements (no bypass)
  if (member && message.guild && isNoviceExcludingVerified(member, message.guild)) {
    if (!meetsNoviceActivityRequirements(userIdStr)) {
      const timestamps = userActivity.get(userIdStr) || [];
      const now = Date.now();
      const in2w = timestamps.filter((t) => now - t <= TWO_WEEKS_MS).length;
      console.log(`User ID: ${userId} (skipped - novice doesn't meet activity: ${timestamps.length} total msgs, ${in2w} in past 2w)`);
      return;
    }
  }

  console.log("User ID:", userId);
  
  // Mark user as checked
  checkedUsers.add(userIdStr);

  // Store message info for later embed parsing (include username to match Rover's embed)
  const authorUsername = message.author?.username || message.author?.globalName || "";
  const displayName = message.member?.displayName || message.author?.globalName || authorUsername;
  pendingChecks.set(userIdStr, {
    message: content,
    channelId: message.channel.id,
    messageId: message.id,
    discordUsername: authorUsername,
    displayName: displayName,
    guildId: message.guild?.id,
  });

  // Preferred path: resolve via Bloxlink's official API (reliable, no slash scraping).
  if (BLOXLINK_API_KEY) {
    try {
      const pending = pendingChecks.get(userIdStr);
      const result = await bloxlinkDiscordToRoblox(userId, message.guild?.id);
      if (!result.ok) {
        console.log(`  → Bloxlink API lookup failed for ${userId} (will retry on next message)`);
        checkedUsers.delete(userIdStr); // allow another attempt later
      } else {
        const discordUser = pending?.discordUsername || pending?.displayName || String(userId);
        console.log(
          `  → [bloxlink api] ${userId} → roblox=${result.robloxId || "none"}${result.notLinked ? " (not linked)" : ""}`
        );
        await finalizeAndSendWebhook({
          robloxUserId: result.robloxId || null,
          discordUser,
          discordUserId: userId,
          pending,
          avatarUrl: null,
          isNotLinked: !!result.notLinked,
        });
      }
    } catch (e) {
      console.error("  → Bloxlink API path error:", e.message);
    } finally {
      pendingChecks.delete(userIdStr);
    }
    return;
  }

  try {
    const verifyChannel = await client.channels.fetch(roverChannelId);
    let responseMsg = await sendVerificationSlash(verifyChannel, verifyAppId, verifySlashCommand, userId);
    console.log(`  → Sent /${verifySlashCommand.replace(/\s+/g, " ")} (${verifyBot})`);

    // Bloxlink replies ephemerally to the slash command — read the returned reply
    // directly instead of waiting for a messageCreate that never fires.
    try {
      const f = responseMsg?.flags;
      const flagStr = f && typeof f.toArray === "function" ? f.toArray().join(",") : (f?.bitfield ?? f ?? "?");
      console.log(
        `  → [reply raw] id=${responseMsg?.id ?? "?"} author=${responseMsg?.author?.id ?? "?"} embeds=${responseMsg?.embeds?.length ?? 0} flags=${flagStr} content="${String(responseMsg?.content || "").slice(0, 60)}"`
      );
    } catch {}
    responseMsg = await resolveSlashResponse(responseMsg, verifyChannel);
    console.log(`  → [reply resolved] id=${responseMsg?.id ?? "?"} embeds=${responseMsg?.embeds?.length ?? 0}`);
    const pending = pendingChecks.get(userIdStr);
    const embeds = (responseMsg && responseMsg.embeds) || [];
    if (embeds.length && pending) {
      // Bloxlink returns a "Roblox Information" embed and a "Discord Information" embed;
      // pick the one that actually yields a Roblox user id.
      let robloxEmbed = embeds[0];
      for (const e of embeds) {
        if (parseRobloxUserIdFromVerificationEmbed(e)) {
          robloxEmbed = e;
          break;
        }
      }
      await processVerificationResult(robloxEmbed, userId, pending);
    } else {
      console.log(`  → No embed in /getinfo reply for ${userId}`);
    }
    pendingChecks.delete(userIdStr);
  } catch (e) {
    console.error("  → Slash failed:", e.message);
    pendingChecks.delete(userIdStr);
  }
});


// Client2: monitors claim channel, sends username to group chat when "c" is sent (manual claim)
client2.on("messageCreate", async (message) => {
  const channelId = message.channel?.id;
  const content = (message.content || "").trim().toLowerCase();

  if (channelId !== claimChannelId || !/^c\s*$/i.test(content)) return;
  try {
    const msgs = await message.channel.messages.fetch({ limit: 20 }).catch(() => null);
    let sourceMsg = null;
    for (const [, m] of msgs || []) {
      if (m.id === message.id) continue;
      if (m.embeds?.length) {
        const emb = m.embeds[0];
        if (emb.description?.match(/\*\*[^*]+\*\*/) || emb.title || emb.fields?.some((f) => (f.name || "").toLowerCase().includes("discord"))) {
          sourceMsg = m;
          break;
        }
      }
    }
    if (!sourceMsg) return;
    let discordUser = null;
    const emb = sourceMsg.embeds[0];
    const match = emb.description?.match(/\*\*([^*]+)\*\*/);
    if (match) discordUser = match[1];
    else if (emb.title) discordUser = emb.title;
    else for (const f of emb.fields || []) { if ((f.name || "").toLowerCase().includes("discord")) { discordUser = f.value?.trim(); break; } }
    if (!discordUser) return;
    const cleanName = normalizeUsername(discordUser);
    if (loggedUserData.claimed.has(cleanName)) {
      console.log(`[C] Skipped "${discordUser}" - already claimed`);
      return;
    }
    // Only claim users we've sent webhooks for (in usernames)
    if (!loggedUserData.usernames.has(cleanName)) {
      console.log(`[C] Skipped "${discordUser}" - not in our logged users (wrong embed or not qualified)`);
      return;
    }
    loggedUserData.claimed.add(cleanName);
    fs.writeFileSync(LOGGED_USERS_FILE, JSON.stringify({ ids: [...loggedUserData.ids], usernames: [...loggedUserData.usernames], claimed: [...loggedUserData.claimed] }));
    const targetChannel = await client2.channels.fetch(targetGroupChatId).catch(() => null);
    if (targetChannel) { await targetChannel.send(discordUser); console.log(`[C] Sent "${discordUser}" to group chat`); }
  } catch (e) { console.error(`[C] Error:`, e.message); }
});

// Diagnostic: see if Bloxlink edits its deferred reply (messageUpdate) in the verify channel
client.on("messageUpdate", (_oldMsg, newMsg) => {
  try {
    if (newMsg && newMsg.channel?.id === roverChannelId && newMsg.author?.id === verifyAppId) {
      console.log(`  → [MU verify] id=${newMsg.id} embeds=${newMsg.embeds?.length ?? 0}`);
    }
  } catch {}
});

// Login both clients
client.login(token).catch((e) => {
  console.error("Client 1 login failed:", e.message);
  process.exit(1);
});

client2.login(secondToken).catch((e) => {
  console.error("Client 2 login failed:", e.message);
  process.exit(1);
});

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  try {
    await Promise.allSettled([
      client.destroy(),
      client2.destroy(),
    ]);
    console.log("Discord clients disconnected.");
  } catch (e) {
    console.error("Error during shutdown:", e.message);
  } finally {
    // Exit 0 for platform-driven termination (e.g., redeploy/stop)
    process.exit(0);
  }
}

process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM");
});

process.on("SIGINT", () => {
  gracefulShutdown("SIGINT");
});
