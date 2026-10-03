# Agent Office：純觀測模型

更新：2026-10-03 ｜ 決策：[ADR 009](adr/009-observation-only.md) ｜ 取代：`docs/task-log.md`、`docs/status.md` 的派工／管理敘述

Agent Office 是 Claude Code 多 agent 的**唯讀觀測介面**。你照常在 Claude Code 裡呼叫 agent，Office 會自動辨認身分與活動，顯示在 Agent 列表、詳情與像素辦公室中。

## 1. 原則

1. Office **不啟動、不派工、不取消、不續跑**任何 agent，也不控制它的 terminal。
2. Office **不修改** agent 的指示、記憶、成果、鎖或工作檔案，也**不寫入** `~/.claude`。
3. 新增受支援形式的 agent，不需要改 Office 程式、也不需要在 Office 建立角色。
4. 沒有可靠訊號時顯示「未知」或最後已知狀態，不猜測、不冒充完成。
5. Office 關閉、重啟或斷線，對 agent 的工作沒有任何影響。

## 2. 自動探索

### 來源

| 範圍                                       | Agents                          | Skills                                  |
| ------------------------------------------ | ------------------------------- | --------------------------------------- |
| 使用者                                     | `~/.claude/agents/**/*.md`      | `~/.claude/skills/<name>/SKILL.md`      |
| 專案（在「探索設定」加入的每個專案根目錄） | `<root>/.claude/agents/**/*.md` | `<root>/.claude/skills/<name>/SKILL.md` |

- 只讀定義檔的 front matter（`name`、`description`）與檔案位置；不把指示全文匯入 Office。
- 來源目錄不存在時，在「探索設定 → 掃描位置」標示「未找到」，**不會**為了掃描建立目錄。
- 每 3 秒重新掃描一次；新增、修改、刪除定義檔不需重啟。
- Skill 沒有 `name` 欄位時，以目錄名稱為名（與 Claude Code 相同）。

### 篩選

- **每個 agent 定義都會顯示**成人物。
- **Skill 預設不顯示**：多半是輔助工具。只有名稱列在「顯示為 Agent 的 Skills」（`skillInclude`，可用 `*` 萬用字元）的 skill 才會成為人物。預設清單是 `figma-ui`。
- 已找到但未顯示的 skill 列為「候選」，在探索設定按一下即可加入。

### 設定檔

探索設定是 **Office 自己的設定**，存在 `~/.agent-office/discovery.json`（tmp + rename 原子寫入），不是 agent 定義：

```json
{
  "includeUserAgents": true,
  "includeUserSkills": true,
  "projectRoots": ["C:\\Users\\me\\Projects\\design"],
  "skillInclude": ["figma-ui"]
}
```

修改設定（`setDiscoveryConfig`）需要伺服器 token（與 hooks 安裝同等級的 privileged 連線）；未帶 token 的頁面仍可觀看。

### 身分對應

觀測到的名稱（`subagent_type` 或 skill 名稱）只有在**唯一**對應到一個顯示中的定義時才算「已辨識」，否則列為「未辨識 Agent」，不歸給任何人物：

1. 專案定義優先：該專案根目錄包含呼叫所在的工作目錄（transcript 的 `cwd`）時，採用最內層的專案定義（與 Claude Code 的優先序相同）。
2. 否則採用使用者層級定義。
3. 同一來源目錄有兩個同名定義 → 標記「名稱衝突」，活動不歸屬任何一個。
4. 專案定義不會被歸給專案以外的工作階段；不知道工作目錄時也不歸給專案定義。
5. 無法解析的定義檔（沒有 front matter、沒有名稱、含 git 衝突標記）列在「無法辨識的定義」。

## 3. 觀測訊號

只用 Claude Code 已有的 hooks、transcript 與 agent 既有的執行紀錄。

| 活動                                                        | 開始                         | 狀態變化                                                              | 結束                                                                                                |
| ----------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 子 agent（`Task`/`Agent` + `subagent_type`）                | `tool_use`                   | hook 權限要求 → 等待回應；之後的活動 → 執行中                         | 對應 `tool_result`（`is_error` → 失敗）                                                             |
| 背景子 agent                                                | 同上                         | `tool_result` 為「Async agent launched…」→ **背景執行中**（不是結束） | `queue-operation` 完成通知（`<status>`）                                                            |
| 隊友（具名 spawn，或 `agent_id: <name>@<team>` 的隱性團隊） | `tool_use`                   | spawn 結果 → 背景執行中，記錄隊友名稱                                 | 團隊設定標示離開 → 已結束；隊友自己的工作階段結束 → 已結束（依據：工作階段結束）；團隊被取代 → 未知 |
| Skill（`Skill` 工具，或使用者輸入 `/name`）                 | `tool_use` 或 slash 指令紀錄 | hook 權限要求 → 等待回應；回合結束且沒有執行紀錄 → **未知**           | 只有 agent 自己的執行紀錄明確表示完成／失敗                                                         |

補充規則：

- 只有 **hooks 事件**才算「等待回應」；heuristic 的 7 秒權限計時器是推測，不改變呼叫紀錄。
- 同一個 skill 在同一工作階段的同一回合，`/name` 與 `Skill` 工具算同一次呼叫。
- 輔助 skill（未顯示者）不留下任何呼叫紀錄。
- 工作階段消失（session 結束或角色被移除）時，未結束的呼叫改為「未知（依據：工作階段結束）」，不補結束時間。
- 每次狀態變化都記錄**依據**（`evidenceSource`），畫面顯示「依據：…」。「已結束」不等於「成功」。

### 狀態

| 呼叫狀態                   | 意義                                                          |
| -------------------------- | ------------------------------------------------------------- |
| 執行中                     | 有證據正在進行                                                |
| 等待回應                   | hook 權限要求，或 agent 執行紀錄顯示有未回答的問題            |
| 背景執行中                 | 已確認背景啟動，完成通知尚未出現                              |
| 已結束 / 失敗              | 有確認的結束證據（見依據）                                    |
| 狀態未知                   | 沒有可靠訊號（Office 重啟、回合／工作階段結束但沒有完成訊號） |
| 背景委派（舊版未追蹤結果） | 舊版本寫入的紀錄，保留顯示                                    |

Agent（人物）狀態由同一個函式（`webview-ui/src/control/agentDirectory.ts`）計算，列表、詳情、人物永遠一致：任一呼叫等待中 → 等待回應；任一執行中或背景執行中 → 工作中；最近一次是未知 → 未知；否則待命。

## 4. `/figma-ui` 與執行紀錄

Office 以唯讀方式讀 agent **既有的**紀錄來補充階段與等待狀態（`server/src/runRecords.ts`）：

- **figma-ui ledger**：`<dir>/design-runs/<run-id>/ledger.json`，`<dir>` 為呼叫所在工作目錄，以及該 skill 所屬專案根目錄。
- **不讀** `.figma-ui/active-run.json`（屬於寫入鎖，不能代表整個 run），不執行任何 Figma 腳本、不取得鎖、不寫入任何檔案。

關聯規則（不猜測）：

1. 紀錄內含相同 Claude session id → 關聯。
2. 否則只有在「同一目錄只有一個進行中的 figma-ui 呼叫」且「只有一個在呼叫開始後建立的 run」時才關聯。
3. 一旦關聯，之後沿用同一個 run id。

套用規則：明確完成判定 → 已結束（依據：Agent 自身的執行紀錄）；失敗 → 失敗；最後一輪提問沒有答案 → 等待回應；`active` 只有在 10 分鐘內有更新、且在呼叫開始之後才算執行中；其餘只顯示階段，不改變狀態。

> **尚待核對**：本工作階段無法讀取 `amber-ou/Agent-Figma-UI-agent`（基準 `69ad2f8`），ledger 欄位名稱以寬鬆方式讀取（`phase`/`currentPhase`、`status`、`completed`/`completion`/`verdict`、`questionRounds[].answers` 等）。實際欄位不符時，Office 會顯示「未知」而不是猜測；需以真實 ledger 核對 `runRecords.ts` 的對照。

### 選配：共用狀態回報

沒有既有紀錄的 agent **可以（不必）**寫入 `<工作目錄>/.agent-status/<run-id>.json`：

```json
{
  "agent": "my-agent",
  "runId": "r1",
  "sessionId": "<可選>",
  "status": "running",
  "phase": "drafting",
  "updatedAt": "2026-10-03T10:00:00Z"
}
```

`status` 為 `running` / `waiting_response` / `ended` / `failed`。Office 只讀，不要求任何 agent 採用。

## 5. 像素人物與去重

- 每個顯示中的定義是一個常駐人物（id 由定義檔路徑決定，重新掃描不會重複）。
- 已辨識的呼叫進行中時，同一次呼叫的**臨時人物**（Subtask 子角色，或同名隊友角色）會被隱藏，由常駐人物代表——一件工作一個人物。呼叫結束或關聯消失後恢復顯示。
- 未辨識的呼叫不建立、不隱藏任何人物。
- 人物上的「×」只是「從辦公室隱藏」，**不會**關閉 agent 的 terminal。

## 6. 資料與備份

`~/.agent-office/`：

| 路徑                                      | 內容                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `agent-office.db`                         | `agent_calls`（觀測紀錄）。舊版的 projects / agents / tasks 等資料表原樣保留、不再讀取 |
| `agent-office.db.backup-v<舊版本>-<時間>` | 升級 schema 前自動建立的完整備份（不覆寫既有備份）                                     |
| `discovery.json`                          | 探索設定                                                                               |
| `agents/`、`blobs/`、`runtime/`           | 舊版留下的資料，**不再讀寫，也不會被刪除**                                             |

新紀錄只保存：名稱、定義檔路徑、session id、呼叫 id、類型、隊友名稱、run id、**一行簡短活動摘要（最多 120 字元）**、階段、狀態、依據與時間。**不保存完整 prompt、工具參數或成果**。舊版寫入的完整任務文字保留在原欄位，畫面僅作舊資料顯示。

重啟時，所有未結束的呼叫改為「未知（依據：Office 重新啟動）」，不補結束時間；之後若讀到該呼叫的結果或背景完成通知，才依證據更新。

## 7. 已移除

Project／Task 管理、派工、Run／Cancel／Resume、Review／Accept、Office Skills／Knowledge 編輯、agent 檔案遷移與 Claude discovery link 同步、`runtime/`（Office 啟動 Claude）、`domain/`、Windows 執行同意流程、VS Code 的「+ Agent」、auto-spawn 與關閉 terminal。協定（`core/asyncapi.yaml`）中對應的管理／派工訊息已全部刪除，伺服器不再有可達的寫入路徑。

## 8. 已知限制

- 以 `claude --agent <name>` 另外啟動的獨立工作階段，hooks／transcript 沒有可驗證的欄位帶出 agent 名稱，因此不歸屬給任何定義。
- Office 停止期間發生的結束，只有在重啟後該工作階段被重新追蹤、且讀到對應紀錄時才會補上；否則維持「未知」。
- Skill 在回合結束後若沒有執行紀錄，只能顯示「未知」。
- 呼叫紀錄的工作目錄（用於執行紀錄關聯）只存在記憶體；重啟後不再為舊呼叫關聯 run。
- figma-ui ledger 欄位對照尚未以真實檔案核對（見 §4）。
- VS Code e2e 已改為「在 terminal 中自行執行 claude」，但本次無法在沙箱下載 VS Code 執行，需在 CI 或本機確認。
