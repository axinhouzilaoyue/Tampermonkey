// ==UserScript==
// @name         链接有效性检测器 (页面标记)-增强版
// @namespace    http://tampermonkey.net
// @version      1.5
// @description  增强版链接检测器：强制样式应用，改进DOM选择，支持表格内外所有链接的标记
// @author       Axin & gemini 2.5 pro & Claude
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
    const MAX_RETRIES = 1;
    const RETRY_DELAY = 500;
    const BROKEN_LINK_CLASS = 'link-checker-broken';
    const CHECKED_LINK_CLASS = 'link-checker-checked';

    // --- 引入和添加样式 ---
    const toastifyCSS = GM_getResourceText("TOASTIFY_CSS");
    GM_addStyle(toastifyCSS);

    // 增强CSS规则，使用更高优先级确保样式应用，但移除叉号标记
    GM_addStyle(`
        .toastify.on.toastify-center { margin-left: auto; margin-right: auto; transform: translateX(0); }

        /* 强化样式应用 - 使用更高特异性选择器和!important，仅保留红色和删除线 */
        a.${BROKEN_LINK_CLASS},
        table a.${BROKEN_LINK_CLASS},
        div a.${BROKEN_LINK_CLASS},
        span a.${BROKEN_LINK_CLASS},
        li a.${BROKEN_LINK_CLASS},
        td a.${BROKEN_LINK_CLASS},
        th a.${BROKEN_LINK_CLASS},
        *[class] a.${BROKEN_LINK_CLASS},
        *[id] a.${BROKEN_LINK_CLASS} {
            color: red !important;
            text-decoration: line-through !important;
            background-color: rgba(255,200,200,0.2) !important;
            padding: 0 2px !important;
            border-radius: 2px !important;
        }

        #linkCheckerButton {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 60px;
            height: 60px;
            background-color: #007bff;
            color: white;
            border: none;
            border-radius: 50%;
            font-size: 24px;
            line-height: 60px;
            text-align: center;
            cursor: pointer;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            z-index: 9999;
            transition: background-color 0.3s, transform 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        #linkCheckerButton:hover {
            background-color: #0056b3;
            transform: scale(1.1);
        }

        #linkCheckerButton:disabled {
            background-color: #cccccc;
            cursor: not-allowed;
            transform: none;
        }
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

    function showToast(text, type = 'info', duration = 3000) {
        let backgroundColor;
        switch(type) {
            case 'success': backgroundColor = "linear-gradient(to right, #00b09b, #96c93d)"; break;
            case 'error': backgroundColor = "linear-gradient(to right, #ff5f6d, #ffc371)"; break;
            case 'warning': backgroundColor = "linear-gradient(to right, #f7b733, #fc4a1a)"; break;
            default: backgroundColor = "#0dcaf0";
        }
        Toastify({
            text: text,
            duration: duration,
            gravity: "bottom",
            position: "center",
            style: { background: backgroundColor },
            stopOnFocus: true
        }).showToast();
    }

    // --- 强制应用样式函数 (简化为仅应用红色和删除线) ---
    function forceApplyBrokenStyle(element) {
        // 确保样式被应用，通过直接操作DOM元素的style属性，但不添加叉号图标
        element.style.setProperty('color', 'red', 'important');
        element.style.setProperty('text-decoration', 'line-through', 'important');
        element.style.setProperty('background-color', 'rgba(255,200,200,0.2)', 'important');
    }

    // --- 核心链接检测函数 (处理405、404，带重试) ---
    async function checkLink(linkElement, retryCount = 0) {
        const url = linkElement.href;

        // 初始过滤和标记 (仅在第一次尝试时)
        if (retryCount === 0) {
            if (!url || !url.startsWith('http')) {
                return { element: linkElement, status: 'skipped', url: url, message: '非HTTP(S)链接' };
            }
            // 不添加CSS类，避免改变正常链接外观
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

            // 如果 GET 失败 (网络错误或超时) 且可以重试
            if ((result.status === 'error' || result.status === 'timeout') && retryCount < MAX_RETRIES) {
                console.warn(`[链接检测] ${result.message}: ${url} (尝试 ${retryCount + 1}/${MAX_RETRIES}), 稍后重试 (GET)...`);
                await delay(RETRY_DELAY);
                // 直接标记为失败
                return { element: linkElement, status: 'broken', url: url, message: `${result.message} (GET 重试 ${MAX_RETRIES} 次后失败)` };
            }
        }

        // --- 返回最终结果 ---
        if (result.status === 'ok') {
            return { element: linkElement, status: 'ok', url: url, statusCode: result.statusCode, message: result.message };
        } else {
            // 所有其他情况都视为 broken
            return { element: linkElement, status: 'broken', url: url, statusCode: result.statusCode, message: result.message || '未知错误' };
        }
    }

    // --- 处理检测结果 ---
    function handleResult(result) {
        checkedLinks++;
        const reason = result.message || (result.statusCode ? `状态码 ${result.statusCode}` : '未知原因');

        if (result.status === 'broken') {
            brokenLinksCount++;
            brokenLinkDetailsForConsole.push({ url: result.url, reason: reason });

            // 使用CSS类和强制样式应用双重保障，但不添加叉号图标
            result.element.classList.add(BROKEN_LINK_CLASS);
            forceApplyBrokenStyle(result.element); // 强制应用样式

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
    function startCheck() {
        if (isChecking) return;
        isChecking = true;

        // 重置状态
        checkedLinks = 0;
        brokenLinksCount = 0;
        linkQueue = [];
        activeChecks = 0;
        brokenLinkDetailsForConsole = [];

        // 清理之前的标记
        document.querySelectorAll(`a.${BROKEN_LINK_CLASS}`).forEach(el => {
            el.classList.remove(BROKEN_LINK_CLASS);
            if (el.title.startsWith('链接失效:')) el.title = '';

            // 重置内联样式
            el.style.removeProperty('color');
            el.style.removeProperty('text-decoration');
            el.style.removeProperty('background-color');
        });

        button.disabled = true;
        button.innerHTML = '0%';
        button.title = '开始检测...';
        showToast('开始检测页面链接...', 'info');
        console.log('[链接检测] 开始...');

        // 使用更全面的选择器获取所有链接
        const links = document.querySelectorAll('a[href]');
        let validLinksFound = 0;

        links.forEach(link => {
            // 跳过锚链接或非HTTP协议
            if (!link.href || link.getAttribute('href').startsWith('#') || !link.protocol.startsWith('http')) return;

            // 加入队列
            linkQueue.push(link);
            validLinksFound++;
        });

        totalLinks = validLinksFound;

        if (totalLinks === 0) {
            showToast('页面上没有找到有效的 HTTP/HTTPS 链接。', 'warning');
            finishCheck();
            return;
        }

        showToast(`发现 ${totalLinks} 个有效链接，开始检测...`, 'info', 5000);
        button.title = `检测中: 0/${totalLinks} (失效: 0)`;
        processQueue();
    }

    // --- 结束检测 ---
    function finishCheck() {
        isChecking = false;
        button.disabled = false;
        button.innerHTML = '🔗';
        let summary = `检测完成！共 ${totalLinks} 个链接。`;

        if (brokenLinksCount > 0) {
            summary += ` ${brokenLinksCount} 个失效链接已在页面上用红色删除线标记。`;
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

    // --- 为动态加载的链接增加观察器 ---
    function setupMutationObserver() {
        // 创建一个观察器实例并传入回调函数
        const observer = new MutationObserver(mutations => {
            // 仅在非检测过程中处理
            if (!isChecking) return;

            // 处理DOM变化
            let newLinks = [];
            mutations.forEach(mutation => {
                // 对于添加的节点，查找其中的链接
                mutation.addedNodes.forEach(node => {
                    // 检查节点是否是元素节点
                    if (node.nodeType === 1) {
                        // 如果节点本身是链接
                        if (node.tagName === 'A' && node.href &&
                            !node.getAttribute('href').startsWith('#') &&
                            node.protocol.startsWith('http') &&
                            !node.classList.contains(BROKEN_LINK_CLASS)) {
                            newLinks.push(node);
                        }

                        // 或者包含链接
                        const childLinks = node.querySelectorAll('a[href]:not(.${BROKEN_LINK_CLASS})');
                        childLinks.forEach(link => {
                            if (link.href &&
                                !link.getAttribute('href').startsWith('#') &&
                                link.protocol.startsWith('http') &&
                                !link.classList.contains(BROKEN_LINK_CLASS)) {
                                newLinks.push(link);
                            }
                        });
                    }
                });
            });

            // 如果找到新链接，将它们加入检测队列
            if (newLinks.length > 0) {
                console.log(`[链接检测] 检测到 ${newLinks.length} 个新动态加载的链接，加入检测队列`);
                totalLinks += newLinks.length;
                newLinks.forEach(link => linkQueue.push(link));

                // 更新按钮显示
                button.title = `检测中: ${checkedLinks}/${totalLinks} (失效: ${brokenLinksCount})`;

                // 如果当前没有活跃检查，启动队列处理
                if (activeChecks === 0) {
                    processQueue();
                }
            }
        });

        // 配置观察选项
        const config = {
            childList: true,
            subtree: true
        };

        // 开始观察文档主体的所有变化
        observer.observe(document.body, config);

        return observer;
    }

    // --- 添加按钮事件 ---
    button.addEventListener('click', startCheck);

    // 初始化动态链接观察器
    const observer = setupMutationObserver();

    console.log('[链接检测器] 脚本已加载 (v1.5 仅红色删除线版)，点击右下角悬浮按钮开始检测。');

})();
