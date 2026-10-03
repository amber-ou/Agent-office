# Agent Office

Claude Code 多 agent 的像素辦公室：**純觀測介面**。

你照常在 Claude Code 裡呼叫 agent、子 agent、隊友與 skill；Agent Office 自動探索它們，並在 Agent 列表、詳情、呼叫歷史與像素辦公室中呈現執行狀態。Office 不啟動、不派工，也不修改 agent 的指示、記憶或成果——那些都留在各自的環境。完整模型見 [`docs/observation.md`](docs/observation.md)。

> **Upstream attribution** — 本專案 fork 自 [pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)（MIT License，author: Pablo de Lucca），base 為 `v1.4.1` / `3537e14`。
> 原始 MIT `LICENSE` 完整保留。fork 來源與上游同步流程見 [`NOTICE`](NOTICE) 與 [`UPSTREAM.md`](UPSTREAM.md)。
> upstream 自身的 README 保留在 [其原始 repository](https://github.com/pixel-agents-hq/pixel-agents#readme)。

## 架構

| 部分                                                                   | 職責                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `core/`、`server/`、`webview-ui/`、`adapters/`                         | upstream Pixel Agents：hooks / transcript 觀測、像素辦公室、傳輸層                       |
| `storage/`                                                             | 觀測資料（`~/.agent-office/agent-office.db` 的 `agent_calls`）與唯讀的 agent／skill 探索 |
| `server/src/callLogBridge.ts`、`runRecords.ts`、`nativeAgentRoster.ts` | 把觀測到的活動轉成有依據的狀態；唯讀讀取 agent 既有的執行紀錄                            |
| `webview-ui/src/control/`                                              | Agent 列表、詳情、呼叫歷史、探索設定                                                     |

層級規則：

```
core/       → nothing
storage/    → nothing（只用 node 與 SQLite）
server/     → core/ + storage/
webview-ui/ → core/
adapters/   → core/ + server/
```

## 文件

| 文件                                                       | 內容                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`docs/observation.md`](docs/observation.md)               | 純觀測模型：探索、狀態依據、去重、資料邊界、已知限制                                |
| [`docs/windows-quickstart.md`](docs/windows-quickstart.md) | Windows 啟動與驗收步驟                                                              |
| [`docs/adr/`](docs/adr/)                                   | Architecture Decision Records（[009](docs/adr/009-observation-only.md) 為現行定位） |
| [`docs/architecture-audit.md`](docs/architecture-audit.md) | Milestone 0 — upstream 完整稽核與 data flow（歷史）                                 |
| [`UPSTREAM.md`](UPSTREAM.md)                               | 上游同步流程與衝突面                                                                |
| `CLAUDE.md` / `CONTEXT.md`                                 | upstream 的工程參考與詞彙表（已擴充分層規則）                                       |

## 開發

```bash
npm install
npm run check-types
npm run lint
npm test
npm run build
```

觀測儲存與探索可單獨測試：

```bash
npm run test:storage
```

其餘開發流程（F5 啟動 Extension Development Host、`node dist/cli.js`、e2e）沿用 upstream，見 `CONTRIBUTING.md` 與 `e2e/README.md`。

## License

MIT — 見 [`LICENSE`](LICENSE)。
