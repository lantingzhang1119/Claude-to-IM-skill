import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from 'claude-to-im/src/lib/bridge/types.js';
import { BaseChannelAdapter, registerAdapterFactory } from 'claude-to-im/src/lib/bridge/channel-adapter.js';
import { getBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { TelegramAdapter } from 'claude-to-im/src/lib/bridge/adapters/telegram-adapter.js';

const TELEGRAM_API = 'https://api.telegram.org';

type TelegramEntity = {
  type?: string;
  offset?: number;
  length?: number;
  user?: { id?: number | string };
};

type TelegramLikeMessage = {
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  chat?: { id?: number | string; type?: string };
  reply_to_message?: {
    from?: { id?: number | string; username?: string; is_bot?: boolean };
  };
};

type TelegramLikeUpdate = {
  message?: TelegramLikeMessage;
  callback_query?: { message?: TelegramLikeMessage };
};

export type TelegramBotIdentity = {
  username?: string;
  userId?: string;
};

export function getTelegramGroupPolicy(): string {
  return (process.env.CTI_TG_GROUP_POLICY || 'all').trim().toLowerCase();
}

function getMessageFromUpdate(raw: unknown): TelegramLikeMessage | undefined {
  const update = raw as TelegramLikeUpdate | undefined;
  return update?.message || update?.callback_query?.message;
}

function isGroupLikeMessage(message: TelegramLikeMessage | undefined): boolean {
  if (!message?.chat) return false;
  const type = message.chat.type?.toLowerCase();
  if (type) return type !== 'private';
  const chatId = Number(message.chat.id);
  return Number.isFinite(chatId) && chatId < 0;
}

function sliceEntityText(text: string, entity: TelegramEntity): string {
  const offset = Math.max(0, entity.offset || 0);
  const length = Math.max(0, entity.length || 0);
  return Array.from(text).slice(offset, offset + length).join('');
}

export function groupMessageMentionsBot(
  text: string,
  entities: TelegramEntity[] | undefined,
  identity: TelegramBotIdentity,
): boolean {
  const username = identity.username?.replace(/^@/, '').toLowerCase();
  const userId = identity.userId ? String(identity.userId) : undefined;
  const lowered = text.toLowerCase();

  if (username && lowered.includes(`@${username}`)) {
    return true;
  }

  for (const entity of entities || []) {
    if (entity.type === 'mention' || entity.type === 'bot_command') {
      const fragment = sliceEntityText(text, entity).toLowerCase();
      if (username && fragment.includes(`@${username}`)) {
        return true;
      }
    }
    if (entity.type === 'text_mention' && userId && entity.user?.id != null) {
      if (String(entity.user.id) === userId) {
        return true;
      }
    }
  }

  return false;
}

export function isReplyToThisBot(message: TelegramLikeMessage | undefined, identity: TelegramBotIdentity): boolean {
  const replyFrom = message?.reply_to_message?.from;
  if (!replyFrom) return false;

  if (identity.userId && replyFrom.id != null && String(replyFrom.id) === String(identity.userId)) {
    return true;
  }

  if (identity.username && replyFrom.username) {
    return replyFrom.username.toLowerCase() === identity.username.replace(/^@/, '').toLowerCase();
  }

  return false;
}

export function shouldAcceptTelegramInbound(
  msg: Pick<InboundMessage, 'text' | 'callbackData' | 'raw'>,
  identity: TelegramBotIdentity,
  policy = getTelegramGroupPolicy(),
): boolean {
  if (msg.callbackData) return true;
  if (policy !== 'mention') return true;

  const rawMessage = getMessageFromUpdate(msg.raw);
  if (!isGroupLikeMessage(rawMessage)) return true;

  if (isReplyToThisBot(rawMessage, identity)) return true;

  const text = rawMessage?.text || rawMessage?.caption || msg.text || '';
  const entities = rawMessage?.entities || rawMessage?.caption_entities;
  if (groupMessageMentionsBot(text, entities, identity)) return true;

  return false;
}

async function fetchBotIdentity(token: string): Promise<TelegramBotIdentity> {
  const url = `${TELEGRAM_API}/bot${token}/getMe`;
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json() as {
    ok?: boolean;
    result?: { id?: number | string; username?: string };
  };

  if (!data.ok || !data.result) {
    return {};
  }

  return {
    username: data.result.username,
    userId: data.result.id != null ? String(data.result.id) : undefined,
  };
}

export class MentionGatedTelegramAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'telegram';

  private readonly inner = new TelegramAdapter();
  private botIdentity: TelegramBotIdentity = {
    username: process.env.CTI_TG_BOT_USERNAME,
    userId: process.env.CTI_TG_BOT_USER_ID,
  };

  async start(): Promise<void> {
    await this.resolveIdentity();
    await this.inner.start();
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }

  isRunning(): boolean {
    return this.inner.isRunning();
  }

  async consumeOne(): Promise<InboundMessage | null> {
    while (true) {
      const msg = await this.inner.consumeOne();
      if (!msg) return null;
      if (shouldAcceptTelegramInbound(msg, this.botIdentity)) {
        return msg;
      }
      if (msg.updateId != null) {
        this.inner.acknowledgeUpdate?.(msg.updateId);
      }
      console.log('[telegram-group-adapter] Dropped group message without mention/reply for this bot');
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    return this.inner.send(message);
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    return this.inner.answerCallback(callbackQueryId, text);
  }

  validateConfig(): string | null {
    return this.inner.validateConfig();
  }

  isAuthorized(userId: string, chatId: string): boolean {
    return this.inner.isAuthorized(userId, chatId);
  }

  acknowledgeUpdate(updateId: number): void {
    this.inner.acknowledgeUpdate?.(updateId);
  }

  onMessageStart(chatId: string): void {
    this.inner.onMessageStart?.(chatId);
  }

  onMessageEnd(chatId: string): void {
    this.inner.onMessageEnd?.(chatId);
  }

  getPreviewCapabilities(chatId: string): PreviewCapabilities | null {
    return this.inner.getPreviewCapabilities?.(chatId) || null;
  }

  async sendPreview(chatId: string, text: string, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.inner.sendPreview) return 'skip';
    return this.inner.sendPreview(chatId, text, draftId);
  }

  endPreview(chatId: string, draftId: number): void {
    this.inner.endPreview?.(chatId, draftId);
  }

  private async resolveIdentity(): Promise<void> {
    if (this.botIdentity.username && this.botIdentity.userId) return;

    const token = getBridgeContext().store.getSetting('telegram_bot_token');
    if (!token) return;

    try {
      const fetched = await fetchBotIdentity(token);
      this.botIdentity = {
        username: this.botIdentity.username || fetched.username,
        userId: this.botIdentity.userId || fetched.userId,
      };
    } catch (err) {
      console.warn('[telegram-group-adapter] Failed to resolve bot identity:', err instanceof Error ? err.message : err);
    }
  }
}

registerAdapterFactory('telegram', () => new MentionGatedTelegramAdapter());
