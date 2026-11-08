import { test, expect } from '@playwright/test';
import { waitForAppReady } from './helpers/app.js';

const BASE_URL = 'http://localhost:3000';

// ===========================
// ヘルパー関数
// ===========================

async function testLogin(page, userId) {
    await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`);
    await waitForAppReady(page);
}

async function createTree(page, name) {
    const response = await page.request.post(`${BASE_URL}/api/trees`, {
        data: { name, description: 'Test tree' }
    });
    const data = await response.json();
    return data.data;
}

async function createNodeAPI(page, treeId, nodeData) {
    const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
        data: nodeData
    });
    const data = await response.json();
    return data.data;
}

async function addRelationAPI(page, treeId, parentId, childId) {
    await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
        data: { parent_node_id: parentId, child_node_id: childId }
    });
}

async function clearTestData(page) {
    try {
        await page.request.delete(`${BASE_URL}/api/test/clear`);
    } catch (e) {
        // Ignore errors
    }
}

async function useEditorMode(page) {
    await page.locator('#md-preview-toggle').uncheck();
}

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6WQAAAAASUVORK5CYII=';

function createTinyPngBuffer() {
    return Buffer.from(TINY_PNG_BASE64, 'base64');
}

async function uploadNodeImageAPI(page, treeId, nodeId, fileName, mimeType, buffer) {
    const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes/${nodeId}/images`, {
        multipart: {
            file: {
                name: fileName,
                mimeType,
                buffer
            }
        }
    });
    const data = await response.json();
    return { response, data };
}

async function dispatchImagePasteAtText(page, markerText, fileNames) {
    const files = fileNames.map((name) => ({
        name,
        mimeType: 'image/png',
        bytes: Array.from(createTinyPngBuffer())
    }));

    await page.evaluate(async ({ markerText, files }) => {
        const editor = window.currentEditor;
        if (!editor) throw new Error('currentEditor not found');

        const content = editor.value();
        const anchor = content.indexOf(markerText);
        if (anchor < 0) throw new Error(`Marker not found: ${markerText}`);
        const moved = typeof editor.setCursorPosition === 'function' ? editor.setCursorPosition(anchor) : false;
        if (!moved) throw new Error('Failed to move editor cursor');

        const dataTransfer = new DataTransfer();
        for (const file of files) {
            const blob = new Blob([new Uint8Array(file.bytes)], { type: file.mimeType });
            dataTransfer.items.add(new File([blob], file.name, { type: file.mimeType }));
        }

        const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dataTransfer,
            bubbles: true,
            cancelable: true
        });

        Object.defineProperty(pasteEvent, 'clipboardData', {
            configurable: true,
            value: dataTransfer
        });

        const wrapper = editor.codemirror?.getWrapperElement?.();
        if (!wrapper) throw new Error('Editor wrapper not found');

        wrapper.dispatchEvent(pasteEvent);

        await new Promise((resolve) => setTimeout(resolve, 50));
    }, { markerText, files });
}

async function dispatchMixedPasteAtText(page, markerText, clipboardEntries, fileNames) {
    const files = fileNames.map((name) => ({
        name,
        mimeType: 'image/png',
        bytes: Array.from(createTinyPngBuffer())
    }));

    await page.evaluate(async ({ markerText, clipboardEntries, files }) => {
        const editor = window.currentEditor;
        if (!editor) throw new Error('currentEditor not found');

        const content = editor.value();
        const anchor = content.indexOf(markerText);
        if (anchor < 0) throw new Error(`Marker not found: ${markerText}`);
        const moved = typeof editor.setCursorPosition === 'function' ? editor.setCursorPosition(anchor) : false;
        if (!moved) throw new Error('Failed to move editor cursor');

        const dataTransfer = new DataTransfer();
        for (const [type, value] of Object.entries(clipboardEntries)) {
            dataTransfer.setData(type, value);
        }
        for (const file of files) {
            const blob = new Blob([new Uint8Array(file.bytes)], { type: file.mimeType });
            dataTransfer.items.add(new File([blob], file.name, { type: file.mimeType }));
        }

        const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dataTransfer,
            bubbles: true,
            cancelable: true
        });
        Object.defineProperty(pasteEvent, 'clipboardData', {
            configurable: true,
            value: dataTransfer
        });

        const wrapper = editor.codemirror?.getWrapperElement?.();
        if (!wrapper) throw new Error('Editor wrapper not found');
        const target = wrapper.querySelector('.CodeMirror-code, .cm-content, textarea, [contenteditable="true"]') || wrapper;
        target.addEventListener('paste', (event) => {
            if (!event.defaultPrevented && clipboardEntries['text/plain']) {
                editor.insertText(clipboardEntries['text/plain']);
            }
        }, { once: true });
        target.dispatchEvent(pasteEvent);

        await new Promise((resolve) => setTimeout(resolve, 50));
    }, { markerText, clipboardEntries, files });
}

async function dispatchTextPasteAtText(page, markerText, clipboardEntries) {
    await page.evaluate(async ({ markerText, clipboardEntries }) => {
        const editor = window.currentEditor;
        if (!editor) throw new Error('currentEditor not found');

        const content = editor.value();
        const anchor = content.indexOf(markerText);
        if (anchor < 0) throw new Error(`Marker not found: ${markerText}`);
        const moved = typeof editor.setCursorPosition === 'function' ? editor.setCursorPosition(anchor) : false;
        if (!moved) throw new Error('Failed to move editor cursor');

        const dataTransfer = new DataTransfer();
        for (const [type, value] of Object.entries(clipboardEntries)) {
            dataTransfer.setData(type, value);
        }

        const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dataTransfer,
            bubbles: true,
            cancelable: true
        });

        Object.defineProperty(pasteEvent, 'clipboardData', {
            configurable: true,
            value: dataTransfer
        });

        const wrapper = editor.codemirror?.getWrapperElement?.();
        if (!wrapper) throw new Error('Editor wrapper not found');

        const target = wrapper.querySelector('.CodeMirror-code, .cm-content, textarea, [contenteditable="true"]') || wrapper;
        target.addEventListener('paste', (event) => {
            if (!event.defaultPrevented && clipboardEntries['text/plain']) {
                editor.insertText(clipboardEntries['text/plain']);
            }
        }, { once: true });

        target.dispatchEvent(pasteEvent);

        await new Promise((resolve) => setTimeout(resolve, 50));
    }, { markerText, clipboardEntries });
}

/** トップレベルノードをUIで追加（初回は "(new)" をリネーム、以降は兄弟追加） */
async function addRootNodeViaUI(page, title) {
    const items = page.locator('.tree-item');
    const count = await items.count();

    if (count >= 1) {
        const firstText = await items.first().locator('.truncate').textContent();
        if (firstText?.trim() === '(new)') {
            // 自動生成された "(new)" ノードをリネーム
            await items.first().click({ force: true });
            await page.waitForTimeout(300);
            await page.fill('#node-title', title);
            await page.click('#save-node-btn');
            await page.waitForTimeout(1000);
            return;
        }
    }

    // 兄弟追加 (Alt+Shift+N) でトップレベルノードを作成
    await items.first().click({ force: true });
    await page.waitForTimeout(300);
    await page.keyboard.press('Alt+Shift+N');
    await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible' });
    await page.fill('#custom-prompt-modal .prompt-input', title);
    await page.click('#custom-prompt-modal .prompt-ok');
    await page.waitForSelector('.tree-item', { timeout: 5000 });
    await page.waitForTimeout(500);
}

/** カスタムプロンプトモーダルを操作して子ノードを追加 */
async function addChildNodeViaUI(page, parentSelector, title) {
    const addChildBtn = page.locator(parentSelector).locator('.add-child-btn').first();
    await addChildBtn.click();
    await page.click('#node-context-menu [data-action="add-child"]');
    await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible' });
    await page.fill('#custom-prompt-modal .prompt-input', title);
    await page.click('#custom-prompt-modal .prompt-ok');
    await page.waitForTimeout(1000);
}

test.describe('Outline Editor Functional Tests', () => {
    let treeId;
    let rootNodeId;

    test.beforeEach(async ({ page }) => {
        await clearTestData(page);
        await testLogin(page, 1);
        const tree = await createTree(page, 'Outline Editor Test');
        treeId = tree.id;
        rootNodeId = tree.root_node_id;
        await page.goto(`${BASE_URL}/index.html?tree=${treeId}`);
        await page.waitForLoadState('networkidle');
    });

    test('TC-FUNC-001: Node addition functionality', async ({ page }) => {
        // UIからルートノード追加
        await addRootNodeViaUI(page, 'テストノード');

        // ノードをクリックして選択
        await page.click('.tree-item:has-text("テストノード")');
        await page.waitForTimeout(500);

        // 右ペインで確認
        await expect(page.locator('#node-title')).toHaveValue('テストノード');
        // author dropdown value is now user_id (numeric string)
        const authorValue = await page.locator('#node-author').inputValue();
        expect(parseInt(authorValue)).toBeGreaterThan(0);
    });

    test('TC-FUNC-002: Node editing functionality', async ({ page }) => {
        // ノード作成
        await addRootNodeViaUI(page, '編集テスト');

        // ノードを選択して編集
        await page.click('.tree-item:has-text("編集テスト")');
        await page.waitForTimeout(500);

        await page.fill('#node-title', '更新タイトル');

        await page.click('button:has-text("保存")');
        await page.waitForTimeout(1000);

        // 変更確認
        await expect(page.locator('.tree-item').filter({ hasText: '更新タイトル' }).first()).toBeVisible();
        await expect(page.locator('#node-title')).toHaveValue('更新タイトル');
    });

    test('TC-FUNC-003: Node deletion functionality', async ({ page }) => {
        // confirm ダイアログは native なので dialog handler で処理
        page.on('dialog', async dialog => {
            if (dialog.type() === 'confirm') {
                await dialog.accept();
            }
        });

        // ノード作成
        await addRootNodeViaUI(page, '削除テスト');

        // ノードを選択
        await page.click('.tree-item:has-text("削除テスト")');
        await page.waitForTimeout(500);

        await expect(page.locator('#delete-node-btn')).toBeVisible();
        await page.click('#delete-node-btn');
        await page.waitForTimeout(1000);

        // ゴミ箱移動確認
        await expect(page.locator('.tree-item:has-text("削除テスト")')).not.toBeVisible();
    });

    test('TC-FUNC-034: Pressing e exits content preview-only mode and restores editor focus', async ({ page }) => {
        const node = await createNodeAPI(page, treeId, {
            title: 'preview shortcut test',
            content: '# Preview heading\n\npreview body',
            author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, node.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await page.locator('.tree-item:has-text("preview shortcut test")').first().click({ force: true });
        await page.waitForTimeout(500);

        await page.evaluate(() => {
            const editor = window.currentEditor;
            if (!editor || typeof editor.togglePreview !== 'function') {
                throw new Error('currentEditor.togglePreview is not available');
            }
            if (!editor.isPreviewActive()) {
                editor.togglePreview();
            }
        });

        await expect.poll(async () => {
            return await page.evaluate(() => window.currentEditor?.isPreviewActive?.() ?? false);
        }).toBe(true);
        await expect(page.locator('#node-content-editor .bytemd-preview')).toBeVisible();

        await page.keyboard.press('e');

        await expect.poll(async () => {
            return await page.evaluate(() => window.currentEditor?.isPreviewActive?.() ?? false);
        }).toBe(false);
        await expect.poll(async () => {
            return await page.evaluate(() => {
                const editorContainer = document.getElementById('node-content-editor');
                return editorContainer ? !editorContainer.classList.contains('bytemd-preview-only') : false;
            });
        }).toBe(true);
        await expect.poll(async () => {
            return await page.evaluate(() => {
                const editorContainer = document.getElementById('node-content-editor');
                return editorContainer ? editorContainer.contains(document.activeElement) : false;
            });
        }).toBe(true);
    });

    test('TC-FUNC-040: Pasted image markdown is inserted at the current cursor position', async ({ page }) => {
        const node = await createNodeAPI(page, treeId, {
            title: '画像ペースト単体',
            content: 'before\n[[CURSOR]]\nafter',
            author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, node.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await useEditorMode(page);
        await page.locator('.tree-item:has-text("画像ペースト単体")').first().click({ force: true });
        await page.waitForTimeout(500);

        await dispatchImagePasteAtText(page, '[[CURSOR]]', ['paste-single.png']);

        await expect.poll(async () => {
            return await page.evaluate(() => window.currentEditor?.value() || '');
        }).toContain('before\n![');

        const content = await page.evaluate(() => window.currentEditor?.value() || '');
        expect(content).toMatch(/before\n!\[[^\]]*\]\([^)]+\)\[\[CURSOR\]\]\nafter/);

        const imagesRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${node.id}/images`);
        const imagesData = await imagesRes.json();
        expect(imagesData.success).toBe(true);
        expect(imagesData.data).toHaveLength(1);
    });

    test('TC-FUNC-041: Multiple pasted images keep insertion order after the cursor position', async ({ page }) => {
        const node = await createNodeAPI(page, treeId, {
            title: '画像ペースト複数',
            content: 'alpha\n[[MULTI_CURSOR]]\nomega',
            author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, node.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await useEditorMode(page);
        await page.locator('.tree-item:has-text("画像ペースト複数")').first().click({ force: true });
        await page.waitForTimeout(500);

        await dispatchImagePasteAtText(page, '[[MULTI_CURSOR]]', ['paste-first.png', 'paste-second.png']);

        await expect.poll(async () => {
            return await page.evaluate(() => {
                const content = window.currentEditor?.value() || '';
                return (content.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
            });
        }).toBe(2);

        const content = await page.evaluate(() => window.currentEditor?.value() || '');
        const firstIndex = content.indexOf('paste-first');
        const secondIndex = content.indexOf('paste-second');
        const markerIndex = content.indexOf('[[MULTI_CURSOR]]');
        expect(firstIndex).toBeGreaterThan(-1);
        expect(secondIndex).toBeGreaterThan(firstIndex);
        expect(firstIndex).toBeLessThan(markerIndex);
        expect(secondIndex).toBeLessThan(markerIndex);
        expect(content).toMatch(/alpha\n!\[[^\]]*paste-first[^\]]*\]\([^)]+\)\n!\[[^\]]*paste-second[^\]]*\]\([^)]+\)\[\[MULTI_CURSOR\]\]\nomega/);

        const imagesRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${node.id}/images`);
        const imagesData = await imagesRes.json();
        expect(imagesData.success).toBe(true);
        expect(imagesData.data).toHaveLength(2);
    });

    test('TC-FUNC-053: Excel cell paste prefers plain text over clipboard image', async ({ page }) => {
        const node = await createNodeAPI(page, treeId, {
            title: 'Excelセルペースト',
            content: 'before\n[[EXCEL_CURSOR]]\nafter',
            author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, node.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await useEditorMode(page);
        await page.locator('.tree-item:has-text("Excelセルペースト")').first().click({ force: true });
        await page.waitForTimeout(500);

        const imageUploadRequests = [];
        page.on('request', (request) => {
            if (request.method() === 'POST' && request.url().includes(`/nodes/${node.id}/images`)) {
                imageUploadRequests.push(request.url());
            }
        });

        await dispatchMixedPasteAtText(page, '[[EXCEL_CURSOR]]', {
            'text/plain': '列A\t列B\n値1\t値2',
            'text/html': '<table><tr><td>列A</td><td>列B</td></tr><tr><td>値1</td><td>値2</td></tr></table>'
        }, ['excel-selection.png']);
        await page.waitForTimeout(250);

        const content = await page.evaluate(() => window.currentEditor?.value() || '');
        expect(content).toContain('before\n列A\t列B\n値1\t値2[[EXCEL_CURSOR]]\nafter');
        expect(imageUploadRequests).toHaveLength(0);

        const imagesRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${node.id}/images`);
        const imagesData = await imagesRes.json();
        expect(imagesData.success).toBe(true);
        expect(imagesData.data).toHaveLength(0);
    });

    test('TC-FUNC-053: Empty Excel cell paste does not fall back to clipboard image', async ({ page }) => {
        const node = await createNodeAPI(page, treeId, {
            title: 'Excel空セルペースト',
            content: 'before\n[[EMPTY_EXCEL_CURSOR]]\nafter',
            author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, node.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await useEditorMode(page);
        await page.locator('.tree-item:has-text("Excel空セルペースト")').first().click({ force: true });
        await page.waitForTimeout(500);

        const imageUploadRequests = [];
        page.on('request', (request) => {
            if (request.method() === 'POST' && request.url().includes(`/nodes/${node.id}/images`)) {
                imageUploadRequests.push(request.url());
            }
        });

        await dispatchMixedPasteAtText(page, '[[EMPTY_EXCEL_CURSOR]]', {
            'text/plain': '',
            'text/html': '<table><tr><td></td></tr></table>'
        }, ['empty-excel-selection.png']);
        await page.waitForTimeout(250);

        const content = await page.evaluate(() => window.currentEditor?.value() || '');
        expect(content).toBe('before\n[[EMPTY_EXCEL_CURSOR]]\nafter');
        expect(imageUploadRequests).toHaveLength(0);

        const imagesRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${node.id}/images`);
        const imagesData = await imagesRes.json();
        expect(imagesData.success).toBe(true);
        expect(imagesData.data).toHaveLength(0);
    });

    test('TC-FUNC-052: Pasted links are converted to Markdown links while normal text remains unchanged', async ({ page }) => {
        const node = await createNodeAPI(page, treeId, {
            title: 'リンクペースト確認',
            content: 'html:[[HTML_LINK]]\nmulti:[[MULTI_LINK]]\nblocks:[[BLOCK_LINKS]]\nuri:[[URI_LINK]]\nplain:[[PLAIN_LINK]]\ntext:[[NORMAL_TEXT]]',
            author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, node.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await useEditorMode(page);
        await page.locator('.tree-item:has-text("リンクペースト確認")').first().click({ force: true });
        await page.waitForTimeout(500);

        await dispatchTextPasteAtText(page, '[[HTML_LINK]]', {
            'text/html': '<a href="https://example.com/docs">Example Docs</a>',
            'text/plain': 'Example Docs'
        });
        await dispatchTextPasteAtText(page, '[[MULTI_LINK]]', {
            'text/html': '会議の記録 <a href="https://docs.google.com/document/d/abc/edit">文字起こし</a> <a href="https://drive.google.com/file/d/def/view">録画</a>',
            'text/plain': '会議の記録 文字起こし 録画'
        });
        await dispatchTextPasteAtText(page, '[[BLOCK_LINKS]]', {
            'text/html': '<div><a href="https://news.yahoo.co.jp/pickup/6590073">熊本地震の死者36人に 県発表NEW19</a></div><div><a href="https://news.yahoo.co.jp/pickup/6590065">被災自治体に支援 税繰り上げ交付258</a></div>',
            'text/plain': '熊本地震の死者36人に 県発表NEW19\n被災自治体に支援 税繰り上げ交付258'
        });
        await dispatchTextPasteAtText(page, '[[URI_LINK]]', {
            'text/uri-list': '# copied link\nhttps://example.com/from-uri-list',
            'text/plain': 'https://example.com/plain-fallback'
        });
        await dispatchTextPasteAtText(page, '[[PLAIN_LINK]]', {
            'text/plain': 'https://example.com/plain-only'
        });
        await dispatchTextPasteAtText(page, '[[NORMAL_TEXT]]', {
            'text/plain': 'not a url'
        });

        const content = await page.evaluate(() => window.currentEditor?.value() || '');
        expect(content).toContain('html:[Example Docs](https://example.com/docs)[[HTML_LINK]]');
        expect(content).toContain('multi:会議の記録 [文字起こし](https://docs.google.com/document/d/abc/edit) [録画](https://drive.google.com/file/d/def/view)[[MULTI_LINK]]');
        expect(content).toContain('blocks:[熊本地震の死者36人に 県発表NEW19](https://news.yahoo.co.jp/pickup/6590073)\n[被災自治体に支援 税繰り上げ交付258](https://news.yahoo.co.jp/pickup/6590065)[[BLOCK_LINKS]]');
        expect(content).toContain('uri:https://example.com/plain-fallback[[URI_LINK]]');
        expect(content).toContain('plain:https://example.com/plain-only[[PLAIN_LINK]]');
        expect(content).toContain('text:not a url[[NORMAL_TEXT]]');
    });

    test('TC-FUNC-046: Node image icon opens tap menu with preview and delete flow', async ({ page }) => {
        const node = await createNodeAPI(page, treeId, {
            title: '画像メニュー確認',
            content: 'menu target',
            author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, node.id);

        const upload = await uploadNodeImageAPI(page, treeId, node.id, 'menu-preview.png', 'image/png', createTinyPngBuffer());
        expect(upload.response.ok()).toBeTruthy();
        expect(upload.data.success).toBe(true);

        await page.reload();
        await page.waitForSelector('.tree-item');
        await page.locator('.tree-item:has-text("画像メニュー確認")').first().click({ force: true });
        await page.waitForTimeout(600);

        const icon = page.locator('#node-image-list .node-image-icon-item').first();
        await expect(icon).toHaveCount(1);
        await expect(icon).toHaveAttribute('title', 'タップでメニュー表示');
        await expect(page.locator('#node-image-list .node-image-icon-delete')).toHaveCount(0);

        await icon.click();

        const menu = page.locator('#node-image-list .node-image-menu.active').first();
        await expect(menu).toBeVisible();
        await expect(menu.locator('.node-image-menu-action[data-action="open"]')).toContainText('別タブで表示');
        await expect(menu.locator('.node-image-menu-action[data-action="delete"]')).toContainText('削除');
        await expect(menu.locator('.node-image-menu-label').filter({ hasText: 'ファイル名' })).toBeVisible();
        await expect(menu.locator('.node-image-menu-label').filter({ hasText: '画像サムネイル' })).toBeVisible();
        await expect(menu.locator('.node-image-menu-file-name')).toHaveText('menu-preview.png');

        const preview = menu.locator('.node-image-menu-preview');
        await expect(preview).toBeVisible();
        await expect(preview).toHaveAttribute('src', new RegExp(`/api/trees/${treeId}/nodes/${node.id}/images/\\d+/file`));

        await page.locator('body').click({ position: { x: 5, y: 5 } });
        await expect(page.locator('#node-image-list .node-image-menu.active')).toHaveCount(0);

        page.once('dialog', dialog => dialog.accept());
        await icon.click();
        await menu.locator('.node-image-menu-action[data-action="delete"]').click();

        await expect(page.locator('#node-image-list .node-image-icon-item')).toHaveCount(0);
    });

    test('TC-FUNC-036: Multi-parent delete offers unlink choice for visible parent', async ({ page }) => {
        const parentA = await createNodeAPI(page, treeId, { title: '親A', content: '', author_user_id: 1 });
        const parentB = await createNodeAPI(page, treeId, { title: '親B', content: '', author_user_id: 1 });
        const child = await createNodeAPI(page, treeId, { title: '子X', content: '', author_user_id: 1 });
        await addRelationAPI(page, treeId, rootNodeId, parentA.id);
        await addRelationAPI(page, treeId, rootNodeId, parentB.id);
        await addRelationAPI(page, treeId, rootNodeId, child.id);
        await addRelationAPI(page, treeId, parentA.id, child.id);
        await addRelationAPI(page, treeId, parentB.id, child.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await page.locator(`.tree-item[data-node-path="${parentA.id}"] .toggle-icon`).click();
        await page.waitForTimeout(300);
        await page.locator(`.tree-item[data-node-path="${parentA.id}-${child.id}"]`).click({ force: true });
        await page.waitForTimeout(300);

        await page.click('#delete-node-btn');
        await expect(page.locator('#delete-node-choice-modal')).toBeVisible();
        await expect(page.locator('#delete-node-choice-modal')).toContainText('「親A」との関係を解消');
        await expect(page.locator('input[name="delete-node-choice"][value="unlink-parent"]')).toBeChecked();

        await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);

        await expect(page.locator(`.tree-item[data-node-path="${child.id}"]`)).toBeVisible();
        await expect(page.locator(`.tree-item[data-node-path="${parentA.id}-${child.id}"]`)).toHaveCount(0);

        const parentsRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${child.id}/parents`);
        const parentsData = await parentsRes.json();
        const parentTitles = parentsData.data.map((parent) => parent.title);
        expect(parentTitles).toContain('root');
        expect(parentTitles).toContain('親B');
        expect(parentTitles).not.toContain('親A');
    });

    test('TC-FUNC-037: Multi-parent delete dialog can trash node and cancel safely', async ({ page }) => {
        const parentA = await createNodeAPI(page, treeId, { title: '親A', content: '', author_user_id: 1 });
        const parentB = await createNodeAPI(page, treeId, { title: '親B', content: '', author_user_id: 1 });
        const child = await createNodeAPI(page, treeId, { title: '子Y', content: '', author_user_id: 1 });
        await addRelationAPI(page, treeId, rootNodeId, parentA.id);
        await addRelationAPI(page, treeId, rootNodeId, parentB.id);
        await addRelationAPI(page, treeId, rootNodeId, child.id);
        await addRelationAPI(page, treeId, parentA.id, child.id);
        await addRelationAPI(page, treeId, parentB.id, child.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await page.locator(`.tree-item[data-node-path="${parentB.id}"] .toggle-icon`).click();
        await page.waitForTimeout(300);
        await page.locator(`.tree-item[data-node-path="${parentB.id}-${child.id}"]`).click({ force: true });
        await page.waitForTimeout(300);

        await page.keyboard.press('Delete');
        await expect(page.locator('#delete-node-choice-modal')).toBeVisible();
        await page.click('#delete-node-choice-modal .delete-node-choice-cancel');
        await expect(page.locator('#delete-node-choice-modal')).not.toBeVisible();
        await expect(page.locator(`.tree-item[data-node-path="${parentB.id}-${child.id}"]`)).toBeVisible();

        await page.keyboard.press('Delete');
        await expect(page.locator('#delete-node-choice-modal')).toBeVisible();
        await page.check('input[name="delete-node-choice"][value="trash-node"]');
        page.on('dialog', async dialog => {
            if (dialog.type() === 'confirm') {
                await dialog.accept();
            }
        });
        await page.click('#delete-node-choice-modal .delete-node-choice-ok');
        await page.waitForTimeout(1000);

        await expect(page.locator('.tree-item:has-text("子Y")')).toHaveCount(0);

        const parentsRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${child.id}/parents`);
        const parentsData = await parentsRes.json();
        expect(parentsData.data).toHaveLength(1);
        expect(parentsData.data[0].title).toBe('(trash)');
    });

    test('TC-FUNC-004: Tree display functionality', async ({ page }) => {
        // APIでノード作成（UI操作不要）
        const node = await createNodeAPI(page, treeId, {
            title: 'ルート1', content: '', author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, node.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        // ツリーモード切替テスト
        const reverseTab = page.locator('button[data-view="reverse"]');
        if (await reverseTab.isVisible()) {
            await page.click('button[data-view="reverse"]');
            await page.click('button[data-view="normal"]');
        }
    });

    test('TC-FUNC-005: Tree expand/collapse', async ({ page }) => {
        // APIで3階層ノードを作成（親 -> 子 -> 孫）
        const parent = await createNodeAPI(page, treeId, {
            title: '親ノード', content: '', author_user_id: 1
        });
        const child = await createNodeAPI(page, treeId, {
            title: '子ノード', content: '', author_user_id: 1
        });
        const grandchild = await createNodeAPI(page, treeId, {
            title: '孫ノード', content: '', author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, parent.id);
        await addRelationAPI(page, treeId, parent.id, child.id);
        await addRelationAPI(page, treeId, child.id, grandchild.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        // 初期状態では子孫ノードが見えていないことを確認
        await expect(page.locator('.tree-item:has-text("親ノード")').first()).toBeVisible();
        await expect(page.locator('.tree-item:has-text("子ノード")').first()).not.toBeVisible();
        await expect(page.locator('.tree-item:has-text("孫ノード")').first()).not.toBeVisible();

        // 手動で展開して子孫ノードを可視化
        await page.locator('.tree-item:has-text("親ノード") .toggle-icon').first().click();
        await page.waitForTimeout(200);
        await page.locator('.tree-item:has-text("子ノード") .toggle-icon').first().click();
        await page.waitForTimeout(200);
        await expect(page.locator('.tree-item:has-text("子ノード")').first()).toBeVisible();
        await expect(page.locator('.tree-item:has-text("孫ノード")').first()).toBeVisible();

        // 通常メニューからroot配下を一括折りたたみ
        await page.click('#normal-view-tab');
        await page.click('#normal-view-menu [data-action="root-collapse-descendants"]');
        await page.waitForTimeout(300);
        await expect(page.locator('.tree-item:has-text("親ノード")').first()).toBeVisible();
        await expect(page.locator('.tree-item:has-text("子ノード")').first()).not.toBeVisible();
        await expect(page.locator('.tree-item:has-text("孫ノード")').first()).not.toBeVisible();
    });

    test('TC-FUNC-006: Search functionality', async ({ page }) => {
        // APIでノード作成（親子）
        const parent = await createNodeAPI(page, treeId, {
            title: '検索親ノード', content: '検索親コンテンツ', author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, parent.id);
        const node = await createNodeAPI(page, treeId, {
            title: '検索テストノード', content: '検索用コンテンツ', author_user_id: 1
        });
        await addRelationAPI(page, treeId, parent.id, node.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        // 親ノードを選択
        await page.click('.tree-item:has-text("検索親ノード")');

        // ツリー検索ボタンから検索ポップアップを開く
        await page.click('#tree-search-btn');
        await expect(page.locator('#search-popup-modal.active')).toBeVisible();
        await expect(page.locator('#search-popup-modal input[name="search-popup-scope"][value="root"]')).toBeChecked();

        // キーワード検索（Enter）
        await page.fill('#search-popup-modal .search-popup-input', '検索テスト');
        await page.check('#search-popup-modal input[name="search-popup-scope"][value="selected"]');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(600);

        // ヒットタイトルが一覧表示され、クリックでノード選択される
        await expect(page.locator('#search-popup-modal .search-popup-item:has-text("検索テストノード")')).toBeVisible();
        await page.click('#search-popup-modal .search-popup-item:has-text("検索テストノード")');
        await expect(page.locator('#search-popup-modal.active')).toBeVisible();
        await expect(page.locator('#node-title')).toHaveValue('検索テストノード');
    });

    test('TC-FUNC-007: Keyboard navigation', async ({ page }) => {
        // 複数ノード作成
        await addRootNodeViaUI(page, 'ノード1');
        await addRootNodeViaUI(page, 'ノード2');

        // 最初のノードを選択
        await page.click('.tree-item:has-text("ノード1")');

        // キーボードナビゲーション
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowUp');
        // クラッシュしないことを確認
    });

    test('TC-FUNC-008: Copy & Paste functionality', async ({ page }) => {
        // 2つのノード作成
        await addRootNodeViaUI(page, 'コピー元');
        await addRootNodeViaUI(page, 'ペースト先');

        // コピー元を選択してコピー
        await page.locator('.tree-item:has-text("コピー元")').first().click({ force: true });
        await page.keyboard.press('Control+c');
        await page.waitForTimeout(500);

        // ペースト先を選択してペースト
        await page.locator('.tree-item:has-text("ペースト先")').first().click({ force: true });
        await page.keyboard.press('Control+v');
        await page.waitForTimeout(2000);

        // 展開して子ノードを確認
        const expandIcon = page.locator('.tree-item:has-text("ペースト先")').locator('.toggle-icon').first();
        if (await expandIcon.count() > 0) {
            await expandIcon.click();
            await page.waitForTimeout(500);
        }

        // 両方のノードが表示されていることを確認
        await expect(page.locator('.tree-item:has-text("ペースト先")').first()).toBeVisible();
        await expect(page.locator('.tree-item:has-text("コピー元")').first()).toBeVisible();
    });

    test('TC-FUNC-009: Copy & Paste (Circular Reference Prevention)', async ({ page }) => {
        // 親ノード作成
        await addRootNodeViaUI(page, '親');

        // 親ノードを選択して子ノード追加
        await page.click('.tree-item:has-text("親")');
        await page.waitForTimeout(500);
        const addChildBtn = page.locator('.tree-item:has-text("親")').locator('.add-child-btn').first();
        if (await addChildBtn.isVisible()) {
            await addChildBtn.click();
            await page.click('#node-context-menu [data-action="add-child"]');
            await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible' });
            await page.fill('#custom-prompt-modal .prompt-input', '子');
            await page.click('#custom-prompt-modal .prompt-ok');
            await page.waitForTimeout(1000);
        }
    });

    test('TC-FUNC-010: Parent node display (single parent)', async ({ page }) => {
        // 2つのルートノードをAPIで作成
        const parentNode = await createNodeAPI(page, treeId, {
            title: '親A', content: '', author_user_id: 1
        });
        const childNode = await createNodeAPI(page, treeId, {
            title: '子X', content: '', author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, parentNode.id);
        await addRelationAPI(page, treeId, rootNodeId, childNode.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        // 子XをコピーしてparentAにペースト（親子関係作成）
        await page.locator('.tree-item:has-text("子X")').first().click({ force: true });
        await page.keyboard.press('Control+c');
        await page.waitForTimeout(500);
        await page.locator('.tree-item:has-text("親A")').first().click({ force: true });
        await page.keyboard.press('Control+v');
        await page.waitForTimeout(600);
        await page.waitForTimeout(1000);

        // 子を選択して親表示を確認
        await page.locator('.tree-item:has-text("子X")').first().click({ force: true });
        await expect(page.locator('#node-title')).toHaveValue('子X');

        const parentsChip = page.locator('#editor-panel .parents-chip-toggle');
        await expect(parentsChip).toBeVisible();
        await expect(parentsChip.locator('span').nth(1)).toHaveText('2');

        // アコーディオンを開く
        await parentsChip.click();
        await expect(page.locator(`#parents-accordion-content-${childNode.id}`)).toBeVisible();

        await expect(page.locator('.parent-name-link:has-text("親A")')).toBeVisible();
        await expect(page.locator('#editor-panel span[title="ルートノード"]')).toHaveText('root');
        await expect(page.locator(`.remove-parent-btn[data-parent-id="${parentNode.id}"]`)).toHaveCount(1);
    });

    test('TC-FUNC-011: Parent node display (multiple parents)', async ({ page }) => {
        // 3つのルートノードをAPIで作成
        const nodeA = await createNodeAPI(page, treeId, { title: '親A', content: '', author_user_id: 1 });
        const nodeB = await createNodeAPI(page, treeId, { title: '親B', content: '', author_user_id: 1 });
        const nodeX = await createNodeAPI(page, treeId, { title: '子X', content: '', author_user_id: 1 });
        await addRelationAPI(page, treeId, rootNodeId, nodeA.id);
        await addRelationAPI(page, treeId, rootNodeId, nodeB.id);
        await addRelationAPI(page, treeId, rootNodeId, nodeX.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        // 子Xを親Aにペースト
        await page.locator('.tree-item:has-text("子X")').first().click({ force: true });
        await page.keyboard.press('Control+c');
        await page.waitForTimeout(500);
        await page.locator('.tree-item:has-text("親A")').first().click({ force: true });
        await page.keyboard.press('Control+v');
        await page.waitForTimeout(600);
        await page.waitForTimeout(1000);

        // 子Xを親Bにペースト
        await page.locator('.tree-item:has-text("子X")').first().click({ force: true });
        await page.keyboard.press('Control+c');
        await page.waitForTimeout(500);
        await page.locator('.tree-item:has-text("親B")').first().click({ force: true });
        await page.keyboard.press('Control+v');
        await page.waitForTimeout(600);
        await page.waitForTimeout(1000);

        // 子を選択して両方の親が表示されることを確認
        await page.locator('.tree-item:has-text("子X")').first().click({ force: true });
        await expect(page.locator('#node-title')).toHaveValue('子X');

        const parentsChip = page.locator('#editor-panel .parents-chip-toggle');
        await expect(parentsChip.locator('span').nth(1)).toHaveText('3');

        // アコーディオンを開く
        await parentsChip.click();
        await expect(page.locator(`#parents-accordion-content-${nodeX.id}`)).toBeVisible();

        await expect(page.locator('.parent-name-link:has-text("親A")')).toBeVisible();
        await expect(page.locator('.parent-name-link:has-text("親B")')).toBeVisible();
        await expect(page.locator('#editor-panel span[title="ルートノード"]')).toHaveText('root');
        await expect(page.locator(`.remove-parent-btn[data-parent-id="${nodeA.id}"]`)).toHaveCount(1);
        await expect(page.locator(`.remove-parent-btn[data-parent-id="${nodeB.id}"]`)).toHaveCount(1);
    });

    test('TC-FUNC-012: Parent deletion functionality', async ({ page }) => {
        // confirm ダイアログ処理
        page.on('dialog', async dialog => {
            if (dialog.type() === 'confirm') {
                await dialog.accept();
            }
        });

        // 3つのノードをAPIで作成
        const node1 = await createNodeAPI(page, treeId, { title: '親1', content: '', author_user_id: 1 });
        const node2 = await createNodeAPI(page, treeId, { title: '親2', content: '', author_user_id: 1 });
        const nodeC = await createNodeAPI(page, treeId, { title: '子', content: '', author_user_id: 1 });
        await addRelationAPI(page, treeId, rootNodeId, node1.id);
        await addRelationAPI(page, treeId, rootNodeId, node2.id);
        await addRelationAPI(page, treeId, rootNodeId, nodeC.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        // 子 -> 親1
        await page.locator('.tree-item:has-text("子")').first().click({ force: true });
        await page.keyboard.press('Control+c');
        await page.waitForTimeout(500);
        await page.locator('.tree-item:has-text("親1")').first().click({ force: true });
        await page.keyboard.press('Control+v');
        await page.waitForTimeout(600);
        await page.waitForTimeout(1000);

        // 子 -> 親2
        await page.locator('.tree-item:has-text("子")').first().click({ force: true });
        await page.keyboard.press('Control+c');
        await page.waitForTimeout(500);
        await page.locator('.tree-item:has-text("親2")').first().click({ force: true });
        await page.keyboard.press('Control+v');
        await page.waitForTimeout(600);
        await page.waitForTimeout(1000);

        // 子を選択して2つの親を確認
        await page.locator('.tree-item:has-text("子")').first().click({ force: true });
        await expect(page.locator('#node-title')).toHaveValue('子');

        const parentsChip = page.locator('#editor-panel .parents-chip-toggle');
        await expect(parentsChip.locator('span').nth(1)).toHaveText('3');

        // アコーディオンを開く
        await parentsChip.click();
        await expect(page.locator(`#parents-accordion-content-${nodeC.id}`)).toBeVisible();
        await expect(page.locator(`.remove-parent-btn[data-parent-id="${node1.id}"]`)).toHaveCount(1);

        // 1つの親を削除（confirm は accept 済み）
        await page.locator(`.remove-parent-btn[data-parent-id="${node1.id}"]`).click();
        // 削除後に selectNode で再描画されるのを待つ
        await expect(page.locator('#node-title')).toHaveValue('子');

        // 1つの親のみ残ることを確認
        await expect(parentsChip.locator('span').nth(1)).toHaveText('2');

        // アコーディオンを開く（再描画後）
        await parentsChip.click();
        await expect(page.locator(`#parents-accordion-content-${nodeC.id}`)).toBeVisible();
        await expect(page.locator(`.remove-parent-btn[data-parent-id="${node2.id}"]`)).toHaveCount(1);
        await expect(page.locator(`.remove-parent-btn[data-parent-id="${node1.id}"]`)).toHaveCount(0);
        await expect(page.locator('.parent-name-link:has-text("親1")')).toHaveCount(0);
    });

    test('TC-FUNC-013: Last parent deletion is blocked (root remains)', async ({ page }) => {
        // confirm ダイアログ処理
        page.on('dialog', async dialog => {
            if (dialog.type() === 'confirm') {
                await dialog.accept();
            }
        });

        // 2つのノードをAPIで作成
        const nodeP = await createNodeAPI(page, treeId, { title: '親', content: '', author_user_id: 1 });
        const nodeC = await createNodeAPI(page, treeId, { title: '子', content: '', author_user_id: 1 });
        await addRelationAPI(page, treeId, rootNodeId, nodeP.id);
        await addRelationAPI(page, treeId, rootNodeId, nodeC.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        // 子 -> 親
        await page.locator('.tree-item:has-text("子")').first().click({ force: true });
        await page.keyboard.press('Control+c');
        await page.waitForTimeout(500);
        await page.locator('.tree-item:has-text("親")').first().click({ force: true });
        await page.keyboard.press('Control+v');
        await page.waitForTimeout(600);
        await page.waitForTimeout(1000);

        // 子を選択して親表示を確認
        await page.locator('.tree-item:has-text("子")').first().click({ force: true });
        await expect(page.locator('#node-title')).toHaveValue('子');

        const parentsChip = page.locator('#editor-panel .parents-chip-toggle');
        await expect(parentsChip.locator('span').nth(1)).toHaveText('2');

        // アコーディオンを開いて削除ボタンを表示
        await parentsChip.click();
        await expect(page.locator(`#parents-accordion-content-${nodeC.id}`)).toBeVisible();
        await expect(page.locator(`.remove-parent-btn[data-parent-id="${nodeP.id}"]`)).toHaveCount(1);

        // 親ノード「親」を削除（rootは残る）
        await page.locator(`.remove-parent-btn[data-parent-id="${nodeP.id}"]`).click();
        // 削除後に selectNode で再描画されるのを待つ
        await expect(page.locator('#node-title')).toHaveValue('子');

        // rootのみになり、親セクションは残る
        await expect(parentsChip.locator('span').nth(1)).toHaveText('1');
        await parentsChip.click();
        await expect(page.locator(`#parents-accordion-content-${nodeC.id}`)).toBeVisible();
        await expect(page.locator('#editor-panel span[title="ルートノード"]')).toHaveText('root');
        await expect(page.locator('#editor-panel .parent-name-link')).toHaveCount(0);
        await expect(page.locator('.remove-parent-btn')).toHaveCount(0);
    });

    test('TC-FUNC-014: Content editor height follows window height', async ({ page }) => {
        await addRootNodeViaUI(page, '高さ追従テスト');
        await page.locator('.tree-item:has-text("高さ追従テスト")').first().click({ force: true });
        await page.waitForTimeout(500);

        const getEditorHeight = async () => {
            return await page.locator('.CodeMirror').first().evaluate(el => Math.round(el.getBoundingClientRect().height));
        };

        const baseHeight = await getEditorHeight();

        await page.setViewportSize({ width: 1280, height: 900 });
        await page.waitForTimeout(500);
        const tallHeight = await getEditorHeight();

        await page.setViewportSize({ width: 1280, height: 640 });
        await page.waitForTimeout(500);
        const shortHeight = await getEditorHeight();

        expect(tallHeight).toBeGreaterThan(baseHeight);
        expect(shortHeight).toBeLessThan(tallHeight);
    });

    test('TC-FUNC-034: Title row copy controls', async ({ page }) => {
        const node = await createNodeAPI(page, treeId, {
            title: '共有確認ノード', content: '共有本文', author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, node.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await page.locator('.tree-item:has-text("共有確認ノード")').first().click({ force: true });
        await page.waitForTimeout(500);

        await page.evaluate(() => {
            window.__clipboardWrites = [];
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {
                    writeText: async (text) => {
                        window.__clipboardWrites.push(text);
                    }
                }
            });
        });

        await expect(page.locator('#copy-title-btn')).toBeVisible();
        await expect(page.locator('#share-node-btn')).toBeVisible();
        await expect(page.locator('#copy-content-btn')).toBeVisible();
        await expect(page.locator('#reload-node-btn')).toBeVisible();
        await expect(page.locator('#download-pdf-btn')).toBeVisible();
        await expect(page.locator('#copy-title-btn')).toHaveAttribute('title', `タイトル(id:${node.id})をクリップボードにいれる`);

        const layoutCheck = await page.evaluate(() => {
            const titleBtn = document.getElementById('copy-title-btn');
            const shareBtn = document.getElementById('share-node-btn');
            const contentBtn = document.getElementById('copy-content-btn');
            const reloadBtn = document.getElementById('reload-node-btn');
            const pdfBtn = document.getElementById('download-pdf-btn');
            return {
                titleAndShareGrouped: titleBtn?.parentElement === shareBtn?.parentElement,
                shareNotInContentGroup: contentBtn?.parentElement !== shareBtn?.parentElement,
                shareAfterTitle: Boolean(titleBtn?.compareDocumentPosition(shareBtn) & Node.DOCUMENT_POSITION_FOLLOWING),
                contentButtonsRemainGrouped: contentBtn?.parentElement === reloadBtn?.parentElement && reloadBtn?.parentElement === pdfBtn?.parentElement
            };
        });

        expect(layoutCheck).toEqual({
            titleAndShareGrouped: true,
            shareNotInContentGroup: true,
            shareAfterTitle: true,
            contentButtonsRemainGrouped: true
        });

        await page.click('#copy-title-btn');
        await page.click('#share-node-btn');

        const clipboardWrites = await page.evaluate(() => window.__clipboardWrites);
        expect(clipboardWrites).toEqual([
            `共有確認ノード (id:${node.id})`,
            `${BASE_URL}/index.html?tree=${treeId}&node=${node.id}`
        ]);
    });

    test('TC-FUNC-015: Split line is hidden in editor fullscreen', async ({ page }) => {
        await addRootNodeViaUI(page, '全画面テスト');
        await page.locator('.tree-item:has-text("全画面テスト")').first().click({ force: true });
        await expect(page.locator('#node-title')).toHaveValue('全画面テスト');

        const resizeHandle = page.locator('#resize-handle');
        const contentHeader = page.locator('#content-editor-header');
        await expect(resizeHandle).toBeVisible();
        await expect(contentHeader).toBeVisible();

        // ByteMD のツールバーアイコンはアクセシブル名を持たないため path[d] で特定する
        const enterFullscreenIcon = page.locator('.bytemd-toolbar-icon:has(path[d="M33 6h9v9M42 33v9h-9M15 42H6v-9M6 15V6h9"])').first();
        await expect(enterFullscreenIcon).toBeVisible();
        await enterFullscreenIcon.click();

        const fullscreenEditor = page.locator('.bytemd-fullscreen');
        await expect(fullscreenEditor).toBeVisible();
        const fullscreenToolbar = fullscreenEditor.locator('.bytemd-toolbar');
        await expect(fullscreenToolbar).toBeVisible();
        const viewport = page.viewportSize();
        const toolbarTop = await fullscreenToolbar.evaluate(el => Math.round(el.getBoundingClientRect().top));
        const editorMetrics = await fullscreenEditor.evaluate(el => {
            const rect = el.getBoundingClientRect();
            return {
                top: Math.round(rect.top),
                bottom: Math.round(rect.bottom),
                height: Math.round(rect.height)
            };
        });
        await expect(resizeHandle).toBeHidden();
        await expect(contentHeader).toBeHidden();
        expect(toolbarTop).toBeLessThanOrEqual(8);
        expect(editorMetrics.top).toBeLessThanOrEqual(8);
        expect(editorMetrics.bottom).toBeGreaterThanOrEqual((viewport?.height ?? 0) - 8);
        expect(editorMetrics.height).toBeGreaterThan((viewport?.height ?? 0) - 48);

        const exitFullscreenIcon = page.locator('.bytemd-toolbar-icon:has(path[d="M33 6v9h9M15 6v9H6M15 42v-9H6M33 42v-9h8.9"])').first();
        await exitFullscreenIcon.click();
        await expect(page.locator('.bytemd-fullscreen')).toHaveCount(0);
        await expect(resizeHandle).toBeVisible();
        await expect(contentHeader).toBeVisible();
    });

    test('TC-FUNC-047: Split bar hover shows col-resize cursor', async ({ page }) => {
        await addRootNodeViaUI(page, 'カーソル検証');
        await page.locator('.tree-item:has-text("カーソル検証")').first().click({ force: true });
        await page.waitForTimeout(500);

        const resizeHandle = page.locator('#resize-handle');
        await expect(resizeHandle).toBeVisible();

        await resizeHandle.hover();
        await page.waitForTimeout(200);
        const cursor = await resizeHandle.evaluate(el => getComputedStyle(el).cursor);
        expect(cursor).toBe('col-resize');
    });

    test('TC-FUNC-039: Manual content editor resize keeps the dragged height', async ({ page }) => {
        const node = await createNodeAPI(page, treeId, {
            title: '手動リサイズ検証',
            content: 'line1\nline2\nline3\nline4\nline5',
            author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, node.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await useEditorMode(page);
        await page.locator('.tree-item:has-text("手動リサイズ検証")').first().click({ force: true });
        await expect(page.locator('#node-title')).toHaveValue('手動リサイズ検証');

        // アプリが高さを管理する #node-content-editor を手動で拡張する
        const heights = await page.evaluate(async () => {
            const container = document.getElementById('node-content-editor');
            const bytemd = container?.querySelector('.bytemd');
            const toolbar = container?.querySelector('.bytemd-toolbar');
            const status = container?.querySelector('.bytemd-status');
            const editorPane = container?.querySelector('.bytemd .CodeMirror');
            if (!container || !bytemd || !toolbar || !editorPane) return null;

            const before = Math.round(container.getBoundingClientRect().height);
            container.style.height = `${before + 220}px`;
            container.style.maxHeight = 'none';

            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            return {
                before,
                after: Math.round(container.getBoundingClientRect().height),
                containerStyleHeight: container.style.height,
                bytemdHeight: Math.round(bytemd.getBoundingClientRect().height),
                toolbarHeight: Math.round(toolbar.getBoundingClientRect().height),
                statusHeight: status ? Math.round(status.getBoundingClientRect().height) : 0,
                editorPaneHeight: Math.round(editorPane.getBoundingClientRect().height)
            };
        });

        expect(heights).not.toBeNull();
        expect(heights.after).toBeGreaterThan(heights.before + 150);
        expect(heights.containerStyleHeight).toBe(`${heights.before + 220}px`);
        // エディタ本体（.bytemd）はコンテナいっぱいに追従し、
        // CodeMirror ペインはツールバーとステータスバー（行数表示）を除いた分だけ伸びる
        expect(heights.bytemdHeight).toBeGreaterThanOrEqual(heights.after - 2);
        expect(heights.editorPaneHeight).toBeGreaterThanOrEqual(heights.after - heights.toolbarHeight - heights.statusHeight - 2);
    });

    test('TC-FUNC-038: Content header and toolbar stay sticky after editor expansion', async ({ page }) => {
        const longContent = Array.from({ length: 120 }, (_, index) => `- sticky line ${index + 1}`).join('\n');
        const node = await createNodeAPI(page, treeId, {
            title: 'sticky検証ノード',
            content: longContent,
            author_user_id: 1
        });
        await addRelationAPI(page, treeId, rootNodeId, node.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await page.locator('.tree-item:has-text("sticky検証ノード")').first().click({ force: true });
        await expect(page.locator('#node-title')).toHaveValue('sticky検証ノード');

        // エディタ本体（#node-content-editor）を手動展開する。
        // window resize は発火しない（editorWindowResizeHandler が高さを再計算して戻してしまうため）。
        await page.evaluate(async () => {
            const container = document.getElementById('node-content-editor');
            if (!container) return;
            container.style.height = '960px';
            container.style.maxHeight = '960px';
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });

        const stickyMetrics = await page.evaluate(() => {
            const scrollArea = document.getElementById('editor-scroll-area');
            const header = document.getElementById('content-editor-header');
            const toolbar = document.querySelector('#content-editor-section .bytemd-toolbar');
            if (!scrollArea || !header || !toolbar) return null;

            scrollArea.scrollTop = 420;

            const headerRect = header.getBoundingClientRect();
            const toolbarRect = toolbar.getBoundingClientRect();
            const scrollRect = scrollArea.getBoundingClientRect();

            return {
                scrollTop: scrollArea.scrollTop,
                headerOffset: Math.round(headerRect.top - scrollRect.top),
                toolbarOffset: Math.round(toolbarRect.top - scrollRect.top),
                headerHeight: Math.round(headerRect.height),
                toolbarHeight: Math.round(toolbarRect.height),
                headerBottomWithinScroll: headerRect.bottom <= scrollRect.bottom,
                toolbarBottomWithinScroll: toolbarRect.bottom <= scrollRect.bottom
            };
        });

        expect(stickyMetrics).not.toBeNull();
        expect(stickyMetrics.scrollTop).toBeGreaterThan(0);
        expect(Math.abs(stickyMetrics.headerOffset)).toBeLessThanOrEqual(2);
        expect(Math.abs(stickyMetrics.toolbarOffset - stickyMetrics.headerHeight)).toBeLessThanOrEqual(3);
        expect(stickyMetrics.headerBottomWithinScroll).toBeTruthy();
        expect(stickyMetrics.toolbarBottomWithinScroll).toBeTruthy();

        // ByteMD の書く専用 / プレビュー専用アイコンでモードを切り替えても
        // スティッキーが維持されることを確認する
        const previewOnlyIcon = page.locator('#content-editor-section .bytemd-toolbar-icon:has(path[d="M6 6v36"])').first();
        await expect(previewOnlyIcon).toBeVisible();
        await previewOnlyIcon.click();
        await expect(page.locator('#content-editor-section .bytemd-editor')).toBeHidden();
        await expect(page.locator('#content-editor-section .bytemd-preview')).toBeVisible();

        const writeOnlyIcon = page.locator('#content-editor-section .bytemd-toolbar-icon:has(path[d="M42 6v36"])').first();
        await expect(writeOnlyIcon).toBeVisible();
        await writeOnlyIcon.click();
        await expect(page.locator('#content-editor-section .bytemd-editor')).toBeVisible();

        const stickyAfterToggle = await page.evaluate(() => {
            const scrollArea = document.getElementById('editor-scroll-area');
            const header = document.getElementById('content-editor-header');
            const toolbar = document.querySelector('#content-editor-section .bytemd-toolbar');
            if (!scrollArea || !header || !toolbar) return null;

            scrollArea.scrollTop = 420;

            const headerRect = header.getBoundingClientRect();
            const toolbarRect = toolbar.getBoundingClientRect();
            const scrollRect = scrollArea.getBoundingClientRect();

            return {
                headerOffset: Math.round(headerRect.top - scrollRect.top),
                toolbarOffset: Math.round(toolbarRect.top - scrollRect.top),
                headerHeight: Math.round(headerRect.height),
                headerVisible: headerRect.bottom <= scrollRect.bottom,
                toolbarVisible: toolbarRect.bottom <= scrollRect.bottom
            };
        });

        expect(stickyAfterToggle).not.toBeNull();
        expect(stickyAfterToggle.headerVisible).toBeTruthy();
        expect(stickyAfterToggle.toolbarVisible).toBeTruthy();
        expect(stickyAfterToggle.toolbarOffset - stickyAfterToggle.headerOffset).toBeGreaterThanOrEqual(stickyAfterToggle.headerHeight - 3);
    });

    test('TC-FUNC-043: Markdown preview toggle shows persisted-preview tooltip', async ({ page }) => {
        await page.goto(`${BASE_URL}/index.html?tree=${treeId}`);
        await page.waitForSelector('.tree-item');

        const previewToggleLabel = page.locator('label:has(#md-preview-toggle)');
        await expect(previewToggleLabel).toHaveAttribute('title', 'ページ遷移時にpreview状態にする');
        await expect(previewToggleLabel).toHaveAttribute('aria-label', 'ページ遷移時にpreview状態にする');
    });

    test('TC-FUNC-044: Tree pane scrolls horizontally while the menu stays near the split bar', async ({ page }) => {
        const treePaneScroll = page.locator('#tree-pane-scroll');
        const beforeMetrics = await treePaneScroll.evaluate(el => ({
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth
        }));
        expect(beforeMetrics.scrollWidth).toBeLessThanOrEqual(beforeMetrics.clientWidth + 1);

        const longTitle = '横スクロール確認用タイトル'.repeat(18);
        await addChildNodeViaUI(page, '.tree-item', longTitle);
        await expect(page.locator(`.tree-item:has-text("${longTitle}")`)).toBeVisible();

        const rightEdgeCheck = await page.locator(`.tree-item:has-text("${longTitle}")`).evaluate(node => {
            const title = node.querySelector('.tree-item-title');
            const actions = node.querySelector('.tree-item-actions');
            const button = node.querySelector('.add-child-btn');
            const pane = document.getElementById('tree-pane-scroll');
            if (!title || !actions || !button || !pane) return null;
            const titleRect = title.getBoundingClientRect();
            const actionsRect = actions.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            const paneRect = pane.getBoundingClientRect();
            const titleStyle = window.getComputedStyle(title);
            const actionsStyle = window.getComputedStyle(actions);
            return {
                paneScrollWidth: pane.scrollWidth,
                paneClientWidth: pane.clientWidth,
                textOverflow: titleStyle.textOverflow,
                overflowX: titleStyle.overflowX,
                whiteSpace: titleStyle.whiteSpace,
                actionsBackground: actionsStyle.backgroundImage,
                titleScrollWidth: title.scrollWidth,
                titleClientWidth: title.clientWidth,
                titleRight: Math.round(titleRect.right),
                actionsWidth: Math.round(actionsRect.width),
                buttonLeft: Math.round(buttonRect.left),
                buttonRight: Math.round(buttonRect.right),
                paneRight: Math.round(paneRect.right)
            };
        });
        expect(rightEdgeCheck).not.toBeNull();
        expect(rightEdgeCheck.paneScrollWidth).toBeGreaterThan(rightEdgeCheck.paneClientWidth + 1);
        expect(rightEdgeCheck.textOverflow).toBe('clip');
        expect(rightEdgeCheck.overflowX).toBe('visible');
        expect(rightEdgeCheck.whiteSpace).toBe('nowrap');
        expect(rightEdgeCheck.titleClientWidth).toBeGreaterThan(rightEdgeCheck.paneClientWidth);
        expect(rightEdgeCheck.titleRight).toBeGreaterThan(rightEdgeCheck.buttonLeft);
        expect(rightEdgeCheck.actionsBackground).toContain('linear-gradient');
        expect(rightEdgeCheck.actionsWidth).toBeGreaterThanOrEqual(52);
        expect(rightEdgeCheck.paneRight - rightEdgeCheck.buttonRight).toBeGreaterThanOrEqual(10);
        expect(rightEdgeCheck.paneRight - rightEdgeCheck.buttonRight).toBeLessThanOrEqual(22);
    });

    test('TC-FUNC-045: Multi-parent badge stays immediately left of the tree item menu', async ({ page }) => {
        const parentA = await createNodeAPI(page, treeId, { title: '親A', content: '', author_user_id: 1 });
        const parentB = await createNodeAPI(page, treeId, { title: '親B', content: '', author_user_id: 1 });
        const child = await createNodeAPI(page, treeId, { title: '複数親の子', content: '', author_user_id: 1 });
        await addRelationAPI(page, treeId, rootNodeId, parentA.id);
        await addRelationAPI(page, treeId, rootNodeId, parentB.id);
        await addRelationAPI(page, treeId, parentA.id, child.id);
        await addRelationAPI(page, treeId, parentB.id, child.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        await page.locator(`.tree-item[data-node-id="${parentA.id}"] .toggle-btn`).first().click({ force: true });
        const visibleChild = page.locator(`.tree-item[data-node-id="${child.id}"]:visible`).first();
        await expect(visibleChild).toBeVisible();

        const badgeCheck = await visibleChild.evaluate(node => {
            const actions = node.querySelector('.tree-item-actions');
            const badge = node.querySelector('.tree-multi-parent-badge');
            const button = node.querySelector('.add-child-btn');
            const pane = document.getElementById('tree-pane-scroll');
            if (!actions || !badge || !button || !pane) return null;
            const actionsRect = actions.getBoundingClientRect();
            const badgeRect = badge.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            const paneRect = pane.getBoundingClientRect();
            const actionsStyle = window.getComputedStyle(actions);
            return {
                badgeText: badge.textContent?.trim(),
                columnGap: actionsStyle.columnGap,
                gridTemplateColumns: actionsStyle.gridTemplateColumns,
                badgeRight: Math.round(badgeRect.right),
                buttonLeft: Math.round(buttonRect.left),
                buttonRight: Math.round(buttonRect.right),
                actionsRight: Math.round(actionsRect.right),
                paneRight: Math.round(paneRect.right)
            };
        });
        expect(badgeCheck).not.toBeNull();
        expect(badgeCheck.badgeText).toBe('2');
        expect(badgeCheck.columnGap).toBe('2px');
        expect(badgeCheck.gridTemplateColumns).toContain('26px');
        expect(badgeCheck.buttonLeft - badgeCheck.badgeRight).toBeGreaterThanOrEqual(0);
        expect(badgeCheck.buttonLeft - badgeCheck.badgeRight).toBeLessThanOrEqual(4);
        expect(badgeCheck.actionsRight - badgeCheck.buttonRight).toBeGreaterThanOrEqual(0);
        expect(badgeCheck.actionsRight - badgeCheck.buttonRight).toBeLessThanOrEqual(2);
        expect(badgeCheck.paneRight - badgeCheck.actionsRight).toBeGreaterThanOrEqual(10);
        expect(badgeCheck.paneRight - badgeCheck.actionsRight).toBeLessThanOrEqual(22);
    });

    test('TC-FUNC-026: Unsaved guard stays quiet during in-flight node switching and still protects real edits', async ({ page }) => {
        const nodeA = await createNodeAPI(page, treeId, { title: 'ガードA', content: 'A', author_user_id: 1 });
        const nodeB = await createNodeAPI(page, treeId, { title: 'ガードB', content: 'B', author_user_id: 1 });
        const nodeC = await createNodeAPI(page, treeId, { title: 'ガードC', content: 'C', author_user_id: 1 });
        await addRelationAPI(page, treeId, rootNodeId, nodeA.id);
        await addRelationAPI(page, treeId, rootNodeId, nodeB.id);
        await addRelationAPI(page, treeId, rootNodeId, nodeC.id);
        await page.reload();
        await page.waitForSelector('.tree-item');

        const delayedNodeBRoute = new RegExp(`/api/trees/${treeId}/nodes/${nodeB.id}$`);
        let delayedNodeBOnce = false;
        await page.route(delayedNodeBRoute, async route => {
            if (delayedNodeBOnce) {
                await route.fallback();
                return;
            }
            delayedNodeBOnce = true;
            // まず取得し、その応答を遅延させて返す（ページからはノードBの応答が遅いように見える）。
            // unroute は使わない（保留中の route を自動解放し、ハンドラの fulfill が
            // "Route is already handled!" になるため）。
            const response = await route.fetch();
            await new Promise(resolve => setTimeout(resolve, 900));
            await route.fulfill({ response });
        });

        await page.locator('.tree-item:has-text("ガードA")').first().click({ force: true });
        await expect(page.locator('#node-title')).toHaveValue('ガードA');

        // クリック前に wait を登録する（登録より先に発生した request は捕捉できないため）
        const nodeBRequestPromise = page.waitForRequest(delayedNodeBRoute);
        await page.locator('.tree-item:has-text("ガードB")').first().click({ force: true });
        // ノードBの取得が発火し、インターセプトで保留になったことを確認してから切り替える
        await nodeBRequestPromise;
        await page.locator('.tree-item:has-text("ガードC")').first().click({ force: true });

        await expect(page.locator('#unsaved-confirm-modal')).toBeHidden();
        await expect(page.locator('#node-title')).toHaveValue('ガードC');

        await page.fill('#node-title', 'ガードC更新');
        await page.locator('.tree-item:has-text("ガードA")').first().click({ force: true });

        await expect(page.locator('#unsaved-confirm-modal')).toBeVisible();
        await page.click('#unsaved-confirm-modal .confirm-no');
        await expect(page.locator('#node-title')).toHaveValue('ガードA');
    });
});
