/*! 台語課堂搶答 — © 2026 詹宗龍（臺中明道中學）保留一切權利。 */
/**
 * 把這個檔案複製成同目錄的 firebase-config.js，填入新 Firebase 專案的設定。
 *
 * 建立步驟（免費 Spark 方案即可）：
 *   1. https://console.firebase.google.com → 建立專案（例如 taigi-buzzer，不用開 Analytics）
 *   2. 建構 → Realtime Database → 建立資料庫 → 位置 asia-southeast1 → 以鎖定模式啟動
 *   3. 建構 → Authentication → 開始使用 → Sign-in method：
 *        啟用「Google」（教師用）與「匿名」（學生用）
 *   4. Authentication → Settings → 已授權網域：加入 cyril-mingdao.github.io
 *   5. 專案設定（齒輪）→ 你的應用程式 → 新增網頁應用程式 </> → 把 firebaseConfig 抄到下面
 *   6. Realtime Database → 規則：把 database.rules.json 整份貼上 → 發布
 *
 * 沒有這個檔案時頁面會顯示「尚未設定 Firebase」。
 */
export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  databaseURL: 'https://YOUR_PROJECT-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'YOUR_PROJECT',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:0000000000000000000000',
};
