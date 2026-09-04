/**
 * HTTP サーバの起動(V0-P3-T02 / ADR-0003)。
 *
 * アプリの定義(`app.ts`)と起動(このファイル)を分けてあるのは、テストが
 * `app.request()` で実ポートを開かずにルーティングごと検証できるようにするため。
 *
 * ADR-0003 §8 のとおり v0 の API は**無認証**なので、リッスンアドレスは
 * `127.0.0.1` に固定する(ローカルホスト以外に公開してはならない)。
 *
 * **【2026-08-06 / `V5-M7-T01` の追記。上の一文は「既定」の話になった】**
 * **省略時のリッスンアドレスは今日も `127.0.0.1` である**が、環境変数 `ST_BIND_HOST` で
 * 差し替えられるようになった。**コンテナの中から外へ公開するために要る**(理由と、
 * 何が弱まったかは下の `BIND_HOST_ENV` の doc に書いた)。**既定値は1バイトも
 * 変えていない。**
 */
import { loadAuthConfig, validateAuthConfig } from "../auth/config.ts";
import {
  ensureIslandRuntimeReady,
  recover,
  resolveTimeZone,
  startWorkflowScheduler,
} from "../kernel/index.ts";
import { startAiDispatcher } from "./ai-dispatcher-scheduler.ts";
import { createServerApp, resolveServerProfile, SERVER_PROFILE_ENV } from "./app.ts";
import { startBackupScheduler } from "./backup.ts";
import { startOutboxDispatcher } from "./outbox-scheduler.ts";
import { checkRunnerVersionGate, formatGateFailure } from "./runner-version-gate.ts";

const DEFAULT_PORT = 3000;

/**
 * **リッスンアドレスの既定**(`ADR-0003` §8 逐語「リッスンアドレスは既定で `127.0.0.1` に
 * 固定する」)。**この値は1バイトも変えていない。**
 */
const DEFAULT_BIND_HOST = "127.0.0.1";

/**
 * リッスンアドレスを差し替える環境変数(`V5-M7-T01`)。
 *
 * **【なぜ足したのか。正直に書く】** **コンテナの中では `127.0.0.1` に束ねたポートに、
 * コンテナの外から到達できない** —— `docker run -p` はコンテナのネットワーク名前空間の
 * **非ループバック**インタフェースへ接続するため、`127.0.0.1` だけに束ねたサーバは
 * 公開できない(2026-08-06 実測)。**配布物として「起動して画面が出る」ためには、
 * コンテナの中で `0.0.0.0` に束ねる必要がある。**
 *
 * **【何を変えていないか】** **省略時は今日どおり `127.0.0.1` である。**
 * `bind-host.test.ts` が「環境変数を与えない起動では `127.0.0.1` に束ねること」を
 * 実プロセスで固定している。**`ADR-0003` §8 の「既定で `127.0.0.1` に固定する」は
 * 今日も真である。**
 *
 * **【何が弱まったか。隠さない】** **この環境変数に `0.0.0.0` を渡せば、コンテナの外でも
 * LAN に開く。** **`ADR-0003` §8 の「ローカルホスト以外に公開してはならない」は、
 * 今日から「機構として不可能」ではなく「運用として守る」に変わった。**
 * **`D-V5-6`(公開範囲はローカルホストを維持)は、コンテナ側では
 * `docker run -p 127.0.0.1:<port>:3000` という**公開の既定**で履行する
 * (`Dockerfile` の doc と `docs/plan/v5/records/v5-m7.md` §1)。
 * **この一段の弱まりは `V5-M8` / `V5-M11` の点検対象である。**
 */
const BIND_HOST_ENV = "ST_BIND_HOST";

/**
 * 起動プロファイル(`src/server/app.ts`)。**この1つの解決結果を、束ね先の判定
 * (`ADR-0286` 限定3)と版のゲート(`:168` 付近)の両方で使う。**
 *
 * **【`V5-M7c` で解決の位置を上へ動かした。何が変わるかを書く】** 以前は版のゲートの
 * 行で初めて解決していた。**語彙外の値(`ST_SERVER_PROFILE=Runner` など)を渡したときに
 * `resolveServerProfile` が投げる位置が、`recover()` の後から前へ移る。** 投げること
 * 自体も、メッセージも1バイトも変えていない。
 */
const serverProfile = resolveServerProfile(process.env[SERVER_PROFILE_ENV]);

// **空文字は「与えていない」と読む。** 空文字のまま `Bun.serve` に渡すと、どこに束ねたのかが
// 起動ログからも読めない状態で待ち受けが始まる(黙って別の場所に開く。憲法6)。
const bindHostRaw = process.env[BIND_HOST_ENV];
const bindHostGiven = bindHostRaw !== undefined && bindHostRaw !== "";

// **【`ADR-0286` 限定3 の是正。`V5-M7c`】**
//
// **`ST_BIND_HOST` を読むのは実行専用プロファイル(`runner`)で起動したときだけである。**
// **`full`(既定)では読まず、必ず `DEFAULT_BIND_HOST` に束ねる**(`ADR-0286` 限定3 逐語
// 「**`full`(既定)では `ST_BIND_HOST` を読まず、必ず `127.0.0.1` に束ねる**」)。
//
// **なぜ `full` だけ別扱いなのか**(`ADR-0286` §限定表の直後の逐語): **`full` は
// `ADR-0014` §2 の免除リストのうち読取5本を今日も塞いでいない**(`src/server/app.ts:2117`
// -`:2118`)。**そこを非ループバックに開けば、そのホストの `ST_DATA_ROOT` 配下の全アプリの
// 定義・変更履歴・要件文書が未認証で読める。** **配布物にはその5本が無い**(`runner` が
// 落とす。`ADR-0251` / `V5-M3b`)。
//
// **【これは「安全になった」ではない】** **`ST_SERVER_PROFILE=runner ST_BIND_HOST=0.0.0.0`
// の2本を渡せば、今日も非ループバックに開く。** **狭めたのは「何が開くか」であって
// 「開けられるか」ではない**(`ADR-0286` S3-2 逐語)。**【禁止】「ローカルホスト限定に
// 戻した」と書かない** —— 戻していない。
const bindHostHonored = bindHostGiven && serverProfile === "runner";
const HOSTNAME = bindHostHonored ? (bindHostRaw as string) : DEFAULT_BIND_HOST;

// **黙って無視しない**(憲法6)。**渡した人は束ね先を変えたつもりでいる** ——
// 何も言わずに既定へ落とすと、「変えたはずなのに変わらない」を手がかり無しに見ることになる。
//
// **止めずに続けるほうを選んだ。** `docs/plan/v5/records/v5-m7b.md` §5-2 は「1行書く」か
// 「起動を止める」かのどちらでもよいとし、**どちらが正しいかを審査は決めていない**と
// 書いている。**続ける側を選んだ理由**: (1) **落ちる先はより狭いループバックであり、
// 開きすぎる方向の取り違えは起きない**。(2) **配布物は影響を受けない** —— `Dockerfile:114`
// が `ENV ST_SERVER_PROFILE=runner` を焼いているので、コンテナの中では常に `runner` である。
// (3) 止めると、`ST_BIND_HOST` が残ったシェルで `full` を起動する開発環境が動かなくなる。
// **【正直に書く】これは私(`V5-M7c`)の判断であり、審査が名指しで許したものではない。**
if (bindHostGiven && !bindHostHonored) {
  console.error(
    `[smailtalk server] 環境変数 ${BIND_HOST_ENV}="${bindHostRaw}" は読みませんでした。` +
      `${BIND_HOST_ENV} が効くのは ${SERVER_PROFILE_ENV}=runner で起動したときだけです` +
      `(今回は ${serverProfile})。リッスンアドレスは ${DEFAULT_BIND_HOST} です。`,
  );
}

const dataRoot = process.env.ST_DATA_ROOT ?? "data";
const port = Number(process.env.PORT ?? DEFAULT_PORT);

// --- 起動時の整合性チェック(V1-M1-T04)-------------------------------------
//
// **リッスンを開始する前に行う。** 未完了の適用が残った状態でリクエストを受けると、
// 画面には「適用済みのマニフェスト」が出るのに `_changelog` にその変更が無い、という
// 状態を、ユーザが正しい現状として読むことになる(憲法5)。
//
// **正常時は1バイトも書かない**(`recovery.ts`)。マーカーが無ければファイルを1つも
// 開かず、`kernel.sqlite` にも接続しない。したがって起動を新しい故障点にしない。
//
// **失敗したら起動しない。** 「壊れたまま静かに起動する」は憲法6 に正面から反する。
//
// **診断ログは `console.error` に出す。** 正常な起動ログ(stdout)と混ぜないためであり、
// MCP 側(`src/mcp/index.ts`)の出力先とも揃う。
try {
  for (const outcome of recover(dataRoot)) {
    if (outcome.status === "clean") {
      continue;
    }
    console.error(
      `[smailtalk server] 未完了の適用を処理しました: app=${outcome.app_id} ` +
        `diff_id=${outcome.diff_id} 結果=${outcome.status}` +
        (outcome.snapshot === undefined ? "" : ` 復元元=${outcome.snapshot}`),
    );
  }
} catch (error) {
  console.error(
    `[smailtalk server] 起動時の整合性チェックに失敗したため起動を中止します ` +
      `(dataRoot=${dataRoot})。未完了の適用が残っている可能性があります。`,
  );
  console.error(error);
  process.exit(1);
}

// --- タイムゾーンの解決(V1-M2-T08 判断1)-----------------------------------
//
// `schedule` トリガーの「毎日 hour:minute」は、**どこかの TZ の壁時計を指していないと
// 意味が決まらない**(`src/kernel/clock.ts`)。ADR-0013 §6c の発火済み判定が
// 「**今日**発火したか」で決まるので、**「今日」の境界もこの TZ で決まる。**
//
// **これは「タイマーの失敗」ではなく「設定の誤り」なので、起動を止める。**
// 黙って既定(`Asia/Tokyo`)へ落とすと、**発火時刻が静かにずれる** —— ユーザは
// 「9時に動くはずのものが動かない/違う時刻に動いた」を、原因の手がかり無しに見る。
// 憲法6 に正面から反するので、**リッスンを始める前に落とす。**
//
// **`recover` の失敗(:43-50)とは理由が別である。**あちらは「壊れた状態の上に
// 積まない」ため、こちらは「設定が読めないまま動かさない」ため。**タイマーそのものの
// 失敗で起動を止めることはしない**(下の try/catch)。
const timeZoneResolution = resolveTimeZone(process.env.ST_TIMEZONE);
if (!timeZoneResolution.ok) {
  console.error(
    `[smailtalk server] 環境変数 ST_TIMEZONE の値が不正なため起動を中止します。\n` +
      timeZoneResolution.message,
  );
  process.exit(1);
}
const timeZone = timeZoneResolution.timeZone;

// --- 認証設定の解決 + fail-fast(V1-M3-T01 / ADR-0014 §10)---------------------
//
// **リッスンを開始する前に検証する。** rpID と expectedOrigin の不整合(rpID が
// origin の登録可能サフィックスでない、IP を rpID に使っている等)を黙って既定へ
// 落とすと、認証が「動いているように見えて実は誰も通れない/誰でも通る」状態になり、
// 手がかり無しに壊れる(憲法6)。timezone 検証(:66-73)と同じ作法で、設定が読めない
// なら**リッスンを始める前に落とす。**`validateAuthConfig` は純関数でテストからも呼べる。
const authConfig = loadAuthConfig(process.env);
try {
  validateAuthConfig(authConfig);
} catch (error) {
  console.error(
    `[smailtalk server] 認証設定(ST_AUTH_*)が不正なため起動を中止します。\n` +
      (error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
}

// --- 版の照合(V5-M5-T03 / V5-M5-T05 / R-G2 / R-G3 / R-G7 / ADR-0251)---------
//
// **リッスンを開始する前に照合する。** ボリュームの `PRAGMA user_version` が Runner の
// イメージのビルド単位の版と合わないまま動き出すと、**マニフェストと実 DB がズレたまま
// 静かに動く** —— 読み取りは 200 で存在しない列が全行 null、絞り込みは 200 で 0件、
// 並べ替えは 200、書き込みだけが 500 になる(実測は `docs/plan/v5/records/v5-m0.md` §1-2)。
// **`:37` の「失敗したら起動しない」の延長である**(ADR-0251 限定5)。
//
// **【掛ける先は実行専用プロファイル(`runner`)だけである】**
//
// **これは迂回口ではない**(限定5 が禁じたのは `--force` / 無効化の環境変数 /
// 「警告だけ出して続行」であり、そのどれも作っていない —— **`runner` で起動する経路には
// 通り抜ける手段が1つも無い**)。**`ADR-0251` の `S1` が確定させた目的の主語は
// 「配った Runner のイメージ」であり、開発・編集用のサーバではない。**
//
// **`full`(既定)に掛けない理由は、掛けると今日の開発環境が二度と起動しなくなるから
// である。** 今日ディスクにある DB は 34本すべて `user_version = 0` であり、
// **`ADR-0251` §6 の 3 により、印の無い DB の救済には門A を新規に通す必要がある** ——
// 「一時的に止まる」ではなく「新しい門A を通すまで止まったままになる」。
// **選ばなかった案5件は `docs/plan/v5/records/v5-m5.md` §3-3 にある。**
//
// **【正直に書く】`ST_SERVER_PROFILE` を `full` にすれば、このゲートは走らない。**
// **ただしそのとき動いているのは編集系5ルートを登録したサーバであり、配布物ではない**
// (`app.ts` の起動プロファイルの doc 逐語「**`ST_SERVER_PROFILE` を外せば、同じ実行
// ファイルが5本を登録する。**」)。**「版の不一致では必ず止まる」とは書けない。**
// **`V5-M7c`**: 解決は `:59` 付近の `serverProfile` へ寄せた(束ね先の判定と同じ1つを使う)。
// **判定そのものは1バイトも変えていない。**
if (serverProfile === "runner") {
  const gate = checkRunnerVersionGate(dataRoot);
  if (!gate.ok) {
    console.error(formatGateFailure(gate));
    process.exit(1);
  }
}

const app = createServerApp({ dataRoot, authConfig });

// --- 島ランタイムの事前ロード(V1-M6-T05 第2段)-------------------------------
//
// `run_function` を含むワークフローは `createRecord` / `updateRecord`(HTTP 経路の
// レコード書込)の**同期**発火の中で島を走らせる。同期経路では `getQuickJSSync()` を使い、
// これは `getQuickJS()` を事前に解決していないと throw する(未ロードなら run_function は
// fail-closed する)。**リッスンを始める前にここで1度ロードしておく**ことで、以後の
// 発火経路が確実に島を実行できる。`getQuickJS()` は共有インスタンスをキャッシュするので
// 冪等。**ロードに失敗しても起動は止めない**(run_function 以外は動く)。
try {
  await ensureIslandRuntimeReady();
} catch (error) {
  console.error(
    `[smailtalk server] 島ランタイム(QuickJS-WASM)の事前ロードに失敗しました。` +
      `**run_function を含むワークフローは実行時に fail-closed します**(サーバ自体は動き続けます)。`,
  );
  console.error(error);
}

const server = Bun.serve({
  hostname: HOSTNAME,
  port,
  fetch: app.fetch,
});

// --- ワークフローのスケジューラ(V1-M2-T08 単位2)-----------------------------
//
// **リッスンを始めた後に起動する。****そして失敗しても起動を止めない**(完了条件5)。
// `recover` の `process.exit(1)` を**真似てはならない** —— あちらは「未完了の適用が
// 残ったまま起動すると、ユーザが誤った現状を正しい現状として読む」から落とすのであり、
// **スケジューラが動かないことは、HTTP API とMCP が動かない理由にならない。**
//
// **黙って落ちもしない**(憲法6)。動かないなら、動かないと `console.error` に書く。
//
// `startWorkflowScheduler` は返るまでにファイルもDBも1つも開かない(タイマーを1つ
// 登録するだけ)ので、**正常時の起動は1バイトも書き換えないまま**である
// (`src/server/index.test.ts` の「正常時の無副作用」が固定している)。
try {
  startWorkflowScheduler({ dataRoot, timeZone });
} catch (error) {
  console.error(
    `[smailtalk server] ワークフローのスケジューラを開始できませんでした。` +
      `**schedule トリガーのワークフローは1本も発火しません**(サーバ自体は動き続けます)。`,
  );
  console.error(error);
}

// 自動バックアップのスケジューラ(V1-M3-T07 / ADR-0019 決定1)。`startWorkflowScheduler` と
// 同じく、返るまでにファイルもDBも1つも開かない(タイマーを1つ登録するだけ)。1時間周期の
// tick で「最新世代から24時間以上なら日次バックアップを取る」。取れないことがあっても
// HTTP API と MCP が動かない理由にはしない(黙って落ちもしない。憲法6)。
try {
  startBackupScheduler({ dataRoot });
} catch (error) {
  console.error(
    `[smailtalk server] 自動バックアップのスケジューラを開始できませんでした。` +
      `**自動バックアップは走りません**(サーバ自体は動き続けます)。`,
  );
  console.error(error);
}

// アウトボックス配送のスケジューラ(V1-M4-T04 / ADR-0020 §3 改訂2)。`call_external` が
// outbox に積んだ送信内容を、非同期の `dispatchOutbox` が周期的に配送する。上の2つと同じく、
// 返るまでにファイルもDBも1つも開かない(タイマーを1つ登録するだけ)。配送が動かないことを、
// HTTP API と MCP が動かない理由にはしない(黙って落ちもしない。憲法6)。
try {
  startOutboxDispatcher({ dataRoot });
} catch (error) {
  console.error(
    `[smailtalk server] アウトボックス配送のスケジューラを開始できませんでした。` +
      `**外部送信(call_external の配送)は行われません**(サーバ自体は動き続けます)。`,
  );
  console.error(error);
}

// AI ジョブ配送のスケジューラ(V1-M5-T02 / ADR-0021 §3c)。`ai_transform` が ai_jobs に
// 積んだ呼び出しを、非同期の `dispatchAiJobs` が周期的に配送する(推論 → 出力検証 →
// レコードへ書き戻し)。上と同じく、返るまでにファイルもDBも開かない。配送が動かないことを、
// HTTP API と MCP が動かない理由にはしない(黙って落ちもしない。憲法6)。
try {
  startAiDispatcher({ dataRoot });
} catch (error) {
  console.error(
    `[smailtalk server] AI ジョブ配送のスケジューラを開始できませんでした。` +
      `**AI 呼び出し(ai_transform の配送)は行われません**(サーバ自体は動き続けます)。`,
  );
  console.error(error);
}

console.log(
  `smailtalk server: http://${server.hostname}:${server.port} ` +
    `(dataRoot=${dataRoot}, timeZone=${timeZone})`,
);
