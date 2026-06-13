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

// ─── Config ──────────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_TOKEN;
const CATEGORY_ID = process.env.CATEGORY_ID; // Set this in Railway

const TARGET_SERVER_ID = "1437578148236754947"; // Hardcoded server
const POKETWO_BOT_ID = "716390085896962058";    // Pokétwo bot user ID

// Catching delay range (ms) — randomized per catch.
// Spawns happen every ~20s so catching within 3–13s looks human.
const MIN_CATCH_DELAY_MS = 3000;
const MAX_CATCH_DELAY_MS = 13000;

// Delay between catching multiple queued pokemon (ms)
const MIN_INTER_CATCH_DELAY_MS = 4000;
const MAX_INTER_CATCH_DELAY_MS = 11000;

// How long to lock a channel after catching (ms) — prevents double-catching
// on the same spawn before the next one arrives
const CHANNEL_LOCK_DURATION_MS = 22000;

// ─── State ────────────────────────────────────────────────────────────────────

const catchQueue = [];            // { channel, pokemonName, channelId }
const lockedChannels = new Set(); // channels currently locked after a catch
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

  while (catchQueue.length > 0) {
    const { channel, pokemonName, channelId } = catchQueue.shift();

    log("CATCH", `Processing: ${pokemonName} in #${channel.name} (${catchQueue.length} remaining in queue)`);

    // Simulate human thinking + typing before catching
    await randomDelay(MIN_CATCH_DELAY_MS, MAX_CATCH_DELAY_MS);

    try {
      await channel.sendTyping();
      // Small extra jitter after typing starts
      await sleep(randomInt(400, 1200));
      await channel.send(`<@${POKETWO_BOT_ID}> c ${pokemonName}`);
      log("CAUGHT", `${pokemonName} in #${channel.name}`);
    } catch (err) {
      log("ERROR", `Failed to catch ${pokemonName}: ${err.message}`);
    }

    // Lock channel so we don't re-queue the same spawn
    lockedChannels.add(channelId);
    setTimeout(() => {
      lockedChannels.delete(channelId);
      log("UNLOCK", `Channel ${channelId} unlocked`);
    }, CHANNEL_LOCK_DURATION_MS);

    // If more pokemon are waiting, add inter-catch delay
    if (catchQueue.length > 0) {
      log("QUEUE", `${catchQueue.length} pokemon waiting — pausing before next catch`);
      await randomDelay(MIN_INTER_CATCH_DELAY_MS, MAX_INTER_CATCH_DELAY_MS);
    }
  }

  isProcessing = false;
}

// ─── Pokemon name extractor ───────────────────────────────────────────────────

/**
 * Extracts a bold pokemon name from message content or embed description/title.
 * Matches: **Magnemite**, **Alolan Vulpix**, etc.
 * Ignores: very long bold strings (not pokemon names).
 */
function extractPokemonName(message) {
  const sources = [message.content || ""];

  // Also check embeds (some naming bots use embeds)
  for (const embed of message.embeds) {
    if (embed.title) sources.push(embed.title);
    if (embed.description) sources.push(embed.description);
  }

  for (const text of sources) {
    // Match **Name** — pokemon names can have spaces (Alolan forms, etc.)
    const match = text.match(/\*\*([A-Za-z][A-Za-z\s'.-]{0,30})\*\*/);
    if (match) {
      const name = match[1].trim();
      // Sanity check: real pokemon names are 1–3 words, no weird characters
      const wordCount = name.split(/\s+/).length;
      if (wordCount >= 1 && wordCount <= 3 && /^[A-Za-z][A-Za-z\s'.-]+$/.test(name)) {
        return name.toLowerCase();
      }
    }
  }

  return null;
}

// ─── Poketwo verification detector ───────────────────────────────────────────

function isVerificationMessage(message) {
  const content = (message.content || "").toLowerCase();

  // Poketwo verification messages typically contain a URL
  const hasLink = /https?:\/\/\S+/.test(message.content || "");

  // Also check embed descriptions (Poketwo sometimes embeds the verify link)
  const embedText = message.embeds
    .map((e) => [e.title || "", e.description || ""].join(" "))
    .join(" ")
    .toLowerCase();

  const verifyKeywords = ["verify", "captcha", "are you a bot", "human verification", "anti-bot"];
  const matchesKeyword =
    verifyKeywords.some((kw) => content.includes(kw)) ||
    verifyKeywords.some((kw) => embedText.includes(kw));

  return hasLink && matchesKeyword;
}

// ─── Client setup ────────────────────────────────────────────────────────────

const client = new Client({ checkUpdate: false });

client.on("ready", () => {
  log("READY", `Logged in as ${client.user.tag}`);
  log("READY", `Target server : ${TARGET_SERVER_ID}`);
  log("READY", `Category filter: ${CATEGORY_ID || "⚠️  NOT SET — please set CATEGORY_ID env var"}`);
  if (!CATEGORY_ID) {
    console.warn("\n⚠️  WARNING: CATEGORY_ID is not set. The bot will NOT catch any pokemon until you set it.\n");
  }
});

client.on("messageCreate", async (message) => {
  try {
    // ── Server gate ──────────────────────────────────────────────────────────
    if (!message.guild || message.guild.id !== TARGET_SERVER_ID) return;

    // ── Category gate ────────────────────────────────────────────────────────
    if (CATEGORY_ID && message.channel.parentId !== CATEGORY_ID) return;

    // ── Poketwo special handlers (runs on all channels in server) ────────────
    if (message.author.id === POKETWO_BOT_ID) {
      const content = message.content || "";

      // 1. Verification link
      if (isVerificationMessage(message)) {
        log("VERIFY", "Verification detected — responding to inc p all -y");
        await sleep(randomInt(1000, 3000));
        await message.channel.send(`<@${POKETWO_BOT_ID}> inc p all -y`);
        return;
      }

      // 2. Quest completion — must include the word "all" AND "completed"
      const lower = content.toLowerCase();
      if (lower.includes("completed all your quests")) {
        log("QUEST", "All quests completed — responding with ev o 3");
        await sleep(randomInt(1500, 4000));
        await message.channel.send(`<@${POKETWO_BOT_ID}> ev o 3`);
        return;
      }

      // Don't process Poketwo's own messages further
      return;
    }

    // ── Spawn detection (only from other bots) ───────────────────────────────
    if (!message.author.bot) return;

    const pokemonName = extractPokemonName(message);
    if (!pokemonName) return;

    const channelId = message.channel.id;

    // Skip if channel is locked (already catching / just caught)
    if (lockedChannels.has(channelId)) {
      log("SKIP", `Channel ${channelId} is locked — ignoring ${pokemonName}`);
      return;
    }

    // Skip if this channel is already in the queue
    const alreadyQueued = catchQueue.some((item) => item.channelId === channelId);
    if (alreadyQueued) {
      log("SKIP", `Channel ${channelId} already queued — ignoring duplicate ${pokemonName}`);
      return;
    }

    // Lock channel immediately to prevent any race condition duplicates
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
