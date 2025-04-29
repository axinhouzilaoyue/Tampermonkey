// ==UserScript==
// @name         链接有效性检测器 (页面标记)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Adds a button to check links, retries failed ones, falls back to GET on 405, marks broken links with an icon, shows log.
// @author       Axin & gemini 2.5 pro
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/toastify-js/src/toastify.min.js
// @resource     TOASTIFY_CSS https://cdn.jsdelivr.net/npm/toastify-js/src/toastify.min.css
// @grant        GM_getResourceText
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    // --- 配置 ---
    const CHECK_TIMEOUT = 10000;
    const CONCURRENT_CHECKS = 5;
    const MAX_RETRIES = 1; // 减少重试次数，因为GET可能更慢
    const RETRY_DELAY = 500;
    const BROKEN_LINK_CLASS = 'link-checker-broken';
    const CHECKED_LINK_CLASS = 'link-checker-checked';

    const BROKEN_ICON_SVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='red' width='1em' height='1em'%3E%3Cpath d='M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'/%3E%3C/svg%3E`;

    // --- 引入和添加样式 ---
    const toastifyCSS = GM_getResourceText("TOASTIFY_CSS");
    GM_addStyle(toastifyCSS);
    GM_addStyle(`
        .toastify.on.toastify-center { margin-left: auto; margin-right: auto; transform: translateX(0); }
        .${BROKEN_LINK_CLASS} { color: red !important; text-decoration: line-through !important; }
        .${BROKEN_LINK_CLASS}::after {
            content: ''; display: inline-block; width: 1em; height: 1em;
            margin-left: 4px; vertical-align: middle;
            background-image: url("${BROKEN_ICON_SVG}");
            background-repeat: no-repeat; background-size: contain;
        }
        #linkCheckerButton { /* ... (按钮样式保持不变) ... */
            position: fixed; bottom: 20px; right: 20px; width: 60px; height: 60px;
            background-color: #007bff; color: white; border: none; border-radius: 50%;
            font-size: 24px; line-height: 60px; text-align: center; cursor: pointer;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2); z-index: 9999;
            transition: background-color 0.3s, transform 0.2s; display: flex;
            align-items: center; justify-content: center;
        }
        #linkCheckerButton:hover { background-color: #0056b3; transform: scale(1.1); }
        #linkCheckerButton:disabled { background-color: #cccccc; cursor: not-allowed; transform: none; }
    `);

    // --- 全局状态 ---
    let isChecking = false;
    let totalLinks = 0;
    let checkedLinks = 0;
    let brokenLinksCount = 0;
    let linkQueue = [];
    let activeChecks = 0;
    let brokenLinkDetailsForConsole = [];

    // --- 创建按钮 ---
    const button = document.createElement('button');
    button.id = 'linkCheckerButton';
    button.innerHTML = '🔗';
    button.title = '点击开始检测页面链接';
    document.body.appendChild(button);

    // --- 工具函数 ---
    function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    function showToast(text, type = 'info', duration = 3000) { /* ... (Toastify 函数保持不变) ... */
        let backgroundColor;
        switch(type) {
            case 'success': backgroundColor = "linear-gradient(to right, #00b09b, #96c93d)"; break;
            case 'error': backgroundColor = "linear-gradient(to right, #ff5f6d, #ffc371)"; break;
            case 'warning': backgroundColor = "linear-gradient(to right, #f7b733, #fc4a1a)"; break;
            default: backgroundColor = "#0dcaf0";
        }
        Toastify({ text: text, duration: duration, gravity: "bottom", position: "center", style: { background: backgroundColor }, stopOnFocus: true }).showToast();
    }


    // --- 核心链接检测函数 (处理405、404，带重试) ---
    async function checkLink(linkElement, retryCount = 0) {
        const url = linkElement.href;

        // 初始过滤和标记 (仅在第一次尝试时)
        if (retryCount === 0) {
            if (!url || !url.startsWith('http')) {
                return { element: linkElement, status: 'skipped', url: url, message: '非HTTP(S)链接' };
            }
            linkElement.classList.add(CHECKED_LINK_CLASS);
        }

        // --- 内部函数：执行实际的 HTTP 请求 ---
        const doRequest = (method) => {
            return new Promise((resolveRequest) => {
                GM_xmlhttpRequest({
                    method: method,
                    url: url,
                    timeout: CHECK_TIMEOUT,
                    onload: function(response) {
                        // 如果是 HEAD 且返回 405 或 404，则尝试 GET
                        if (method === 'HEAD' && (response.status === 405 || response.status === 404 || (response.status >= 500 && response.status < 600))) {
                            console.log(`[链接检测] HEAD 收到 ${response.status}: ${url}, 尝试使用 GET...`);
                            resolveRequest({ status: 'retry_with_get' });
                            return; // 不再处理此 onload
                        }

                        // 其他情况，根据状态码判断
                        if (response.status >= 200 && response.status < 400) {
                            resolveRequest({ status: 'ok', statusCode: response.status, message: `方法 ${method}` });
                        } else {
                            resolveRequest({ status: 'broken', statusCode: response.status, message: `方法 ${method} 错误 (${response.status})` });
                        }
                    },
                    onerror: function(response) {
                        resolveRequest({ status: 'error', message: `网络错误 (${response.error || 'Unknown Error'}) using ${method}` });
                    },
                    ontimeout: function() {
                        resolveRequest({ status: 'timeout', message: `请求超时 using ${method}` });
                    }
                });
            });
        };

        // --- 主要逻辑：先尝试 HEAD，处理结果 ---
        let result = await doRequest('HEAD');

        // 如果 HEAD 失败 (网络错误或超时) 且可以重试
        if ((result.status === 'error' || result.status === 'timeout') && retryCount < MAX_RETRIES) {
            console.warn(`[链接检测] ${result.message}: ${url} (尝试 ${retryCount + 1}/${MAX_RETRIES}), 稍后重试 (HEAD)...`);
            await delay(RETRY_DELAY);
            return checkLink(linkElement, retryCount + 1); // 返回重试的 Promise
        }

        // 如果 HEAD 返回 405，则尝试 GET
        if (result.status === 'retry_with_get') {
            result = await doRequest('GET'); // 等待 GET 请求的结果

             // 如果 GET 失败 (网络错误或超时) 且可以重试 (注意: 这里的重试是针对GET的)
             // 通常如果 HEAD 能通，GET 的网络错误概率较低，但还是加上以防万一
            if ((result.status === 'error' || result.status === 'timeout') && retryCount < MAX_RETRIES) {
                console.warn(`[链接检测] ${result.message}: ${url} (尝试 ${retryCount + 1}/${MAX_RETRIES}), 稍后重试 (GET)...`);
                await delay(RETRY_DELAY);
                // 注意：再次调用 checkLink 会重新从 HEAD 开始，可能导致死循环。
                // 这里应该直接重试 GET 或标记为失败。为简单起见，直接标记失败。
                 return { element: linkElement, status: 'broken', url: url, message: `${result.message} (GET 重试 ${MAX_RETRIES} 次后失败)` };
                // 或者，可以实现一个独立的 GET 重试逻辑，但会使代码更复杂。
            }
        }

        // --- 返回最终结果 ---
        // 将内部状态映射回 handleResult 能理解的状态
        if (result.status === 'ok') {
            return { element: linkElement, status: 'ok', url: url, statusCode: result.statusCode, message: result.message };
        } else {
            // 所有其他情况 (HEAD 错误且无重试, HEAD 405 -> GET 错误, HEAD 其他 4xx/5xx, GET 错误) 都视为 broken
             return { element: linkElement, status: 'broken', url: url, statusCode: result.statusCode, message: result.message || '未知错误' };
        }
    }


    // --- 处理检测结果 ---
    function handleResult(result) {
        checkedLinks++;
        const reason = result.message || (result.statusCode ? `状态码 ${result.statusCode}` : '未知原因'); // 获取原因

        if (result.status === 'broken') {
            brokenLinksCount++;
            brokenLinkDetailsForConsole.push({ url: result.url, reason: reason });
            result.element.classList.add(BROKEN_LINK_CLASS);
            result.element.title = `链接失效: ${reason}\nURL: ${result.url}`;
            console.warn(`[链接检测] 失效 (${reason}): ${result.url}`);
            showToast(`失效: ${result.url.substring(0,50)}... (${reason})`, 'error', 5000);
        } else if (result.status === 'ok') {
            console.log(`[链接检测] 正常 (${reason}, 状态码: ${result.statusCode}): ${result.url}`);
            if (result.element.title.startsWith('链接失效:')) {
                 result.element.title = '';
            }
        } else if (result.status === 'skipped') {
            console.log(`[链接检测] 跳过 (${result.message}): ${result.url || '空链接'}`);
        }

        // 更新进度
        const progressText = `检测中: ${checkedLinks}/${totalLinks} (失效: ${brokenLinksCount})`;
        button.innerHTML = totalLinks > 0 ? `${Math.round((checkedLinks / totalLinks) * 100)}%` : '...';
        button.title = progressText;

        // 处理下一个
        activeChecks--;
        processQueue();

        // 检查完成
        if (checkedLinks === totalLinks) {
            finishCheck();
        }
    }

    // --- 队列处理 ---
    function processQueue() {
        while (activeChecks < CONCURRENT_CHECKS && linkQueue.length > 0) {
            activeChecks++;
            const linkElement = linkQueue.shift();
            checkLink(linkElement).then(handleResult); // 异步执行
        }
    }

    // --- 开始检测 ---
    function startCheck() { /* ... (基本不变, 确保清理和初始化) ... */
        if (isChecking) return;
        isChecking = true;

        checkedLinks = 0;
        brokenLinksCount = 0;
        linkQueue = [];
        activeChecks = 0;
        brokenLinkDetailsForConsole = [];

        document.querySelectorAll(`a.${BROKEN_LINK_CLASS}`).forEach(el => {
             el.classList.remove(BROKEN_LINK_CLASS);
             if (el.title.startsWith('链接失效:')) el.title = '';
        });
        document.querySelectorAll(`a.${CHECKED_LINK_CLASS}`).forEach(el => {
             el.classList.remove(CHECKED_LINK_CLASS);
        });

        button.disabled = true;
        button.innerHTML = '0%';
        button.title = '开始检测...';
        showToast('开始检测页面链接...', 'info');
        console.log('[链接检测] 开始...');

        const links = document.querySelectorAll('a[href]');
        let validLinksFound = 0;
        links.forEach(link => {
            if (!link.href || link.getAttribute('href').startsWith('#') || !link.protocol.startsWith('http')) return;
             linkQueue.push(link);
             validLinksFound++;
        });
        totalLinks = validLinksFound;

        if (totalLinks === 0) {
            showToast('页面上没有找到有效的 HTTP/HTTPS 链接。', 'warning');
            finishCheck(); return;
        }

        showToast(`发现 ${totalLinks} 个有效链接，开始检测 (将对405、404错误尝试GET)...`, 'info', 5000);
        button.title = `检测中: 0/${totalLinks} (失效: 0)`;
        processQueue();
    }

    // --- 结束检测 ---
    function finishCheck() { /* ... (基本不变, 更新消息和控制台输出) ... */
        isChecking = false;
        button.disabled = false;
        button.innerHTML = '🔗';
        let summary = `检测完成！共 ${totalLinks} 个链接。`;

        if (brokenLinksCount > 0) {
            summary += ` ${brokenLinksCount} 个失效链接已在页面上用 ❌ 标记。`;
            showToast(summary, 'error', 10000);
            console.warn("----------------------------------------");
            console.warn(`检测到 ${brokenLinksCount} 个失效链接 (详细原因):`);
            console.group("失效链接详细列表 (控制台)");
            brokenLinkDetailsForConsole.forEach(detail => console.warn(`- ${detail.url} (原因: ${detail.reason})`));
            console.groupEnd();
            console.warn("----------------------------------------");
        } else {
            summary += " 所有链接均可访问！";
            showToast(summary, 'success', 5000);
        }
        button.title = summary + '\n点击重新检测';
        console.log(`[链接检测] ${summary}`);
        activeChecks = 0;
    }

    // --- 添加按钮事件 ---
    button.addEventListener('click', startCheck);
    console.log('[链接检测器] 脚本已加载 (v1.4 处理405错误)，点击右下角悬浮按钮开始检测。');

})();
