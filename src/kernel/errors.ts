/**
 * LLM向けバリデーションエラー形式(handover.md 3.8 / V0-P1-T04)。
 *
 * すべてのバリデータ(スキーマ適合・参照整合性・差分パッチ)の出口はこの形式に統一する。
 * 目的は「LLMが1往復で自己修正できること」。そのため
 * - path は機械的に位置を特定できる RFC 6901 JSON Pointer
 * - message は人間にもLLMにも読める日本語の具体的な理由
 * - enum 系の違反では必ず allowed_values に許可値の一覧を入れる
 * を満たす。
 */

/** 1件のバリデーションエラー。 */
export type ValidationError = {
  /** RFC 6901 JSON Pointer。例: "/app/tables/0/fields/2/type"。ルートは空文字。 */
  path: string;
  /** LLMが自己修正できる具体的な日本語メッセージ。 */
  message: string;
  /** enum / const 違反時は必ず入れる、許可される値の一覧。 */
  allowed_values?: string[];
  /** 修正のヒント(任意)。 */
  hint?: string;
};

/** バリデーション結果。成功時はエラー配列を持たない。 */
export type ValidationResult = { valid: true } | { valid: false; errors: ValidationError[] };

/** 成功結果を作る。 */
export function valid(): ValidationResult {
  return { valid: true };
}

/** 失敗結果を作る。 */
export function invalid(errors: ValidationError[]): ValidationResult {
  return { valid: false, errors };
}

/**
 * エラー配列を人間が読める複数行テキストに整形する(CLI・ログ・LLMへの提示用)。
 * 1件につき1行で「パス: 理由 (許可される値: ...) ヒント: ...」の形になる。
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors
    .map((error) => {
      const path = error.path === "" ? "/" : error.path;
      let line = `${path}: ${error.message}`;
      if (error.allowed_values !== undefined) {
        line += ` 許可される値: ${error.allowed_values.join(" / ")}`;
      }
      if (error.hint !== undefined) {
        line += ` ヒント: ${error.hint}`;
      }
      return line;
    })
    .join("\n");
}

// --- 同じアプリへの同時書込の順番待ち(V3-M13-T15 / ADR-0069)------------------------
//
// SQLite は1ファイル1ライタである(ADR-0018)。同じ `app.sqlite` へ2つの書き手が同時に
// 来ると、後から来た側は書込ロックを取れない。**そのとき「待たずに落ちる」か「待つ」かを
// 決めているのは接続の `busy_timeout` だけである**(V3-M13-T15 の実測: 値を 0 → 5000 に
// するだけで、600 試行中 545 件あった `SQLITE_BUSY` が 0 件になった)。
//
// **待ち時間はここにある1つの定数だけである**(ADR-0069 限定2)。アプリごと・経路ごとに
// 変えられるようにしない —— マニフェストに待ち時間キーを1つも足していないので、
// 「経路 × 待ち方」の積で AI が覚える規則が増えることはない。
//
// **再試行(リトライ)は1つも実装していない**(限定1)。待つのは SQLite の busy handler
// だけである。アプリケーション側でループを回すと、副作用のあるワークフローが2度走りうる。

/** 順番待ちの上限(ミリ秒)。ADR-0018 D2(b) の逐語「例 5000」をそのまま採った。 */
const CONCURRENT_WRITE_WAIT_MS = 5000;

/**
 * 入口層が開いた `app.sqlite` の接続に流す PRAGMA(ADR-0069 §Decision 2 / 限定2)。
 *
 * **値を1箇所に閉じるために文そのものを配る** —— 入口層に数値リテラルを置くと、
 * 入口が増えたときに値がずれる。`src/server/app.ts` / `src/mcp/tools/write.ts` /
 * `src/server/inbound-route.ts` はこの定数を `db.exec(...)` に渡すだけである。
 *
 * **`schedule`(`src/kernel/workflow-scheduler.ts`)には流さない**(限定5)——
 * スケジューラは負けても次の周期で再判定するので、待つ必要が無い。
 */
export const CONCURRENT_WRITE_WAIT_PRAGMA = `PRAGMA busy_timeout = ${CONCURRENT_WRITE_WAIT_MS};`;

/**
 * 順番待ちの上限を過ぎた書込を、業務の言葉の統一エラーへ翻訳する
 * (ADR-0069 §Decision 3 / 限定7 / 限定12 / 限定13)。
 *
 * - **`SQLITE_BUSY` でなければ `null` を返す** —— 想定外の例外は今日どおり伝播させる
 *   (限定13。握り潰す方向へ1ミリも動かさない)。
 * - **新しいエラー形式を作らない** —— 既存の `ValidationError` である(限定7)。
 * - **文面の出所はこの関数だけである**(限定12)。3つの入口はこれを呼ぶだけで、
 *   文字列リテラルを1つも持たない。
 * - **「待てば必ず通る」と書かない**(限定14)。書けるのは「もう一度お試しください」までで、
 *   成功を約束しない —— 同じ窓が開き続けていれば何度でも落ちる。
 * - **文面に待ち時間の値を書かない。** `SQLITE_BUSY` は「上限まで待って諦めた」ときだけでなく
 *   「そもそも待たない接続が当たった」ときにも来る(`apply_diff` は自前で接続を開き、
 *   この PRAGMA を流していない)。**値を書くと、待っていない経路で嘘になる。**
 *
 * **`conflict:true` を立てない**(限定9)。「版が古い」(ADR-0017 の CAS)と
 * 「今は書けない」は別の事実であり、混ぜると利用者が「取り直せば直る」と誤解する。
 */
export function concurrentWriteBusyErrors(error: unknown): ValidationError[] | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== "SQLITE_BUSY") {
    return null;
  }
  return [
    {
      path: "",
      message:
        "いま同じアプリへ別の書き込みが進行中のため、この操作は成立しませんでした" +
        "(1バイトも書き込まれていません)。",
      hint:
        "しばらく間を置いてから、同じ操作をもう一度お試しください。" +
        "何度も続く場合は、時間のかかる自動処理(ワークフローの連鎖や一括処理)が" +
        "同じアプリで動いていないか確認してください。",
    },
  ];
}
