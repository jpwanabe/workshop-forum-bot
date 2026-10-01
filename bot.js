require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder
} = require("discord.js");

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");
const STATE_TEMP_PATH = path.join(__dirname, "state.json.tmp");
class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const FORUM_CHANNEL_ID = process.env.DISCORD_FORUM_CHANNEL_ID;

let config;
let forumChannel;

let shuttingDown = false;
let workshopTimer = null;
let subscriberTimer = null;
let activeClient = null;

let newItemCheckRunning = false;
let subscriberUpdateRunning = false;
let subscriberUpdateWaiting = false;

let stateWorkOwner = null;
const stateWorkWaiters = [];

async function acquireStateWork(owner) {
  if (owner === "subscriber") {
    subscriberUpdateWaiting = true;
  }

  if (stateWorkOwner === null) {
    stateWorkOwner = owner;

    if (owner === "subscriber") {
      subscriberUpdateWaiting = false;
    }

    return;
  }

  await new Promise(resolve => {
    stateWorkWaiters.push({
      owner,
      resolve
    });
  });

  if (owner === "subscriber") {
    subscriberUpdateWaiting = false;
  }
}

function releaseStateWork(owner) {
  if (stateWorkOwner !== owner) {
    throw new Error(
      `State work lock release mismatch: ${owner} tried to release ` +
      `${stateWorkOwner ?? "an unlocked lock"}.`
    );
  }

  if (!stateWorkWaiters.length) {
    stateWorkOwner = null;
    return;
  }

  let nextIndex = 0;

  if (subscriberUpdateWaiting) {
    const subscriberIndex = stateWorkWaiters.findIndex(
      waiter => waiter.owner === "subscriber"
    );

    if (subscriberIndex !== -1) {
      nextIndex = subscriberIndex;
    }
  }

  const [next] = stateWorkWaiters.splice(nextIndex, 1);

  stateWorkOwner = next.owner;
  next.resolve();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logError(prefix, error) {
  if (error instanceof UserError) {
    console.error(`${prefix}: ${error.message}`);
    return;
  }

  console.error(`${prefix}:`, error);
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  log(`Received ${signal}. Shutting down...`);

  if (workshopTimer) {
    clearTimeout(workshopTimer);
    workshopTimer = null;
  }

  if (subscriberTimer) {
    clearTimeout(subscriberTimer);
    subscriberTimer = null;
  }

  try {
    if (activeClient) {
      activeClient.destroy();
      activeClient = null;
    }
  } catch (error) {
    logError("Error while disconnecting from Discord", error);
  }

  log("Shutdown complete.");
  process.exit(0);
}


process.once("SIGINT", () => {
  shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});

function validateEnvironment() {
  const missing = [];

  if (!STEAM_API_KEY) missing.push("STEAM_API_KEY");
  if (!DISCORD_TOKEN) missing.push("DISCORD_TOKEN");
  if (!FORUM_CHANNEL_ID) missing.push("DISCORD_FORUM_CHANNEL_ID");

  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`
    );
  }
}

function validateConfig(loaded) {
  const errors = [];

  // Steam AppID
  if (
    !Number.isInteger(Number(loaded.steam?.appId)) ||
    Number(loaded.steam?.appId) <= 0
  ) {
    errors.push(
      "steam.appId must be a positive Steam AppID."
    );
  }

  // Workshop filter
  const filterMode = loaded.steam?.filter?.mode;

  if (!["all", "include"].includes(filterMode)) {
    errors.push(
      'steam.filter.mode must be either "all" or "include".'
    );
  }

  if (!Array.isArray(loaded.steam?.filter?.tags)) {
    errors.push(
      "steam.filter.tags must be an array."
    );
  }

  if (
    filterMode === "include" &&
    Array.isArray(loaded.steam?.filter?.tags) &&
    loaded.steam.filter.tags.length === 0
  ) {
    errors.push(
      'steam.filter.tags must contain at least one tag when steam.filter.mode is "include".'
    );
  }

  if (
    loaded.steam?.filter?.matchAll !== undefined &&
    typeof loaded.steam.filter.matchAll !== "boolean"
  ) {
    errors.push(
      "steam.filter.matchAll must be true or false."
    );
  }

  if (
    loaded.steam?.filter?.excludeTags !== undefined &&
    !Array.isArray(loaded.steam.filter.excludeTags)
  ) {
    errors.push(
      "steam.filter.excludeTags must be an array."
    );
  }

  // Discord
  if (
    !Number.isInteger(Number(loaded.discord?.descriptionLimit)) ||
    Number(loaded.discord?.descriptionLimit) < 1 ||
    Number(loaded.discord?.descriptionLimit) > 4096
  ) {
    errors.push(
      "discord.descriptionLimit must be a whole number from 1 to 4096."
    );
  }

  // Monitoring
  if (
    !Number.isFinite(Number(loaded.monitor?.newItemCheckMinutes)) ||
    Number(loaded.monitor?.newItemCheckMinutes) < 1
  ) {
    errors.push(
      "monitor.newItemCheckMinutes must be a number of at least 1."
    );
  }

  if (
    !Number.isFinite(Number(loaded.monitor?.subscriberUpdateHours)) ||
    Number(loaded.monitor?.subscriberUpdateHours) < 1
  ) {
    errors.push(
      "monitor.subscriberUpdateHours must be a number of at least 1."
    );
  }

  // Posting
  if (
    !Number.isFinite(Number(loaded.posting?.delaySeconds)) ||
    Number(loaded.posting?.delaySeconds) < 1
  ) {
    errors.push(
      "posting.delaySeconds must be a number of at least 1."
    );
  }

  if (
    !Number.isFinite(Number(loaded.posting?.subscriberUpdateDelayMs)) ||
    Number(loaded.posting?.subscriberUpdateDelayMs) < 0
  ) {
    errors.push(
      "posting.subscriberUpdateDelayMs must be a number of 0 or greater."
    );
  }

  // Initial import
  const importMode = loaded.initialImport?.mode;

  if (!["all", "latest", "none"].includes(importMode)) {
    errors.push(
      'initialImport.mode must be "all", "latest", or "none".'
    );
  }

  if (
    !Number.isInteger(Number(loaded.initialImport?.limit)) ||
    Number(loaded.initialImport?.limit) < 0
  ) {
    errors.push(
      "initialImport.limit must be a whole number of 0 or greater."
    );
  }

  if (
    importMode === "latest" &&
    Number(loaded.initialImport?.limit) < 1
  ) {
    errors.push(
      'initialImport.limit must be at least 1 when initialImport.mode is "latest".'
    );
  }

  // Validate individual tag values too.
  if (Array.isArray(loaded.steam?.filter?.tags)) {
    loaded.steam.filter.tags.forEach((tag, index) => {
      if (typeof tag !== "string" || !tag.trim()) {
        errors.push(
          `steam.filter.tags[${index}] must be a non-empty string.`
        );
      }
    });
  }

  if (Array.isArray(loaded.steam?.filter?.excludeTags)) {
    loaded.steam.filter.excludeTags.forEach((tag, index) => {
      if (typeof tag !== "string" || !tag.trim()) {
        errors.push(
          `steam.filter.excludeTags[${index}] must be a non-empty string.`
        );
      }
    });
  }

  if (errors.length) {
    throw new UserError(
      "Configuration error(s):\n\n" +
      errors.map(error => `  - ${error}`).join("\n")
    );
  }
}

async function loadConfig() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");

  let loaded;

  try {
    loaded = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `config.json contains invalid JSON:\n${error.message}`
    );
  }

  // Sections that can safely receive defaults.
  loaded.steam ??= {};
  loaded.steam.filter ??= {};

  loaded.discord ??= {};
  loaded.monitor ??= {};
  loaded.posting ??= {};
  loaded.initialImport ??= {};

  // Defaults.
  loaded.steam.filter.mode ??= "all";
  loaded.steam.filter.tags ??= [];
  loaded.steam.filter.matchAll ??= true;
  loaded.steam.filter.excludeTags ??= [];

  loaded.discord.descriptionLimit ??= 500;

  loaded.monitor.newItemCheckMinutes ??= 5;
  loaded.monitor.subscriberUpdateHours ??= 6;

  loaded.posting.delaySeconds ??= 10;
  loaded.posting.subscriberUpdateDelayMs ??= 500;

  loaded.initialImport.mode ??= "all";
  loaded.initialImport.limit ??= 0;

  // Validate before converting values.
  validateConfig(loaded);

  // Normalize numeric values after validation.
  loaded.steam.appId =
    Number(loaded.steam.appId);

  loaded.discord.descriptionLimit =
    Number(loaded.discord.descriptionLimit);

  loaded.monitor.newItemCheckMinutes =
    Number(loaded.monitor.newItemCheckMinutes);

  loaded.monitor.subscriberUpdateHours =
    Number(loaded.monitor.subscriberUpdateHours);

  loaded.posting.delaySeconds =
    Number(loaded.posting.delaySeconds);

  loaded.posting.subscriberUpdateDelayMs =
    Number(loaded.posting.subscriberUpdateDelayMs);

  loaded.initialImport.limit =
    Number(loaded.initialImport.limit);

  return loaded;
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");

    let state;

    try {
      state = JSON.parse(raw);
    } catch (error) {
      throw new UserError(
        `state.json contains invalid JSON:\n${error.message}`
      );
    }

    if (!state || typeof state !== "object") {
      throw new UserError(
        "state.json does not contain a valid state object."
      );
    }

    if (!state.version) {
      throw new UserError(
        "state.json is missing its version."
      );
    }

    if (!state.appId) {
      throw new UserError(
        "state.json is missing its Steam AppID."
      );
    }

    if (
      String(state.appId) !==
      String(config.steam.appId)
    ) {
      throw new UserError(
        `state.json belongs to Steam AppID ${state.appId}, ` +
        `but config.json is configured for AppID ${config.steam.appId}.\n` +
        `If you intentionally changed games, move or delete state.json ` +
        `before starting the bot.`
      );
    }

    if (
      !state.items ||
      typeof state.items !== "object" ||
      Array.isArray(state.items)
    ) {
      throw new UserError(
        "state.json is missing a valid items object."
      );
    }

    return state;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function saveState(state) {
  const json = JSON.stringify(state, null, 2) + "\n";

  await fs.writeFile(STATE_TEMP_PATH, json, "utf8");
  await fs.rename(STATE_TEMP_PATH, STATE_PATH);
}

function truncateDescription(text, maxLength) {
  if (!text || !text.trim()) {
    return "No description provided.";
  }

  const cleaned = text.trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  const shortened = cleaned.slice(0, maxLength - 3);
  const lastSpace = shortened.lastIndexOf(" ");

  if (lastSpace > Math.floor(maxLength * 0.8)) {
    return shortened.slice(0, lastSpace) + "...";
  }

  return shortened + "...";
}

function workshopUrl(item) {
  return (
    "https://steamcommunity.com/sharedfiles/filedetails/?id=" +
    item.publishedfileid
  );
}

async function steamGet(endpoint, params) {
  const query = new URLSearchParams({
    key: STEAM_API_KEY,
    ...params
  });

  const response = await fetch(
    `https://api.steampowered.com/${endpoint}?${query.toString()}`
  );

  if (!response.ok) {
    throw new Error(
      `Steam API request failed: HTTP ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}

async function getAllWorkshopItems() {
  const items = [];

  let cursor = "*";
  let previousCursor = null;

  while (true) {
    const params = new URLSearchParams({
      key: STEAM_API_KEY,
      appid: String(config.steam.appId),
      query_type: "1",
      numperpage: "100",
      cursor,
      return_metadata: "true",
      return_tags: "true",
      return_previews: "true"
    });

    const url =
      "https://api.steampowered.com/" +
      "IPublishedFileService/QueryFiles/v1/?" +
      params.toString();

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Steam QueryFiles request failed: ` +
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();

    const pageItems =
      data.response?.publishedfiledetails ?? [];

    items.push(...pageItems);

    const nextCursor = data.response?.next_cursor;

    // No more results.
    if (!nextCursor || pageItems.length === 0) {
      break;
    }

    // Defensive protection against Steam unexpectedly returning
    // the same cursor repeatedly.
    if (
      nextCursor === cursor ||
      nextCursor === previousCursor
    ) {
      throw new Error(
        "Steam QueryFiles returned a repeated cursor. " +
        "Stopping to prevent an infinite request loop."
      );
    }

    previousCursor = cursor;
    cursor = nextCursor;
  }

  return items;
}


async function getWorkshopDetails(publishedFileIds) {
  const uniqueIds = [
    ...new Set(
      publishedFileIds
        .map(id => String(id))
        .filter(Boolean)
    )
  ];

  const items = [];

  // Keep requests reasonably sized. This also prevents one huge
  // installation from creating an enormous request URL.
  const batchSize = 100;

  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);

    const input = {
      publishedfileids: batch,
      includetags: true,
      includeadditionalpreviews: true,
      includechildren: false,
      includekvtags: false,
      includevotes: false,
      short_description: false,
      includeforsaledata: false,
      includemetadata: true,
      appid: Number(config.steam.appId),
      strip_description_bbcode: true
    };

    const query = new URLSearchParams({
      key: STEAM_API_KEY,
      input_json: JSON.stringify(input)
    });

    const response = await fetch(
      "https://api.steampowered.com/" +
      "IPublishedFileService/GetDetails/v1/?" +
      query.toString()
    );

    if (!response.ok) {
      throw new Error(
        `Steam GetDetails request failed: ` +
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();

    items.push(
      ...(data.response?.publishedfiledetails ?? [])
    );
  }

  return items;
}

async function getCreators(steamIds) {
  const uniqueIds = [...new Set(steamIds.filter(Boolean))];
  const creators = new Map();

  // Steam GetPlayerSummaries accepts batches.
  for (let i = 0; i < uniqueIds.length; i += 100) {
    const batch = uniqueIds.slice(i, i + 100);

    const data = await steamGet(
      "ISteamUser/GetPlayerSummaries/v2/",
      {
        steamids: batch.join(",")
      }
    );

    for (const player of data.response?.players ?? []) {
      creators.set(player.steamid, {
        name: player.personaname,
        profileUrl: player.profileurl
      });
    }
  }

  return creators;
}

function buildEmbed(item, creator) {
  const url = workshopUrl(item);

  const creatorName =
    creator?.name ??
    `Steam user ${item.creator}`;

  const creatorUrl =
    creator?.profileUrl ??
    `https://steamcommunity.com/profiles/${item.creator}/`;

  const embed = new EmbedBuilder()
    .setAuthor({
      name: `Created by ${creatorName}`,
      url: creatorUrl
    })
    .setDescription(
      truncateDescription(
        item.file_description,
        config.discord.descriptionLimit
      )
    )
    .addFields(
      {
        name: "Subscribers",
        value: Number(item.subscriptions ?? 0).toLocaleString(),
        inline: true
      },
      {
        name: "Steam Workshop",
        value: `[View Workshop Item](${url})`,
        inline: true
      }
    )
    .setURL(url);

  if (item.preview_url) {
    embed.setImage(item.preview_url);
  }

  return embed;
}

async function createForumPost(item, creator) {
  const embed = buildEmbed(item, creator);

  const thread = await forumChannel.threads.create({
    name: item.title.slice(0, 100),
    message: {
      embeds: [embed]
    }
  });

  const starterMessage = await thread.fetchStarterMessage();

  if (!starterMessage) {
    throw new Error(
      `Could not retrieve starter message for thread ${thread.id}`
    );
  }

  return {
    threadId: thread.id,
    messageId: starterMessage.id
  };
}

function createEmptyState() {
  return {
    version: 1,
    appId: String(config.steam.appId),
    initializedAt: new Date().toISOString(),
    items: {}
  };
}

async function establishInitialState(items) {
  const state = createEmptyState();

  const mode = config.initialImport.mode;

  if (mode === "none") {
    for (const item of items) {
      state.items[item.publishedfileid] = {
        baseline: true,
        threadId: null,
        messageId: null,
        subscribers: Number(item.subscriptions ?? 0)
      };
    }

    await saveState(state);

    log(
      `Initial baseline complete. ${items.length} existing Workshop item(s) ` +
      `recorded without posting.`
    );

    return state;
  }

  let itemsToPost = [...items];

  // Always post oldest -> newest.
  itemsToPost.sort(
    (a, b) =>
      Number(a.time_created ?? 0) -
      Number(b.time_created ?? 0)
  );

  if (mode === "latest") {
    const limit = config.initialImport.limit;

    // Keep only the newest X, while retaining oldest -> newest
    // ordering among those selected items.
    itemsToPost = itemsToPost.slice(-limit);

    const selectedIds = new Set(
      itemsToPost.map(item => item.publishedfileid)
    );

    // Anything older than the selected import window becomes a
    // baseline item so it will not suddenly post later.
    for (const item of items) {
      if (!selectedIds.has(item.publishedfileid)) {
        state.items[item.publishedfileid] = {
          baseline: true,
          threadId: null,
          messageId: null,
          subscribers: Number(item.subscriptions ?? 0)
        };
      }
    }
  }

  // Save immediately, even before posting.
  await saveState(state);

  log(
    `Initial import mode "${mode}". ` +
    `${itemsToPost.length} Workshop item(s) will be posted.`
  );

  const creators = await getCreators(
    itemsToPost.map(item => item.creator)
  );

  for (let i = 0; i < itemsToPost.length; i++) {
    const item = itemsToPost[i];

    // This check makes the import restart-safe.
    if (state.items[item.publishedfileid]) {
      continue;
    }

    try {
      const creator = creators.get(item.creator);

      log(
        `Initial import ${i + 1}/${itemsToPost.length}: ` +
        `${item.title} (${item.publishedfileid})`
      );

      const discord = await createForumPost(item, creator);

      state.items[item.publishedfileid] = {
        baseline: false,
        threadId: discord.threadId,
        messageId: discord.messageId,
        subscribers: Number(item.subscriptions ?? 0)
      };

      // Persist every successful post immediately.
      await saveState(state);

      log(`Posted "${item.title}" successfully.`);

      if (i < itemsToPost.length - 1) {
        log(
          `Waiting ${config.posting.delaySeconds} second(s) before next post.`
        );

        await sleep(config.posting.delaySeconds * 1000);
      }
    } catch (error) {
      log(
        `Failed initial import for ${item.publishedfileid}: ` +
        `${error.stack ?? error}`
      );
    }
  }

  log("Initial Workshop import complete.");

  return state;
}

async function checkForNewItems() {
  if (newItemCheckRunning) {
    log("New-item check skipped because the previous check is still running.");
    return;
  }

  newItemCheckRunning = true;
  let lockAcquired = false;

  try {
    if (subscriberUpdateWaiting || stateWorkOwner === "subscriber") {
      log("New-item check waiting for subscriber update to finish.");
    }

    await acquireStateWork("workshop");
    lockAcquired = true;
    let state = await loadState();
    const items = await getAllWorkshopItems();

    if (!state) {
      await establishInitialState(items);
      return;
    }

    const newItems = items.filter(
      item => !state.items[item.publishedfileid]
    );

    if (!newItems.length) {
      log(`Workshop check complete. No new items. Total visible: ${items.length}.`);
      return;
    }

    // Oldest first so multiple new uploads appear in chronological order.
    newItems.sort(
      (a, b) => Number(a.time_created ?? 0) - Number(b.time_created ?? 0)
    );

    const creators = await getCreators(
      newItems.map(item => item.creator)
    );

    log(`Found ${newItems.length} new Workshop item(s).`);

    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i];
      try {
        const creator = creators.get(item.creator);

        log(`Posting Workshop item ${item.publishedfileid}: ${item.title}`);

        const discord = await createForumPost(item, creator);

        state.items[item.publishedfileid] = {
          baseline: false,
          threadId: discord.threadId,
          messageId: discord.messageId,
          subscribers: Number(item.subscriptions ?? 0)
        };

        // Save after every successful post so a later failure cannot
        // cause already-posted items to be duplicated after restart.
        await saveState(state);

        log(`Posted "${item.title}" successfully.`);
		if (i < newItems.length - 1) {
          log(
            `Waiting ${config.posting.delaySeconds} second(s) before next post.`
          );

          await sleep(config.posting.delaySeconds * 1000);
        }
      } catch (error) {
        log(
          `Failed to post Workshop item ${item.publishedfileid}: ${error.stack ?? error}`
        );
      }
    }
	
    log(
      `Workshop catch-up complete. ${newItems.length} new item(s) processed.`
    );
  } finally {
    if (lockAcquired) {
      releaseStateWork("workshop");
    }

    newItemCheckRunning = false;
  }
}

async function updateSubscriberCounts() {
  if (subscriberUpdateRunning) {
    log(
      "Subscriber update skipped because the previous update is still running."
    );
    return;
  }

  subscriberUpdateRunning = true;
  subscriberUpdateWaiting = true;
  let lockAcquired = false;

  try {
    if (stateWorkOwner !== null) {
      log("Subscriber update waiting for current Workshop work to finish.");
    }

    await acquireStateWork("subscriber");
    lockAcquired = true;
    const state = await loadState();

    if (!state) {
      log("Subscriber update skipped because no state file exists yet.");
      return;
    }

    const trackedIds = Object.entries(state.items)
      .filter(
        ([, entry]) =>
          !entry.baseline &&
          entry.threadId &&
          entry.messageId
      )
      .map(([publishedFileId]) => publishedFileId);

    if (!trackedIds.length) {
      log("Subscriber update complete. No bot-posted items to update yet.");
      return;
    }

    const currentItems =
	await getWorkshopDetails(trackedIds);

    const currentById = new Map(
      currentItems.map(item => [
        item.publishedfileid,
        item
      ])
    );

    const changedItems = [];

    for (const publishedFileId of trackedIds) {
      const item = currentById.get(publishedFileId);

      if (!item) {
        continue;
      }

      const previous =
        Number(state.items[publishedFileId].subscribers ?? 0);

      const current =
        Number(item.subscriptions ?? 0);

      if (previous !== current) {
        changedItems.push(item);
      }
    }

    if (!changedItems.length) {
      log(
        `Subscriber update complete. Checked ${trackedIds.length} tracked item(s); ` +
        `0 changed; 0 updated; 0 failed.`
      );
      return;
    }

    const creators = await getCreators(
      changedItems.map(item => item.creator)
    );

    let updated = 0;
    let failed = 0;

    for (let i = 0; i < changedItems.length; i++) {
      const item = changedItems[i];
      const entry = state.items[item.publishedfileid];

      try {
        const thread =
          await forumChannel.threads.fetch(entry.threadId);

        const message =
          await thread.messages.fetch(entry.messageId);

        const creator = creators.get(item.creator);

        await message.edit({
          embeds: [buildEmbed(item, creator)]
        });

        const oldCount = entry.subscribers;
        const newCount = Number(item.subscriptions ?? 0);

        entry.subscribers = newCount;

        // Save immediately so a crash cannot lose successful updates.
        await saveState(state);

        updated++;

        log(
          `Updated subscribers for "${item.title}": ${oldCount} -> ${newCount}`
        );
      } catch (error) {
        failed++;

        log(
          `Failed subscriber update for ${item.publishedfileid}: ` +
          `${error.stack ?? error}`
        );
      }

      // Pace Discord edits when more changed items remain.
      if (
        i < changedItems.length - 1 &&
        config.posting.subscriberUpdateDelayMs > 0
      ) {
        await sleep(
          config.posting.subscriberUpdateDelayMs
        );
      }
    }

    log(
      `Subscriber update complete. Checked ${trackedIds.length} tracked item(s); ` +
      `${changedItems.length} changed; ${updated} updated; ${failed} failed.`
    );
  } finally {
    subscriberUpdateWaiting = false;

    if (lockAcquired) {
      releaseStateWork("subscriber");
    }

    subscriberUpdateRunning = false;
  }
}

function scheduleLoop(name, intervalMs, task, setTimer) {
  async function run() {
    if (shuttingDown) {
      return;
    }

    try {
      await task();
    } catch (error) {
      log(`${name} failed: ${error.stack ?? error}`);
    } finally {
      if (!shuttingDown) {
        const timer = setTimeout(run, intervalMs);
        setTimer(timer);
      }
    }
  }

  run();
}

async function runSubscriberUpdateTest() {
  validateEnvironment();

  config = await loadConfig();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });
  activeClient = client;

  client.once("clientReady", async () => {
    try {
      log(`Logged in to Discord as ${client.user.tag}`);

      forumChannel =
        await client.channels.fetch(FORUM_CHANNEL_ID);

      if (
        !forumChannel ||
        forumChannel.type !== ChannelType.GuildForum
      ) {
        throw new Error(
          "DISCORD_FORUM_CHANNEL_ID does not point to a Discord Forum channel."
        );
      }

      log("Running one subscriber update test.");

      await updateSubscriberCounts();

      log("Subscriber update test complete.");

      client.destroy();
      activeClient = null;
      process.exit(0);
    } catch (error) {
      logError("Subscriber update test failed", error);
      client.destroy();
      activeClient = null;
      process.exit(1);
    }
  });

  await client.login(DISCORD_TOKEN);
}

async function main() {
  validateEnvironment();

  config = await loadConfig();

  log(`Configured Steam AppID: ${config.steam.appId}`);
  log(
    `Workshop check interval: ${config.monitor.newItemCheckMinutes} minute(s)`
  );
  log(
    `Subscriber update interval: ${config.monitor.subscriberUpdateHours} hour(s)`
  );
    log(
    `Initial import mode: ${config.initialImport.mode}` +
    (
      config.initialImport.mode === "latest"
        ? ` (latest ${config.initialImport.limit})`
        : ""
    )
  );

  log(
    `Delay between multiple Discord posts: ${config.posting.delaySeconds} second(s)`
  );
  log(
    `Delay between subscriber edits: ` +
    `${config.posting.subscriberUpdateDelayMs} ms`
  );

  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  activeClient = client;

  client.once("clientReady", async () => {
    try {
      log(`Logged in to Discord as ${client.user.tag}`);

      forumChannel =
        await client.channels.fetch(FORUM_CHANNEL_ID);

      if (
        !forumChannel ||
        forumChannel.type !== ChannelType.GuildForum
      ) {
        throw new Error(
          "DISCORD_FORUM_CHANNEL_ID does not point to a Discord Forum channel."
        );
      }

      log(
        `Using Discord Forum channel: ${forumChannel.name} (${forumChannel.id})`
      );

      const newItemInterval =
        config.monitor.newItemCheckMinutes * 60 * 1000;

        const subscriberInterval =
        config.monitor.subscriberUpdateHours * 60 * 60 * 1000;

      scheduleLoop(
        "Workshop check",
        newItemInterval,
        checkForNewItems,
        timer => {
          workshopTimer = timer;
        }
      );

      // Don't run subscriber updates immediately because a fresh
      // installation has nothing bot-posted to update.
      subscriberTimer = setTimeout(() => {
        subscriberTimer = null;

        if (shuttingDown) {
          return;
        }

        scheduleLoop(
          "Subscriber update",
          subscriberInterval,
          updateSubscriberCounts,
          timer => {
            subscriberTimer = timer;
          }
        );
      }, subscriberInterval);

      log("Workshop monitor is running.");
    } catch (error) {
      log(`Startup failed: ${error.stack ?? error}`);
      client.destroy();
      process.exit(1);
    }
  });

  await client.login(DISCORD_TOKEN);
}

if (process.argv.includes("--update-subscribers")) {
  runSubscriberUpdateTest().catch(error => {
    logError("Fatal error", error);
    process.exit(1);
  });
} else {
  main().catch(error => {
    logError("Fatal error", error);
    process.exit(1);
  });
}