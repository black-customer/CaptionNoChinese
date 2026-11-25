import test from 'node:test';
import assert from 'node:assert/strict';
import { createSync, normalizeSyncBase } from '../src/sync.js';

test('only the two explicit HTTP loopback hosts are accepted', () => {
    assert.equal(normalizeSyncBase('http://localhost:8765/'), 'http://localhost:8765');
    for (const value of ['https://localhost:8765', 'http://127.1:8765', 'http://localhost.evil',
        'http://localhost:8765/path', 'http://localhost@evil', 'http://127.0.0.1:65536',
        'http://[::1]:8765']) assert.throws(() => normalizeSyncBase(value));
});

test('incremental delivery persists only acknowledged notes and blocks redirects', async () => {
    const sent = [], marks = new Set();
    let fail = true;
    const repo = {
        hasSynced: async (scope, id) => marks.has(scope + id),
        markSynced: async (scope, id) => marks.add(scope + id),
        syncNote: async id => ({ id, time: 4 }),
    };
    const sync = createSync({ repo, read: () => ({ base: 'http://127.0.0.1:8765', token: 'paired' }),
        request(options) {
            sent.push(options);
            if (options.method === 'GET') {
                options.onload({ status: 200, responseText: '{"ok":true}', finalUrl: options.url });
                return;
            }
            if (JSON.parse(options.data).notes[0].id === 'b' && fail) {
                options.onerror();
                return;
            }
            options.onload({ status: 200, responseText: '{"imported":1,"duplicates":0}',
                finalUrl: options.url });
        },
    });
    await sync.ping();
    await assert.rejects(sync.push(['a', 'b']), /连接/);
    fail = false;
    assert.deepEqual(await sync.push(['a', 'b', 'b']), { imported: 1, skipped: 1 });
    assert.equal(sent.length, 4);
    for (const options of sent) {
        assert.equal(options.headers['X-Scene-Sync-Token'], 'paired');
        assert.equal(options.redirect, 'error');
        assert.equal(options.anonymous, true);
    }
});

test('a different final URL may not be acknowledged', async () => {
    const sync = createSync({ read: () => ({ base: 'http://localhost:8765', token: 'paired' }),
        request: options => options.onload({ status: 200, responseText: '{"ok":true}',
            finalUrl: 'https://attacker.test' }),
    });
    await assert.rejects(sync.ping(), /响应/);
});
