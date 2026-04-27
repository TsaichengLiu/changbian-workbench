# 長編工作臺 (History Research Workbench)

用於歷史研究長編整理的桌面化工作臺，支持：

- 專案管理（可新增/改名/刪除/拖拽排序）
- 專案下章節管理（可選，支援拖拽排序）
- 史料四元素錄入：時間、史料文本、備註、引文註釋
- 當前層級史料拖拽排序（便於處理非標準紀年）
- 專案與史料的複製 / 粘貼（跨專案搬運）
- 備註 `#標籤` 解析與標籤過濾檢索
- 高級檢索彈窗：按關鍵詞 / 標籤 / 引文《》書名檢索，並可將結果導入新專案、新章節、既有專案、既有章節
- 左欄合併：合併專案、合併章節（章節合併為新章節，來源不刪除）
- 全局檢索（繁簡通用，例：`長` 可命中 `长`）
- 匯出 `txt` / `docx` / `xlsx`
- MCP Server（供 agent/LLM 錄入史料）

## 技術設計

- 前端：`React + TypeScript + Vite`
- 桌面殼：`Electron`
- 匯出：
  - Word: `docx`
  - Excel: `xlsx`
- 繁簡檢索：`opencc-js`
- 本地資料儲存：`localStorage`

## 開發與啟動

```bash
npm install
npm run dev
```

## 打包 macOS

```bash
npm run dist:mac
```

打包產物位於 `release/`。

## 專案結構

- `src/`：界面、狀態與匯出邏輯
- `electron/`：桌面啟動殼（主進程 + preload）
- `dist/`：前端構建輸出（build 後）
- `release/`：桌面安裝包輸出（dist:mac 後）
- `mcp/server.cjs`：可獨立啟動的 MCP server（stdio）

## MCP Server（給 agent / LLM 接入）

```bash
npm run mcp:start
```

- 默認資料檔：`~/.changbian-workbench/workspace.json`
- 可用環境變數覆蓋：`CHANGBIAN_MCP_STORE=/your/path/workspace.json`
- Electron 桌面版會同步同一份共享檔（啟動時讀取、編輯時寫回）

已提供工具：
- `list_projects`
- `create_project`
- `create_chapter`
- `add_entry`
- `search_entries`

## 後續可擴展

- 自動排序策略（僅公元紀年排序，其他歸併）
- 依引文來源自動聚類
- 本地檔案式資料庫（SQLite）
- iCloud/雲同步
