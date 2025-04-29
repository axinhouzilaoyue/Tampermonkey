// ==UserScript==
// @name         链接有效性检测器 (页面标记失效链接)
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Adds a floating button to check links, retries failed ones, marks broken links directly on the page with an icon, shows a log.
// @author       axin & gemini 2.5 pro
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
    const CHECK_TIMEOUT = 10000; // 单个链接检测超时时间 (毫秒)
    const CONCURRENT_CHECKS = 5; // 同时检测的链接数量
    const MAX_RETRIES = 2; // 失败后最大重试次数
    const RETRY_DELAY = 500; // 重试前的延迟时间 (毫秒)
    const BROKEN_LINK_CLASS = 'link-checker-broken';
    const CHECKED_LINK_CLASS = 'link-checker-checked'; // 用于标记已检查过的链接

    // --- SVG 图标 (红色 X) ---
    const BROKEN_ICON_SVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='red' width='1em' height='1em'%3E%3Cpath d='M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'/%3E%3C/svg%3E`;

    // --- 引入 Toastify 通知库的 CSS 和自定义样式 ---
    const toastifyCSS = GM_getResourceText("TOASTIFY_CSS");
    GM_addStyle(toastifyCSS);
    GM_addStyle(`
        .toastify.on.toastify-center { margin-left: auto; margin-right: auto; transform: translateX(0); }

        /* 失效链接样式 */
        .${BROKEN_LINK_CLASS} {
            color: red !important;
            text-decoration: line-through !important;
            /* outline: 1px dashed red; /* 可选：保留或移除轮廓 */
        }
        /* 在失效链接后添加图标 */
        .${BROKEN_LINK_CLASS}::after {
            content: ''; /* 使用背景图而非文字 */
            display: inline-block;
            width: 1em; /* 图标大小，可调整 */
            height: 1em; /* 图标大小，可调整 */
            margin-left: 4px; /* 图标与文字间距 */
            vertical-align: middle; /* 垂直对齐 */
            background-image: url("${BROKEN_ICON_SVG}");
            background-repeat: no-repeat;
            background-size: contain; /* 缩放图标以适应容器 */
        }

        /* 悬浮按钮样式 */
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
    let brokenLinkDetailsForConsole = []; // 仍然保留控制台列表以便查看详细原因

    // --- 创建悬浮按钮 ---
    const button = document.createElement('button');
    button.id = 'linkCheckerButton';
    button.innerHTML = '🔗';
    button.title = '点击开始检测页面链接';
    document.body.appendChild(button);

    // --- 延迟函数 ---
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // --- Toastify 通知函数 ---
    function showToast(text, type = 'info', duration = 3000) {
        let backgroundColor;
        switch(type) {
            case 'success': backgroundColor = "linear-gradient(to right, #00b09b, #96c93d)"; break;
            case 'error': backgroundColor = "linear-gradient(to right, #ff5f6d, #ffc371)"; break;
            case 'warning': backgroundColor = "linear-gradient(to right, #f7b733, #fc4a1a)"; break;
            default: backgroundColor = "#0dcaf0"; // 默认为蓝色信息
        }
        Toastify({
            text: text,
            duration: duration,
            gravity: "bottom",
            position: "center",
            style: { background: backgroundColor },
            stopOnFocus: true,
        }).showToast();
    }

    // --- 链接检测函数 (带重试) ---
    async function checkLink(linkElement, retryCount = 0) {
        const url = linkElement.href;

        if (retryCount === 0) {
             if (!url || !url.startsWith('http')) {
                return { element: linkElement, status: 'skipped', url: url, message: '非HTTP(S)链接' };
            }
            linkElement.classList.add(CHECKED_LINK_CLASS);
        }

        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'HEAD',
                url: url,
                timeout: CHECK_TIMEOUT,
                onload: function(response) {
                    if (response.status >= 200 && response.status < 400) { // 2xx 和 3xx 都算 OK
                        resolve({ element: linkElement, status: 'ok', url: url, statusCode: response.status });
                    } else {
                        resolve({ element: linkElement, status: 'broken', url: url, statusCode: response.status, message: `访问错误 (${response.status})` });
                    }
                },
                onerror: async function(response) {
                    if (retryCount < MAX_RETRIES) {
                        console.warn(`[链接检测] 网络错误: ${url} (尝试 ${retryCount + 1}/${MAX_RETRIES}), 稍后重试...`);
                        await delay(RETRY_DELAY);
                        resolve(await checkLink(linkElement, retryCount + 1));
                    } else {
                         resolve({ element: linkElement, status: 'broken', url: url, message: `网络错误 (${response.error || 'Unknown Error'}) (重试 ${MAX_RETRIES} 次后失败)` });
                    }
                },
                ontimeout: async function() {
                    if (retryCount < MAX_RETRIES) {
                        console.warn(`[链接检测] 超时: ${url} (尝试 ${retryCount + 1}/${MAX_RETRIES}), 稍后重试...`);
                        await delay(RETRY_DELAY);
                        resolve(await checkLink(linkElement, retryCount + 1));
                    } else {
                        resolve({ element: linkElement, status: 'broken', url: url, message: `请求超时 (重试 ${MAX_RETRIES} 次后失败)` });
                    }
                }
            });
        });
    }

    // --- 处理检测结果 ---
    function handleResult(result) {
        checkedLinks++;
        const reason = result.message || `状态码 ${result.statusCode}`; // 统一获取原因

        if (result.status === 'broken') {
            brokenLinksCount++;
            brokenLinkDetailsForConsole.push({ url: result.url, reason: reason }); // 仍然记录到控制台列表
            result.element.classList.add(BROKEN_LINK_CLASS); // 添加样式类，触发CSS标记
            result.element.title = `链接失效: ${reason}\nURL: ${result.url}`; // 更新悬停提示
            console.warn(`[链接检测] 失效 (${reason}): ${result.url}`);
            showToast(`失效: ${result.url.substring(0,50)}... (${reason})`, 'error', 5000);
        } else if (result.status === 'ok') {
            console.log(`[链接检测] 正常 (${result.statusCode || 'OK'}): ${result.url}`);
            // 可选：清除之前的 title (如果之前可能是 broken)
            if (result.element.title.startsWith('链接失效:')) {
                 result.element.title = ''; // 或者设置为 '链接有效'
            }
        } else if (result.status === 'skipped') {
            console.log(`[链接检测] 跳过 (${result.message}): ${result.url || '空链接'}`);
        }

        // 更新进度显示
        const progressText = `检测中: ${checkedLinks}/${totalLinks} (失效: ${brokenLinksCount})`;
        button.innerHTML = totalLinks > 0 ? `${Math.round((checkedLinks / totalLinks) * 100)}%` : '...';
        button.title = progressText;

        // 从活动检查中移除，并尝试启动下一个
        activeChecks--;
        processQueue();

        // 检查是否全部完成
        if (checkedLinks === totalLinks) {
            finishCheck();
        }
    }

    // --- 队列处理 ---
    function processQueue() {
        while (activeChecks < CONCURRENT_CHECKS && linkQueue.length > 0) {
            activeChecks++;
            const linkElement = linkQueue.shift();
            checkLink(linkElement).then(handleResult);
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
        brokenLinkDetailsForConsole = []; // 清空控制台列表

        // 清除之前的标记 (重要：要同时移除 class 和 title)
        document.querySelectorAll(`a.${BROKEN_LINK_CLASS}`).forEach(el => {
             el.classList.remove(BROKEN_LINK_CLASS);
             if (el.title.startsWith('链接失效:')) {
                 el.title = ''; // 清除失效提示
             }
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
            if (!link.href || link.getAttribute('href').startsWith('#') || !link.protocol.startsWith('http')) {
                 // console.log(`[链接检测] 过滤: ${link.href || link.getAttribute('href')}`);
                 return;
            }
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
            // 更新通知，强调页面标记
            summary += ` ${brokenLinksCount} 个失效链接已在页面上用 ❌ 标记。`;
            showToast(summary, 'error', 10000);

            // 仍然在控制台打印详细列表，作为补充信息
            console.warn("----------------------------------------");
            console.warn(`检测到 ${brokenLinksCount} 个失效链接 (详细原因):`);
            console.group("失效链接详细列表 (控制台)");
            brokenLinkDetailsForConsole.forEach(detail => {
                console.warn(`- ${detail.url} (原因: ${detail.reason})`);
            });
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

    // --- 添加按钮点击事件 ---
    button.addEventListener('click', startCheck);

    console.log('[链接检测器] 脚本已加载 (v1.3 页面标记失效链接)，点击右下角悬浮按钮开始检测。');

})();
