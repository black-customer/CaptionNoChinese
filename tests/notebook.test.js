import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebook } from '../src/notebook.js';
import { isDue, schedule } from '../src/schedule.js';

// A fixed evening, so due dates and navigation markers do not depend on when the suite runs.
const NOW = new Date(2026, 10, 24, 21, 30).getTime();
const SESSION_KEY = 'bili_caption_review_session';

// A small event/DOM fixture for notebook orchestration, not a browser or layout test.
class FixtureNode {
    constructor(tag, document) {
        this.tagName = tag.toUpperCase(); this.ownerDocument = document;
        this.children = []; this.parentNode = null; this.attributes = new Map();
        this.listeners = new Map(); this.dataset = {}; this.className = ''; this.value = '';
        this.hidden = false; this.disabled = false; this.inert = false; this.textContent = '';
        this.classList = { toggle: (name, enabled) => {
            const tokens = new Set(this.className.split(' ').filter(Boolean));
            if (enabled) tokens.add(name); else tokens.delete(name);
            this.className = [...tokens].join(' ');
        } };
        // Nodes link back to their document, so a failed assertion must not print the whole tree.
        this[Symbol.for('nodejs.util.inspect.custom')] = () => `<${this.tagName.toLowerCase()}${this.className ? ` class="${this.className}"` : ''}>`;
    }
    append(...nodes) {
        for (const item of nodes) {
            if (item.tagName === '#FRAGMENT') { this.append(...[...item.children]); continue; }
            item.remove(); item.parentNode = this; this.children.push(item);
            if (this.tagName === 'SELECT' && this.children.length === 1) this.value = item.value;
        }
    }
    replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
    remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    async emit(type, extra = {}) {
        await Promise.all([...this.listeners.get(type) || []].map(callback => callback({
            target: this, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {}, ...extra
        })));
    }
    click() { return this.disabled ? Promise.resolve() : this.emit('click'); }
    focus() { this.ownerDocument.activeElement = this; }
    get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
}

function find(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children) { const result = find(child, predicate); if (result) return result; }
    return null;
}
const byClass = (root, name) => find(root, item => item.className.split(' ').includes(name));
const byText = (root, text) => find(root, item => item.tagName === 'BUTTON' && item.textContent === text);
const sessionOf = notebook => byClass(notebook.element, 'bcm-session');
const choice = (root, rating) => find(root, item => item.dataset.rating === rating);
const scene = (id, createdAt, extra = {}) => ({
    id, seriesId: 'series_1', seriesTitle: 'Friends', epTitle: `Episode ${id.slice(-1)}`,
    source: { url: 'https://www.bilibili.com/video/BV1xx411c7mD/', sourceId: 'source_1' },
    time: 42, timeStr: '00:42', userNote: `note ${id}`, tags: [], reviewState: 'new', createdAt, updatedAt: createdAt, ...extra
});
const FAR = scene('note_far', 1, { epTitle: 'Episode 9', source: { url: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2', sourceId: 'source_2' } });
const deferred = () => {
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

function setup(t, overrides = {}) {
    const previous = { document: globalThis.document, window: globalThis.window, observer: globalThis.IntersectionObserver };
    const document = {};
    document.createElement = tag => new FixtureNode(tag, document);
    document.createDocumentFragment = () => new FixtureNode('#fragment', document);
    document.body = document.createElement('body');
    document.activeElement = document.body;
    const window = document.createElement('window');
    const observers = [];
    globalThis.document = document;
    globalThis.window = window;
    globalThis.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
        observe(target) { this.targets.add(target); }
        unobserve(target) { this.targets.delete(target); }
        disconnect() { this.targets.clear(); }
        trigger() { this.callback([...this.targets].map(target => ({ target, isIntersecting: true }))); }
    };
    const note = {
        id: 'note_1', seriesId: 'series_1', seriesTitle: 'Friends', epTitle: 'Episode 1',
        source: { url: 'https://www.bilibili.com/video/BV1xx411c7mD/', sourceId: 'source_1' },
        time: 42, timeStr: '00:42', userNote: 'original', tags: [], reviewState: 'new', hasImage: false,
        createdAt: 1, updatedAt: 1
    };
    const updates = []; const seeks = []; const messages = []; let changeCount = 0; let playCount = 0;
    const repo = {
        ready: async () => {},
        list: async () => ({ notes: [{ ...note }], total: 1 }),
        get: async () => ({ ...note }),
        update: async (id, patch) => { updates.push({ id, patch }); Object.assign(note, patch); },
        remove: async () => ({ ...note }), restore: async () => {}, countDue: async () => 0, review: async () => {}, ...overrides.repo
    };
    const player = { getCurrent: () => ({ identity: { seriesId: 'series_1', source: { sourceId: 'source_1' } }, sourceReady: true, media: { play: async () => { playCount += 1; } } }), seek: async (...args) => { seeks.push(args); return { navigated: false }; } };
    const values = new Map();
    const store = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
    const options = {
        repo, player, notify: value => messages.push(value), onChange: () => { changeCount += 1; }, getLeadIn: overrides.getLeadIn, now: () => NOW,
        sessionStorage: store, ...overrides.notebook
    };
    const notebook = createNotebook(options);
    document.body.append(notebook.element);
    t.after(async () => {
        await notebook.dispose();
        globalThis.document = previous.document;
        globalThis.window = previous.window;
        globalThis.IntersectionObserver = previous.observer;
    });
    return {
        notebook, repo, player, note, updates, seeks, messages, document, window, observers, store, changes: () => changeCount, plays: () => playCount,
        create: (extra = {}) => createNotebook({ ...options, ...extra })
    };
}

/** Cards that follow the real scheduler, so a sitting behaves as it does over IndexedDB. */
function sitting(t, cards, overrides = {}) {
    const fixture = setup(t, { ...overrides, repo: { countDue: async () => cards.filter(card => isDue(card, NOW)).length, ...overrides.repo } });
    const ratings = [];
    fixture.repo.list = async options => options.status === 'due'
        ? { notes: cards.filter(card => isDue(card, NOW)), total: cards.length }
        : { notes: [{ ...fixture.note }], total: 1 };
    fixture.repo.get = async id => { const card = cards.find(item => item.id === id); return card ? { ...card } : null; };
    fixture.repo.review = async (id, rating) => {
        const card = cards.find(item => item.id === id);
        ratings.push(`${id}:${rating}`);
        Object.assign(card, schedule(card, rating, NOW));
        return { ...card };
    };
    return { ...fixture, cards, ratings };
}

const onFarPage = fixture => {
    fixture.player.getCurrent = () => ({ identity: { seriesId: 'series_1', source: { sourceId: 'source_2' } }, sourceReady: true, media: { play: async () => {} } });
};

test('editing during a pending save serializes the next patch and keeps the latest text', async t => {
    const firstCommit = deferred(); const calls = [];
    const fixture = setup(t, { repo: { update: async (id, patch) => { calls.push({ ...patch }); if (calls.length === 1) await firstCommit.promise; } } });
    await fixture.notebook.open();
    const input = byClass(fixture.notebook.element, 'bcm-note-input');
    input.value = 'first draft'; await input.emit('input');
    const saving = fixture.notebook.flushDrafts();
    await tick();
    input.value = 'second draft'; await input.emit('input');
    const secondFlush = fixture.notebook.flushDrafts();
    firstCommit.resolve();
    assert.equal(await saving, true);
    assert.equal(await secondFlush, true);
    assert.deepEqual(calls, [{ userNote: 'first draft' }, { userNote: 'second draft' }]);
    assert.equal(byClass(fixture.notebook.element, 'bcm-save-state').textContent, '已保存');
});

test('failed saves retain drafts across refresh and block source navigation until retry succeeds', async t => {
    let fail = true;
    const fixture = setup(t, { repo: { update: async () => { if (fail) throw new Error('quota exceeded'); } } });
    await fixture.notebook.open();
    const input = byClass(fixture.notebook.element, 'bcm-note-input');
    input.value = '<b>keep this literal draft</b>'; await input.emit('input');
    assert.equal(await fixture.notebook.flushDrafts(), false);
    await fixture.notebook.refresh();
    assert.equal(byClass(fixture.notebook.element, 'bcm-note-input').value, '<b>keep this literal draft</b>');
    await byClass(fixture.notebook.element, 'bcm-play-button').click();
    assert.equal(fixture.seeks.length, 0);
    fail = false;
    await byClass(fixture.notebook.element, 'bcm-play-button').click();
    assert.equal(fixture.seeks.length, 1);
    assert.equal(fixture.plays(), 1);
    assert.deepEqual(fixture.seeks[0][1], { leadIn: 3 });
});

test('source changes after seek do not play the wrong media', async t => {
    const fixture = setup(t);
    await fixture.notebook.open();
    fixture.player.getCurrent = () => ({ identity: { seriesId: 'series_1', source: { sourceId: 'another_source' } }, sourceReady: false, media: { play: () => assert.fail('wrong media must not play') } });
    await byClass(fixture.notebook.element, 'bcm-play-button').click();
    assert.match(fixture.messages.at(-1), /视频正在切换/);
});

test('replay reads the current lead-in preference when clicked', async t => {
    let leadIn = 4;
    const fixture = setup(t, { getLeadIn: () => leadIn });
    await fixture.notebook.open();
    leadIn = 8;
    await byClass(fixture.notebook.element, 'bcm-play-button').click();
    assert.equal(fixture.seeks[0][1].leadIn, 8);
});

test('a delayed list response cannot replace text edited and saved while it was loading', async t => {
    const staleQuery = deferred(); let useDeferred = false;
    const fixture = setup(t);
    const initialList = fixture.repo.list;
    fixture.repo.list = () => useDeferred ? staleQuery.promise : initialList();
    await fixture.notebook.open();
    useDeferred = true;
    const refreshing = fixture.notebook.refresh();
    await tick();
    const input = byClass(fixture.notebook.element, 'bcm-note-input');
    input.value = 'newest text'; await input.emit('input');
    await fixture.notebook.flushDrafts();
    staleQuery.resolve({ notes: [{ ...fixture.note, userNote: 'stale server text' }], total: 1 });
    await refreshing;
    assert.equal(byClass(fixture.notebook.element, 'bcm-note-input').value, 'newest text');
});

test('close flushes drafts, hides the non-modal aside and restores focus', async t => {
    const fixture = setup(t);
    const trigger = fixture.document.createElement('button'); fixture.document.body.append(trigger); trigger.focus();
    await fixture.notebook.open();
    assert.equal(fixture.document.activeElement.tagName, 'INPUT');
    const input = byClass(fixture.notebook.element, 'bcm-note-input');
    input.value = 'saved on close'; await input.emit('input');
    await fixture.notebook.close();
    assert.equal(fixture.note.userNote, 'saved on close');
    assert.equal(fixture.notebook.element.hidden, true);
    assert.equal(fixture.notebook.element.inert, true);
    assert.equal(fixture.document.activeElement, trigger);
    assert.equal(fixture.notebook.isOpen(), false);
});

test('images are fetched when observed and their object URLs are released on close', async t => {
    const fixture = setup(t);
    fixture.note.hasImage = true;
    let gets = 0; const revoked = [];
    fixture.repo.get = async () => { gets += 1; return { ...fixture.note, imageBlob: new Blob(['picture'], { type: 'image/jpeg' }) }; };
    const oldCreate = URL.createObjectURL; const oldRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:test-notebook';
    URL.revokeObjectURL = value => revoked.push(value);
    t.after(() => { URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; });
    await fixture.notebook.open();
    assert.equal(gets, 0);
    fixture.observers[0].trigger(); await tick();
    assert.equal(gets, 1);
    assert.equal(byClass(fixture.notebook.element, 'bcm-note-image').src, 'blob:test-notebook');
    await fixture.notebook.close();
    assert.deepEqual(revoked, ['blob:test-notebook']);
});

test('filters reset pagination and queries have an explicit series scope', async t => {
    const calls = []; const fixture = setup(t);
    fixture.repo.list = async options => { calls.push(options); return { notes: [{ ...fixture.note }], total: 61 }; };
    await fixture.notebook.open();
    assert.deepEqual(calls[0], { seriesId: 'series_1', query: '', status: 'all', offset: 0, limit: 30 });
    await byText(fixture.notebook.element, '下一页').click();
    assert.equal(calls.at(-1).offset, 30);
    const scope = find(fixture.notebook.element, item => item.attributes.get('aria-label') === '收藏范围');
    scope.value = 'all'; await scope.emit('change'); await tick();
    assert.equal(calls.at(-1).seriesId, null);
    assert.equal(calls.at(-1).offset, 0);
});

test('backup import previews conflicts and waits for explicit confirmation', async t => {
    const backup = { schemaVersion: 1, notes: [{ id: 'a' }, { id: 'b' }] };
    const imported = [];
    const fixture = setup(t, { repo: {
        previewImport: async data => { assert.deepEqual(data, backup); return { total: 2, existing: 1, newCount: 1 }; },
        importBackup: async data => { imported.push(data); return { imported: 1, skipped: 1 }; }
    } });
    await fixture.notebook.open();
    const input = find(fixture.notebook.element, item => item.type === 'file');
    input.files = [{ name: 'backup.json', size: 100, text: async () => JSON.stringify(backup) }];
    await input.emit('change');
    assert.equal(imported.length, 0);
    assert.equal(byClass(fixture.notebook.element, 'bcm-import-preview').hidden, false);
    await byText(fixture.notebook.element, '确认导入').click();
    assert.deepEqual(imported, [backup]);
    assert.equal(byClass(fixture.notebook.element, 'bcm-import-preview').hidden, true);
});

test('oversized backup is rejected before reading or parsing its contents', async t => {
    const fixture = setup(t);
    await fixture.notebook.open();
    const input = find(fixture.notebook.element, item => item.type === 'file');
    input.files = [{ name: 'too-large.json', size: 151 * 1024 * 1024, text: () => assert.fail('must not read oversized file') }];
    await input.emit('change');
  const notice = byClass(fixture.notebook.element, 'bcm-notices');
  assert.match(notice.children[0].textContent, /超过 150 MiB/);
});

test('due cards become a sitting that reveals, rates and advances one card at a time', async t => {
    const fixture = sitting(t, [scene('note_1', 1, { userNote: 'the first note' }), scene('note_2', 2)]);
    const { notebook } = fixture;
    await notebook.open();
    assert.match(byClass(notebook.element, 'bcm-due-text').textContent, /有 2 条收藏到期/);
    assert.equal(fixture.ratings.length, 0, 'opening the notebook records nothing');
    await byText(notebook.element, '开始复习').click();
    const view = sessionOf(notebook);
    assert.equal(view.hidden, false);
    assert.equal(byClass(notebook.element, 'bcm-note-list').hidden, true);
    assert.match(byClass(view, 'bcm-session-progress').textContent, /还剩 2 条/);
    assert.equal(byClass(view, 'bcm-session-title').textContent, 'Episode 1 · 00:42');
    assert.equal(byClass(view, 'bcm-session-answer').hidden, true);
    assert.equal(byClass(view, 'bcm-ratings').hidden, true);
    await byText(view, '显示答案').click();
    assert.equal(byClass(view, 'bcm-session-answer').hidden, false);
    assert.match(byClass(view, 'bcm-session-note').textContent, /the first note/);
    assert.equal(byClass(view, 'bcm-ratings').hidden, false);
    assert.deepEqual(fixture.ratings, [], 'revealing is not a rating');
    assert.equal(choice(view, 'good').attributes.get('aria-label'), '听懂了，1 天后再来');
    const changes = fixture.changes();
    await choice(view, 'good').click();
    assert.deepEqual(fixture.ratings, ['note_1:good']);
    assert.ok(fixture.changes() > changes, 'the player badge is told to refresh');
    assert.equal(byClass(view, 'bcm-session-title').textContent, 'Episode 2 · 00:42');
    assert.equal(byClass(view, 'bcm-session-answer').hidden, true, 'the next card starts hidden');
});

test('a card that was not understood comes back later in the sitting, which then summarizes', async t => {
    const fixture = sitting(t, [scene('note_1', 1), scene('note_2', 2), scene('note_3', 3)]);
    const view = sessionOf(fixture.notebook);
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    await byText(view, '显示答案').click(); await choice(view, 'again').click();
    assert.equal(byClass(view, 'bcm-session-title').textContent, 'Episode 2 · 00:42');
    await byText(view, '显示答案').click(); await choice(view, 'good').click();
    await byText(view, '显示答案').click(); await choice(view, 'hard').click();
    assert.equal(byClass(view, 'bcm-session-title').textContent, 'Episode 1 · 00:42');
    assert.match(byClass(view, 'bcm-session-progress').textContent, /还剩 1 条/);
    await byText(view, '显示答案').click(); await choice(view, 'good').click();
    assert.equal(byClass(view, 'bcm-session-title').textContent, '本轮复习完成');
    assert.match(byClass(view, 'bcm-session-hint').textContent, /复习了 3 条收藏：听懂了 2，费劲 1，没听懂 1/);
    assert.equal(fixture.store.getItem(SESSION_KEY), null);
    assert.deepEqual(fixture.ratings, ['note_1:again', 'note_2:good', 'note_3:hard', 'note_1:good']);
    await byText(view, '返回复习本').click();
    assert.equal(view.hidden, true);
    assert.equal(byClass(fixture.notebook.element, 'bcm-note-list').hidden, false);
    assert.equal(byClass(fixture.notebook.element, 'bcm-due-bar').hidden, true, 'nothing is left to review');
});

test('a sitting takes at most the configured number of cards, and another can follow', async t => {
    const fixture = sitting(t, [scene('note_1', 1), scene('note_2', 2)], { notebook: { getBatchSize: () => 1 } });
    const view = sessionOf(fixture.notebook);
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    assert.match(byClass(view, 'bcm-session-progress').textContent, /还剩 1 条/);
    await byText(view, '显示答案').click(); await choice(view, 'good').click();
    assert.equal(byClass(view, 'bcm-session-title').textContent, '本轮复习完成');
    await byText(view, '再来一组').click();
    assert.equal(byClass(view, 'bcm-session-title').textContent, 'Episode 2 · 00:42');
});

test('closing mid-sitting keeps the place and offers to continue', async t => {
    const fixture = sitting(t, [scene('note_1', 1), scene('note_2', 2), scene('note_3', 3)]);
    const view = sessionOf(fixture.notebook);
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    await byText(view, '显示答案').click(); await choice(view, 'good').click();
    assert.equal(JSON.parse(fixture.store.getItem(SESSION_KEY)).index, 1);
    await fixture.notebook.close();
    assert.notEqual(fixture.store.getItem(SESSION_KEY), null);
    await fixture.notebook.open();
    assert.match(byClass(fixture.notebook.element, 'bcm-due-text').textContent, /上次复习还剩 2 条/);
    assert.equal(view.hidden, true, 'reopening shows the list first');
    await byText(fixture.notebook.element, '继续复习').click();
    assert.equal(byClass(view, 'bcm-session-title').textContent, 'Episode 2 · 00:42');
    await byText(view, '结束复习').click();
    assert.equal(view.hidden, true);
    assert.equal(JSON.parse(fixture.store.getItem(SESSION_KEY)).index, 1);
});

test('cards deleted or reviewed elsewhere are skipped when a sitting resumes', async t => {
    const fixture = sitting(t, [scene('note_1', 1), scene('note_2', 2)]);
    const get = fixture.repo.get;
    fixture.repo.get = async id => id === 'note_1' ? null : get(id);
    const view = sessionOf(fixture.notebook);
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    assert.equal(byClass(view, 'bcm-session-title').textContent, 'Episode 2 · 00:42');
    await fixture.notebook.close();
    Object.assign(fixture.cards[1], schedule(fixture.cards[1], 'good', NOW));
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '继续复习').click();
    assert.equal(byClass(view, 'bcm-session-title').textContent, '本轮复习完成');
    assert.deepEqual(fixture.ratings, []);
});

test('space reveals and 1 / 2 / 3 rate, only while a card is showing and only after the answer', async t => {
    const fixture = sitting(t, [scene('note_1', 1)]);
    const view = sessionOf(fixture.notebook);
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    await fixture.window.emit('keydown', { key: '3' });
    assert.deepEqual(fixture.ratings, [], 'a hidden answer cannot be rated');
    await fixture.window.emit('keydown', { key: ' ' });
    assert.equal(byClass(view, 'bcm-session-answer').hidden, false);
    await fixture.window.emit('keydown', { key: '3', repeat: true });
    assert.deepEqual(fixture.ratings, [], 'a held key does not rate');
    await fixture.window.emit('keydown', { key: '3' });
    assert.deepEqual(fixture.ratings, ['note_1:good']);
    assert.equal(byClass(view, 'bcm-session-title').textContent, '本轮复习完成');
    await fixture.notebook.close();
    await fixture.window.emit('keydown', { key: ' ' });
});

test('session shortcuts ignore editable inputs and shadow DOM editors for Space and 1 / 2 / 3', async t => {
    const fixture = sitting(t, [scene('note_1', 1)]);
    const view = sessionOf(fixture.notebook);
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    const input = fixture.document.createElement('input');
    fixture.document.body.append(input);
    input.focus();
    const spaceInInput = { key: ' ', target: input, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
    await fixture.window.emit('keydown', spaceInInput);
    assert.equal(byClass(view, 'bcm-session-answer').hidden, true, 'Space inside input does not reveal');
    assert.equal(spaceInInput.defaultPrevented, false);

    const host = fixture.document.createElement('bili-comments');
    const editor = fixture.document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('role', 'textbox');
    host.shadowRoot = { activeElement: editor };
    fixture.document.body.append(host);
    host.focus();
    const spaceInShadow = { key: ' ', target: host, composedPath: () => [editor, host, fixture.document.body, fixture.window], defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
    await fixture.window.emit('keydown', spaceInShadow);
    assert.equal(byClass(view, 'bcm-session-answer').hidden, true, 'Space inside shadow DOM editor does not reveal');
    assert.equal(spaceInShadow.defaultPrevented, false);

    await byText(view, '显示答案').click();
    input.focus();
    const digitInInput = { key: '3', target: input, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
    await fixture.window.emit('keydown', digitInInput);
    assert.deepEqual(fixture.ratings, [], '1 / 2 / 3 inside input does not rate');
    assert.equal(digitInInput.defaultPrevented, false);

    host.focus();
    const digitInShadow = { key: '2', target: host, composedPath: () => [editor, host, fixture.document.body, fixture.window], defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
    await fixture.window.emit('keydown', digitInShadow);
    assert.deepEqual(fixture.ratings, [], '1 / 2 / 3 inside shadow DOM editor does not rate');
    assert.equal(digitInShadow.defaultPrevented, false);

    byClass(view, 'bcm-session-title').focus();
    await fixture.window.emit('keydown', { key: '3' });
    assert.deepEqual(fixture.ratings, ['note_1:good']);
});

test('custom session shortcuts reveal, rate, disable keys and update kbd labels live', async t => {
    let shortcuts = { reveal: 'E', rateAgain: 'A', rateHard: '', rateGood: 'Alt+D' };
    const fixture = sitting(t, [scene('note_1', 1)], { notebook: { getShortcuts: () => shortcuts } });
    const view = sessionOf(fixture.notebook);
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    assert.match(byClass(view, 'bcm-nowrap').textContent, /E显示答案，A \/ — \/ Alt \+ D 自评/);
    await fixture.window.emit('keydown', { key: ' ' });
    assert.equal(byClass(view, 'bcm-session-answer').hidden, true, 'old Space key no longer reveals');
    await fixture.window.emit('keydown', { key: 'e', code: 'KeyE' });
    assert.equal(byClass(view, 'bcm-session-answer').hidden, false);
    assert.equal(choice(view, 'hard').children[0].children[0].hidden, true, 'disabled rating hides kbd badge');
    shortcuts = { reveal: 'E', rateAgain: 'A', rateHard: 'S', rateGood: 'D' };
    fixture.notebook.refreshShortcuts();
    assert.equal(choice(view, 'hard').children[0].children[0].hidden, false);
    assert.equal(choice(view, 'hard').children[0].children[0].textContent, 'S');
    await fixture.window.emit('keydown', { key: '3' });
    assert.deepEqual(fixture.ratings, [], 'old digit key no longer rates');
    await fixture.window.emit('keydown', { key: 'd', code: 'KeyD' });
    assert.deepEqual(fixture.ratings, ['note_1:good']);
});

test('a rating that cannot be saved keeps the card on screen and can be retried', async t => {
    const fixture = sitting(t, [scene('note_1', 1)]);
    const view = sessionOf(fixture.notebook);
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    await byText(view, '显示答案').click();
    let fail = true;
    fixture.repo.review = async () => { if (fail) throw new Error('quota exceeded'); };
    await choice(view, 'good').click();
    assert.match(byClass(fixture.notebook.element, 'bcm-notices').children[0].textContent, /自评没有保存：quota exceeded/);
    assert.equal(byClass(view, 'bcm-session-title').textContent, 'Episode 1 · 00:42');
    assert.equal(JSON.parse(fixture.store.getItem(SESSION_KEY)).index, 0);
    assert.equal(choice(view, 'good').disabled, false);
    fail = false;
    await choice(view, 'good').click();
    assert.equal(byClass(view, 'bcm-session-title').textContent, '本轮复习完成');
});

test('leaving for another video marks the sitting, and the next page resumes it', async t => {
    const fixture = sitting(t, [FAR]);
    let navigations = 0;
    fixture.player.seek = async () => { navigations += 1; return { navigated: true }; };
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    const view = sessionOf(fixture.notebook);
    assert.match(byClass(view, 'bcm-session-hint').textContent, /其他视频/);
    await byClass(view, 'bcm-play-button').click();
    assert.equal(navigations, 1);
    assert.equal(JSON.parse(fixture.store.getItem(SESSION_KEY)).pending, 'listen');
    onFarPage(fixture);
    const next = fixture.create();
    fixture.document.body.append(next.element);
    assert.equal(await next.resumeSession(), true);
    assert.equal(next.isOpen(), true);
    assert.equal(sessionOf(next).hidden, false);
    assert.equal(byClass(sessionOf(next), 'bcm-session-title').textContent, 'Episode 9 · 00:42');
    assert.equal(JSON.parse(fixture.store.getItem(SESSION_KEY)).pending, null);
    await next.dispose();
});

test('a loop requested across videos starts by itself once the next page is ready', async t => {
    let navigated = true;
    const loops = [];
    const fixture = sitting(t, [FAR], { notebook: {
        onLoop: async note => { loops.push(`${note.id}:${navigated ? 'navigated' : 'here'}`); return { navigated }; }
    } });
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    await byText(sessionOf(fixture.notebook), '片段循环').click();
    assert.deepEqual(loops, ['note_far:navigated']);
    assert.equal(JSON.parse(fixture.store.getItem(SESSION_KEY)).pending, 'loop');
    navigated = false;
    onFarPage(fixture);
    const next = fixture.create();
    fixture.document.body.append(next.element);
    await next.resumeSession();
    assert.deepEqual(loops, ['note_far:navigated', 'note_far:here']);
    assert.equal(JSON.parse(fixture.store.getItem(SESSION_KEY)).pending, null);
    await next.dispose();
});

test('a stale navigation marker is dropped, and playing on the same video leaves no marker', async t => {
    const fixture = sitting(t, [scene('note_1', 1)]);
    fixture.store.setItem(SESSION_KEY, JSON.stringify({ queue: ['note_1'], index: 0, again: 0, hard: 0, good: 0, pending: 'listen', pendingAt: NOW - 3 * 60 * 1000 }));
    const stale = fixture.create();
    fixture.document.body.append(stale.element);
    assert.equal(await stale.resumeSession(), false);
    assert.equal(stale.isOpen(), false);
    assert.equal(JSON.parse(fixture.store.getItem(SESSION_KEY)).pending, null);
    await stale.dispose();
    fixture.store.setItem(SESSION_KEY, '{not json');
    const corrupt = fixture.create();
    assert.equal(await corrupt.resumeSession(), false);
    await corrupt.dispose();
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    await byClass(sessionOf(fixture.notebook), 'bcm-play-button').click();
    assert.equal(fixture.seeks.length, 1);
    assert.equal(fixture.plays(), 1);
    assert.equal(fixture.document.activeElement, byClass(sessionOf(fixture.notebook), 'bcm-session-title'), 'focus returns to the card so that space reveals');
    assert.equal(fixture.store.getItem(SESSION_KEY).indexOf('"pending":null') > 0, true);
});

test('the scene is part of the answer, and its object URL is released when the sitting moves on', async t => {
    const fixture = sitting(t, [
        scene('note_1', 1, { hasImage: true, imageBlob: new Blob(['picture'], { type: 'image/jpeg' }) }), scene('note_2', 2)
    ]);
    const oldCreate = URL.createObjectURL; const oldRevoke = URL.revokeObjectURL;
    const revoked = [];
    URL.createObjectURL = () => 'blob:test-session';
    URL.revokeObjectURL = value => revoked.push(value);
    t.after(() => { URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; });
    const view = sessionOf(fixture.notebook);
    const answer = () => byClass(view, 'bcm-session-answer').hidden;
    await fixture.notebook.open();
    await byText(fixture.notebook.element, '开始复习').click();
    assert.equal(answer(), true, 'the scene waits for the answer');
    await byText(view, '显示答案').click();
    assert.equal(answer(), false);
    assert.equal(byClass(view, 'bcm-note-image').src, 'blob:test-session');
    await choice(view, 'good').click();
    assert.deepEqual(revoked, ['blob:test-session']);
    assert.equal(byClass(view, 'bcm-session-title').textContent, 'Episode 2 · 00:42');
});

test('the due filter queries due cards, and a manual status overrides the schedule', async t => {
    const calls = [];
    const fixture = setup(t);
    fixture.repo.list = async options => { calls.push(options); return { notes: [{ ...fixture.note }], total: 1 }; };
    await fixture.notebook.open();
    const status = find(fixture.notebook.element, item => item.attributes.get('aria-label') === '复习状态');
    assert.deepEqual(status.children.map(option => option.textContent), ['全部状态', '今日到期', '待复习', '学习中', '已掌握']);
    status.value = 'due'; await status.emit('change'); await tick();
    assert.equal(calls.at(-1).status, 'due');
    const select = find(fixture.notebook.element, item => item.attributes.get('aria-label') === '这条收藏的复习状态');
    select.value = 'mastered'; await select.emit('change');
    assert.deepEqual(fixture.updates.at(-1).patch, { reviewState: 'mastered' });
    select.value = 'learning'; await select.emit('change');
    assert.deepEqual(fixture.updates.at(-1).patch, { reviewState: 'learning', dueAt: NOW });
});
