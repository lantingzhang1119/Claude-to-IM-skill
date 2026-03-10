import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMentionedBotUsernames,
  groupMessageMentionsBot,
  isReplyToThisBot,
  mentionsOnlyOtherBots,
  shouldAcceptTelegramInbound,
} from '../telegram-group-adapter.js';

describe('telegram group mention gating', () => {
  afterEach(() => {
    delete process.env.CTI_TG_GROUP_POLICY;
  });

  it('passes private chats even in mention mode', () => {
    assert.equal(
      shouldAcceptTelegramInbound({
        text: 'hello',
        raw: {
          message: {
            text: 'hello',
            chat: { id: 1, type: 'private' },
          },
        },
      }, { username: 'Enyi12_bot' }, 'mention'),
      true,
    );
  });

  it('rejects non-mentioned group messages', () => {
    assert.equal(
      shouldAcceptTelegramInbound({
        text: 'hello team',
        raw: {
          message: {
            text: 'hello team',
            chat: { id: -1001, type: 'supergroup' },
          },
        },
      }, { username: 'Enyi12_bot' }, 'mention'),
      false,
    );
  });

  it('accepts explicit @mention in groups', () => {
    const text = '@Enyi12_bot please check';
    assert.equal(
      groupMessageMentionsBot(text, [{ type: 'mention', offset: 0, length: 11 }], { username: 'Enyi12_bot' }),
      true,
    );

    assert.equal(
      shouldAcceptTelegramInbound({
        text,
        raw: {
          message: {
            text,
            entities: [{ type: 'mention', offset: 0, length: 11 }],
            chat: { id: -1001, type: 'supergroup' },
          },
        },
      }, { username: 'Enyi12_bot' }, 'mention'),
      true,
    );
  });


  it('detects when a message only mentions other bots', () => {
    const text = '@enyi11_bot please take this';
    const entities = [{ type: 'mention', offset: 0, length: 11 }];

    assert.deepEqual(extractMentionedBotUsernames(text, entities), ['enyi11_bot']);
    assert.equal(
      mentionsOnlyOtherBots(text, entities, { username: 'Enyi12_bot' }),
      true,
    );
    assert.equal(
      mentionsOnlyOtherBots('@enyi11_bot @Enyi12_bot sync', undefined, { username: 'Enyi12_bot' }),
      false,
    );
  });

  it('accepts replies to this bot only', () => {
    assert.equal(
      isReplyToThisBot({
        chat: { id: -1001, type: 'group' },
        reply_to_message: { from: { username: 'Enyi12_bot', id: 100 } },
      }, { username: 'Enyi12_bot', userId: '100' }),
      true,
    );

    assert.equal(
      shouldAcceptTelegramInbound({
        text: 'follow-up',
        raw: {
          message: {
            text: 'follow-up',
            chat: { id: -1001, type: 'group' },
            reply_to_message: { from: { username: 'Other_bot', id: 200 } },
          },
        },
      }, { username: 'Enyi12_bot', userId: '100' }, 'mention'),
      false,
    );
  });


  it('rejects replies to this bot when the text only mentions another bot', () => {
    const text = '@enyi11_bot please continue';
    assert.equal(
      shouldAcceptTelegramInbound({
        text,
        raw: {
          message: {
            text,
            entities: [{ type: 'mention', offset: 0, length: 11 }],
            chat: { id: -1001, type: 'group' },
            reply_to_message: { from: { username: 'Enyi12_bot', id: 100 } },
          },
        },
      }, { username: 'Enyi12_bot', userId: '100' }, 'mention'),
      false,
    );
  });

  it('always accepts callback queries', () => {
    assert.equal(
      shouldAcceptTelegramInbound({
        text: '',
        callbackData: 'approve:1',
        raw: { callback_query: {} },
      }, { username: 'Enyi12_bot' }, 'mention'),
      true,
    );
  });
});
