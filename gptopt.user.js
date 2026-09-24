// ==UserScript==
// @name         GPTOpt - ChatGPT 手机远程横置 + 会话导航
// @namespace    https://github.com/snownico0722/gptopt
// @version      1.2.0
// @description  手机远程控制电脑时，将 ChatGPT 放进真实竖向视口后横置 90°；内置轻量、旋转感知的会话快捷导航。
// @author       snownico0722
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @homepageURL  https://github.com/snownico0722/gptopt
// @supportURL   https://github.com/snownico0722/gptopt/issues
// @downloadURL  https://raw.githubusercontent.com/snownico0722/gptopt/main/gptopt.user.js
// @updateURL    https://raw.githubusercontent.com/snownico0722/gptopt/main/gptopt.user.js
// ==/UserScript==

(function () {
    'use strict';

    const REMOTE_FRAME_ID = 'tm-gpt-remote-frame';
    const IS_TOP = window.top === window.self;
    const IS_REMOTE_FRAME = !IS_TOP && (() => {
        try {
            return window.frameElement?.id === REMOTE_FRAME_ID;
        } catch (_) {
            return false;
        }
    })();

    // GPTOpt only executes in the top page. The remote ChatGPT iframe is
    // same-origin, so the top script can inspect and control it directly.
    if (!IS_TOP) return;

    bootConversationRail();
    bootRemoteViewport();

    /* ====================================================================== *
     * Conversation navigation (top overlay; controls top page or remote iframe)
     * ====================================================================== */

    function bootConversationRail() {
    const NAV_KEY = 'gptopt-nav-enabled';
    const SETTINGS = {
        minItems: 1,
        labelChars: 88,
        readingLine: 0.32,
        rebuildDelayMs: 80,
        periodicMs: 650,
        apiRetryMs: 30000
    };

    let enabled = GM_getValue(NAV_KEY, true);
    let rail = null;
    let popup = null;
    let rebuildTimer = null;
    let periodicTimer = null;
    let activeFrame = 0;
    let activeIndex = -1;
    let exchanges = [];
    let lastSignature = '';
    let lastContextKey = '';
    let lastPath = '';
    let scrollOwner = null;
    let scrollTarget = null;

    const labelCache = new Map();
    const api = {
        token: null,
        tokenAt: -Infinity,
        conversationId: null,
        groups: null,
        pending: false,
        failedAt: -Infinity
    };

    installStyles();
    installUi();
    installController();
    start();

    function installController() {
        window.__GPTOPT_NAV__ = {
            setEnabled(value) {
                enabled = Boolean(value);
                GM_setValue(NAV_KEY, enabled);
                scheduleRebuild();
            },
            getEnabled() {
                return enabled;
            },
            rebuild() {
                scheduleRebuild();
            }
        };
    }

    function installStyles() {
        if (document.getElementById('gptopt-nav-style')) return;
        const style = document.createElement('style');
        style.id = 'gptopt-nav-style';
        style.textContent = `
#gptopt-nav-rail {
    position: fixed !important;
    top: 92px !important;
    right: 10px !important;
    bottom: 118px !important;
    width: 46px !important;
    z-index: 2147483647 !important;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    padding: 4px 0;
    box-sizing: border-box;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-width: none;
    color: #5f6368;
    pointer-events: auto !important;
    visibility: visible !important;
}
#gptopt-nav-rail::-webkit-scrollbar { display: none; }
#gptopt-nav-rail[hidden], #gptopt-nav-popup[hidden] { display: none !important; }

.gptopt-nav-menu,
.gptopt-nav-tick {
    appearance: none;
    border: 0;
    margin: 0;
    padding: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    touch-action: manipulation;
}
.gptopt-nav-menu {
    flex: 0 0 36px;
    width: 42px;
    height: 36px;
    border-radius: 10px;
    font: 700 18px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    opacity: .78;
}
.gptopt-nav-menu:hover,
.gptopt-nav-menu:focus-visible { background: rgba(127,127,127,.14); opacity: 1; }

.gptopt-nav-tick {
    flex: 1 1 11px;
    min-height: 9px;
    max-height: 24px;
    width: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
}
.gptopt-nav-tick > span {
    width: 18px;
    height: 3px;
    border-radius: 999px;
    background: currentColor;
    opacity: .33;
    transition: width 100ms ease, opacity 100ms ease;
}
.gptopt-nav-tick:hover > span { width: 27px; opacity: .7; }
.gptopt-nav-tick.is-active > span { width: 34px; opacity: 1; }

#gptopt-nav-popup {
    position: fixed !important;
    top: 50% !important;
    right: 62px !important;
    transform: translateY(-50%) !important;
    width: min(420px, calc(100vw - 90px)) !important;
    max-height: min(660px, calc(100vh - 80px)) !important;
    z-index: 2147483647 !important;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 8px;
    box-sizing: border-box;
    border: 1px solid rgba(127,127,127,.22);
    border-radius: 16px;
    background: rgba(250,250,250,.96);
    box-shadow: 0 10px 34px rgba(0,0,0,.18);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    color: #111;
    scrollbar-width: thin;
    pointer-events: auto !important;
    visibility: visible !important;
}
html.dark #gptopt-nav-popup { background: rgba(32,32,32,.96); color: #f3f3f3; }

.gptopt-nav-row {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 10px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
    font: 500 14px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.gptopt-nav-row:hover,
.gptopt-nav-row:focus-visible { background: rgba(127,127,127,.12); }
.gptopt-nav-row.is-active { background: rgba(127,127,127,.16); font-weight: 700; }
.gptopt-nav-index {
    flex: 0 0 auto;
    min-width: 26px;
    opacity: .48;
    font-variant-numeric: tabular-nums;
    text-align: right;
}
.gptopt-nav-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.gptopt-nav-flash {
    outline: 2px solid #10a37f !important;
    outline-offset: 4px !important;
    border-radius: 10px;
}
`;
        document.documentElement.appendChild(style);
    }

    function installUi() {
        const init = () => {
            if (!document.body) return;
            if (!rail) {
                rail = document.createElement('nav');
                rail.id = 'gptopt-nav-rail';
                rail.setAttribute('aria-label', 'GPTOpt 会话快捷导航');
                rail.hidden = true;
                document.body.appendChild(rail);
            }
            if (!popup) {
                popup = document.createElement('div');
                popup.id = 'gptopt-nav-popup';
                popup.setAttribute('role', 'menu');
                popup.hidden = true;
                document.body.appendChild(popup);
                document.addEventListener(
                    'pointerdown',
                    (event) => {
                        if (popup.hidden) return;
                        if (popup.contains(event.target) || rail?.contains(event.target)) return;
                        popup.hidden = true;
                    },
                    true
                );
            }
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
            init();
        }
    }

    function start() {
        const begin = () => {
            installUi();
            scheduleRebuild();
            periodicTimer = setInterval(scheduleRebuild, SETTINGS.periodicMs);
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', begin, { once: true });
        } else {
            begin();
        }
    }

    function getContext() {
        const frame = document.getElementById(REMOTE_FRAME_ID);
        const frameMode =
            document.documentElement.classList.contains('gptopt-frame-ready') &&
            frame &&
            frame.isConnected;

        if (frameMode) {
            try {
                const doc = frame.contentDocument;
                const win = frame.contentWindow;
                if (doc?.documentElement && win?.location?.origin === location.origin) {
                    return { mode: 'frame', doc, win, key: `frame:${win.location.pathname}` };
                }
            } catch (_) {}
        }
        return { mode: 'top', doc: document, win: window, key: `top:${location.pathname}` };
    }

    function scheduleRebuild() {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(rebuild, SETTINGS.rebuildDelayMs);
    }

    function rebuild() {
        installUi();
        if (!rail || !popup) return;

        if (!enabled) {
            rail.hidden = true;
            popup.hidden = true;
            return;
        }

        const ctx = getContext();
        const path = safePath(ctx.win);
        if (ctx.key !== lastContextKey || path !== lastPath) {
            lastContextKey = ctx.key;
            lastPath = path;
            activeIndex = -1;
            lastSignature = '';
            labelCache.clear();
            api.conversationId = null;
            api.groups = null;
            api.pending = false;
            api.failedAt = -Infinity;
            unbindScrollOwner();
        }

        exchanges = scanExchanges(ctx);
        if (exchanges.length < SETTINGS.minItems) {
            rail.hidden = true;
            popup.hidden = true;
            return;
        }

        rail.hidden = false;
        bindScrollOwner(ctx);

        const signature = exchanges.map((item) => `${item.key}\u0000${item.label}`).join('\u0001');
        if (signature !== lastSignature) {
            lastSignature = signature;
            renderRail();
            renderPopup();
        }

        updateActive(ctx);
        prefetchConversationLabels(ctx);
    }

    function safePath(win) {
        try { return win.location.pathname; } catch (_) { return ''; }
    }

    function normalizeText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    function scanExchanges(ctx) {
        const root = ctx.doc.querySelector('main') || ctx.doc;
        const shellSelector =
            'section[data-testid^="conversation-turn-"], article[data-testid^="conversation-turn-"]';
        const shells = Array.from(root.querySelectorAll(shellSelector));
        const groups = [];
        let current = null;

        if (shells.length) {
            for (const shell of shells) {
                const testId = shell.getAttribute('data-testid') || '';
                const match = /conversation-turn-(\d+)/.exec(testId);
                const explicitRole = shell.getAttribute('data-turn');
                const role =
                    explicitRole ||
                    (shell.querySelector('[data-message-author-role="user"]')
                        ? 'user'
                        : shell.querySelector('[data-message-author-role="assistant"]')
                          ? 'assistant'
                          : '');

                if (role === 'user' || !current) {
                    current = {
                        key: match ? `turn-${match[1]}` : `turn-${groups.length}`,
                        els: [shell],
                        userEl: role === 'user' ? shell : null
                    };
                    groups.push(current);
                } else {
                    current.els.push(shell);
                }
            }
        } else {
            const messages = Array.from(root.querySelectorAll('[data-message-author-role]'));
            for (const message of messages) {
                const role = message.getAttribute('data-message-author-role');
                if (role === 'user' || !current) {
                    current = {
                        key: 'msg-' + (message.getAttribute('data-message-id') || String(groups.length)),
                        els: [message],
                        userEl: role === 'user' ? message : null
                    };
                    groups.push(current);
                } else {
                    current.els.push(message);
                }
            }
        }

        const apiByUid = new Map();
        if (api.groups) {
            for (const item of api.groups) if (item.uid) apiByUid.set(item.uid, item);
        }

        return groups.map((group, index) => {
            const roleNode = getUserRoleNode(group.userEl);
            const uidNode =
                roleNode?.matches?.('[data-message-id]')
                    ? roleNode
                    : roleNode?.querySelector?.('[data-message-id]');
            const uid = uidNode?.getAttribute('data-message-id') || null;

            const mountedLabel = readPromptText(roleNode);
            if (mountedLabel) labelCache.set(group.key, mountedLabel);

            const apiItem =
                (uid && apiByUid.get(uid)) ||
                (api.groups && api.groups.length === groups.length ? api.groups[index] : null);

            if (!labelCache.get(group.key) && apiItem?.prompt) {
                labelCache.set(group.key, apiItem.prompt);
            }

            return { ...group, uid, label: labelCache.get(group.key) || `问题 ${index + 1}` };
        });
    }

    function getUserRoleNode(userEl) {
        if (!userEl?.isConnected) return null;
        if (userEl.matches?.('[data-message-author-role="user"]')) return userEl;
        return userEl.querySelector?.('[data-message-author-role="user"]') || null;
    }

    function readPromptText(roleNode) {
        if (!roleNode) return '';
        const candidates = [];
        roleNode.querySelectorAll?.('.user-message-bubble-color').forEach((node) => {
            candidates.push(normalizeText(node.innerText));
        });
        roleNode.querySelectorAll?.('button .line-clamp-3').forEach((node) => {
            candidates.push(normalizeText(node.innerText));
        });
        const legacy = roleNode.querySelector?.('.whitespace-pre-wrap');
        if (legacy) candidates.push(normalizeText(legacy.innerText));
        if (!candidates.some(Boolean)) candidates.push(normalizeText(roleNode.innerText));

        let best = '';
        for (const candidate of candidates) {
            if (candidate && candidate.length > best.length) best = candidate;
        }
        return best;
    }

    function shortLabel(text) {
        const clean = normalizeText(text);
        return clean.length <= SETTINGS.labelChars ? clean : clean.slice(0, SETTINGS.labelChars - 1) + '…';
    }

    function renderRail() {
        rail.replaceChildren();

        const menu = document.createElement('button');
        menu.type = 'button';
        menu.className = 'gptopt-nav-menu';
        menu.textContent = '≡';
        menu.title = '会话导航';
        menu.setAttribute('aria-label', '打开会话导航');
        menu.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            popup.hidden = !popup.hidden;
            if (!popup.hidden) refreshActiveUi();
        });
        rail.appendChild(menu);

        exchanges.forEach((exchange, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'gptopt-nav-tick';
            button.dataset.index = String(index);
            button.title = shortLabel(exchange.label);
            button.setAttribute('aria-label', `${index + 1}. ${shortLabel(exchange.label)}`);
            button.appendChild(document.createElement('span'));
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                jumpToExchange(index);
            });
            rail.appendChild(button);
        });
    }

    function renderPopup() {
        const wasHidden = popup.hidden;
        popup.replaceChildren();
        exchanges.forEach((exchange, index) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'gptopt-nav-row';
            row.dataset.index = String(index);
            row.setAttribute('role', 'menuitem');

            const number = document.createElement('span');
            number.className = 'gptopt-nav-index';
            number.textContent = String(index + 1);

            const label = document.createElement('span');
            label.className = 'gptopt-nav-label';
            label.textContent = shortLabel(exchange.label);
            label.title = exchange.label;

            row.append(number, label);
            row.addEventListener('click', () => {
                jumpToExchange(index);
                popup.hidden = true;
            });
            popup.appendChild(row);
        });
        popup.hidden = wasHidden;
    }

    function findScrollContainer(element, ctx) {
        let node = element?.parentElement;
        while (node && node !== ctx.doc.body && node !== ctx.doc.documentElement) {
            const style = ctx.win.getComputedStyle(node);
            if (
                (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                node.scrollHeight > node.clientHeight + 4
            ) return node;
            node = node.parentElement;
        }
        return null;
    }

    function unbindScrollOwner() {
        if (scrollTarget) scrollTarget.removeEventListener('scroll', onScroll, true);
        scrollOwner = null;
        scrollTarget = null;
    }

    function bindScrollOwner(ctx) {
        const sample = exchanges.find((item) => item.els.some((el) => el.isConnected));
        const sampleEl = sample?.userEl || sample?.els?.[0] || ctx.doc.querySelector('main');
        const owner = findScrollContainer(sampleEl, ctx) || ctx.doc.scrollingElement;
        const target =
            owner === ctx.doc.scrollingElement || owner === ctx.doc.documentElement ? ctx.win : owner;
        if (owner === scrollOwner && target === scrollTarget) return;

        unbindScrollOwner();
        scrollOwner = owner;
        scrollTarget = target;
        scrollTarget?.addEventListener('scroll', onScroll, { passive: true, capture: true });
    }

    function onScroll() {
        cancelAnimationFrame(activeFrame);
        activeFrame = requestAnimationFrame(() => updateActive(getContext()));
    }

    function exchangeAnchor(exchange) {
        if (!exchange) return null;
        if (exchange.userEl?.isConnected) return exchange.userEl;
        return exchange.els.find((el) => el.isConnected) || null;
    }

    function updateActive(ctx) {
        if (!exchanges.length) return;
        let line;
        if (
            scrollOwner &&
            scrollOwner !== ctx.doc.scrollingElement &&
            scrollOwner !== ctx.doc.documentElement
        ) {
            const rect = scrollOwner.getBoundingClientRect();
            line = rect.top + scrollOwner.clientHeight * SETTINGS.readingLine;
        } else {
            line = ctx.win.innerHeight * SETTINGS.readingLine;
        }

        let best = 0;
        let foundAbove = false;
        let nearestBelow = Infinity;

        exchanges.forEach((exchange, index) => {
            const anchor = exchangeAnchor(exchange);
            if (!anchor) return;
            const top = anchor.getBoundingClientRect().top;
            if (top <= line + 1) {
                best = index;
                foundAbove = true;
            } else if (!foundAbove) {
                const distance = top - line;
                if (distance < nearestBelow) {
                    nearestBelow = distance;
                    best = index;
                }
            }
        });

        if (best !== activeIndex) {
            activeIndex = best;
            refreshActiveUi();
        }
    }

    function refreshActiveUi() {
        rail?.querySelectorAll('.gptopt-nav-tick').forEach((button) => {
            button.classList.toggle('is-active', Number(button.dataset.index) === activeIndex);
        });
        popup?.querySelectorAll('.gptopt-nav-row').forEach((row) => {
            row.classList.toggle('is-active', Number(row.dataset.index) === activeIndex);
        });
        if (popup && !popup.hidden) {
            popup.querySelector('.gptopt-nav-row.is-active')?.scrollIntoView?.({ block: 'nearest' });
        }
    }

    function jumpToExchange(index) {
        if (!exchanges[index]) return;
        activeIndex = index;
        refreshActiveUi();

        const jump = () => {
            const ctx = getContext();
            const target = exchangeAnchor(exchanges[index]);
            if (!target) return;

            const owner = findScrollContainer(target, ctx) || ctx.doc.scrollingElement;
            const targetRect = target.getBoundingClientRect();

            if (
                owner &&
                owner !== ctx.doc.scrollingElement &&
                owner !== ctx.doc.documentElement
            ) {
                const ownerRect = owner.getBoundingClientRect();
                owner.scrollTop += targetRect.top - ownerRect.top - 64;
            } else {
                ctx.win.scrollBy({ top: targetRect.top - 64, left: 0, behavior: 'auto' });
            }
        };

        jump();
        setTimeout(jump, 100);
        setTimeout(() => {
            jump();
            const target = exchangeAnchor(exchanges[index]);
            if (!target || target.getBoundingClientRect().height <= 0) return;
            target.classList.add('gptopt-nav-flash');
            setTimeout(() => target.classList.remove('gptopt-nav-flash'), 900);
        }, 280);
    }

    function conversationIdFromContext(ctx) {
        const match = /\/c\/([0-9a-f-]{8,})/i.exec(safePath(ctx.win));
        return match ? match[1] : null;
    }

    async function fetchAccessToken(ctx) {
        if (api.token && performance.now() - api.tokenAt < 10 * 60 * 1000) return api.token;
        const response = await ctx.win.fetch('/api/auth/session', { credentials: 'include' });
        if (!response.ok) throw new Error(`session ${response.status}`);
        const data = await response.json();
        if (!data?.accessToken) throw new Error('missing access token');
        api.token = data.accessToken;
        api.tokenAt = performance.now();
        return api.token;
    }

    async function fetchConversationGroups(ctx, id) {
        const token = await fetchAccessToken(ctx);
        const response = await ctx.win.fetch(`/backend-api/conversation/${id}`, {
            credentials: 'include',
            headers: { Authorization: `Bearer ${token}` }
        });
        if (response.status === 401 || response.status === 403) api.token = null;
        if (!response.ok) throw new Error(`conversation ${response.status}`);

        const data = await response.json();
        const mapping = data?.mapping;
        if (!mapping) return [];

        const chain = [];
        let node = data.current_node ? mapping[data.current_node] : null;
        for (let hops = 0; node && hops < 10000; hops++) {
            chain.push(node);
            node = node.parent ? mapping[node.parent] : null;
        }
        chain.reverse();

        const groups = [];
        let current = null;
        for (const item of chain) {
            const message = item.message;
            if (!message?.author) continue;
            const role = message.author.role;
            if (role !== 'user' && role !== 'assistant') continue;
            if (message.recipient && message.recipient !== 'all') continue;
            if (message.metadata?.is_visually_hidden_from_conversation) continue;

            if (role === 'user' || !current) {
                current = {
                    uid: role === 'user' ? message.id : null,
                    prompt: role === 'user' ? normalizeText(messageText(message)) : ''
                };
                groups.push(current);
            }
        }
        return groups;
    }

    function messageText(message) {
        const content = message?.content;
        if (!content) return '';
        if (content.content_type === 'text' || content.content_type === 'multimodal_text') {
            return (content.parts || [])
                .filter((part) => typeof part === 'string')
                .join('\n\n')
                .trim();
        }
        return '';
    }

    function prefetchConversationLabels(ctx) {
        const id = conversationIdFromContext(ctx);
        if (!id) return;
        if (api.conversationId === id && (api.groups || api.pending)) return;
        if (performance.now() - api.failedAt < SETTINGS.apiRetryMs) return;

        api.conversationId = id;
        api.pending = true;
        fetchConversationGroups(ctx, id).then(
            (groups) => {
                if (api.conversationId !== id) return;
                api.groups = groups;
                api.pending = false;
                scheduleRebuild();
            },
            () => {
                if (api.conversationId !== id) return;
                api.pending = false;
                api.failedAt = performance.now();
            }
        );
    }
}

    /* ====================================================================== *
     * Remote viewport / rotation (top frame only)
     * ====================================================================== */

    function bootRemoteViewport() {
        const KEY = 'gptopt-remote-v1-';
        const DEFAULTS = {
            enabled: false,
            direction: 'cw',
            navEnabled: true
        };

        let state = {
            enabled: GM_getValue(KEY + 'enabled', DEFAULTS.enabled),
            direction: GM_getValue(KEY + 'direction', DEFAULTS.direction),
            navEnabled: GM_getValue('gptopt-nav-enabled', DEFAULTS.navEnabled)
        };

        let frame = null;
        let frameReady = false;
        let frameError = '';
        let loadTimer = null;
        let resizeTimer = null;
        let syncTimer = null;
        let menuIds = [];

        const style = document.createElement('style');
        style.id = 'gptopt-remote-style';
        style.textContent = `
html.gptopt-frame-mode {
    overflow: hidden !important;
}

html.gptopt-frame-mode body {
    overflow: hidden !important;
}

html.gptopt-frame-ready body > *:not(#${REMOTE_FRAME_ID}):not(#gptopt-nav-rail):not(#gptopt-nav-popup) {
    visibility: hidden !important;
    pointer-events: none !important;
}

#${REMOTE_FRAME_ID} {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    outline: 0 !important;
    max-width: none !important;
    max-height: none !important;
    transform-origin: 0 0 !important;
    overflow: hidden !important;
    z-index: 2147483000 !important;
    background: white !important;
    opacity: 0;
    pointer-events: none;
    visibility: visible !important;
}

html.gptopt-frame-ready #${REMOTE_FRAME_ID} {
    opacity: 1 !important;
    pointer-events: auto !important;
}
`;
        document.documentElement.appendChild(style);

        rebuildMenus();

        function saveState() {
            GM_setValue(KEY + 'enabled', state.enabled);
            GM_setValue(KEY + 'direction', state.direction);
            GM_setValue('gptopt-nav-enabled', state.navEnabled);
        }

        function getViewport() {
            return {
                width: document.documentElement.clientWidth || window.innerWidth,
                height: document.documentElement.clientHeight || window.innerHeight
            };
        }

        function updateFrameGeometry() {
            if (!frame || !frame.isConnected) return;

            const { width: W, height: H } = getViewport();
            frame.style.width = `${H}px`;
            frame.style.height = `${W}px`;

            if (state.direction === 'cw') {
                frame.style.transform = `matrix(0, 1, -1, 0, ${W}, 0)`;
            } else {
                frame.style.transform = `matrix(0, -1, 1, 0, 0, ${H})`;
            }
        }

        function verifyFrame() {
            if (!frame || !frame.isConnected) return false;
            try {
                const win = frame.contentWindow;
                const doc = frame.contentDocument;
                return Boolean(
                    win &&
                    doc?.documentElement &&
                    win.location.origin === window.location.origin
                );
            } catch (_) {
                return false;
            }
        }

        function markFrameReady() {
            if (frameReady) return;
            frameReady = true;
            frameError = '';
            clearTimeout(loadTimer);
            document.documentElement.classList.add('gptopt-frame-ready');
            updateFrameGeometry();
            startUrlSync();
            rebuildMenus();
        }

        function frameFailed() {
            if (frameReady) return;
            frameError = 'ChatGPT 拒绝 iframe 嵌入';
            state.enabled = false;
            saveState();
            removeFrame(false);
            rebuildMenus();
            console.warn('[GPTOpt]', frameError);
        }

        function createFrame() {
            if (frame?.isConnected) {
                updateFrameGeometry();
                return;
            }
            if (!document.body) return;

            frameReady = false;
            frameError = '';
            document.documentElement.classList.add('gptopt-frame-mode');

            frame = document.createElement('iframe');
            frame.id = REMOTE_FRAME_ID;
            frame.src = window.location.href;
            frame.setAttribute(
                'allow',
                'microphone; camera; clipboard-read; clipboard-write; display-capture; fullscreen'
            );
            frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
            document.body.appendChild(frame);
            updateFrameGeometry();

            frame.addEventListener('load', () => {
                setTimeout(() => {
                    if (verifyFrame()) markFrameReady();
                }, 250);
                setTimeout(() => {
                    if (verifyFrame()) markFrameReady();
                }, 1000);
            });

            clearTimeout(loadTimer);
            loadTimer = setTimeout(() => {
                if (frameReady) return;
                if (verifyFrame()) markFrameReady();
                else frameFailed();
            }, 10000);
        }

        function getFrameUrl() {
            if (!frame || !frameReady) return null;
            try {
                const url = frame.contentWindow.location.href;
                return url.startsWith(window.location.origin) ? url : null;
            } catch (_) {
                return null;
            }
        }

        function startUrlSync() {
            stopUrlSync();
            syncTimer = setInterval(() => {
                const url = getFrameUrl();
                if (!url || url === window.location.href) return;
                try {
                    history.replaceState(history.state, '', url);
                } catch (_) {}
            }, 800);
        }

        function stopUrlSync() {
            if (!syncTimer) return;
            clearInterval(syncTimer);
            syncTimer = null;
        }

        function removeFrame(reloadOuter) {
            clearTimeout(loadTimer);
            stopUrlSync();

            const currentUrl = reloadOuter ? getFrameUrl() : null;
            frameReady = false;
            document.documentElement.classList.remove('gptopt-frame-ready', 'gptopt-frame-mode');

            if (frame) {
                frame.remove();
                frame = null;
            }

            if (reloadOuter && currentUrl) {
                window.location.href = currentUrl;
            }
        }

        function enable() {
            if (!document.body) return;
            createFrame();
        }

        function disable() {
            removeFrame(true);
        }

        function updateState(patch) {
            const oldEnabled = state.enabled;
            state = { ...state, ...patch };
            saveState();

            if (oldEnabled !== state.enabled) {
                if (state.enabled) enable();
                else disable();
            } else if (state.enabled) {
                updateFrameGeometry();
            }
            rebuildMenus();
        }

        function clearMenus() {
            for (const id of menuIds) {
                try {
                    GM_unregisterMenuCommand(id);
                } catch (_) {}
            }
            menuIds = [];
        }

        function addMenu(label, callback) {
            menuIds.push(GM_registerMenuCommand(label, callback));
        }

        function rebuildMenus() {
            clearMenus();

            addMenu(
                state.enabled
                    ? (frameReady ? '✅ 横置遥控模式：开启' : '⏳ 横置遥控模式：加载中')
                    : '⬜ 横置遥控模式：关闭',
                () => updateState({ enabled: !state.enabled })
            );

            addMenu(
                state.direction === 'cw' ? '↻ 方向：顺时针' : '↺ 方向：逆时针',
                () => updateState({ direction: state.direction === 'cw' ? 'ccw' : 'cw' })
            );

            addMenu(
                state.navEnabled ? '✅ 会话快捷导航：开启' : '⬜ 会话快捷导航：关闭',
                () => {
                    const next = !state.navEnabled;
                    updateState({ navEnabled: next });
                    window.__GPTOPT_NAV__?.setEnabled(next);
                }
            );

            addMenu('🔧 重新计算横置尺寸', updateFrameGeometry);

            if (frameError) addMenu(`❌ ${frameError}`, () => {});
        }

        function onResize() {
            if (!state.enabled) return;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(updateFrameGeometry, 80);
        }

        window.addEventListener('resize', onResize, { passive: true });
        window.addEventListener(
            'keydown',
            (event) => {
                if (event.altKey && event.shiftKey && event.code === 'KeyR') {
                    event.preventDefault();
                    event.stopPropagation();
                    updateState({ enabled: !state.enabled });
                }
            },
            true
        );

        function init() {
            if (state.enabled) enable();
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
            init();
        }
    }
})();
