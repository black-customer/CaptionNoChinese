import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createRepository } from '../src/storage.js';
import { STEPS } from '../src/schedule.js';
import { normalizeSource as normalizePlayerSource } from '../src/player.js';

const IMAGE = 'data:image/jpeg;base64,/9j/';
const LEGACY_KEY = 'bili_caption_notes_v200';
// A fixed evening and the following one, so due dates do not depend on when the suite runs.
const FIRST_EVENING = new Date(2026, 10, 24, 21, 30).getTime();
const NEXT_EVENING = new Date(2026, 10, 25, 21, 30).getTime();
const note = (id = 'note-1', overrides = {}) => ({
    id, seriesId: 'season-1', seriesTitle: '学习剧集', epTitle: '第一集',
    source: { url: 'http://www.bilibili.com/video/BV123?p=1', videoId: 'BV123', episodeId: '', page: 1, sourceId: 'BV123:1' },
    time: 42, timeStr: '00:42', imageUrl: IMAGE, userNote: 'A useful expression', tags: ['表达'],
    reviewState: 'new', createdAt: 1000, updatedAt: 1000, ...overrides
});
const backup = notes => ({ format: 'caption-study-backup', schemaVersion: 1, notes });
const localStore = initial => {
    const values = new Map(Object.entries(initial || {}));
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
function repoFixture(overrides = {}) {
    const indexedDB = new IDBFactory();
    const repository = createRepository({ indexedDB, localStorage: null, ...overrides });
    return { indexedDB, repository };
}
function rawOpen(factory, version, upgrade) {
    return new Promise((resolve, reject) => {
        const request = factory.open('BiliCaptionStudyDB', version);
        request.onupgradeneeded = () => upgrade?.(request.result, request.transaction);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
function readRaw(database, store, id) {
    return new Promise((resolve, reject) => {
        const tx = database.transaction(store, 'readonly');
        const request = tx.objectStore(store).get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
function abortableFactory(factory) {
    const control = { abortNextWrite: false, transactions: [] };
    control.indexedDB = {
        open(...args) {
            const request = factory.open(...args);
            request.addEventListener('success', () => {
                const database = request.result;
                const original = database.transaction.bind(database);
                database.transaction = (stores, mode, ...rest) => {
                    const tx = original(stores, mode, ...rest);
                    control.transactions.push({ stores: [...tx.objectStoreNames], mode });
                    if (mode === 'readwrite' && control.abortNextWrite) {
                        control.abortNextWrite = false;
                        queueMicrotask(() => tx.abort());
                    }
                    return tx;
                };
            });
            return request;
        }
    };
    return control;
}

test('save/get commits metadata and media; source URL becomes HTTPS', async t => {
    const { repository, indexedDB } = repoFixture();
    t.after(() => repository.close());
    const saved = await repository.save(note());
    assert.equal(saved.source.url, 'https://www.bilibili.com/video/BV123?p=1');
    assert.equal(saved.hasImage, true);
    assert.equal((await repository.get(saved.id)).imageUrl, IMAGE);
    const database = await rawOpen(indexedDB, 2);
    t.after(() => database.close());
    const stored = await readRaw(database, 'notes', saved.id);
    assert.equal(stored.imageUrl, undefined);
    assert.equal((await readRaw(database, 'media', saved.id)).imageUrl, IMAGE);
});

test('stored sources remain compatible with the player across BV parts and bangumi episodes', async t => {
    const { repository } = repoFixture();
    t.after(() => repository.close());
    for (const [id, url] of [['part', 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2'], ['episode', 'https://www.bilibili.com/bangumi/play/ep123']]) {
        const source = normalizePlayerSource(url);
        assert.ok(source);
        await repository.save(note(id, { source }));
        assert.deepEqual(normalizePlayerSource((await repository.get(id)).source), source);
    }
});

test('v1 upgrade keeps notes and moves legacy images out of the metadata store', async t => {
    const indexedDB = new IDBFactory();
    const old = await rawOpen(indexedDB, 1, db => {
        const store = db.createObjectStore('notes', { keyPath: 'id' });
        store.createIndex('by_series', 'seriesId');
        store.createIndex('by_created', 'createdAt');
        const { source, tags, reviewState, updatedAt, ...legacy } = note('legacy');
        store.add(legacy);
    });
    old.close();
    const repository = createRepository({ indexedDB, localStorage: null });
    t.after(() => repository.close());
    await repository.ready();
    const saved = await repository.get('legacy');
    assert.equal(saved.imageUrl, IMAGE);
    assert.deepEqual(saved.tags, []);
    assert.equal(saved.reviewState, 'new');
    assert.deepEqual([saved.dueAt, saved.interval, saved.reps], [null, 0, 0], 'cards from before scheduled review are due now');
    assert.equal(saved.source.url, '');
    assert.equal((await repository.list()).notes[0].imageUrl, undefined);
});

test('an invalid v1 record aborts the upgrade and preserves the original database', async t => {
    const indexedDB = new IDBFactory();
    const old = await rawOpen(indexedDB, 1, db => {
        db.createObjectStore('notes', { keyPath: 'id' }).add(note('invalid-old', { imageUrl: 'https://outside.example/image.jpg' }));
    });
    old.close();
    const repository = createRepository({ indexedDB, localStorage: null });
    t.after(() => repository.close());
    await assert.rejects(repository.ready(), /原数据已保留/);
    const unchanged = await rawOpen(indexedDB, 1);
    t.after(() => unchanged.close());
    assert.equal(unchanged.version, 1);
    assert.equal((await readRaw(unchanged, 'notes', 'invalid-old')).imageUrl, 'https://outside.example/image.jpg');
    assert.equal(unchanged.objectStoreNames.contains('media'), false);
});

test('legacy GM/local migration is atomic, merges both sources, and cannot undo later edits or deletions', async t => {
    const indexedDB = new IDBFactory();
    const local = localStore({ [LEGACY_KEY]: JSON.stringify({ 'season-1': [note('local')] }) });
    const gm = JSON.stringify({ 'season-1': [note('gm')] });
    let gmReads = 0;
    const options = { indexedDB, localStorage: local, gmGet: () => { gmReads++; return gm; } };
    let repository = createRepository(options);
    t.after(() => repository.close());
    await Promise.all([repository.ready(), repository.ready()]);
    assert.equal(await repository.count(), 2);
    await repository.update('gm', { userNote: 'updated after migration' });
    await repository.remove('local');
    repository.close();
    repository = createRepository(options);
    await repository.ready();
    assert.equal((await repository.get('gm')).userNote, 'updated after migration');
    assert.equal(await repository.get('local'), null);
    assert.equal(gmReads, 1);
    assert.ok(local.getItem(LEGACY_KEY), 'original backup is retained');
});

test('two tabs can migrate the same legacy source concurrently without duplicate writes', async t => {
    const indexedDB = new IDBFactory();
    const gmGet = () => JSON.stringify({ 'season-1': [note('shared')] });
    const first = createRepository({ indexedDB, gmGet, localStorage: null });
    const second = createRepository({ indexedDB, gmGet, localStorage: null });
    t.after(() => { first.close(); second.close(); });
    await Promise.all([first.ready(), second.ready()]);
    assert.equal(await first.count(), 1);
    assert.equal(await second.count(), 1);
});

test('aborted migration retains original copies, does not commit its marker, and can retry', async t => {
    const factory = new IDBFactory();
    const control = abortableFactory(factory);
    const raw = JSON.stringify({ 'season-1': [note('legacy')] });
    const local = localStore({ [LEGACY_KEY]: raw });
    const repository = createRepository({ indexedDB: control.indexedDB, localStorage: local });
    t.after(() => repository.close());
    control.abortNextWrite = true;
    await assert.rejects(repository.ready(), /迁移失败/);
    assert.equal(local.getItem(LEGACY_KEY), raw);
    await repository.ready();
    assert.equal(await repository.count(), 1);
});

test('asynchronous transaction abort rejects a save and leaves no partial card or media', async t => {
    const control = abortableFactory(new IDBFactory());
    const repository = createRepository({ indexedDB: control.indexedDB, localStorage: null });
    t.after(() => repository.close());
    await repository.ready();
    control.abortNextWrite = true;
    await assert.rejects(repository.save(note('aborted')), /保存卡片失败/);
    assert.equal(await repository.count(), 0);
    assert.equal(await repository.get('aborted'), null);
});

test('list filters, sorts, and paginates metadata without opening the media store', async t => {
    const control = abortableFactory(new IDBFactory());
    const repository = createRepository({ indexedDB: control.indexedDB, localStorage: null });
    t.after(() => repository.close());
    await repository.save(note('one', { createdAt: 1 }));
    await repository.save(note('two', { createdAt: 2, reviewState: 'learning' }));
    await repository.save(note('three', { createdAt: 3, userNote: 'different', seriesId: 'season-2' }));
    control.transactions.length = 0;
    const page = await repository.list({ seriesId: 'season-1', query: 'USEFUL', offset: 1, limit: 1 });
    assert.equal(page.total, 2);
    assert.deepEqual(page.notes.map(n => n.id), ['one']);
    assert.equal(page.notes[0].imageUrl, undefined);
    assert.equal(page.notes[0].imageBlob, undefined);
    assert.equal(page.notes[0].hasImage, true);
    assert.ok(control.transactions.every(tx => !tx.stores.includes('media')));
    assert.equal((await repository.list({ status: 'learning' })).total, 1);
    assert.equal((await repository.list({ status: 'due' })).total, 3);
    await assert.rejects(repository.list({ status: 'soon' }), /复习筛选状态/);
    assert.equal(await repository.count('season-1'), 2);
    await assert.rejects(repository.list({ limit: 0 }), /分页/);
});

test('update preserves media and serial concurrent patches do not overwrite one another', async t => {
    const { repository } = repoFixture();
    t.after(() => repository.close());
    await repository.save(note());
    await Promise.all([
        repository.update('note-1', { userNote: '<b>literal text</b>' }),
        repository.update('note-1', { reviewState: 'mastered', tags: ['one', 'one', ' two '] })
    ]);
    const result = await repository.get('note-1');
    assert.equal(result.userNote, '<b>literal text</b>');
    assert.equal(result.reviewState, 'mastered');
    assert.deepEqual(result.tags, ['one', 'two']);
    assert.equal(result.imageUrl, IMAGE);
    assert.ok(result.updatedAt > result.createdAt);
    await repository.update('note-1', { imageUrl: undefined, userNote: 'still keeps the image' });
    assert.equal((await repository.get('note-1')).imageUrl, IMAGE);
    await assert.rejects(repository.update('note-1', { id: 'different' }), /ID/);
    await assert.rejects(repository.update('missing', { userNote: 'hello' }), /不存在/);
});

test('review schedules from the stored card, keeps media, and due queries follow the schedule', async t => {
    const { repository } = repoFixture();
    t.after(() => repository.close());
    await repository.save(note('one', { createdAt: 1 }));
    await repository.save(note('two', { createdAt: 2, reviewState: 'mastered' }));
    await repository.save(note('three', { createdAt: 3, reviewState: 'learning' }));
    await repository.save(note('four', { createdAt: 4, seriesId: 'season-2' }));
    // Cards that were never scheduled are due now, oldest first.
    assert.equal(await repository.countDue(null, FIRST_EVENING), 3);
    assert.equal(await repository.countDue('season-1', FIRST_EVENING), 2);
    assert.deepEqual((await repository.list({ status: 'due', now: FIRST_EVENING })).notes.map(n => n.id), ['one', 'three', 'four']);
    const rated = await repository.review('one', 'good', FIRST_EVENING);
    assert.deepEqual([rated.reviewState, rated.interval, rated.reps, rated.lapses, rated.lastReviewedAt], ['learning', 1, 1, 0, FIRST_EVENING]);
    assert.equal(rated.imageUrl, IMAGE);
    assert.equal(rated.dueAt > FIRST_EVENING, true);
    assert.equal(await repository.countDue('season-1', FIRST_EVENING + 3600000), 1);
    const again = await repository.review('one', 'again', NEXT_EVENING);
    assert.deepEqual([again.interval, again.dueAt, again.reps, again.lapses], [0, NEXT_EVENING, 2, 1]);
    assert.equal(await repository.countDue('season-1', NEXT_EVENING), 2);
    const ladder = [];
    for (let step = 0; step < STEPS.length; step += 1) ladder.push((await repository.review('one', 'good', NEXT_EVENING)).interval);
    assert.deepEqual(ladder, [...STEPS]);
    const graduated = await repository.review('one', 'good', NEXT_EVENING);
    assert.deepEqual([graduated.reviewState, graduated.dueAt, graduated.reps], ['mastered', null, 8]);
    assert.equal(await repository.countDue('season-1', NEXT_EVENING), 1);
    const hard = await repository.review('three', 'hard', NEXT_EVENING);
    assert.deepEqual([hard.interval, hard.dueAt > NEXT_EVENING], [0, true]);
    assert.equal(await repository.countDue('season-1', NEXT_EVENING), 0);
    await assert.rejects(repository.review('three', 'easy', NEXT_EVENING), /复习结果/);
    await assert.rejects(repository.review('missing', 'good', NEXT_EVENING), /不存在/);
    await assert.rejects(repository.review('three', 'good', -1), /复习时间/);
    assert.equal((await repository.get('three')).reps, 1);
});

test('an aborted review leaves the previous schedule untouched', async t => {
    const control = abortableFactory(new IDBFactory());
    const repository = createRepository({ indexedDB: control.indexedDB, localStorage: null });
    t.after(() => repository.close());
    await repository.ready();
    await repository.save(note());
    control.abortNextWrite = true;
    await assert.rejects(repository.review('note-1', 'good'), /记录复习失败/);
    assert.deepEqual([(await repository.get('note-1')).reps, await repository.countDue(null, FIRST_EVENING)], [0, 1]);
});

test('backups carry the schedule and still accept cards from before it', async t => {
    const { repository } = repoFixture();
    const { repository: destination } = repoFixture();
    t.after(() => { repository.close(); destination.close(); });
    const rated = await repository.review((await repository.save(note())).id, 'good', FIRST_EVENING);
    const exported = JSON.parse(JSON.stringify(await repository.exportBackup()));
    assert.equal(exported.schemaVersion, 1);
    assert.deepEqual(await destination.importBackup(exported), { imported: 1, skipped: 0 });
    const imported = await destination.get('note-1');
    assert.deepEqual([imported.reps, imported.interval, imported.reviewState, imported.dueAt, imported.lastReviewedAt], [1, 1, 'learning', rated.dueAt, FIRST_EVENING]);
    await destination.importBackup(JSON.parse(JSON.stringify(backup([note('legacy')]))));
    const legacy = await destination.get('legacy');
    assert.deepEqual([legacy.dueAt, legacy.interval, legacy.reps, legacy.lapses, legacy.lastReviewedAt], [null, 0, 0, 0, null]);
    assert.deepEqual((await destination.list({ status: 'due', now: FIRST_EVENING })).notes.map(n => n.id), ['legacy']);
    for (const patch of [{ dueAt: 'tomorrow' }, { interval: -1 }, { reps: 1.5 }, { lapses: -3 }, { lastReviewedAt: 'yesterday' }]) {
        await assert.rejects(repository.update('note-1', patch));
    }
    await assert.rejects(repository.importBackup(backup([note('bad', { reps: 'many' })])), /复习次数/);
    assert.equal((await repository.get('note-1')).reps, 1);
});

test('remove returns a complete undo snapshot; restore commits media and refuses ID conflicts', async t => {
    const { repository } = repoFixture();
    t.after(() => repository.close());
    await repository.save(note());
    const removed = await repository.remove('note-1');
    assert.equal(removed.imageUrl, IMAGE);
    assert.equal(await repository.count(), 0);
    await repository.restore(removed);
    assert.equal((await repository.get('note-1')).imageUrl, IMAGE);
    await assert.rejects(repository.restore({ ...removed, userNote: 'overwrite' }), /已存在/);
    assert.equal((await repository.get('note-1')).userNote, removed.userNote);
});

test('Blob images export to JSON data URLs and backups round-trip without overwriting existing IDs', async t => {
    const { repository } = repoFixture();
    const { repository: destination } = repoFixture();
    t.after(() => { repository.close(); destination.close(); });
    await repository.save(note('blob', { imageUrl: undefined, imageBlob: new Blob([Uint8Array.of(255, 216, 255)], { type: 'image/jpeg' }) }));
    const exported = await repository.exportBackup();
    assert.equal(exported.format, 'caption-study-backup');
    assert.equal(exported.schemaVersion, 1);
    assert.equal(exported.notes[0].imageBlob, undefined);
    assert.equal(exported.notes[0].imageUrl, IMAGE);
    assert.deepEqual(await destination.previewImport(exported), { total: 1, existing: 0, newCount: 1 });
    assert.deepEqual(await destination.importBackup(JSON.parse(JSON.stringify(exported))), { imported: 1, skipped: 0 });
    await destination.update('blob', { userNote: 'keep local' });
    assert.deepEqual(await destination.previewImport(exported), { total: 1, existing: 1, newCount: 0 });
    assert.deepEqual(await destination.importBackup(exported), { imported: 0, skipped: 1 });
    assert.equal((await destination.get('blob')).userNote, 'keep local');
});

test('import validates all records before writing; unsafe URLs, prototype keys, states and duplicate IDs fail', async t => {
    const { repository } = repoFixture();
    t.after(() => repository.close());
    for (const url of ['javascript:alert(1)', 'https://evil.example/video', 'https://bilibili.com.evil.example/', 'https://user:pass@www.bilibili.com/video/BV1', 'data:text/html,test']) {
        await assert.rejects(repository.importBackup(backup([note('good'), note('bad', { source: { url } })])), /地址/);
    }
    const polluted = JSON.parse(JSON.stringify(backup([note()])).replace('"id":"note-1"', '"__proto__":{"polluted":true},"id":"note-1"'));
    await assert.rejects(repository.importBackup(polluted), /不安全字段/);
    await assert.rejects(repository.importBackup(backup([note('bad', { imageUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })])), /截图/);
    await assert.rejects(repository.importBackup(backup([note('bad', { reviewState: 'invalid' })])), /复习状态/);
    await assert.rejects(repository.importBackup(backup([note(), note()])), /重复/);
    await assert.rejects(repository.importBackup(backup([{ id: 'partial', seriesId: 'season' }])), /缺少必要字段/);
    await assert.rejects(repository.importBackup(backup([note('bad', { tags: [null] })])), /标签/);
    await assert.rejects(repository.importBackup({ format: 'other', schemaVersion: 1, notes: [] }), /格式/);
    assert.equal(await repository.count(), 0);
    assert.equal({}.polluted, undefined);
});

test('import enforces count and image size limits', async t => {
    const { repository } = repoFixture();
    t.after(() => repository.close());
    await assert.rejects(repository.previewImport(backup(Array.from({ length: 5001 }, (_, i) => note(`n-${i}`)))), /5000/);
    await assert.rejects(repository.previewImport(backup([note('large', { imageUrl: 'data:image/jpeg;base64,' + 'A'.repeat(14 * 1024 * 1024) })])), /10 MiB/);
});

test('aborted import rolls back all records and permits retry', async t => {
    const control = abortableFactory(new IDBFactory());
    const repository = createRepository({ indexedDB: control.indexedDB, localStorage: null });
    t.after(() => repository.close());
    await repository.ready();
    control.abortNextWrite = true;
    await assert.rejects(repository.importBackup(backup([note('a'), note('b')])), /导入备份失败/);
    assert.equal(await repository.count(), 0);
    assert.deepEqual(await repository.importBackup(backup([note('a'), note('b')])), { imported: 2, skipped: 0 });
});

test('unavailable storage and closed repositories report errors instead of false success', async () => {
    const repository = createRepository({ indexedDB: { open() { throw new Error('denied'); } }, localStorage: null });
    await assert.rejects(repository.save(note()), /无法打开/);
    const unavailable = createRepository({ indexedDB: null, localStorage: null });
    await assert.rejects(unavailable.save(note()), /无法使用 IndexedDB/);
    const { repository: working } = repoFixture();
    await working.ready();
    working.close();
    await assert.rejects(working.save(note()), /已关闭/);
});
