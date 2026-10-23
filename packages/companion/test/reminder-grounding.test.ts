import test from 'node:test';
import assert from 'node:assert/strict';
import { groundedReminderDueAt } from '../src/application/turn-processor.js';

test('reminder persistence requires the proposed ISO instant in the current user source', () => {
  const explicit = '请在 2099-05-06T19:30:00+08:00 提醒我交材料';
  assert.equal(groundedReminderDueAt(explicit, '2099-05-06T11:30:00.000Z').toISOString(), '2099-05-06T11:30:00.000Z');
  assert.throws(() => groundedReminderDueAt('晚上提醒我交材料', '2099-05-06T11:30:00.000Z'), /reminder_time_not_grounded/);
  assert.throws(() => groundedReminderDueAt(explicit, '2099-05-07T11:30:00.000Z'), /reminder_time_not_grounded/);
});
