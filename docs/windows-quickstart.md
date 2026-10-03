# Agent Office on Windows — 啟動與驗收

單一使用者、Windows 原生。Claude Code 在同一台電腦上執行。Agent Office 只觀測，
不啟動也不控制任何 agent（見 [observation.md](observation.md)）。

## 第一次設定

1. 安裝 [Node.js 20 以上](https://nodejs.org) 與 Claude Code。
2. 在本資料夾執行：

   ```powershell
   npm.cmd ci
   npm.cmd run build
   ```

3. 雙擊 **`agent-office.cmd`**（或執行 `node .\dist\cli.js`），開啟它印出的網址。
   網址含 `?token=…`，請勿外流；沒有 token 的頁面只能觀看，不能改探索設定或 hooks。
4. 首次開啟時，辦公室的引導會詢問是否安裝 Claude Code hooks（寫入
   `~/.claude/settings.json`，只加入 Office 自己的項目）。建議安裝：等待／權限狀態只有
   hooks 才能可靠取得。

關閉這個視窗只會停止 Office，對正在執行的 agent 沒有影響。

## 升級時會發生什麼

第一次用新版開啟時，若 `%USERPROFILE%\.agent-office\agent-office.db` 需要升級，
Office 會先複製一份 `agent-office.db.backup-v<舊版本>-<時間>`，然後只**新增**欄位。舊的
Project／Task／Agent 資料表與 `agents\`、`blobs\`、`runtime\` 資料夾原樣保留，不讀也不刪。
之前未結束的呼叫會顯示為「狀態未知（依據：Office 重新啟動）」。

## 驗收步驟

以下步驟中，**1–3 與 7 不會呼叫模型**；4–6 需要真的使用 Claude Code（會消耗額度），
`/figma-ui` 可能寫入 Figma——執行前請先確認任務內容。

1. **探索**：開啟底部「Agent」。`~/.claude/agents` 下的每個 agent 都應列出，狀態「待命」。
   在「探索設定」加入你的專案根目錄（例如 Figma UI agent 的 repo），其 `.claude/agents`
   與 `.claude/skills` 會被掃描；`figma-ui` 在預設的「顯示為 Agent 的 Skills」中。
   「掃描位置」對不存在的目錄顯示「未找到」，且 Office 沒有建立它。
2. **新增 agent 不改 Office**：在 `~/.claude/agents` 新增一個 `.md`（含 `name:`），3 秒內出現在
   列表與辦公室，不需重新整理或重啟。
3. **篩選**：「已找到但未顯示的 Skills」只列出，不會變成人物；按「+ 名稱」才會顯示。
4. **子 agent**：在 Claude Code 對話中請它用 `Agent`/`Task` 委派給某個已探索的 agent。
   確認該人物與列表變「工作中」，旁邊沒有多出一個 Subtask 人物；完成後回到「待命」，
   歷史一筆「已結束」，展開可見「依據：對話紀錄」；歷史只顯示一行摘要，沒有完整 prompt。
5. **並行與背景**：同時委派兩個子任務，或請它以背景方式委派；確認兩筆互不覆蓋，背景
   啟動顯示「背景執行中」（不是已結束），完成通知到達後才變「已結束」。
6. **`/figma-ui`**：在 Figma UI 專案中執行 `/figma-ui`。確認 figma-ui 人物變「工作中」；
   回合結束時若 ledger 尚無對應紀錄會顯示「未知」；若 ledger 有未回答的提問，顯示
   「等待回應」與階段；明確完成後顯示「已結束（依據：Agent 自身的執行紀錄）」。
   請把實際 `design-runs/<id>/ledger.json` 的欄位回報，以核對欄位對照。
7. **重啟與資料邊界**：在 agent 執行中關閉 Office 再開啟，該筆顯示「未知」而非「已結束」，
   agent 本身不受影響。比對 `~/.claude/agents`、專案 `.claude`、`design-runs` 的修改時間，
   Office 沒有寫入。

## 資料位置

`%USERPROFILE%\.agent-office\`

| 路徑                            | 內容                                |
| ------------------------------- | ----------------------------------- |
| `agent-office.db`               | 觀測紀錄（`agent_calls`）；舊表保留 |
| `agent-office.db.backup-*`      | 升級前自動備份                      |
| `discovery.json`                | 探索設定                            |
| `agents\`、`blobs\`、`runtime\` | 舊版資料，不再使用、不刪除          |

備份：停止 Office 後複製整個 `.agent-office` 資料夾即可。
