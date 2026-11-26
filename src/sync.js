export function normalizeSyncBase(raw) {
    const value = String(raw).trim().toLowerCase();
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?\/?$/.test(value)) {
        throw new Error('请输入本机 HTTP 地址，例如 http://127.0.0.1:8765');
    }
    try { return new URL(value).origin; }
    catch { throw new Error('本机端口无效'); }
}

export function createSync({ repo, read, request }) {
    let pending = Promise.resolve();

    function pairing(draft = read()) {
        if (typeof request !== 'function') throw new Error('脚本管理器未提供本机连接接口');
        const token = draft?.token?.trim();
        if (!token) throw new Error('请在设置中填写配对码，或使用 JSON 备份');
        if (!/^[\w-]{1,128}$/.test(token)) throw new Error('配对码格式无效');
        return { base: normalizeSyncBase(draft.base), token };
    }

    function send({ base, token }, endpoint, notes) {
        const url = base + '/api/captures/scenes/' + endpoint;
        const headers = { 'X-Scene-Sync-Token': token };
        if (notes) headers['Content-Type'] = 'application/json';
        return new Promise((resolve, reject) => {
            const failed = () => reject(new Error('无法连接桌面端，请确认服务已启动后重试'));
            request({
                method: notes ? 'POST' : 'GET', url, headers, timeout: 8000,
                redirect: 'error', anonymous: true,
                data: notes ? JSON.stringify({ notes }) : undefined,
                onerror: failed, ontimeout: failed, onabort: failed,
                onload(response) {
                    if (response.finalUrl && response.finalUrl !== url) {
                        reject(new Error('本机连接返回了意外响应'));
                        return;
                    }
                    if (response.status === 403) { reject(new Error('配对码无效，请重新配对')); return; }
                    try {
                        const result = JSON.parse(response.responseText);
                        if (response.status !== 200) throw new Error('桌面端拒绝了此请求');
                        resolve(result);
                    } catch (error) { reject(new Error('本机连接返回了意外响应', { cause: error })); }
                },
            });
        });
    }

    async function ping(draft) {
        const result = await send(pairing(draft), 'ping');
        if (result?.ok !== true) throw new Error('本机连接返回了意外响应');
    }

    function push(ids) {
        const run = pending.then(async () => {
            const options = pairing();
            const digest = await crypto.subtle.digest('SHA-256',
                new TextEncoder().encode(options.base + '\n' + options.token));
            const scope = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            const counts = { imported: 0, updated: 0, skipped: 0 };
            for (const id of new Set(ids)) {
                const receipt = await repo.getSyncReceipt(scope, id);
                if (receipt) {
                    const current = await repo.get(id);
                    if (!current) continue;
                    const previous = receipt.updatedAt ?? receipt.syncedAt ?? current.createdAt;
                    if (!current.userNote?.trim() || current.updatedAt <= previous) {
                        counts.skipped++;
                        continue;
                    }
                }
                const note = await repo.syncNote(id);
                if (!note) continue;
                const result = await send(options, 'inbox', [note]);
                if (result?.imported === 1 && result.duplicates === 0) counts.imported++;
                else if (result?.imported === 0 && result.updated === 1 &&
                         result.duplicates === 0) counts.updated++;
                else if (result?.imported === 0 && result.duplicates === 1) {
                    if (receipt && result.updated === undefined) {
                        throw new Error('请更新桌面学习器后重试补同步备注');
                    }
                    counts.skipped++;
                } else throw new Error('桌面端未确认收到记录');
                await repo.markSynced(scope, id, note.updatedAt);
            }
            return counts;
        });
        pending = run.catch(() => {});
        return run;
    }

    return { ping, push };
}
