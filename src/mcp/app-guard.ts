/**
 * app_id の実在ガード(V0-P5-T02 / 計画 R1)。
 *
 * **なぜ専用のガードが要るか。** カーネルの入口の多くは
 * `readCurrentManifest`(`src/kernel/apply-manifest.ts:74-86`)を経由し、これは
 * アプリが無いとき**素の `Error` を throw する**。マニフェストの不在は
 * 「LLM がマニフェストを直せば解決する」種類の失敗ではない、という判断による
 * 設計であり、カーネル側としては正しい。
 *
 * ところが MCP の入口から見ると事情が変わる。LLM は app_id を**タイプミスする**し、
 * 前の会話で見たアプリ名をうろ覚えで渡す。これは十分に「1往復で自己修正できる」
 * 種類の失敗であり、例外メッセージではなく統一形式(`path` + `allowed_values`)で
 * 返すべきものである。そこで**カーネルに触る前に**存在を確かめる。
 * `src/server/app.ts:325-328` の `ensureApp` が HTTP 側で 500 を 404 に変えている
 * のと同じ役割を、MCP 側で果たす。
 *
 * R3: `KernelMetaStore` は**呼び出しごとに open し、`finally` で close する**。
 * モジュールレベルで持ち回すと、別プロセスである Web サーバの書き込みとの
 * 整合が取りにくくなり、close 漏れで WAL ファイルが残り続ける。
 */
import { KernelMetaStore, type ValidationError } from "../kernel/index.ts";

/**
 * アプリが台帳に登録されているかを確かめる。
 *
 * @returns 実在すれば `null`、しなければ返すべきエラー配列
 */
export function requireApp(dataRoot: string, appId: string): ValidationError[] | null {
  const store = KernelMetaStore.open(dataRoot);
  try {
    if (store.hasApp(appId)) {
      return null;
    }
    return [
      {
        path: "/app_id",
        message: `アプリ "${appId}" は存在しません。`,
        // 実在する app_id を必ず添える。LLM がここから正解を選び直せる形にするのが要点で、
        // アプリが0件でも `undefined` ではなく空配列を返す(「候補が無い」も情報)。
        allowed_values: store.listApps().map((app) => app.app_id),
        hint: "list_apps ツールで実在するアプリの一覧を取得できます。",
      },
    ];
  } finally {
    store.close();
  }
}
