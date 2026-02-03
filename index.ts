/**
 * Lark Bot — OpenClaw Channel Plugin
 * 
 * Connect a Lark/Feishu custom app bot as an OpenClaw messaging channel.
 * Supports both WebSocket and Webhook connection modes.
 * 
 * @author OpenClaw Community
 * @license MIT
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import * as Lark from "@larksuiteoapi/node-sdk";
import http from "http";

// ─── Internal OpenClaw imports ──────────────────────────────────────
// These are not part of the public SDK but required for proper inbound message handling.
// @ts-ignore - internal import not in SDK types
import { dispatchInboundMessage } from "openclaw/dist/auto-reply/dispatch.js";
// @ts-ignore - internal import not in SDK types
import { createReplyDispatcher } from "openclaw/dist/auto-reply/reply/reply-dispatcher.js";
// @ts-ignore - internal import not in SDK types
import { loadConfig } from "openclaw/dist/config/config.js";

// ─── State ──────────────────────────────────────────────────────────

const clients = new Map<string, Lark.Client>();
const wsClients = new Map<string, Lark.WSClient>();
const httpServers = new Map<string, http.Server>();

// ─── Types ──────────────────────────────────────────────────────────

interface AccountConfig {
  accountId: string;
  appId: string;
  appSecret: string;
  encryptKey: string;
  verificationToken: string;
  domain: "lark" | "feishu";
  connectionMode: "websocket" | "webhook";
  webhookPort: number;
  webhookPath: string;
  handleGroups: boolean;
  handleDMs: boolean;
  triggerOnMention: boolean;
  dmPolicy: "open" | "allowlist" | "blocklist";
  allowFrom: string[];
  blockFrom: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────

function resolveAccountConfig(cfg: any, accountId?: string): AccountConfig {
  const channelCfg = cfg.channels?.["lark-bot"] ?? {};
  const accounts = channelCfg.accounts;
  const raw = accounts
    ? accounts[accountId ?? "default"] ?? accounts[Object.keys(accounts)[0]]
    : channelCfg;
  return {
    accountId: accountId ?? "default",
    appId: raw?.appId ?? "",
    appSecret: raw?.appSecret ?? "",
    encryptKey: raw?.encryptKey ?? "",
    verificationToken: raw?.verificationToken ?? "",
    domain: raw?.domain ?? "lark",
    connectionMode: raw?.connectionMode ?? "webhook",
    webhookPort: raw?.webhookPort ?? 9876,
    webhookPath: raw?.webhookPath ?? "/webhook/lark",
    handleGroups: raw?.handleGroups ?? true,
    handleDMs: raw?.handleDMs ?? true,
    triggerOnMention: raw?.triggerOnMention ?? true,
    dmPolicy: raw?.dmPolicy ?? "open",
    allowFrom: raw?.allowFrom ?? ["*"],
    blockFrom: raw?.blockFrom ?? [],
  };
}

function clientKey(accountId: string): string {
  return `lark-bot:${accountId}`;
}

function isAllowed(senderId: string, account: AccountConfig): boolean {
  const { dmPolicy, allowFrom, blockFrom } = account;
  if (dmPolicy === "open") return true;
  if (dmPolicy === "allowlist") {
    if (allowFrom.includes("*")) return true;
    return allowFrom.includes(senderId);
  }
  if (dmPolicy === "blocklist") return !blockFrom.includes(senderId);
  return true;
}

function parseMessageText(content: string, msgType: string): string {
  if (msgType !== "text") return `[${msgType} message]`;
  try {
    const parsed = JSON.parse(content);
    let text = parsed.text ?? "";
    text = text.replace(/@_user_\d+\s*/g, "").trim();
    return text;
  } catch {
    return content;
  }
}

function mapChatType(larkChatType: string): "direct" | "group" {
  return larkChatType === "p2p" ? "direct" : "group";
}

function isBotMentioned(data: any): boolean {
  const mentions = data?.message?.mentions;
  if (!mentions || !Array.isArray(mentions)) return false;
  return mentions.some((m: any) => m.key && m.name);
}

function createLarkClient(account: AccountConfig): Lark.Client {
  const config: any = { appId: account.appId, appSecret: account.appSecret };
  config.domain = account.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
  return new Lark.Client(config);
}

function buildSessionKey(params: { channel: string; accountId: string; chatId: string; chatType: string }): string {
  const { channel, accountId, chatId, chatType } = params;
  return `${channel}:${accountId}:${chatType}:${chatId}`.toLowerCase();
}

// ─── Channel Plugin ─────────────────────────────────────────────────

const larkBotChannel = {
  id: "lark-bot",

  meta: {
    id: "lark-bot",
    label: "Lark Bot",
    selectionLabel: "Lark Bot (Custom App)",
    docsPath: "/channels/lark-bot",
    blurb: "Connect a Lark/Feishu custom app bot as a messaging channel.",
    aliases: ["lark", "feishu"],
  },

  capabilities: {
    chatTypes: ["direct", "group"] as const,
    outbound: true,
  },

  config: {
    listAccountIds: (cfg: any): string[] => {
      const channelCfg = cfg.channels?.["lark-bot"];
      if (!channelCfg) return [];
      const accounts = channelCfg.accounts;
      if (accounts && typeof accounts === "object") return Object.keys(accounts);
      if (channelCfg.appId) return ["default"];
      return [];
    },
    resolveAccount: (cfg: any, accountId?: string) => {
      return resolveAccountConfig(cfg, accountId);
    },
    isConfigured: (account: any) => Boolean(account?.appId && account?.appSecret),
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      enabled: true,
      configured: Boolean(account?.appId),
    }),
  },

  outbound: {
    deliveryMode: "direct" as const,
    sendText: async ({ to, text, account }: any) => {
      const key = clientKey(account.accountId);
      const client = clients.get(key);
      if (!client) return { ok: false, error: "Lark client not initialized" };
      try {
        const res = await client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: to, content: JSON.stringify({ text }), msg_type: "text" },
        });
        if (res?.code === 0) return { ok: true, channel: "lark-bot", messageId: res.data?.message_id };
        return { ok: false, error: `Lark API error ${res?.code}: ${res?.msg}` };
      } catch (err: any) {
        return { ok: false, error: `Send failed: ${err.message ?? err}` };
      }
    },
  },

  gateway: {
    startAccount: async (ctx: any) => {
      const account = resolveAccountConfig(ctx.cfg, ctx.account?.accountId);
      const key = clientKey(account.accountId);

      ctx.log?.info?.(`[lark-bot:${account.accountId}] Starting provider (${account.connectionMode} mode)`);

      if (!account.appId || !account.appSecret) {
        throw new Error("[lark-bot] Missing appId or appSecret in channels.lark-bot config");
      }

      const client = createLarkClient(account);
      clients.set(key, client);

      let botOpenId = "";
      try {
        const botInfo = await client.contact.v3.user.get({ path: { user_id: "me" }, params: { user_id_type: "open_id" } });
        botOpenId = botInfo?.data?.user?.open_id ?? "";
        ctx.log?.info?.(`[lark-bot] Bot ID: ${botOpenId}`);
      } catch {
        ctx.log?.warn?.("[lark-bot] Could not get bot info (non-fatal)");
      }

      const messageHandler = async (data: any) => {
        try {
          const message = data?.message;
          if (!message) return;

          const chatType = mapChatType(message.chat_type ?? "");
          const senderId = data?.sender?.sender_id?.open_id ?? "";
          const senderType = data?.sender?.sender_type ?? "";
          
          if (senderType === "app") return;
          if (senderId === botOpenId) return;

          if (chatType === "direct" && !account.handleDMs) return;
          if (chatType === "group" && !account.handleGroups) return;
          if (chatType === "direct" && !isAllowed(senderId, account)) {
            ctx.log?.debug?.(`[lark-bot] Blocked message from ${senderId} by policy`);
            return;
          }
          if (chatType === "group" && account.triggerOnMention && !isBotMentioned(data)) {
            return;
          }

          const text = parseMessageText(message.content ?? "{}", message.message_type ?? "text");
          if (!text.trim()) return;

          const chatId = message.chat_id ?? "";
          const messageId = message.message_id ?? Date.now().toString();

          ctx.log?.info?.(`[lark-bot] Inbound: from=${senderId} chat=${chatId} type=${chatType} text="${text.slice(0, 50)}..."`);

          const sessionKey = buildSessionKey({
            channel: "lark-bot",
            accountId: account.accountId,
            chatId,
            chatType,
          });

          const cfg = loadConfig();

          const inboundCtx = {
            Body: text,
            BodyForAgent: text,
            BodyForCommands: text,
            RawBody: message.content ?? text,
            CommandBody: text,
            SessionKey: sessionKey,
            Provider: "lark-bot",
            Surface: "lark-bot",
            MessageChannel: "lark-bot",
            OriginatingChannel: "lark-bot",
            ChatType: chatType,
            CommandAuthorized: true,
            MessageSid: messageId,
            SenderId: senderId,
            SenderName: senderId,
            SenderUsername: senderId,
            From: senderId,
            To: botOpenId || "lark-bot",
            AccountId: account.accountId,
          };

          const replyParts: string[] = [];

          const dispatcher = createReplyDispatcher({
            deliver: async (payload: any, info: any) => {
              const replyText = payload.text?.trim();
              if (!replyText) return;
              if (info.kind === "final") {
                replyParts.push(replyText);
              }
            },
            onError: (err: any) => {
              ctx.log?.error?.(`[lark-bot] Dispatch error: ${err}`);
            },
          });

          try {
            await dispatchInboundMessage({
              ctx: inboundCtx,
              cfg,
              dispatcher,
              replyOptions: {
                disableBlockStreaming: true,
              },
            });

            await dispatcher.waitForIdle?.();

            if (replyParts.length > 0) {
              const fullReply = replyParts.join("\n\n").trim();
              if (fullReply) {
                const res = await client.im.v1.message.create({
                  params: { receive_id_type: "chat_id" },
                  data: { 
                    receive_id: chatId, 
                    content: JSON.stringify({ text: fullReply }), 
                    msg_type: "text" 
                  },
                });
                if (res?.code === 0) {
                  ctx.log?.info?.(`[lark-bot] Sent reply: "${fullReply.slice(0, 50)}..."`);
                } else {
                  ctx.log?.error?.(`[lark-bot] Failed to send reply: ${res?.msg}`);
                }
              }
            }
          } catch (dispatchErr: any) {
            ctx.log?.error?.(`[lark-bot] Failed to dispatch message: ${dispatchErr.message ?? dispatchErr}`);
          }
        } catch (err: any) {
          ctx.log?.error?.(`[lark-bot] Error processing message: ${err.message ?? err}`);
        }
      };

      const eventDispatcherConfig: any = {};
      if (account.encryptKey) eventDispatcherConfig.encryptKey = account.encryptKey;
      if (account.verificationToken) eventDispatcherConfig.verificationToken = account.verificationToken;

      const eventDispatcher = new Lark.EventDispatcher(eventDispatcherConfig).register({
        "im.message.receive_v1": messageHandler,
      });

      if (account.connectionMode === "websocket") {
        ctx.log?.info?.("[lark-bot] Connecting via WebSocket...");
        const wsConfig: any = {
          appId: account.appId,
          appSecret: account.appSecret,
          loggerLevel: Lark.LoggerLevel.info,
          domain: account.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
        };
        const wsClient = new Lark.WSClient(wsConfig);
        await wsClient.start({ eventDispatcher });
        wsClients.set(key, wsClient);
        ctx.log?.info?.("[lark-bot] WebSocket connected successfully");
      } else {
        ctx.log?.info?.(`[lark-bot] Starting webhook server on port ${account.webhookPort}...`);
        const server = http.createServer();
        server.on("request", Lark.adaptDefault(account.webhookPath, eventDispatcher, { autoChallenge: true }));
        await new Promise<void>((resolve, reject) => {
          server.listen(account.webhookPort, () => resolve());
          server.on("error", reject);
        });
        httpServers.set(key, server);
        ctx.log?.info?.(`[lark-bot] Webhook ready at http://0.0.0.0:${account.webhookPort}${account.webhookPath}`);
      }

      if (ctx.abortSignal) {
        ctx.abortSignal.addEventListener("abort", async () => {
          ctx.log?.info?.("[lark-bot] Shutting down...");
          wsClients.delete(key);
          const server = httpServers.get(key);
          if (server) {
            await new Promise<void>(r => server.close(() => r()));
            httpServers.delete(key);
          }
          clients.delete(key);
          ctx.log?.info?.("[lark-bot] Stopped");
        }, { once: true });
      }

      ctx.log?.info?.("[lark-bot] Gateway started — listening for messages");
    },
  },
};

// ─── Plugin Descriptor ──────────────────────────────────────────────

const plugin = {
  id: "lark-bot",
  name: "Lark Bot",
  description: "Lark/Feishu custom app bot integration",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: larkBotChannel });
  },
};

export default plugin;
