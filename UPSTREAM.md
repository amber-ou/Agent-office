# Upstream Sync

Agent Office 是 [pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) 的 fork，並刻意保留長期同步上游的能力。

## 同步狀態

| 項目      | 值                                                |
| --------- | ------------------------------------------------- |
| Upstream  | `https://github.com/pixel-agents-hq/pixel-agents` |
| Fork base | `v1.4.1` / `3537e14`                              |
| 最後同步  | `3537e14`（fork base，尚未有後續同步）            |

## 設定

```bash
git remote add upstream https://github.com/pixel-agents-hq/pixel-agents
git fetch upstream main
```

## 同步流程

```bash
git fetch upstream main
git checkout v1.0
git merge upstream/main
# 解衝突（預期只會落在「已知衝突面」那幾個檔案）
npm install
npm run check-types && npm run lint && npm test && npm run build
# 更新本檔案的「最後同步」欄位
```

## Additive 紀律

能長期同步的唯一原因是：**Agent Office 的程式碼幾乎全部放在 upstream 不存在的新目錄**。

| 規則                                | 說明                                                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新程式碼放新目錄                    | `storage/`、`server/src/control/`、`webview-ui/src/control/`，以及 `server/src/` 下的 `callLogBridge.ts`、`nativeAgentRoster.ts`、`runRecords.ts`、`observation*.ts` |
| 不改寫 upstream 既有檔案的語意      | `AgentEvent`、`HookProvider`、`MessageTransport`、Office UI 行為不變                                                                                                 |
| 只觀測，不控制（ADR 009）           | 沒有下行（派工）通道；不把指令塞進 `AgentEvent`                                                                                                                      |
| `core/asyncapi.yaml` 只新增 channel | 不修改既有 27 個 ServerMessage / 18 個 ClientMessage                                                                                                                 |
| **絕不手改 `core/src/messages.ts`** | 它是 codegen 產物，且 CI 有 drift check                                                                                                                              |
| 資料寫 `~/.agent-office/`           | 與 upstream 的 `~/.pixel-agents/` 分離，互不污染                                                                                                                     |
| 暫不 rename                         | npm package name、VS Code extension id、內部路徑維持 upstream 原樣                                                                                                   |

## 已知衝突面

以下是**唯一**會與 upstream 產生衝突的檔案。每次同步只需檢查這幾個：

| 檔案                                | Agent Office 的改動                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 衝突處理                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `README.md`                         | 整份換成 Agent Office 的 README                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 保留我方版本；必要時人工挑入 upstream 的新內容                                                        |
| `package.json`                      | `workspaces` 增加 `storage`；`lint` / `lint:fix` / `check-types` / `test` 串接新目錄；移除 `pixel-agents.autoSpawnAgent` 設定                                                                                                                                                                                                                                                                                                                                                                                       | 取 union：保留 upstream 的新 script，並確認我方的串接仍在                                             |
| `tsconfig.json`                     | `include` 增加 `storage/src`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 取 union                                                                                              |
| `knip.json`                         | 新 workspace 與 ignore entries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 取 union                                                                                              |
| `CLAUDE.md`                         | 分層規則段落補上新目錄                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 取 union                                                                                              |
| `.github/workflows/ci.yml`          | 新增 `Storage Tests` step，並加進 summary 表與 Final Gate                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 取 union；**務必確認 Final Gate 的迴圈仍包含 `STORAGE_TEST`**，否則新測試會變成不擋 build 的 advisory |
| 觀測專用的 upstream 改動（ADR 009） | VS Code：移除 `launchAgent` 處理、auto-spawn、`closeAgent` 改為只隱藏不 dispose terminal（`PixelAgentsViewProvider.ts`、`agentManager.ts` 刪除 `launchNewTerminal`、`constants.ts`）；webview：移除「+ Agent」（`BottomToolbar.tsx`、`useEditorActions.ts`、`App.tsx`）、`ToolOverlay.tsx` 的隱藏按鈕；server：`transcriptParser.ts` 的觀測事件、`agentRuntime.ts` 的觀測接線、`clientMessageHandler.ts`／`httpServer.ts`；e2e：`helpers/webview.ts`、`helpers/internal-agent.ts` 改為在 terminal 中自行執行 claude | 保留我方行為：upstream 新增的啟動 agent 入口不得重新接上；其餘取 union                                |

`LICENSE` 永不修改。

## 上游 ADR 編號

`docs/adr/` 內有兩個系列，避免混淆：

- **4 位數** `0001-`…：upstream 的 ADR，隨上游同步進來，不修改。
- **3 位數** `001-`…：Agent Office 自己的 ADR。
