// ==UserScript==
// @name         GPTOpt - ChatGPT 手机远程横置 + 会话导航
// @namespace    https://github.com/snownico0722/gptopt
// @version      1.1.0
// @description  手机远程控制电脑时，将 ChatGPT 放进真实竖向视口后横置 90°；内置轻量、旋转感知的会话快捷导航。
// @author       snownico0722
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
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

    // Ignore unrelated frames. The same userscript intentionally runs inside the
    // one iframe created by GPTOpt so the navigation plugin can live there.
    if (!IS_TOP && !IS_REMOTE_FRAME) return;

    if (IS_REMOTE_FRAME) {
        bootConversationRail();
        return;
    }

    bootRemoteViewport();

    /* ====================================================================== *
     * Conversation navigation (remote iframe only)
     * ====================================================================== */

    function bootConversationRail() {
    const NAV_KEY = 'gptopt-nav-enabled';
    const SETTINGS = {
        minItems: 2,
        labelChars: 80,
        readingLine: 0.32,
        rebuildDelayMs: 120,
        popupHideDelayMs: 220,
        apiRetryMs: 30000
    };

    let enabled = GM_getValue(NAV_KEY, true);
    let direction = getFrameDirection();

    const labelCache = new Map();
    let exchanges = [];
    let activeIndex = -1;

    let rail = null;
    let popup = null;
    let observer = null;
    let rebuildTimer = null;
    let activeFrame = 0;
    let hideTimer = null;
    let scrollOwner = null;
    let scrollEventTarget = null;
    let lastPath = location.pathname;

    const api = {
        token: null,
        tokenAt: -Infinity,
        conversationId: null,
        groups: null,
        pending: false,
        failedAt: -Infinity
    };

    installStyles();
    applyDirection();
    listenForParentSettings();
    start();

    function getFrameDirection() {
        try {
            const value = window.frameElement?.dataset?.gptoptDirection;
            return value === 'ccw' ? 'ccw' : 'cw';
        } catch (_) {
            return 'cw';
        }
    }

    function applyDirection() {
        document.documentElement.setAttribute('data-gptopt-direction', direction);
    }

    function listenForParentSettings() {
        window.addEventListener('message', (event) => {
            if (event.source !== window.parent || event.origin !== location.origin) return;
            const data = event.data;
            if (!data || typeof data !== 'object') return;

            if (data.type === 'gptopt-settings') {
                if (data.direction === 'cw' || data.direction === 'ccw') {
                    direction = data.direction;
                    applyDirection();
                }
                if (typeof data.navEnabled === 'boolean') {
                    enabled = data.navEnabled;
                    GM_setValue(NAV_KEY, enabled);
                    scheduleRebuild();
                }
            }
        });
    }

    function installStyles() {
        if (document.getElementById('gptopt-nav-style')) return;

        const style = document.createElement('style');
        style.id = 'gptopt-nav-style';
        style.textContent = `
#gptopt-nav-rail {
    position: fixed;
    left: 64px;
    right: 64px;
    height: 46px;
    z-index: 2147483000;
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 0 4px;
    box-sizing: border-box;
    pointer-events: auto;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    color: var(--text-primary, #111);
}

#gptopt-nav-rail::-webkit-scrollbar {
    display: none;
}

html[data-gptopt-direction="cw"] #gptopt-nav-rail {
    top: 8px;
    bottom: auto;
}

html[data-gptopt-direction="ccw"] #gptopt-nav-rail {
    top: auto;
    bottom: 8px;
}

#gptopt-nav-rail[hidden],
#gptopt-nav-popup[hidden] {
    display: none !important;
}

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
    flex: 0 0 30px;
    width: 30px;
    height: 42px;
    border-radius: 10px;
    font: 600 18px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    opacity: .72;
}

.gptopt-nav-menu:hover,
.gptopt-nav-menu:focus-visible {
    background: color-mix(in srgb, currentColor 8%, transparent);
    opacity: 1;
}

.gptopt-nav-tick {
    flex: 1 1 12px;
    min-width: 9px;
    max-width: 24px;
    height: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
}

.gptopt-nav-tick > span {
    width: 2px;
    height: 19px;
    border-radius: 999px;
    background: currentColor;
    opacity: .24;
    transition: height 100ms ease, opacity 100ms ease;
}

.gptopt-nav-tick:hover > span {
    height: 25px;
    opacity: .55;
}

.gptopt-nav-tick.is-active > span {
    height: 31px;
    opacity: .95;
}

#gptopt-nav-popup {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, calc(100vw - 44px));
    max-height: min(390px, calc(100vh - 120px));
    z-index: 2147483001;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 8px;
    box-sizing: border-box;
    border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
    border-radius: 16px;
    background: color-mix(in srgb, var(--main-surface-primary, #fff) 96%, transparent);
    box-shadow: 0 10px 34px rgba(0,0,0,.18);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    color: var(--text-primary, #111);
    scrollbar-width: thin;
}

html[data-gptopt-direction="cw"] #gptopt-nav-popup {
    top: 58px;
    bottom: auto;
}

html[data-gptopt-direction="ccw"] #gptopt-nav-popup {
    top: auto;
    bottom: 58px;
}

.gptopt-nav-row {
    width: 100%;
    min-height: 42px;
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
.gptopt-nav-row:focus-visible {
    background: color-mix(in srgb, currentColor 7%, transparent);
}

.gptopt-nav-row.is-active {
    background: color-mix(in srgb, currentColor 10%, transparent);
    font-weight: 650;
}

.gptopt-nav-index {
    flex: 0 0 auto;
    min-width: 24px;
    opacity: .45;
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
    outline: 2px solid color-mix(in srgb, var(--theme-entity-accent, #10a37f) 70%, transparent) !important;
    outline-offset: 4px !important;
    border-radius: 10px;
}

@media (prefers-color-scheme: dark) {
    #gptopt-nav-popup {
        background: color-mix(in srgb, var(--main-surface-primary, #212121) 95%, transparent);
    }
}
`;
        document.documentElement.appendChild(style);
    }

    function start() {
        const init = () => {
            ensureUi();
            bindObserver();
            scheduleRebuild();
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
            init();
        }
    }

    function ensureUi() {
        if (!document.body) return;

        if (!rail) {
            rail = document.createElement('nav');
            rail.id = 'gptopt-nav-rail';
            rail.setAttribute('aria-label', 'GPTOpt conversation navigation');
            rail.addEventListener('pointerenter', () => {
                if (enabled && exchanges.length >= SETTINGS.minItems) showPopup(false);
            });
            rail.addEventListener('pointerleave', scheduleHidePopup);
            document.body.appendChild(rail);
        }

        if (!popup) {
            popup = document.createElement('div');
            popup.id = 'gptopt-nav-popup';
            popup.setAttribute('role', 'menu');
            popup.hidden = true;
            popup.addEventListener('pointerenter', cancelHidePopup);
            popup.addEventListener('pointerleave', scheduleHidePopup);
            document.body.appendChild(popup);
        }
    }

    function bindObserver() {
        if (observer || !document.body) return;
        observer = new MutationObserver(() => scheduleRebuild());
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function scheduleRebuild() {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(rebuild, SETTINGS.rebuildDelayMs);
    }

    function rebuild() {
        ensureUi();
        handleRouteChange();

        if (!enabled) {
            if (rail) rail.hidden = true;
            hidePopup(true);
            return;
        }

        exchanges = scanExchanges();
        if (exchanges.length < SETTINGS.minItems) {
            if (rail) rail.hidden = true;
            hidePopup(true);
            return;
        }

        if (rail) rail.hidden = false;
        bindScrollOwner();
        renderRail();
        renderPopup();
        updateActive();
        prefetchConversationLabels();
    }

    function handleRouteChange() {
        if (location.pathname === lastPath) return;
        lastPath = location.pathname;
        labelCache.clear();
        activeIndex = -1;
        api.conversationId = null;
        api.groups = null;
        api.pending = false;
        api.failedAt = -Infinity;
    }

    function normalizeText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    function scanExchanges() {
        const root = document.querySelector('main') || document;
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
                        key:
                            'msg-' +
                            (message.getAttribute('data-message-id') || String(groups.length)),
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
            for (const item of api.groups) {
                if (item.uid) apiByUid.set(item.uid, item);
            }
        }

        return groups.map((group, index) => {
            const userRoleNode = getUserRoleNode(group.userEl);
            const uidNode =
                userRoleNode?.matches?.('[data-message-id]')
                    ? userRoleNode
                    : userRoleNode?.querySelector?.('[data-message-id]');
            const uid = uidNode?.getAttribute('data-message-id') || null;

            const mountedLabel = readPromptText(userRoleNode);
            if (mountedLabel) {
                labelCache.set(group.key, mountedLabel);
            }

            const apiItem =
                (uid && apiByUid.get(uid)) ||
                (api.groups && api.groups.length === groups.length ? api.groups[index] : null);

            if (!labelCache.get(group.key) && apiItem?.prompt) {
                labelCache.set(group.key, apiItem.prompt);
            }

            return {
                ...group,
                uid,
                label: labelCache.get(group.key) || `问题 ${index + 1}`
            };
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

        if (!candidates.some(Boolean)) {
            candidates.push(normalizeText(roleNode.innerText));
        }

        let best = '';
        for (const candidate of candidates) {
            if (candidate && candidate.length > best.length) best = candidate;
        }
        return best;
    }

    function shortLabel(text) {
        const clean = normalizeText(text);
        if (clean.length <= SETTINGS.labelChars) return clean;
        return clean.slice(0, SETTINGS.labelChars - 1) + '…';
    }

    function renderRail() {
        if (!rail) return;
        rail.replaceChildren();

        const menuButton = document.createElement('button');
        menuButton.type = 'button';
        menuButton.className = 'gptopt-nav-menu';
        menuButton.textContent = '≡';
        menuButton.title = '会话导航';
        menuButton.setAttribute('aria-label', '打开会话导航');
        menuButton.addEventListener('click', (event) => {
            event.stopPropagation();
            if (popup?.hidden) showPopup(true);
            else hidePopup(true);
        });
        rail.appendChild(menuButton);

        exchanges.forEach((exchange, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'gptopt-nav-tick';
            button.dataset.index = String(index);
            button.title = shortLabel(exchange.label);
            button.setAttribute('aria-label', `${index + 1}. ${shortLabel(exchange.label)}`);

            const bar = document.createElement('span');
            button.appendChild(bar);

            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                jumpToExchange(index);
            });

            rail.appendChild(button);
        });
    }

    function renderPopup() {
        if (!popup) return;
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
                hidePopup(true);
            });
            popup.appendChild(row);
        });

        popup.hidden = wasHidden;
    }

    function showPopup(pin) {
        if (!popup || !enabled || exchanges.length < SETTINGS.minItems) return;
        cancelHidePopup();
        popup.hidden = false;
        popup.dataset.pinned = pin ? '1' : '0';
        refreshActiveUi();
    }

    function hidePopup(force) {
        if (!popup) return;
        if (!force && popup.dataset.pinned === '1') return;
        popup.hidden = true;
        popup.dataset.pinned = '0';
    }

    function scheduleHidePopup() {
        cancelHidePopup();
        hideTimer = setTimeout(() => hidePopup(false), SETTINGS.popupHideDelayMs);
    }

    function cancelHidePopup() {
        clearTimeout(hideTimer);
        hideTimer = null;
    }

    function findScrollContainer(element) {
        let node = element?.parentElement;
        while (node && node !== document.body && node !== document.documentElement) {
            const style = getComputedStyle(node);
            if (
                (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                node.scrollHeight > node.clientHeight + 4
            ) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    function bindScrollOwner() {
        const sample = exchanges.find((item) => item.els.some((el) => el.isConnected));
        const sampleEl = sample?.userEl || sample?.els?.[0] || document.querySelector('main');
        const owner = findScrollContainer(sampleEl) || document.scrollingElement;
        if (owner === scrollOwner) return;

        if (scrollEventTarget) {
            scrollEventTarget.removeEventListener('scroll', onScroll, true);
        }

        scrollOwner = owner;
        scrollEventTarget =
            owner === document.scrollingElement || owner === document.documentElement
                ? window
                : owner;

        scrollEventTarget?.addEventListener('scroll', onScroll, {
            passive: true,
            capture: true
        });
    }

    function onScroll() {
        cancelAnimationFrame(activeFrame);
        activeFrame = requestAnimationFrame(updateActive);
    }

    function exchangeAnchor(exchange) {
        if (!exchange) return null;
        if (exchange.userEl?.isConnected) return exchange.userEl;
        return exchange.els.find((el) => el.isConnected) || null;
    }

    function updateActive() {
        if (!exchanges.length) return;

        let line;
        if (
            scrollOwner &&
            scrollOwner !== document.scrollingElement &&
            scrollOwner !== document.documentElement
        ) {
            const rect = scrollOwner.getBoundingClientRect();
            line = rect.top + scrollOwner.clientHeight * SETTINGS.readingLine;
        } else {
            line = window.innerHeight * SETTINGS.readingLine;
        }

        let best = 0;
        let bestBelowDistance = Infinity;
        let foundAbove = false;

        exchanges.forEach((exchange, index) => {
            const anchor = exchangeAnchor(exchange);
            if (!anchor) return;
            const top = anchor.getBoundingClientRect().top;

            if (top <= line + 1) {
                best = index;
                foundAbove = true;
            } else if (!foundAbove) {
                const distance = top - line;
                if (distance < bestBelowDistance) {
                    bestBelowDistance = distance;
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
            const activeRow = popup.querySelector('.gptopt-nav-row.is-active');
            activeRow?.scrollIntoView?.({ block: 'nearest' });
        }
    }

    function jumpToExchange(index) {
        const exchange = exchanges[index];
        const target = exchangeAnchor(exchange);
        if (!target) return;

        activeIndex = index;
        refreshActiveUi();

        const doJump = () => {
            const owner = findScrollContainer(target) || document.scrollingElement;
            const targetRect = target.getBoundingClientRect();

            if (
                owner &&
                owner !== document.scrollingElement &&
                owner !== document.documentElement
            ) {
                const ownerRect = owner.getBoundingClientRect();
                owner.scrollTop += targetRect.top - ownerRect.top - 64;
            } else {
                window.scrollBy({
                    top: targetRect.top - 64,
                    left: 0,
                    behavior: 'auto'
                });
            }
        };

        doJump();
        setTimeout(doJump, 90);
        setTimeout(() => {
            doJump();
            flashTarget(exchange);
        }, 260);
    }

    function flashTarget(exchange) {
        const target = exchange?.userEl || exchange?.els?.[0];
        if (!target?.isConnected || target.getBoundingClientRect().height <= 0) return;
        target.classList.add('gptopt-nav-flash');
        setTimeout(() => target.classList.remove('gptopt-nav-flash'), 900);
    }

    function conversationIdFromPath() {
        const match = /\/c\/([0-9a-f-]{8,})/i.exec(location.pathname);
        return match ? match[1] : null;
    }

    async function fetchAccessToken() {
        if (api.token && performance.now() - api.tokenAt < 10 * 60 * 1000) {
            return api.token;
        }

        const response = await fetch('/api/auth/session', { credentials: 'include' });
        if (!response.ok) throw new Error(`session ${response.status}`);

        const data = await response.json();
        if (!data?.accessToken) throw new Error('missing access token');

        api.token = data.accessToken;
        api.tokenAt = performance.now();
        return api.token;
    }

    async function fetchConversationGroups(id) {
        const token = await fetchAccessToken();
        const response = await fetch(`/backend-api/conversation/${id}`, {
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

        const messages = [];
        for (const item of chain) {
            const message = item.message;
            if (!message?.author) continue;

            const role = message.author.role;
            if (role !== 'user' && role !== 'assistant') continue;
            if (message.recipient && message.recipient !== 'all') continue;
            if (message.metadata?.is_visually_hidden_from_conversation) continue;

            messages.push({
                id: message.id,
                role,
                text: messageText(message)
            });
        }

        const groups = [];
        let current = null;

        for (const message of messages) {
            if (message.role === 'user' || !current) {
                current = {
                    uid: message.role === 'user' ? message.id : null,
                    prompt: message.role === 'user' ? normalizeText(message.text) : ''
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

    function prefetchConversationLabels() {
        const id = conversationIdFromPath();
        if (!id) return;
        if (api.conversationId === id && (api.groups || api.pending)) return;
        if (performance.now() - api.failedAt < SETTINGS.apiRetryMs) return;

        api.conversationId = id;
        api.pending = true;

        fetchConversationGroups(id).then(
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

html.gptopt-frame-ready body > *:not(#${REMOTE_FRAME_ID}) {
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
    z-index: 2147483647 !important;
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

            frame.dataset.gptoptDirection = state.direction;

            if (state.direction === 'cw') {
                frame.style.transform = `matrix(0, 1, -1, 0, ${W}, 0)`;
            } else {
                frame.style.transform = `matrix(0, -1, 1, 0, 0, ${H})`;
            }

            postFrameSettings();
        }

        function postFrameSettings() {
            if (!frame?.contentWindow) return;
            try {
                frame.contentWindow.postMessage(
                    {
                        type: 'gptopt-settings',
                        direction: state.direction,
                        navEnabled: state.navEnabled
                    },
                    location.origin
                );
            } catch (_) {}
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
            postFrameSettings();
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
            frame.dataset.gptoptDirection = state.direction;
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
                () => updateState({ navEnabled: !state.navEnabled })
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
