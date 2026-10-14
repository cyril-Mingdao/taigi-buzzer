# 台語課堂搶答 v01

© 2026 詹宗龍（臺中明道中學）

教師在投影幕顯示 QR code，學生用手機掃碼加入（不限學校帳號），老師核准後進行搶答或全班作答。系統不存題目與答案，題目由老師用口頭或簡報出。

## 頁面
| 檔案 | 誰用 | 功能 |
|---|---|---|
| `index.html` | 老師（電腦投影） | Google 登入 → 建立房間 → 大 QR 等候區（學生卡片即時出現、點虛線卡片核准）→ 搶答順序／作答分布／排行榜；右上「📱 手機遙控」顯示遙控 QR |
| `remote.html?room=XXXXXX` | 老師（手機） | 開始／鎖定／重置、✓✗ 判定、公布正解、核准／改名／移除、加減分、設定、結束並清除 |
| `join.html?room=XXXXXX` | 學生 | 選班級＋姓名（分組模式再選組別）→ 等核准 → 搶答鈕或選項鈕 |

## 每題兩種題型（老師在控制面板切換）
- **搶答題**：老師按「開始」才可按，太早按算偷跑（處罰可設：不處罰／鎖 3 秒／鎖 5 秒／本題不能搶）。順序以 Firebase 伺服器時間排序。搶到者口頭回答，老師按 ✓（+1 並自動鎖定）或 ✗（可設扣 1 分，換下一位）；再按一次可取消。
- **作答題**：學生在手機選 ⭕❌／AB／ABC／ABCD／ABCDE，只能選一次。老師按正解後自動比對、答對 +1；按錯可直接點別的選項更正，分數自動重算。

## 分組規則（設定）
個人賽／一組只算第一個按的人／每人各自計算／一組只限一台手機。分組（前者與後者）時排行榜以組加總。

## 教師帳號
與 taigi-quiz 相同的 4 個帳號，寫在 `assets/core.js` 的 `TEACHERS`（前端提示）與 `database.rules.json`（真正的權限），**兩處要一起改**。

## Firebase 設定（一次性）
1. <https://console.firebase.google.com> 建立新專案。
2. Realtime Database → 建立 → asia-southeast1 → 鎖定模式。
3. Authentication → Sign-in method → 啟用 **Google** 與 **匿名**。
4. Authentication → Settings → 已授權網域：加入 `cyril-mingdao.github.io`。
5. 專案設定 → 新增網頁應用程式 → 把 config 填進 `config/firebase-config.js`（由 `firebase-config.example.js` 複製）。
6. Realtime Database → 規則：貼上 `database.rules.json` → 發布。

## 個資
學生姓名只存在該房間內；老師按「結束並清除資料」即整個刪除，24 小時以上的舊房間在老師下次開房時自動刪除。

## 本機測試
`python -m http.server 8794` 後開 `http://localhost:8794/?mock=1`：改用 `tests/mock-firebase.js`（localStorage 模擬，不檢查規則）。學生頁加 `&slot=a`、`&slot=b` 可在同一台電腦模擬多位學生。`?mock=0` 關閉。`tests/` 不需部署。

## 部署（GitHub Pages）
repo `cyril-Mingdao/taigi-buzzer`，Pages 來源為 **GitHub Actions**（`.github/workflows/deploy.yml`）。
`config/firebase-config.js` 不進 git：部署時由 repo secret `FIREBASE_CONFIG_JSON`（一行 JSON：apiKey、authDomain、databaseURL、projectId、storageBucket、messagingSenderId、appId）產生，做法同 taigi-whiteboard。沒設 secret 時部署會失敗並提示。
Firebase 與電子白板共用專案 `cyril-mingdao`；線上規則是合併版 `firebase-rules.merged.json`，重新發布白板規則時務必用合併版。
