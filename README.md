# NFTree Gatekeeper Telegram Bot

This bot governs a Telegram whale chat by checking that each member owns at least one NFTree in the Sui wallet they verify.

It checks the NFTree collection type:

```text
0xf6c6d439ea0da2f3e9ba79e4992a7a4c113215fbf54c442ac9020c315f953705::collection::NFT
```

## What It Does

- Lets a user register with `/verify <sui wallet address>`.
- Reads live wallet-owned NFTree objects from Sui RPC.
- Stores the Telegram user id, wallet address, NFTree count, and NFTree object ids locally.
- Runs as a command-based Telegram verifier.
- Handles Telegram join requests when the group uses approval-based joining.
- Removes tracked members from the whale chat if they no longer own an NFTree.
- Lets admins run `/audit` to force an immediate ownership check.

## Important Telegram Limits

Telegram bots cannot pull a full list of existing group members. For that reason, the bot can only continuously audit users it has seen through:

- `/verify <wallet>`
- a join request
- joining the group while the bot is already running

For best results, turn on group join approval and make this bot an admin with permission to approve members and remove users.

## Setup

1. Create a Telegram bot with BotFather and copy the token.
2. Add the bot to the whale chat as an admin.
3. Give it permission to approve join requests and ban/remove users.
4. Copy `.env.example` to `.env`.
5. Fill in:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_GROUP_CHAT_ID=
ADMIN_TELEGRAM_IDS=
```

To find `TELEGRAM_GROUP_CHAT_ID`, add the bot to the group, send a message in the group, then open:

```text
https://api.telegram.org/botYOUR_TOKEN/getUpdates
```

The group chat id is usually a negative number.

To find your admin Telegram user id, message the bot directly, then check `getUpdates` the same way.

## Run

```powershell
node src/bot.js
```

Or:

```powershell
npm start
```

No package install is required.

The bot also starts a small HTTP health server on:

```text
http://127.0.0.1:8787/
```

Render web services expect the bot to listen on a web port. This health server keeps Render happy while verification happens in Telegram with `/verify`.

## Command-Only Setup

Use this mode when you want people to verify directly in Telegram instead of opening a Mini App.

1. Open **@BotFather**.
2. Send `/mybots`.
3. Select `Tree Gatekeeper`.
4. Choose **Bot Settings**.
5. Choose **Menu Button**.
6. Send:

```text
/empty
```

7. In Render, leave `ENABLE_WEBAPP` as `false` or unset.
8. Remove `WEBAPP_URL` from Render if it is currently set.
9. Redeploy the service.

Users can verify in any chat where the bot is present:

```text
/verify@TreeGatekeeperBot 0x...
```

## User Commands

```text
/verify 0x...
/status
/help
```

## Admin Commands

```text
/audit
```

## Render Environment Variables

Add these in Render's Environment section:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_GROUP_CHAT_ID=
ADMIN_TELEGRAM_IDS=
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
NFTREE_PACKAGE_ID=0xf6c6d439ea0da2f3e9ba79e4992a7a4c113215fbf54c442ac9020c315f953705
NFTREE_MODULE_NAME=collection
NFTREE_STRUCT_TYPE=0xf6c6d439ea0da2f3e9ba79e4992a7a4c113215fbf54c442ac9020c315f953705::collection::NFT
NFTREE_NAME_PATTERN=nftree
ENABLE_WEBAPP=false
WEBAPP_PORT=8787
TELEGRAM_POLL_SECONDS=25
AUDIT_INTERVAL_MINUTES=30
MEMBER_STORE_PATH=data/members.json
```

## BotFather Commands

Paste this into BotFather's **Edit Commands** screen:

```text
start - Show NFTree verification instructions
verify - Verify your Sui wallet for whale chat access
status - Check your registered NFTree ownership status
audit - Admin only: re-check all verified members
help - Show help
```

## Notes

- Secrets belong in `.env`, not in shared zip files.
- The verification and removal rule checks for NFTree objects owned directly by the submitted Sui wallet.
- If users keep NFTrees inside kiosks or third-party custody, direct wallet ownership may not show up in this check.
- Wallet ownership is based on the Telegram user submitting a wallet. For high-stakes gating, add a signed-wallet challenge before treating the wallet as proven ownership.
