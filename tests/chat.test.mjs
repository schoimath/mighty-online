import assert from 'node:assert/strict';
import test from 'node:test';
import {ChatLog, chatText} from '../chat.js';

const message = id => ({id, seat:1, name:'친구', time:1700000000000, text:' 안녕하세요! '});

test('room chat accepts ordered messages, retains the last 60, and ignores duplicates', () => {
  const log = new ChatLog();
  for (let id = 1; id <= 65; id++) assert.equal(log.accept(message(id)), true);
  assert.equal(log.messages.length, 60);
  assert.equal(log.messages[0].id, 6);
  assert.equal(log.lastId, 65);
  assert.equal(log.accept(message(65)), false);
  assert.equal(log.accept(message(10)), false);
  assert.equal(log.messages.length, 60);
});

test('chat keeps only public message fields and validates text at the sender and receiver', () => {
  const log = new ChatLog();
  assert.equal(chatText('  안녕!  '), '안녕!');
  for (const text of ['', '  ', 'a'.repeat(281), 123]) {
    assert.equal(chatText(text), '');
    assert.equal(log.accept({...message(1), text}), false);
  }
  assert.equal(log.accept({...message(1), seat:5}), false);
  assert.equal(log.accept({...message(1), time:NaN}), false);
  assert.equal(log.accept({...message(1), unrelated:'extra data'}), true);
  assert.deepEqual(log.messages, [{...message(1), text:'안녕하세요!'}]);
});
