import test from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, compareDue, dayStart, isDue, nextRollover, orderSession, schedule } from '../src/schedule.js';

// Fixed local instants on one day, so the assertions do not depend on when the suite runs.
const at = (hour, minute = 30) => { const date = new Date(2026, 10, 24); date.setHours(hour, minute, 0, 0); return date.getTime(); };
const plusDays = (time, days) => { const date = new Date(time); date.setDate(date.getDate() + days); return date.getTime(); };
const EVENING = at(21);
const card = (overrides = {}) => ({ id: 'a', reviewState: 'new', createdAt: 1, interval: 0, reps: 0, ...overrides });

test('a new card is due now, and each success climbs one step until the card graduates', () => {
    assert.equal(isDue(card(), EVENING), true);
    let note = card();
    const intervals = [];
    STEPS.forEach((step, index) => {
        const result = schedule(note, 'good', EVENING);
        intervals.push(result.interval);
        assert.deepEqual([result.reps, result.reviewState, result.dueAt], [index + 1, 'learning', plusDays(dayStart(EVENING), step)]);
        note = { ...note, ...result };
    });
    assert.deepEqual(intervals, [...STEPS]);
    const graduated = schedule(note, 'good', EVENING);
    assert.deepEqual([graduated.reviewState, graduated.dueAt, graduated.reps], ['mastered', null, STEPS.length + 1]);
    assert.equal(isDue({ ...note, ...graduated }, EVENING + 365 * 86400000), false);
});

test('hard shows the card tomorrow one step down; again brings it back now', () => {
    const hard = schedule(card({ interval: 7, reps: 3 }), 'hard', EVENING);
    assert.deepEqual([hard.interval, hard.dueAt, hard.reps, hard.reviewState], [3, nextRollover(EVENING), 4, 'learning']);
    // A card that has not climbed yet cannot go lower.
    assert.deepEqual([schedule(card(), 'hard', EVENING).interval, schedule(card({ interval: 1 }), 'hard', EVENING).interval], [0, 0]);
    const again = schedule(card({ interval: 7, reps: 3, lapses: 1 }), 'again', EVENING);
    assert.deepEqual([again.interval, again.dueAt, again.reps, again.lapses, again.reviewState], [0, EVENING, 4, 2, 'learning']);
    assert.equal(isDue({ reviewState: 'learning', dueAt: EVENING }, EVENING), true);
});

test('a card is not due before its time, and a mastered card is never due', () => {
    assert.equal(isDue(card({ dueAt: EVENING + 1 }), EVENING), false);
    assert.equal(isDue(card({ dueAt: EVENING }), EVENING), true);
    assert.equal(isDue(card({ reviewState: 'mastered', dueAt: null }), EVENING), false);
    assert.equal(isDue(card({ reviewState: 'mastered', dueAt: 0 }), EVENING), false);
});

test('the review day starts at 04:00, so a late-night sitting belongs to the evening before', () => {
    const night = at(1);
    assert.equal(dayStart(night), plusDays(at(4, 0), -1));
    assert.equal(dayStart(EVENING), at(4, 0));
    assert.equal(nextRollover(night), at(4, 0));
    assert.equal(nextRollover(EVENING), plusDays(at(4, 0), 1));
    // "Tomorrow" is the next review day, not 24 hours later.
    assert.equal(schedule(card(), 'hard', night).dueAt, at(4, 0));
    assert.equal(schedule(card(), 'good', night).dueAt, at(4, 0));
});

test('due cards list most overdue first, and never-scheduled cards follow oldest first', () => {
    const ordered = [
        card({ id: 'new-2', createdAt: 20 }),
        card({ id: 'later', createdAt: 1, dueAt: 900 }),
        card({ id: 'new-1', createdAt: 10 }),
        card({ id: 'overdue', createdAt: 2, dueAt: 100 })
    ].sort(compareDue).map(note => note.id);
    assert.deepEqual(ordered, ['overdue', 'later', 'new-1', 'new-2']);
});

test('a sitting keeps each video together, opens with the video being watched and stops at its limit', () => {
    const notes = [
        card({ id: 'b1', createdAt: 1, source: { sourceId: 'B' } }),
        card({ id: 'a1', createdAt: 2, source: { sourceId: 'A' } }),
        card({ id: 'b2', createdAt: 3, source: { sourceId: 'B' } }),
        card({ id: 'c1', createdAt: 4, source: { sourceId: 'C' }, dueAt: 500 }),
        card({ id: 'd1', createdAt: 5, source: { sourceId: 'D' }, dueAt: 100 })
    ];
    const ids = cards => cards.map(note => note.id);
    assert.deepEqual(ids(orderSession(notes, { currentSourceId: 'A' })), ['a1', 'd1', 'c1', 'b1', 'b2']);
    assert.deepEqual(ids(orderSession(notes, { limit: 3 })), ['d1', 'c1', 'b1']);
    assert.deepEqual(ids(orderSession(notes, { limit: 3, currentSourceId: 'B' })), ['b1', 'b2', 'd1']);
    assert.deepEqual(orderSession([]), []);
    assert.deepEqual(notes.map(note => note.id), ['b1', 'a1', 'b2', 'c1', 'd1'], 'the input list is left in its own order');
});

test('unknown ratings are rejected instead of scheduling something', () => {
    for (const rating of ['easy', undefined, null, 'GOOD']) assert.throws(() => schedule(card(), rating, EVENING), /复习结果无效/);
});
