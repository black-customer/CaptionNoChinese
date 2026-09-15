import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebook } from '../src/notebook.js';

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
        await Promise.all([...this.listeners.get(type) || []].map(callback => callback({ target: this, ...extra })));
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
        remove: async () => ({ ...note }), restore: async () => {}, ...overrides.repo
    };
    const player = { getCurrent: () => ({ identity: { seriesId: 'series_1', source: { sourceId: 'source_1' } }, sourceReady: true, media: { play: async () => { playCount += 1; } } }), seek: async (...args) => { seeks.push(args); return { navigated: false }; } };
    const notebook = createNotebook({ repo, player, getLeadIn: overrides.getLeadIn, notify: value => messages.push(value), onChange: () => { changeCount += 1; } });
    document.body.append(notebook.element);
    t.after(async () => {
        await notebook.dispose();
        globalThis.document = previous.document;
        globalThis.window = previous.window;
        globalThis.IntersectionObserver = previous.observer;
    });
    return { notebook, repo, player, note, updates, seeks, messages, document, window, observers, changes: () => changeCount, plays: () => playCount };
}

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
