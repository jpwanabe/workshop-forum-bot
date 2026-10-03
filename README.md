# Workshop Forum Bot

Workshop Forum Bot is a Node.js Discord bot that monitors a game's Steam Workshop and automatically creates a Discord Forum post for each new Workshop item.

Each Discord post includes:

- Workshop item title
- Creator name with a link to their Steam profile
- Workshop description
- Preview image
- Link to the Steam Workshop item
- Current subscriber count

The bot periodically refreshes subscriber counts on existing posts.

## Features

- Works with configurable Steam AppIDs
- Post all Workshop items or filter by Workshop tags
- Discord Forum channel integration
- Creator attribution with Steam profile links
- Workshop preview images and descriptions
- Subscriber count updates
- Automatic cleanup of incompatible, banned, or removed Workshop items
- Two-check protection before treating a missing Workshop item as removed
- Manual posting of individual Workshop items by published file ID
- Persistent local state to prevent duplicate posts
- Restart-safe initial imports and catch-up
- Cursor-based Steam Workshop pagination
- Configurable pacing between Discord posts and edits
- Graceful SIGINT/SIGTERM shutdown
- Subscriber updates receive priority over new-item processing when both need to modify state
- No external database required

## Requirements

- Node.js 20 or newer
- A Discord bot
- A Discord Forum channel
- A Steam Web API key

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/jpwanabe/workshop-forum-bot.git
cd workshop-forum-bot
npm install
```

Copy the example configuration files:

```bash
cp .env.example .env
cp config.example.json config.json
```

Edit `.env` and provide:

```dotenv
STEAM_API_KEY=your_steam_api_key_here
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_FORUM_CHANNEL_ID=your_forum_channel_id_here
```

Do not commit `.env`. It contains secrets and is ignored by Git.

## Discord permissions

The bot should have access to the target Forum channel with these permissions:

- View Channel
- Send Messages
- Create Public Threads
- Send Messages in Threads
- Embed Links
- Attach Files
- Read Message History

Administrator permission is not required.

## Configuration

Runtime settings are stored in `config.json`.

Start by copying `config.example.json`.

### Steam AppID

Set:

```json
"appId": 2963800
```

to the Steam AppID of the game you want to monitor.

### Workshop filtering

To accept every Workshop item:

```json
"filter": {
  "mode": "all",
  "tags": [],
  "matchAll": true,
  "excludeTags": []
}
```

To only accept selected Workshop tags:

```json
"filter": {
  "mode": "include",
  "tags": ["Map"],
  "matchAll": true,
  "excludeTags": []
}
```

Workshop tags are defined by each game. Some games do not use tags.

When multiple include tags are configured:

- `"matchAll": true` requires every configured tag.
- `"matchAll": false` accepts an item matching any configured tag.

`excludeTags` can be used to reject specific tags.

### Initial import

`initialImport.mode` controls what happens the first time the bot runs without a `state.json`.

#### Post everything

```json
"initialImport": {
  "mode": "all",
  "limit": 0
}
```

#### Post only the newest items

```json
"initialImport": {
  "mode": "latest",
  "limit": 10
}
```

Older items are recorded as baseline items and will not be posted later.

#### Post nothing that already exists

```json
"initialImport": {
  "mode": "none",
  "limit": 0
}
```

Existing Workshop items are recorded as a baseline. Only items discovered afterward will be posted.

### Workshop cleanup

The optional `cleanup` settings control whether Discord Forum threads are automatically removed when the corresponding Steam Workshop item is no longer usable.

Available settings:

- `deleteIncompatibleItems` removes the Discord thread when Steam explicitly marks the Workshop item as incompatible.
- `deleteBannedItems` removes the Discord thread when Steam explicitly marks the Workshop item as banned.
- `deleteRemovedItems` removes the Discord thread when the Workshop item is no longer available from Steam.

Removed Workshop items must be unavailable during two consecutive successful Steam detail checks before their Discord thread is deleted. A failed Steam API request does not count as a missing check.

The Discord thread is deleted before the item is removed from `state.json`. If Discord deletion fails, the state entry is retained so the bot can try again during a later update.

## Running

Run directly:

```bash
npm start
```

or:

```bash
node bot.js
```

The bot performs its own scheduled Workshop checks and subscriber updates. Cron is not required.

To manually create and track a Forum post for a specific Steam Workshop item, run `node bot.js --post-item WORKSHOP_ID`.

The item must belong to the configured Steam AppID and must not already exist in `state.json`. If Steam currently marks the item as incompatible or banned, the bot will display a warning but will still allow the manual post.

To manually run one subscriber update and exit:

```bash
npm run update-subscribers
```

## State

The bot stores runtime state in:

```text
state.json
```

This contains the relationship between Steam Workshop items and their Discord threads/messages.

`state.json` is intentionally ignored by Git.

Do not delete it from a live installation unless you intentionally want the bot to perform first-run initialization again.

State writes use a temporary file followed by a rename to reduce the risk of a partially written state file.

## Updating

For a Git installation:

```bash
git pull
npm install
```

Then restart the bot.

Review release notes and configuration changes before updating a production installation.

## Running with systemd

A systemd service example is included in `deploy/workshop-forum-bot.service`.

Copy it:

```bash
sudo cp deploy/workshop-forum-bot.service /etc/systemd/system/
```

Edit the service and change `User`, `Group`, and `WorkingDirectory` if necessary.

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now workshop-forum-bot.service
```

Check status:

```bash
systemctl status workshop-forum-bot.service
```

Follow logs:

```bash
journalctl -u workshop-forum-bot.service -f
```

Optional daily-restart service and timer examples are also provided in `deploy/`.

## Security

Never commit:

- `.env`
- `config.json` if it contains installation-specific information
- `state.json`
- Discord bot tokens
- Steam Web API keys

These local files are ignored by the included `.gitignore`.

If a secret is accidentally published, revoke or rotate it ASAP rather than relying only on deleting it from Git history.

## API failure behavior

The bot intentionally does not aggressively retry failed Steam or Discord operations.

Workshop checks run periodically, so an item missed during a temporary API failure can be discovered during a later successful check.

A failed Steam detail request does not mark tracked Workshop items as missing and does not advance the removed-item cleanup counter.

Subscriber counts are informational and will be refreshed during a later scheduled update if an update fails.

## License

MIT License. See `LICENSE`.