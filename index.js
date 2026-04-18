require("dotenv").config();
const { io } = require("socket.io-client");
const { WebhookClient, EmbedBuilder } = require("discord.js");

// ─── Config ───────────────────────────────────────────────────────────────────
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const RUSTMAGIC_WS = process.env.RUSTMAGIC_WS_URL || "wss://rustmagic.com";
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "30000");
const RECONNECT_DELAY_MS = 5000;
const UPDATE_INTERVAL_MS = 60000; // send "time remaining" updates every 60s

if (!WEBHOOK_URL) {
  console.error("❌  Missing DISCORD_WEBHOOK_URL in .env");
  process.exit(1);
}

// ─── State ────────────────────────────────────────────────────────────────────
let webhook;
let activeRain = null;       // { amount, currency, endsAt, messageId? }
let updateTimer = null;
let socket = null;

// ─── Discord Webhook ──────────────────────────────────────────────────────────
const RUSTMAGIC_LOGO = "https://rustmagic.com/favicon.ico";
const RUSTMAGIC_BANNER = "https://rustmagic.com/og-image.png"; // used as image if available

const COLORS = {
  start:  0x00d4ff,   // electric cyan  — rain just started
  update: 0xf5a623,   // amber          — still going, time ticking
  low:    0xff4d4d,   // red            — under 1 minute left
  end:    0x4a4a5a,   // muted slate    — rain over
};

function getWebhook() {
  if (!webhook) webhook = new WebhookClient({ url: WEBHOOK_URL });
  return webhook;
}

/** Returns remaining time as a human-readable string */
function formatTimeLeft(endsAt) {
  const ms = endsAt - Date.now();
  if (ms <= 0) return "Ended";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}h ${m}m`;
  }
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/** Unicode progress bar — e.g. ▓▓▓▓▓▓░░░░ */
function progressBar(endsAt, totalDuration) {
  const ms = endsAt - Date.now();
  const pct = Math.max(0, Math.min(1, ms / totalDuration));
  const FILLED = "▓";
  const EMPTY  = "░";
  const BARS   = 14;
  const filled = Math.round(pct * BARS);
  return FILLED.repeat(filled) + EMPTY.repeat(BARS - filled) + `  ${Math.round(pct * 100)}%`;
}

/** Format a coin amount with commas */
function formatAmount(amount) {
  const n = Number(amount);
  return isNaN(n) ? String(amount) : n.toLocaleString();
}

// ── Alert: Rain Just Started ──────────────────────────────────────────────────
async function sendRainStartAlert(rain) {
  const unixEnd = Math.floor(rain.endsAt / 1000);
  const timeLeft = formatTimeLeft(rain.endsAt);
  const bar = progressBar(rain.endsAt, rain.totalDuration ?? 5 * 60 * 1000);

  const embed = new EmbedBuilder()
    .setColor(COLORS.start)
    .setAuthor({
      name: "RustMagic Rain",
      iconURL: RUSTMAGIC_LOGO,
      url: "https://rustmagic.com",
    })
    .setTitle("🌧️  Rain Has Started!")
    .setDescription(
      `> Free coins are raining on **[RustMagic](https://rustmagic.com)**!\n> Claim yours before time runs out.\n\n` +
      `\`\`\`\n${bar}\n\`\`\``
    )
    .addFields(
      {
        name: "💰  Coin Amount",
        value: `\`\`${formatAmount(rain.amount)} ${rain.currency}\`\``,
        inline: true,
      },
      {
        name: "⏳  Time Remaining",
        value: `\`\`${timeLeft}\`\``,
        inline: true,
      },
      {
        name: "⏰  Ends",
        value: `<t:${unixEnd}:R> (<t:${unixEnd}:T>)`,
        inline: true,
      }
    )
    .setThumbnail(RUSTMAGIC_LOGO)
    .setFooter({ text: "RustMagic Rain Monitor  •  Updates every 60s" })
    .setTimestamp();

  try {
    const msg = await getWebhook().send({
      content: "@everyone 🌧️ **Rain is live on RustMagic — grab your free coins!**",
      embeds: [embed],
      username: "RustMagic Rain Bot",
      avatarURL: RUSTMAGIC_LOGO,
    });
    console.log(`✅  Rain start alert sent (ID: ${msg?.id})`);
    return msg?.id;
  } catch (err) {
    console.error("❌  Failed to send rain start alert:", err.message);
  }
}

// ── Alert: Rain Update (tick every minute) ────────────────────────────────────
async function sendRainUpdateAlert(rain) {
  const timeLeft = formatTimeLeft(rain.endsAt);
  if (timeLeft === "Ended") return sendRainEndAlert();

  const msLeft = rain.endsAt - Date.now();
  const isLow  = msLeft < 60_000;
  const bar    = progressBar(rain.endsAt, rain.totalDuration ?? 5 * 60 * 1000);
  const unixEnd = Math.floor(rain.endsAt / 1000);

  const embed = new EmbedBuilder()
    .setColor(isLow ? COLORS.low : COLORS.update)
    .setAuthor({
      name: "RustMagic Rain",
      iconURL: RUSTMAGIC_LOGO,
      url: "https://rustmagic.com",
    })
    .setTitle(isLow ? "⚠️  Rain Ending Soon!" : "🌧️  Rain Still Active")
    .setDescription(
      (isLow
        ? `> ⚠️ Less than a minute left — **claim now!**\n\n`
        : `> Coins are still raining on **[RustMagic](https://rustmagic.com)**!\n\n`) +
      `\`\`\`\n${bar}\n\`\`\``
    )
    .addFields(
      {
        name: "💰  Coin Amount",
        value: `\`\`${formatAmount(rain.amount)} ${rain.currency}\`\``,
        inline: true,
      },
      {
        name: "⏳  Time Remaining",
        value: `\`\`${timeLeft}\`\``,
        inline: true,
      },
      {
        name: "⏰  Ends",
        value: `<t:${unixEnd}:R>`,
        inline: true,
      }
    )
    .setThumbnail(RUSTMAGIC_LOGO)
    .setFooter({ text: "RustMagic Rain Monitor" })
    .setTimestamp();

  try {
    await getWebhook().send({
      content: isLow ? "@everyone ⚠️ **Rain is ending in under a minute!**" : undefined,
      embeds: [embed],
      username: "RustMagic Rain Bot",
      avatarURL: RUSTMAGIC_LOGO,
    });
    console.log(`🔄  Rain update sent — ${timeLeft} left${isLow ? " (LOW)" : ""}`);
  } catch (err) {
    console.error("❌  Failed to send rain update:", err.message);
  }
}

// ── Alert: Rain Ended ─────────────────────────────────────────────────────────
async function sendRainEndAlert() {
  const embed = new EmbedBuilder()
    .setColor(COLORS.end)
    .setAuthor({
      name: "RustMagic Rain",
      iconURL: RUSTMAGIC_LOGO,
      url: "https://rustmagic.com",
    })
    .setTitle("☀️  Rain Has Ended")
    .setDescription(
      "> The rain event has finished.\n" +
      "> Stay tuned — the next one could start any time!\n\n" +
      "```\n░░░░░░░░░░░░░░  0%\n```"
    )
    .setThumbnail(RUSTMAGIC_LOGO)
    .setFooter({ text: "RustMagic Rain Monitor  •  Watching for next rain…" })
    .setTimestamp();

  try {
    await getWebhook().send({
      embeds: [embed],
      username: "RustMagic Rain Bot",
      avatarURL: RUSTMAGIC_LOGO,
    });
    console.log("🏁  Rain end alert sent");
  } catch (err) {
    console.error("❌  Failed to send rain end alert:", err.message);
  }
}

// ─── Rain State Machine ───────────────────────────────────────────────────────
function startUpdateTimer() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(async () => {
    if (!activeRain) return clearInterval(updateTimer);
    if (Date.now() >= activeRain.endsAt) {
      await sendRainEndAlert();
      activeRain = null;
      clearInterval(updateTimer);
    } else {
      await sendRainUpdateAlert(activeRain);
    }
  }, UPDATE_INTERVAL_MS);
}

async function onRainStart(data) {
  console.log("🌧️  Rain event received:", JSON.stringify(data, null, 2));

  // Normalise the payload — RustMagic may use different field names
  const amount   = data.amount   ?? data.prize   ?? data.value  ?? data.coins ?? "?";
  const currency = data.currency ?? data.type     ?? "coins";
  // endsAt can be a Unix timestamp (seconds or ms) or an ISO string
  let endsAt = data.endsAt ?? data.end_time ?? data.endAt ?? data.expiry ?? null;
  if (!endsAt && data.duration) endsAt = Date.now() + data.duration * 1000;
  if (endsAt && endsAt < 1e12) endsAt *= 1000; // convert seconds → ms if needed

  if (!endsAt) {
    console.warn("⚠️  Could not determine rain end time from payload.");
    endsAt = Date.now() + 5 * 60 * 1000; // assume 5 min fallback
  }

  activeRain = { amount, currency, endsAt };

  const msgId = await sendRainStartAlert(activeRain);
  activeRain.messageId = msgId;
  startUpdateTimer();
}

function onRainEnd() {
  if (!activeRain) return;
  sendRainEndAlert();
  activeRain = null;
  if (updateTimer) clearInterval(updateTimer);
}

// ─── WebSocket Connection ─────────────────────────────────────────────────────
function connect() {
  console.log(`🔌  Connecting to ${RUSTMAGIC_WS} …`);

  socket = io(RUSTMAGIC_WS, {
    transports: ["websocket"],
    reconnectionAttempts: Infinity,
    reconnectionDelay: RECONNECT_DELAY_MS,
    timeout: 20000,
  });

  socket.on("connect", () => {
    console.log(`✅  Connected to RustMagic WebSocket (id: ${socket.id})`);
  });

  socket.on("disconnect", (reason) => {
    console.warn(`⚠️  Disconnected: ${reason}. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s …`);
  });

  socket.on("connect_error", (err) => {
    console.error("❌  Connection error:", err.message);
  });

  // ── Listen for known rain event names ─────────────────────────────────────
  const RAIN_START_EVENTS = ["rain", "rain:start", "rainStart", "newRain", "activeRain", "chat:rain"];
  const RAIN_END_EVENTS   = ["rain:end", "rainEnd", "rainStopped", "rainOver"];

  RAIN_START_EVENTS.forEach((evt) => {
    socket.on(evt, (data) => {
      console.log(`📡  Event "${evt}" received`);
      onRainStart(typeof data === "string" ? JSON.parse(data) : data);
    });
  });

  RAIN_END_EVENTS.forEach((evt) => {
    socket.on(evt, () => {
      console.log(`📡  Event "${evt}" received`);
      onRainEnd();
    });
  });

  // ── Debug: log ALL events (disable in production) ─────────────────────────
  if (process.env.DEBUG_EVENTS === "true") {
    const origOnevent = socket.onevent?.bind(socket);
    if (origOnevent) {
      socket.onevent = (packet) => {
        console.log("📦  RAW EVENT:", packet.data?.[0], packet.data?.[1]);
        origOnevent(packet);
      };
    }
  }
}

// ─── Polling Fallback (HTTP) ──────────────────────────────────────────────────
// Used if WebSocket events can't be detected. Polls a known API endpoint.
let lastRainId = null;

async function pollRainAPI() {
  try {
    const res = await fetch("https://rustmagic.com/api/rain/active", {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; RainMonitor/1.0)",
      },
    });

    if (!res.ok) return;
    const json = await res.json();

    // If there's an active rain and it's new
    const rain = json?.data ?? json?.rain ?? json;
    if (rain && rain.id && rain.id !== lastRainId) {
      lastRainId = rain.id;
      console.log("🌐  New rain detected via HTTP poll");
      await onRainStart(rain);
    } else if (!rain && activeRain) {
      console.log("🌐  Rain ended (HTTP poll)");
      onRainEnd();
    }
  } catch (err) {
    // Silently fail — WebSocket is primary
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
console.log("🤖  RustMagic Rain Bot starting …");
console.log(`    Webhook: ${WEBHOOK_URL.slice(0, 40)}…`);
console.log(`    WS URL:  ${RUSTMAGIC_WS}`);
console.log(`    Update interval: ${UPDATE_INTERVAL_MS / 1000}s`);
console.log(`    HTTP poll interval: ${CHECK_INTERVAL_MS / 1000}s`);

connect();
setInterval(pollRainAPI, CHECK_INTERVAL_MS);

process.on("SIGINT", () => {
  console.log("\n👋  Shutting down …");
  if (socket) socket.disconnect();
  process.exit(0);

// Keep-alive web server for UptimeRobot
const http = require("http");
http.createServer((req, res) => res.end("Bot is running!")).listen(3000, () => {
  console.log("🌐 Keep-alive server on port 3000");
});
