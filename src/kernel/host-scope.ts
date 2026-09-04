/**
 * 宛先スコープ判定(ADR-0020 原則1 / §8c-4)。**capability の宛先ホワイトリスト照合の単一ソース。**
 *
 * この純関数は2箇所から呼ばれる:
 * - `workflow-runner.ts` の `runCallExternal` —— **enqueue 時**の遮断点。
 * - `outbox-dispatcher.ts` の `dispatchOutbox` —— **配送時**の再検証(多層防御)。
 *
 * **判定ロジックを2箇所に複製しないため**にモジュールへ切り出した(V1-M4-T05 の
 * レッドチーム申し送り)。enqueue と dispatch が同一の関数を通ることが、将来 owner が
 * 「接続の許可ホストを狭める」機能を足したときに、**既に積まれた outbox 行を配送時にも
 * 同じ規則で弾ける**根拠になる。ここのロジックを変えると両経路が同時に変わる。
 *
 * - ホスト名は**小文字化して**比較する(大文字小文字を無視する)。
 * - `allowedHosts` が空なら**常に不許可**(既定 deny。ワイルドカード全許可を既定にしない)。
 * - URL パースに失敗したら不許可(fail-closed)。
 */
export function hostAllowed(allowedHosts: string[], destination: string): boolean {
  if (allowedHosts.length === 0) {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(destination).hostname.toLowerCase();
  } catch {
    return false;
  }
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  return allowed.has(hostname);
}
