/**
 * アウトボックスの非同期配送(ADR-0020 §3 改訂2。V1-M4-T03)。
 *
 * `runAction` の `call_external` 分岐(実行層の遮断点)は capability チェックを同期で
 * 行い、許可されたら送信内容(宛先 + 解決済み payload)を outbox に**積むだけ**である。
 * 実際の外部 fetch は、この非同期ディスパッチャが**別実行**で行う ——
 * 書き込み経路(`records.ts` 以下)を async 化しないための分離である(§3 改訂2 の理由)。
 *
 * **secret の扱い(§2d / §8c-6 / T4)**:
 * - secret は outbox に載っていない。connection の参照(`connection_id`)だけがある。
 * - dispatch 時に初めて `resolveSecret` で use-time 解決する(§3 の疑似コード (2))。
 * - 解決した値は `outboundFetch` のスコープを出さない。**error / ログ / outbox のどの列にも
 *   secret を入れない。**`resolveSecret` の `SecretResolutionError.message` は secret 値を
 *   含まない設計なので、失敗理由として outbox に残してよい。
 *
 * **スケジューラ等からの自動起動はしない**(T04 の配線)。この T03 は関数を提供するだけで、
 * どのスケジューラ tick / サーバルートにも結線しない。
 */
import { CapabilityStore } from "./capability-store.ts";
import { hostAllowed } from "./host-scope.ts";
import { resolveSecret } from "./secret-resolver.ts";

/**
 * 1件を外部へ POST する(V1-M4-T03)。
 *
 * `authorization: Bearer <secret>` を付けて JSON body で送る。**secret はこの関数の
 * スコープを出ない** —— 返すのは `res.ok`(真偽)だけで、例外は握って `false` を返す
 * (**例外メッセージに secret を出さない**)。
 *
 * @param fetchImpl テスト用の注入口。省略時はグローバル `fetch`。
 */
export async function outboundFetch(
  destination: string,
  payload: Record<string, unknown>,
  secret: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const doFetch = fetchImpl ?? fetch;
  try {
    const res = await doFetch(destination, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    // **例外の内容(secret を含みうる)を握りつぶす。**メッセージにも secret を出さない。
    return false;
  }
}

/**
 * outbox の pending をすべて配送する(V1-M4-T03)。
 *
 * 各 item について:
 * - connection が失効(削除)していれば `failed`(「接続が失効しています」)にして次へ。
 * - `resolveSecret` を use-time に呼ぶ。失敗したら `failed`(理由は secret 値を含まない
 *   `SecretResolutionError.message`)にして次へ。
 * - `outboundFetch` の成否で `sent` / `failed`(「送信先が失敗応答」)に確定する。
 *
 * @param fetchImpl テスト用の注入口(実ネットワークに触れずスパイで検査する)。
 */
export async function dispatchOutbox(
  dataRoot: string,
  fetchImpl?: typeof fetch,
): Promise<{ sent: number; failed: number }> {
  const store = CapabilityStore.openForKernel(dataRoot);
  let sent = 0;
  let failed = 0;
  try {
    for (const item of store.listPendingOutbox()) {
      const conn = store.getConnection(item.connectionId);
      if (conn === undefined) {
        // 失効:接続が消えているので secret も引けない。
        store.markOutbox(item.id, "failed", "接続が失効しています");
        failed += 1;
        continue;
      }

      // 配送時スコープ再検証(多層防御。V1-M4-T05)。**enqueue 時と同じ `hostAllowed` を通す。**
      // 現状は接続の allowedHosts が immutable なので enqueue 済みの行は必ずスコープ内だが、
      // 将来 owner が「許可ホストを狭める」機能を足すと、旧スコープの宛先を指したまま積まれた
      // 行が残りうる。それを配送直前に弾く。**secret 解決の前に置く**ので、スコープ外の行では
      // `resolveSecret` を走らせない(不要な取得を避け、失敗理由も secret 由来にならない)。
      if (!hostAllowed(conn.allowedHosts, item.destination)) {
        store.markOutbox(item.id, "failed", "宛先が接続の許可スコープ外です(配送時の再検証)");
        failed += 1;
        continue;
      }

      let secret: string;
      try {
        secret = await resolveSecret(conn.secretSource);
      } catch (error) {
        // SecretResolutionError.message は secret 値を含まない設計(secret-resolver.ts)。
        // それ以外の例外も message は secret 値を含まないが、念のため message のみを残す。
        store.markOutbox(item.id, "failed", error instanceof Error ? error.message : String(error));
        failed += 1;
        continue;
      }

      const ok = await outboundFetch(item.destination, item.payload, secret, fetchImpl);
      if (ok) {
        store.markOutbox(item.id, "sent");
        sent += 1;
      } else {
        store.markOutbox(item.id, "failed", "送信先が失敗応答");
        failed += 1;
      }
    }
  } finally {
    store.close();
  }
  return { sent, failed };
}
