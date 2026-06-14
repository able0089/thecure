/**
 * Pokétwo Self-Bot Catcher
 * Railway-friendly | Anti-detection | Queue-based catching
 *
 * Required env vars:
 *   DISCORD_TOKEN  — your Discord account token
 *   CATEGORY_ID    — the category ID to watch for spawns
 *
 * Hardcoded server: 1437578148236754947
 */

const { Client } = require("discord.js-selfbot-v13");
const { resolveCatchName } = require("./aliases");

// ─── Config ──────────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_TOKEN;
const CATEGORY_ID = process.env.CATEGORY_ID;

const TARGET_SERVER_ID = "1437578148236754947";
const POKETWO_BOT_ID   = "716390085896962058";

// Delay before the FIRST catch in a batch (ms).
const MIN_CATCH_DELAY_MS = 1500;
const MAX_CATCH_DELAY_MS = 3500;

// Delay between consecutive queued catches (ms).
// All 6 channels spawn simultaneously every 20s → must catch all 6 within window.
const MIN_INTER_CATCH_DELAY_MS = 800;
const MAX_INTER_CATCH_DELAY_MS = 1800;

// How long to lock a channel after catching (ms).
const CHANNEL_LOCK_DURATION_MS = 8000;

// How long to remember a sent catch message for wrong-name fallback (ms).
const WRONG_NAME_WINDOW_MS = 25000;

// Pokemon names (lowercase) to silently ignore — never catch these.
const IGNORE_POKEMON = new Set([
  "absol",
]);

// ─── State ────────────────────────────────────────────────────────────────────

const catchQueue    = [];            // { channel, pokemonName, channelId }
const lockedChannels = new Set();    // channels locked after a catch

// Tracks the most recent catch attempt per channel for wrong-name retry.
// Map<channelId, { originalName: string, timer: Timeout }>
const recentCatches = new Map();

// When true, no new catches are queued (set after verification, cleared by resume cmd).
let isPaused = false;

let isProcessing = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay(min, max) {
  return sleep(randomInt(min, max));
}

function log(tag, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tag}] ${msg}`);
}

// ─── Queue processor ─────────────────────────────────────────────────────────

async function processQueue() {
  if (isProcessing || catchQueue.length === 0) return;
  isProcessing = true;

  let firstInBatch = true;

  while (catchQueue.length > 0) {
    const { channel, pokemonName, channelId } = catchQueue.shift();

    log("CATCH", `Processing: ${pokemonName} in #${channel.name} (${catchQueue.length} remaining)`);

    // First catch gets full human reaction delay; subsequent catches just need
    // a short tab-switch jitter since the inter-catch delay already ran.
    if (firstInBatch) {
      await randomDelay(MIN_CATCH_DELAY_MS, MAX_CATCH_DELAY_MS);
      firstInBatch = false;
    } else {
      await randomDelay(400, 1200);
    }

    try {
      await channel.sendTyping();
      await sleep(randomInt(400, 900));

      const catchName = resolveCatchName(pokemonName);
      const sentMsg = await channel.send(`<@${POKETWO_BOT_ID}> c ${catchName}`);
      log("CAUGHT", `${pokemonName} → ${catchName} in #${channel.name}`);

      // Store sent message + original name for wrong-name fallback.
      // Only needed when we used an alias (if no alias, English name was already sent).
      if (catchName.toLowerCase() !== pokemonName.toLowerCase()) {
        const prev = recentCatches.get(channelId);
        if (prev) clearTimeout(prev.timer);

        const timer = setTimeout(() => recentCatches.delete(channelId), WRONG_NAME_WINDOW_MS);
        recentCatches.set(channelId, { originalName: pokemonName, sentMsg, timer });
        log("TRACK", `Tracking wrong-name fallback for ${pokemonName} → ${catchName} (${WRONG_NAME_WINDOW_MS / 1000}s window)`);
      }
    } catch (err) {
      log("ERROR", `Failed to catch ${pokemonName}: ${err.message}`);
    }

    // Lock channel so we don't re-queue the same spawn
    lockedChannels.add(channelId);
    setTimeout(() => {
      lockedChannels.delete(channelId);
      log("UNLOCK", `Channel ${channelId} unlocked`);
    }, CHANNEL_LOCK_DURATION_MS);

    if (catchQueue.length > 0) {
      log("QUEUE", `${catchQueue.length} pokemon waiting — pausing before next catch`);
      await randomDelay(MIN_INTER_CATCH_DELAY_MS, MAX_INTER_CATCH_DELAY_MS);
    }
  }

  isProcessing = false;
}

// ─── Pokemon name extractor ───────────────────────────────────────────────────

function extractPokemonName(message) {
  const sources = [message.content || ""];

  for (const embed of message.embeds) {
    if (embed.title)       sources.push(embed.title);
    if (embed.description) sources.push(embed.description);
  }

  for (const text of sources) {
    const match = text.match(/\*\*([A-Za-z][A-Za-z\s'.\u2019-]{0,30})\*\*/);
    if (match) {
      const name = match[1].trim();
      const wordCount = name.split(/\s+/).length;
      if (wordCount >= 1 && wordCount <= 4 && /^[A-Za-z][A-Za-z\s'.\u2019-]+$/.test(name)) {
        return name.toLowerCase();
      }
    }
  }

  return null;
}

// ─── Poketwo verification detector ───────────────────────────────────────────

function isVerificationMessage(message) {
  const content    = (message.content || "").toLowerCase();
  const hasLink    = /https?:\/\/\S+/.test(message.content || "");
  const embedText  = message.embeds
    .map((e) => [e.title || "", e.description || ""].join(" "))
    .join(" ")
    .toLowerCase();

  const verifyKeywords = ["verify", "captcha", "are you a bot", "human verification", "anti-bot"];
  const matchesKeyword =
    verifyKeywords.some((kw) => content.includes(kw)) ||
    verifyKeywords.some((kw) => embedText.includes(kw));

  return hasLink && matchesKeyword;
}

// ─── Wrong-name detector ─────────────────────────────────────────────────────

function isWrongNameMessage(content) {
  const lower = content.toLowerCase();
  return (
    lower.includes("that is the wrong") ||
    lower.includes("that's the wrong") ||
    lower.includes("wrong pokémon") ||
    lower.includes("wrong pokemon") ||
    lower.includes("incorrect pokémon") ||
    lower.includes("incorrect pokemon")
  );
}

// ─── Client setup ────────────────────────────────────────────────────────────

const client = new Client({ checkUpdate: false });

client.on("ready", () => {
  log("READY", `Logged in as ${client.user.tag}`);
  log("READY", `Target server : ${TARGET_SERVER_ID}`);
  log("READY", `Category filter: ${CATEGORY_ID || "⚠️  NOT SET"}`);
  if (!CATEGORY_ID) {
    console.warn("\n⚠️  WARNING: CATEGORY_ID is not set. Bot will NOT catch until you set it.\n");
  }
});

client.on("messageCreate", async (message) => {
  try {
    // ── Server gate ──────────────────────────────────────────────────────────
    if (!message.guild || message.guild.id !== TARGET_SERVER_ID) return;

    // ── Resume command — check before category gate so it works from anywhere
    // in the server. Triggered when anyone (including the account itself) sends
    // the resume command.
    const rawContent = message.content || "";
    if (rawContent.includes(`<@${POKETWO_BOT_ID}> inc r all -y`)) {
      if (isPaused) {
        isPaused = false;
        log("RESUME", "Bot resumed — catching is active again");
      }
      return;
    }

    // ── Category gate ────────────────────────────────────────────────────────
    if (CATEGORY_ID && message.channel.parentId !== CATEGORY_ID) return;

    // ── Poketwo message handlers ─────────────────────────────────────────────
    if (message.author.id === POKETWO_BOT_ID) {
      const content = rawContent;
      const lower   = content.toLowerCase();

      // 1. Verification — send once, then pause all catching until resume cmd
      if (isVerificationMessage(message)) {
        if (!isPaused) {
          log("VERIFY", "Verification detected — sending inc p all -y and pausing bot");
          await sleep(randomInt(1000, 3000));
          await message.channel.send(`<@${POKETWO_BOT_ID}> inc p all -y`);
          isPaused = true;
          log("PAUSED", `Bot paused. Send '<@${POKETWO_BOT_ID}> inc r all -y' to resume.`);
        } else {
          log("VERIFY", "Verification detected but bot is already paused — ignoring");
        }
        return;
      }

      // 2. Wrong pokemon name — retry with original detected English name
      if (isWrongNameMessage(lower)) {
        const channelId = message.channel.id;
        const tracked   = recentCatches.get(channelId);
        if (tracked) {
          const { originalName, sentMsg, timer } = tracked;
          clearTimeout(timer);
          recentCatches.delete(channelId);
          log("WRONG", `Wrong name in #${message.channel.name} — editing to original: ${originalName}`);
          await sleep(randomInt(600, 1500));
          await sentMsg.edit(`<@${POKETWO_BOT_ID}> c ${originalName}`);
          log("RETRY", `Edited catch message to: ${originalName} in #${message.channel.name}`);
        } else {
          log("WRONG", `Wrong name detected in #${message.channel.name} but no tracked catch to retry`);
        }
        return;
      }

      // 3. Quest completion
      if (lower.includes("completed all your quests")) {
        log("QUEST", "All quests completed — responding with ev o 3");
        await sleep(randomInt(1500, 4000));
        await message.channel.send(`<@${POKETWO_BOT_ID}> ev o 3`);
        return;
      }

      return;
    }

    // ── Spawn detection (only from bots, not self) ───────────────────────────
    if (!message.author.bot) return;

    // Skip all catches while paused (waiting for verification)
    if (isPaused) {
      log("PAUSED", `Spawn ignored (bot paused) — channel #${message.channel.name}`);
      return;
    }

    const pokemonName = extractPokemonName(message);
    if (!pokemonName) return;

    // Skip ignored pokemon
    if (IGNORE_POKEMON.has(pokemonName.toLowerCase())) {
      log("IGNORE", `Skipping ignored pokemon: ${pokemonName}`);
      return;
    }

    const channelId = message.channel.id;

    // Skip if channel is locked
    if (lockedChannels.has(channelId)) {
      log("SKIP", `Channel ${channelId} locked — ignoring ${pokemonName}`);
      return;
    }

    // Skip if already queued for this channel
    const alreadyQueued = catchQueue.some((item) => item.channelId === channelId);
    if (alreadyQueued) {
      log("SKIP", `Channel ${channelId} already queued — ignoring duplicate ${pokemonName}`);
      return;
    }

    lockedChannels.add(channelId);
    catchQueue.push({ channel: message.channel, pokemonName, channelId });
    log("QUEUE", `Queued: ${pokemonName} from #${message.channel.name} (queue size: ${catchQueue.length})`);

    processQueue();
  } catch (err) {
    log("ERROR", `Unhandled error in messageCreate: ${err.message}`);
  }
});

client.on("error", (err) => {
  log("ERROR", `Client error: ${err.message}`);
});

// ─── Login ────────────────────────────────────────────────────────────────────

if (!TOKEN) {
  console.error("[FATAL] DISCORD_TOKEN environment variable is not set. Exiting.");
  process.exit(1);
}

log("START", "Connecting to Discord...");
client.login(TOKEN).catch((err) => {
  console.error(`[FATAL] Login failed: ${err.message}`);
  process.exit(1);
});
