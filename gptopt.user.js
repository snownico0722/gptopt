// ==UserScript==
// @name         GPTOpt - ChatGPT 手机远程横置 + 会话导航
// @namespace    https://github.com/snownico0722/gptopt
// @version      1.0.0
// @description  手机远程控制电脑时，将 ChatGPT 放进真实竖向视口后横置 90°；在横置 iframe 内集成 Conversation Overview 会话导航。
// @author       snownico0722
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
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
        bootConversationOverview().catch((error) => {
            console.error('[GPTOpt] Conversation Overview failed to start:', error);
        });
        return;
    }

    bootRemoteViewport();

    /* ====================================================================== *
     * Conversation Overview integration (remote iframe only)
     * ====================================================================== */

    async function bootConversationOverview() {
        if (window.__GPTOPT_COR_BOOTED__) return;
        window.__GPTOPT_COR_BOOTED__ = true;

        const UPSTREAM = {
            repo: 'boabab/conversation-overview',
            version: '1.5.0',
            commit: '445a0e2d53fcfcf57b6297efc56346b2a773213a',
            url: 'https://raw.githubusercontent.com/boabab/conversation-overview/445a0e2d53fcfcf57b6297efc56346b2a773213a/conversation-overview.user.js',
            cacheKey: 'gptopt-cor-source-445a0e2d53fcfcf57b6297efc56346b2a773213a'
        };

        // Conversation Overview deliberately ships with a frame guard, but also
        // exposes this documented demo seam before its SETTINGS object is frozen.
        // We use that seam rather than editing the upstream source. 760 px keeps
        // the rail available in GPTOpt's portrait-layout iframe (typically ~983 px).
        window.__COR_DEMO__ = {
            settings: {
                minViewportWidth: 760,
                debug: false
            }
        };

        const source = await getConversationOverviewSource(UPSTREAM);
        validateConversationOverviewSource(source, UPSTREAM);

        // Execute the pinned upstream script inside this Tampermonkey sandbox.
        // Direct eval keeps GM_* grants available to the upstream code and avoids
        // injecting a page <script>, which ChatGPT's CSP may reject.
        eval(`${source}\n//# sourceURL=gptopt-conversation-overview-${UPSTREAM.version}.js`);
    }

    function getConversationOverviewSource(upstream) {
        const cached = GM_getValue(upstream.cacheKey, '');
        if (cached) return Promise.resolve(cached);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: upstream.url,
                timeout: 15000,
                onload(response) {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`upstream HTTP ${response.status}`));
                        return;
                    }
                    const text = response.responseText || '';
                    try {
                        validateConversationOverviewSource(text, upstream);
                        GM_setValue(upstream.cacheKey, text);
                        resolve(text);
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror() {
                    reject(new Error('failed to download Conversation Overview'));
                },
                ontimeout() {
                    reject(new Error('Conversation Overview download timed out'));
                }
            });
        });
    }

    function validateConversationOverviewSource(source, upstream) {
        if (typeof source !== 'string' || source.length < 50000) {
            throw new Error('Conversation Overview source is unexpectedly short');
        }
        if (!source.includes('// @name         Conversation Overview')) {
            throw new Error('Conversation Overview source marker missing');
        }
        if (!source.includes(`// @version      ${upstream.version}`)) {
            throw new Error(`Conversation Overview version is not ${upstream.version}`);
        }
        if (!source.includes('window.__COR_DEMO__')) {
            throw new Error('Conversation Overview demo seam missing');
        }
    }

    /* ====================================================================== *
     * Remote viewport / rotation (top frame only)
     * ====================================================================== */

    function bootRemoteViewport() {
        const KEY = 'gptopt-remote-v1-';
        const DEFAULTS = {
            enabled: false,
            direction: 'cw'
        };

        let state = {
            enabled: GM_getValue(KEY + 'enabled', DEFAULTS.enabled),
            direction: GM_getValue(KEY + 'direction', DEFAULTS.direction)
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
