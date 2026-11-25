const DAY = 24 * 60 * 60 * 1000;
const ROLLOVER_HOUR = 4;
export const RATINGS = new Set(['again', 'hard', 'good']);
/** Days until the next success; a success on the last step graduates the card. */
export const STEPS = Object.freeze([1, 3, 7, 15, 31]);

/** Start of the current review day. The 04:00 boundary keeps a late-night session on one day. */
export function dayStart(now = Date.now()) {
    const date = new Date(now);
    date.setHours(ROLLOVER_HOUR, 0, 0, 0);
    if (date.getTime() > now) date.setDate(date.getDate() - 1);
    return date.getTime();
}

function daysFrom(start, days) {
    const date = new Date(start);
    date.setDate(date.getDate() + days);
    return date.getTime();
}

/** When cards scheduled "tomorrow" become due. */
export function nextRollover(now = Date.now()) {
    return daysFrom(dayStart(now), 1);
}

/** Mastered cards are never due; a card without a date was never scheduled, so it is due now. */
export function isDue(note, now = Date.now()) {
    return note?.reviewState !== 'mastered' && !(note.dueAt > now);
}

function dueKey(note) {
    return Number.isFinite(note.dueAt) ? note.dueAt : Infinity;
}

/** Scheduled cards first, most overdue first; never-scheduled cards follow, oldest first. */
export function compareDue(left, right) {
    const difference = dueKey(left) - dueKey(right);
    return difference === 0 || Number.isNaN(difference) ? left.createdAt - right.createdAt : difference;
}

/**
 * Fields changed by one self-rating, on a fixed ladder rather than an adaptive algorithm.
 * again: due now, back to the start; hard: due tomorrow, one step down;
 * good: one step up, and the last step graduates the card.
 */
export function schedule(note, rating, now = Date.now()) {
    if (!RATINGS.has(rating)) throw new Error('复习结果无效');
    const step = STEPS.indexOf(note.interval);
    const base = { reps: (note.reps || 0) + 1, lastReviewedAt: now, reviewState: 'learning' };
    if (rating === 'again') return { ...base, lapses: (note.lapses || 0) + 1, interval: 0, dueAt: now };
    if (rating === 'hard') return { ...base, interval: step > 0 ? STEPS[step - 1] : 0, dueAt: nextRollover(now) };
    if (step === STEPS.length - 1) return { ...base, reviewState: 'mastered', dueAt: null };
    const interval = STEPS[step + 1];
    return { ...base, interval, dueAt: daysFrom(dayStart(now), interval) };
}

/**
 * Cards for one sitting. The open video comes first and each video's cards stay together,
 * so cross-video playback happens once per video instead of once per card.
 */
export function orderSession(notes, { currentSourceId = null, limit = Infinity } = {}) {
    const groups = new Map();
    for (const note of notes) {
        const sourceId = note.source?.sourceId || '';
        if (!groups.has(sourceId)) groups.set(sourceId, []);
        groups.get(sourceId).push(note);
    }
    const position = group => {
        const sourceId = group[0].source?.sourceId || '';
        return sourceId === currentSourceId ? -Infinity : dueKey(group[0]);
    };
    const ordered = [...groups.values()].sort((left, right) => {
        const difference = position(left) - position(right);
        return Number.isNaN(difference) ? compareDue(left[0], right[0]) : difference;
    });
    return ordered.flatMap(group => group.sort(compareDue)).slice(0, limit);
}
