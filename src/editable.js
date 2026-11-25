/** Deep active element across open Shadow DOM trees (e.g. Bilibili comment editors). */
export function getDeepActiveElement(doc = typeof document !== 'undefined' ? document : null) {
    let active = doc?.activeElement;
    while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
    }
    return active;
}

export function isEditableNode(node) {
    if (!node) return false;
    const el = node.nodeType === 3 ? node.parentElement : (node.nodeType === 1 || typeof node.tagName === 'string' ? node : null);
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    const role = el.getAttribute?.('role') ?? el.attributes?.get?.('role');
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
    const ce = el.getAttribute?.('contenteditable') ?? el.attributes?.get?.('contenteditable');
    if (ce != null && ce !== 'false') return true;
    if (tag === 'bili-comment-box' || tag === 'bili-comment-reply-box' || tag === 'bili-comments-box-root' || tag === 'bili-comment-editor') return true;
    if (el.classList?.contains?.('ProseMirror') || el.classList?.contains?.('comment-send-box') || el.classList?.contains?.('reply-box') || el.classList?.contains?.('bili-comment-box')) return true;
    if (el.closest?.('input,textarea,select,[role="textbox"],[role="searchbox"],[role="combobox"],[contenteditable]:not([contenteditable="false"]),bili-comment-box,bili-comment-reply-box,bili-comments-box-root,.comment-send-box,.reply-box,.bili-comment-box')) return true;
    return false;
}

export function isEditableEvent(targetOrEvent, doc = typeof document !== 'undefined' ? document : null) {
    if (!targetOrEvent) return false;
    if (doc) {
        if (isEditableNode(getDeepActiveElement(doc))) return true;
        if (isEditableNode(doc.activeElement)) return true;
    }
    if (typeof targetOrEvent.composedPath === 'function' || 'target' in targetOrEvent) {
        const event = targetOrEvent;
        if (isEditableNode(event.target)) return true;
        if (typeof event.composedPath === 'function') {
            const path = event.composedPath();
            for (let i = 0; i < path.length; i++) {
                if (isEditableNode(path[i])) return true;
            }
        }
        return false;
    }
    return isEditableNode(targetOrEvent);
}
