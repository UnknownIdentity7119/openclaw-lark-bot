# Lark Bot — OpenClaw Channel Plugin

Connect a **Lark/Feishu custom app bot** as an OpenClaw messaging channel. Supports both WebSocket and Webhook connection modes.

## Features

- 🔌 **Dual Mode** — WebSocket (persistent) or Webhook (HTTP callbacks)
- 💬 **DM Support** — Direct messages with the bot
- 👥 **Group Support** — Respond in group chats (with optional @mention trigger)
- 🔒 **Access Control** — Allowlist/blocklist policies
- 🌏 **Lark & Feishu** — Works with both international (Lark) and China (Feishu) versions

## Installation

### Option 1: npm (recommended)

```bash
cd ~/.openclaw/extensions
npm install openclaw-lark-bot
```

### Option 2: Manual

```bash
cd ~/.openclaw/extensions
git clone https://github.com/UnknownIdentity7119/openclaw-lark-bot.git lark-bot
cd lark-bot
npm install
```

## Setup

### Step 1: Create a Lark Custom App

1. Go to [Lark Developer Console](https://open.larksuite.com/) (or [Feishu](https://open.feishu.cn/))
2. Create a new **Custom App**
3. Note your **App ID** and **App Secret**

### Step 2: Configure Permissions

Add these permissions to your app:
- `im:message` — Send messages
- `im:message:send_as_bot` — Send as bot
- `im:message.group_at_msg:readonly` — Read @mentions
- `im:message.p2p_msg:readonly` — Read DMs
- `im:message.group_msg:readonly` — Read group messages

### Step 3: Configure Events

1. Go to **Event Configuration**
2. Set **Request URL**: `https://your-domain.com/webhook/lark`
3. Subscribe to event: `im.message.receive_v1`

### Step 4: Configure OpenClaw

Add to your `openclaw.json`:

```json
{
  "channels": {
    "lark-bot": {
      "enabled": true,
      "appId": "YOUR_APP_ID",
      "appSecret": "YOUR_APP_SECRET",
      "domain": "lark",
      "connectionMode": "webhook",
      "webhookPort": 9876,
      "webhookPath": "/webhook/lark",
      "handleGroups": true,
      "handleDMs": true,
      "triggerOnMention": false,
      "dmPolicy": "open"
    }
  },
  "plugins": {
    "entries": {
      "lark-bot": {
        "enabled": true
      }
    }
  }
}
```

### Step 5: Setup Reverse Proxy (for webhook mode)

If using webhook mode, configure your reverse proxy (e.g., Caddy, nginx):

**Caddy:**
```
your-domain.com {
    reverse_proxy /webhook/lark* 127.0.0.1:9876
}
```

**nginx:**
```nginx
location /webhook/lark {
    proxy_pass http://127.0.0.1:9876;
}
```

### Step 6: Restart OpenClaw

```bash
openclaw gateway restart
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `appId` | string | *required* | Lark App ID |
| `appSecret` | string | *required* | Lark App Secret |
| `domain` | string | `"lark"` | `"lark"` (international) or `"feishu"` (China) |
| `connectionMode` | string | `"webhook"` | `"webhook"` or `"websocket"` |
| `webhookPort` | number | `9876` | Local port for webhook server |
| `webhookPath` | string | `"/webhook/lark"` | URL path for webhook endpoint |
| `encryptKey` | string | `""` | Event encryption key (optional) |
| `verificationToken` | string | `""` | Event verification token (optional) |
| `handleGroups` | boolean | `true` | Process group messages |
| `handleDMs` | boolean | `true` | Process direct messages |
| `triggerOnMention` | boolean | `true` | In groups, only respond when @mentioned |
| `dmPolicy` | string | `"open"` | `"open"`, `"allowlist"`, or `"blocklist"` |
| `allowFrom` | string[] | `["*"]` | Allowed user IDs (for allowlist mode) |
| `blockFrom` | string[] | `[]` | Blocked user IDs (for blocklist mode) |

## Connection Modes

### Webhook Mode (recommended for production)

- Lark sends HTTP POST to your server
- Requires public URL with HTTPS
- More reliable, works behind firewalls
- URL must be verified in Lark console

### WebSocket Mode

- Persistent connection to Lark servers
- No public URL needed
- Easier setup, but may disconnect
- Only available for self-built apps

## How It Works

```
┌─────────────────┐                    ┌──────────────────┐
│  Lark Servers   │ ─── Webhook ────►  │  OpenClaw        │
│                 │    (or WebSocket)  │  Gateway         │
└─────────────────┘                    └────────┬─────────┘
                                                │
                                                ▼
                                       ┌──────────────────┐
                                       │  Your AI Agent   │
                                       └──────────────────┘
```

## Security Notes

⚠️ **Keep your credentials safe:**
- Never commit `appId` or `appSecret` to public repos
- Use environment variables or OpenClaw's secrets management
- Set `encryptKey` for encrypted events in production

## License

MIT — see [LICENSE](./LICENSE)

## Contributing

Issues and PRs welcome at [github.com/UnknownIdentity7119/openclaw-lark-bot](https://github.com/UnknownIdentity7119/openclaw-lark-bot)
