/**
 * **入口の本数の全量表**(`V5-M25-T05` / `L-G12` /
 * [`ADR-0176`](../../docs/adr/0176-manual-trigger-entry-point.md) 限定1 / 限定2 / 限定6)。
 *
 * ## なぜこのファイルが要るのか(**`ADR-0176` §Context 3 の実測を引く**)
 *
 * > **【最も重い実測】** **ルート44本・ツール23本という本数そのものを機械的に固定している
 * > テストは、探した範囲で1本も見つからなかった**(`src/mcp/server.test.ts:70` は
 * > `toBeGreaterThan(0)` を見ているだけである)。**これは「未確認」ではない —— 探して0件だった。**
 * > **したがって入口が増えたことは、既存の検査が赤くなることでは検出されない。**
 *
 * **本ファイルがその0件を1件にする。** **`ADR-0176` §限界2 の逐語「**【禁止】「入口の
 * 本数は守られている」と書かない** —— 守る仕組みは `V5-M25-T05` が作るまで1本も無い」は、
 * **本ファイルが在る今日から、この1本の射程の中でだけ**満たされる。
 *
 * ## **表は1つだけである**(限定6)
 *
 * **HTTP と MCP を同じファイルに置く。** **分けると片方だけが更新される。**
 *
 * ## この検査が言えないこと(**丸めない**)
 *
 * - **走査は正規表現である。** **`app.get(...)` の形で書かれていない登録**(変数経由・
 *   `app.route()` によるマウント・middleware だけの経路)**は1本も数えていない。**
 * - **静的配信 / SPA フォールバック(`app.use` / `app.notFound` 等)を数えていない** ——
 *   **数えているのは「メソッド + パス」で登録された API の口だけである。**
 * - **本ファイルは「増えたら赤くなる」を作るだけで、増やしてよいかは1文字も判定しない。**
 *   **判定するのは `ADR-0007` の門A である。**
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

/**
 * 走査対象の HTTP ルート定義ファイル(`ADR-0176` §Context 3 が数えた3本 **+ 1本**)。
 *
 * **【`V5-M3-T01`(2026-08-06)で4本目が増えた】** **`src/server/change-routes.ts`。**
 * **編集系5ルート(`POST /diffs` / `POST /undo` / `GET /undo/preview` / `GET /changelog` /
 * `GET /requirements`)を `app.ts` から移設したものである。** **口は1本も増えていない**
 * —— **45本のまま、5本の定義位置が変わっただけである**(移設した時点でこの検査は実際に
 * 赤くなり、上記5本が `- Expected - 5` として出た)。
 *
 * **【この4本目が持ち込んだ穴。丸めない】** **`change-routes.ts` の5本は
 * `createServerApp({ profile: "runner" })` では1本も登録されない**(`V5-M3-T02`)。
 * **本検査は「ソースに定義が在るか」しか見ておらず、どの起動プロファイルで登録されるかを
 * 1バイトも見ていない。** **プロファイル別の登録は `src/server/runner-profile.test.ts` が見る。**
 *
 * **【`V5-M3b` / `D-V5-96`(2026-08-06)で穴が広がった】** **起動プロファイルで登録の有無が
 * 変わる口は `change-routes.ts` の5本だけではなくなった** —— **`auth-routes.ts` の逃げ道
 * CSS 4本(`GET`・`POST` `/escape-hatch-assets` / `GET …/requests` / `DELETE …/:asset_id`)と
 * `app.ts` の `GET /api/apps` を合わせた10本が `runner` では登録されない。**
 * **本表の45本は1行も増減していない** —— **定義はソースに在り続けるためである。**
 */
const ROUTE_FILES = [
  join(SRC, "server", "app.ts"),
  join(SRC, "server", "auth-routes.ts"),
  join(SRC, "server", "change-routes.ts"),
  join(SRC, "server", "inbound-route.ts"),
];

/** 走査対象の MCP ツール定義ファイル。 */
const TOOL_FILES = [join(SRC, "mcp", "tools", "read.ts"), join(SRC, "mcp", "tools", "write.ts")];

function scanRoutes(): string[] {
  const found: string[] = [];
  for (const file of ROUTE_FILES) {
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(/app\.(get|post|patch|delete|put)\("([^"]+)"/g)) {
      found.push(`${(match[1] as string).toUpperCase()} ${match[2]}`);
    }
  }
  return found.sort();
}

function scanTools(): string[] {
  const found: string[] = [];
  for (const file of TOOL_FILES) {
    const source = readFileSync(file, "utf-8");
    for (const match of source.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)) {
      found.push(match[1] as string);
    }
  }
  return found.sort();
}

/**
 * **HTTP の口の全量**(2026-08-05 実測。**45本**)。
 *
 * **着手前は44本だった。** **45本目が `POST /api/apps/:app_id/views/:view_id/actions/run`
 * (手動起動)である**(`ADR-0176` 限定1 = 44 → 45)。
 * **2本目を足していない** —— **一括起動・状態照会・取り消しの口を1つも作っていない。**
 *
 * ## **【`V7-M5-T02`(`Z-G19`)による更新。旧文を1バイトも消していない】(2026-08-09)**
 *
 * **46本目が `GET /api/apps/:app_id/tables/:table_id/unreachable-records` である** ——
 * **「誰にも見えない行」(付与が1件も無い行)を運営者が見つけるための、読取専用の口である**
 * (`D-V7-15` / `v7-m0.md` §6-3 `Z-G19`)。
 *
 * **【この更新が越えたもの。丸めない】** —— **`ADR-0176` 限定1 の第4列は
 * 「新設する全量表の検査(HTTP **45**)」であり、本表の `45` はその機械的な固定であった。**
 * **今日その数字は 46 になった。** **`ADR-0176` の主題(手動起動の入口を1本に限る)は
 * 1バイトも破っていない**(下の「手動起動の HTTP の口は1本だけ」は今日も緑である)——
 * **破ったのは「HTTP の口の総数を 45 に固定する」という、限定1 の第4列の読み方の方である。**
 * **`Z-G19` の `S2`(門A・catch-all)は本ファイルを変更予定ファイルに挙げていない** ——
 * **挙げ漏れであり、実装で実際に赤くなった。** **この事実を消さずにここに書く。**
 * **【禁止】この更新を「`ADR-0176` の想定内である」と書かない。**
 *
 * ## **【`V8-M41`(台帳 `F-G14` / `ADR-0332`)による更新。旧文を1バイトも消していない】(2026-08-14)**
 *
 * **48本目が `POST /api/apps/:app_id/inbound-endpoints` である** ——
 * **受信口(inbound endpoint)を人が発行できる口である**(`v8-m33.md` §1-A の `A-8` /
 * `v8-m35.md` §5-1 の `F-G14`)。
 *
 * **【この更新は「3度目」である。数え直して書く】** —— **45 → 46(`V7-M5-T02`)/
 * 46 → 47(`V8-M21` 後半)/ 47 → 48(本更新)。** **本ファイルの `:209` / `:214` /
 * `:219` に、45 / 46 / 47 の3世代の旧の期待値が逐語のコメントで残っている。**
 *
 * **【`ADR-0176` 限定1 の違反ではない理由。計画の裁定 `F-20` の逐語を引く】**
 * (`docs/plan/v8/06-defect-closure-baseline.md` の `F-G14` の (3)):
 * 「**`ADR-0176:113` の逐語は「**新設する全量表の検査は、将来の全ての入口追加を赤くする。
 * それが本 ADR の実質である。**」であり、作ったのは**検査**であって門ではない。限定1 は
 * 「**一括起動・状態照会・取り消しの口を1つも作らない**」で手動起動に閉じている。**」/
 * 「**検査値は `ADR-0299` §5 と `ADR-0313` §4 で既に2度、本文を1バイトも書き換えずに
 * 引き直されている** —— **47 → 48 は限定1 違反ではなく、同じ手続きの3度目である。**」
 * **本更新も `ADR-0176` の本文を1バイトも書き換えていない。**
 * **手動起動の口は今日も1本のままである**(下の検査が緑である)。
 *
 * **【`F-G14` の門は割れていた。両方の読みを残す】** —— **計画の §5 は門外(`Δ7`)、
 * 枠 §D と §6 は catch-all で門A であった**(裁定 `F-20`)。 **本審査(`V8-M35` §5-5)が
 * **門A** に倒した** —— **理由は「網から漏れたものは必ず重い側へ落ちる」(`ADR-0007:109`)。**
 * **【禁止】これを「条文どおりに解けた」と書かない** —— **`ADR-0007` はこの競合の解き方を
 * 1文字も書いていない。**
 */
const HTTP_ENTRY_POINTS: readonly string[] = [
  "DELETE /api/apps/:app_id/ai-capabilities/:capability_id",
  "DELETE /api/apps/:app_id/auth/me",
  "DELETE /api/apps/:app_id/connections/:connection_id",
  "DELETE /api/apps/:app_id/escape-hatch-assets/:asset_id",
  "DELETE /api/apps/:app_id/tables/:table_id/records/:record_id",
  "GET /api/apps",
  "GET /api/apps/:app_id/ai-capabilities",
  "GET /api/apps/:app_id/ai-capabilities/requests",
  "GET /api/apps/:app_id/auth/activity",
  "GET /api/apps/:app_id/auth/me",
  "GET /api/apps/:app_id/auth/users",
  "GET /api/apps/:app_id/changelog",
  // **52本目**(`V10-M15-T05` / 台帳 `CM-G21` / `ADR-0370`)。**対応できないまま残った
  // コメントを一覧する読出の口。** **クエリは `state` だけ(任意)。`limit` / `offset` は
  // 置かない。**
  "GET /api/apps/:app_id/comments",
  "GET /api/apps/:app_id/connections",
  "GET /api/apps/:app_id/connections/requests",
  "GET /api/apps/:app_id/escape-hatch-assets",
  "GET /api/apps/:app_id/escape-hatch-assets/requests",
  "GET /api/apps/:app_id/files/:file_id",
  "GET /api/apps/:app_id/manifest",
  // **47本目**(`V8-M21` の後半 / 台帳 `J-G24b` / ユーザ決定 `D-V8-34`)。
  // **未ログインへ渡る最小限**(アプリ名と、未ログインでも見せると決めた画面の名前だけ)。
  // **`GET /manifest` がログインを要求するようになったので、ログイン画面を描くために
  // 1本だけ足した** —— **`J-G24b` の限定「口を足すなら1本」ちょうどである。**
  // **2本目を足していない。**
  "GET /api/apps/:app_id/public",
  "GET /api/apps/:app_id/requirements",
  "GET /api/apps/:app_id/tables/:table_id/records",
  "GET /api/apps/:app_id/tables/:table_id/records/:record_id",
  // **46本目**(`V7-M5-T02` / `Z-G19`)。**読取専用の運営用の口である** ——
  // **同じパスに `POST` / `PATCH` / `DELETE` は1本も無い**(上の並びを見れば分かる形で
  // あることが、この表を「名称の全量」で突き合わせている理由でもある)。
  "GET /api/apps/:app_id/tables/:table_id/unreachable-records",
  "GET /api/apps/:app_id/undo/preview",
  "GET /api/apps/:app_id/views/:view_id/custom.css",
  // **50本目**(`V8-M8` / 台帳 `Q-G1` / 門A 本審査 = `V8-M7`)。**集計表を1つ計算して返す
  // 読取専用の口である** —— **同じパスに `POST` / `PATCH` / `DELETE` は1本も登録して
  // いない**(`Q-G35`「集計値を書き込む口が HTTP に1つも無い」)。**並びはアルファベット順
  // なので、`custom.css` の隣に入る。**
  "GET /api/apps/:app_id/views/:view_id/report",
  "PATCH /api/apps/:app_id/ai-capabilities/:capability_id/limit",
  "PATCH /api/apps/:app_id/auth/users/:user_id",
  "PATCH /api/apps/:app_id/tables/:table_id/records/:record_id",
  "POST /api/apps/:app_id/ai-capabilities",
  // **49本目**(`V8-M2-T04` / 台帳 `I-G9` / `ADR-0336` 限定5)。
  // **運営者が招待を発行する口である** —— **着手前は HTTP にも MCP にも招待の口が1本も
  // 無かった**(実測: `招待|invite|invitation` は `src` `schemas` `web` `scripts` に0件。
  // `V8-M0` の面3)。
  // **`ADR-0336` 限定5 により、同じパスに `GET` / `DELETE` / `PATCH` は1本も無い** ——
  // **取り消しと出し直しは、この1本の**引数**で表す**(`PATCH .../auth/users/:user_id` が
  // 役割の付け外しを引数で表したのと同型)。**一覧も口を足さず、既存の
  // `GET /api/apps/:app_id/auth/users` の応答に足した**(限定12)。
  // **この「無いこと」は `src/server/invitation-issuance.test.ts` の (g) が 404 で
  // 機械的に固定している。**
  "POST /api/apps/:app_id/auth/invitations",
  "POST /api/apps/:app_id/auth/logout",
  "POST /api/apps/:app_id/auth/passkey/login/options",
  "POST /api/apps/:app_id/auth/passkey/login/verify",
  "POST /api/apps/:app_id/auth/passkey/register/options",
  "POST /api/apps/:app_id/auth/passkey/register/verify",
  "POST /api/apps/:app_id/auth/password/change",
  "POST /api/apps/:app_id/auth/password/login",
  "POST /api/apps/:app_id/auth/password/register",
  // **【`V5-M17-T04` / `G-G6` / `ADR-0158` 限定9】経路の名前から利用者の種類を外した。**
  // **着手前は `POST /api/apps/:app_id/auth/customer/password/register` だった**
  // (`ADR-0176` 限定1 の「45本ちょうど」は動いていない —— **1本消えて1本増えた**)。
  // **旧パスは残していない**(実測: 旧パスへの POST は 404。
  // `src/server/declared-user-kind-scope.test.ts` の (1))。
  "POST /api/apps/:app_id/auth/signup/password/register",
  "POST /api/apps/:app_id/batch",
  // **51本目**(2026-08-24。`V10-M11-T01` / 台帳 `CM-G4` = **門外**(`Δ7`)/ 限定採用)。
  // **アプリを使う人が、画面へのコメントを1件書く口である。** **`src/server/auth-routes.ts` に置いた**
  // —— **`change-routes.ts` に置くと `profile: "runner"` で登録されず、`runner-profile.test.ts` の
  // `dropped` が 12 → 13 になって `CM-G4` 限定3 と正面から当たる**(実測済み)。
  // **`CM-G4` 限定1 は「50 → 51。2本目を足さない」である。** **`M9-T11-DECISIONS.md` 決定1 は
  // 軸全体で 50 → **52** と書いているが、読出の口(`CM-G21`)を足すのは `V10-M15-T05` であり、
  // **本工程の窓では実物のルートが 51本しか無い**(台帳だけ 52 にすると `:298` の全量一致が赤のまま残る)。
  // **したがって本工程は 51 にする。** **52 にするのは `V10-M15-T05` である。**
  "POST /api/apps/:app_id/comments",
  "POST /api/apps/:app_id/connections",
  "POST /api/apps/:app_id/diffs",
  "POST /api/apps/:app_id/escape-hatch-assets",
  "POST /api/apps/:app_id/files",
  // **48本目**(`V8-M41` 後半 / 台帳 `F-G14` / `ADR-0332` / `ADR-0041` 限定1)。
  // **受信口(inbound endpoint)を人が発行できる口である** —— **着手前は HTTP にも MCP にも
  // 発行の口が1本も無く、`request_inbound_endpoint`(AI)は申請までだった**
  // (`v8-m33.md` §1-A の `A-8`)。
  // **`ADR-0332` 限定3 により、同じパスに `GET` / `DELETE` / `PATCH` は1本も無い** ——
  // **再発行・失効・一覧の口を1本も作っていない**(上の `unreachable-records` の行と
  // 同じ形の申し送りである)。**この「無いこと」は
  // `src/server/inbound-endpoint-issuance.test.ts` の (6) が 404 で機械的に固定している。**
  "POST /api/apps/:app_id/inbound-endpoints",
  "POST /api/apps/:app_id/tables/:table_id/records",
  "POST /api/apps/:app_id/undo",
  // **45本目**(`V5-M25-T05` / `ADR-0176` 限定1)。
  "POST /api/apps/:app_id/views/:view_id/actions/run",
  "POST /inbound/:endpoint_id",
];

/**
 * **MCP の口の全量**(2026-08-05 実測。**23本**)。
 *
 * **1本も足していない**(`ADR-0176` 限定2)—— **`run_workflow` / `run_function` /
 * `trigger_*` の MCP ツールは今日も1本も無い。**
 * **`ADR-0176` §Context 2 の帰属先申告(答え = MCP 層には帰属しない)の機械的な担保が
 * この配列である。**
 */
const MCP_ENTRY_POINTS: readonly string[] = [
  "apply_diff",
  "create_app",
  "delete_app",
  "delete_record",
  // **【2026-08-25。`V10-M28-T02`。台帳 `FU-G`(追いの直し)ではなく `V10-M9` の軸2の外】**
  // **この口に `app` × `write` の判定が入った**(`src/mcp/tools/write.ts` の
  // `denyAppSettingWrite` を、更新系と**同じ1本**として呼ぶ)。
  // **本数は 25 のまま動いていない** —— **口を1本も足していないからである。**
  "dry_run_diff",
  "generate_requirements_doc",
  "get_changelog",
  "get_manifest",
  "get_preview_url",
  "insert_sample_data",
  "list_apps",
  // **【2026-08-24。`V10-M12-T01`。台帳 `CM-G7` = 限定採用(門A)。門A 本審査 = `V10-M9`】**
  // **25本目。積まれたコメントを読み出す参照系の道具である**(`registerReadTools` が登録する)。
  // **読むだけで、書込の口を1つも作っていない**(`ADR-0368` 限定2)。
  // **`ADR-0346` §1 の限定1「24を超えない」は `ADR-0368` が引き直した** ——
  // **今日の上限は 25 であり、ちょうど 25 になった。**
  "list_comments",
  "list_records",
  "preview_redo",
  "preview_undo",
  // **【2026-08-15。`V8-M13-T02`。台帳 `Q-G28` = 限定採用(門A)。門A 本審査 = `V8-M7`】**
  // **24本目。集計表を1枚読む参照系の道具である**(`registerReadTools` が登録する)。
  // **読むだけで、書込の口を1つも作っていない。**
  // **限定1 の逐語は「道具は24本を超えない」であり、今日ちょうど 24 になった。**
  "read_report",
  "redo",
  "report_drift",
  "request_ai_capability",
  "request_connection",
  "request_custom_css",
  "request_inbound_endpoint",
  // **【2026-08-25。`V10-M30-T02`。台帳 `CM-G37` = 限定採用(門A)。門A 本審査 = `V10-M29`。
  //   `ADR-0378`】**
  // **26本目。アプリごとのコメントの出し入れを切り替える更新系の道具である**
  // (`registerWriteTools` が登録する)。
  // **`ADR-0368` 限定1 の逐語「24 → 25。26本目を足さない」を `ADR-0378` が
  //   1点ちょうど引き直した** —— **今日の上限は 26 であり、ちょうど 26 になった。**
  // **書く先は `apps` 表の列2本だけで、コメントそのものにも状態にも1バイトも触らない**
  //   (`ADR-0378` 限定6 / 線7)。
  "set_comment_visibility",
  "undo",
  "update_record",
  "write_records",
];

// **【`V7-M5-T02` による更新。旧文を1バイトも消していない】**
// **旧の名前**: `test("ADR-0176 限定1: HTTP の口は45本ちょうどで、名称の全量が一致する", …)`。
// **旧の期待値**: `expect(HTTP_ENTRY_POINTS).toHaveLength(45);`。
// **経路を1本足したので宣言どおりこの検査が赤くなり、表と本数の両方を更新した。**
// **検査は1本も消しておらず、`skip` にもしておらず、名称の全量の突き合わせも緩めていない。**
// **【`V8-M21` の後半による更新。旧文を1バイトも消していない】**
// **旧の名前**: `test("ADR-0176 限定1: HTTP の口は46本ちょうどで、名称の全量が一致する", …)`。
// **旧の期待値**: `expect(HTTP_ENTRY_POINTS).toHaveLength(46);`。
// **経路を1本足したので宣言どおりこの検査が赤くなり、表と本数の両方を更新した。**
// **検査は1本も消しておらず、`skip` にもしておらず、名称の全量の突き合わせも緩めていない。**
// **【`V8-M41` 後半(台帳 `F-G14` / `ADR-0332`)による更新。旧文を1バイトも消していない】**
// **旧の名前**: `test("ADR-0176 限定1: HTTP の口は47本ちょうどで、名称の全量が一致する", …)`。
// **旧の期待値**: `expect(HTTP_ENTRY_POINTS).toHaveLength(47);`。
// **経路を1本足したので宣言どおりこの検査が赤くなり、表と本数の両方を更新した。**
// **検査は1本も消しておらず、`skip` にもしておらず、名称の全量の突き合わせも緩めていない。**
// **これは同じ作法の3度目の適用である**(45 → 46 → 47 → 48。旧の期待値は上の3世代とも
// 逐語のコメントで残っている)。
// **【`V8-M2-T04`(台帳 `I-G9` / `ADR-0336` 限定5)による更新。旧文を1バイトも消していない】**
// **旧の名前**: `test("ADR-0176 限定1: HTTP の口は48本ちょうどで、名称の全量が一致する", …)`。
// **旧の期待値**: `expect(HTTP_ENTRY_POINTS).toHaveLength(48);`。
// **経路を1本足したので宣言どおりこの検査が赤くなり、表と本数の両方を更新した。**
// **検査は1本も消しておらず、`skip` にもしておらず、名称の全量の突き合わせも緩めていない。**
// **これは同じ作法の4度目の適用である**(45 → 46 → 47 → 48 → 49。旧の期待値は上の4世代とも
// 逐語のコメントで残っている)。
// **【禁止】これを「口は増えていない」と書かない** —— **増えた。1本ちょうどである。**
// **【禁止】これを「条文どおりに解けた」と書かない** —— **`I-G9` の門A は `Δ7` と
// catch-all が同時に成立する場面の裁定であり、`ADR-0007` はその解き方を1文字も書いていない**
// (`ADR-0336` §3 の `S3`-3 が同じことを自認している)。
// **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`。テスト名は1バイトも
// 書き換えていない】** **口は今日 50本である** —— **`GET /api/apps/:app_id/views/:view_id/report`
// (集計表を1つ計算して返す読取専用の口)を1本足した。****名称の全量を突き合わせる形は
// 1バイトも変えていないので、1本消して1本足した差し引き0も今日どおり見逃さない。**
test("ADR-0176 限定1: HTTP の口は49本ちょうどで、名称の全量が一致する", () => {
  // **本数だけでなく名称の全量を突き合わせる** —— **1本消して1本足した差し引き0を
  // 見逃さないためである。**
  expect(scanRoutes()).toEqual([...HTTP_ENTRY_POINTS]);
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`】期待値を 49 → 50 へ書き換えた。**
  // **旧行の逐語**: `expect(HTTP_ENTRY_POINTS).toHaveLength(49);`
  // **【2026-08-24。`V10-M11-T01`。台帳 `CM-G4` = 門外(`Δ7`)/ 限定採用】期待値を 50 → 51 へ
  //   書き換えた。****旧行の逐語**: `expect(HTTP_ENTRY_POINTS).toHaveLength(50);`
  // **【2026-08-24。`V10-M15-T05`。台帳 `CM-G21` = 門A / 限定採用】期待値を 51 → 52 へ
  //   書き換えた。****旧行の逐語**: `expect(HTTP_ENTRY_POINTS).toHaveLength(51);`
  //   **足したのは `GET /api/apps/:app_id/comments`(対応できないまま残ったコメントを
  //   一覧する読出の口)1本ちょうどである。**
  // **テスト名は1バイトも書き換えていない**(このリポジトリの作法。訂正は追記)——
  //   **名前の「49本ちょうど」は 2026-08-14 から字面として偽である。**
  // **【禁止】これを「口は増えていない」と書かない** —— **増えた。1本ちょうどである。**
  expect(HTTP_ENTRY_POINTS).toHaveLength(52);
});

// **【2026-08-15。`V8-M13-T02`。台帳 `Q-G28` = 限定採用(門A)。テスト名は1バイトも
//   書き換えていない】** **口は今日 24本である** —— **`read_report`(集計表を1枚読む
//   参照系の道具)を1本足した。**
// **【この名前は字面として今日から偽である】** —— **「MCP の口は23本ちょうど」は
//   2026-08-14 までの事実である。** **このリポジトリの作法(本文・テスト名を書き換えず、
//   訂正は追記)に従い、名前は1バイトも触らず、期待値だけを直した。**
// **【`ADR-0176` 限定2 を引き直す ADR は `V8-M13-T07` が書く】** —— **本タスクは ADR を
//   1本も起草していない。** **限定2 の逐語(「MCP には1本も足さない。23 のまま」)は、
//   今日この実装によって偽になった。** **`ADR-0327`(「23本の割り当て」)も同じ扱いである。**
// **名称の全量を突き合わせる形は1バイトも変えていないので、1本消して1本足した差し引き0も
//   今日どおり見逃さない。**
test("ADR-0176 限定2: MCP の口は23本ちょうどで、名称の全量が一致する", () => {
  expect(scanTools()).toEqual([...MCP_ENTRY_POINTS]);
  // **【2026-08-15。`V8-M13-T02`。台帳 `Q-G28`】期待値を 23 → 24 へ書き換えた。**
  // **旧行の逐語**: `expect(MCP_ENTRY_POINTS).toHaveLength(23);`
  // **【2026-08-24。`V10-M12-T01`。台帳 `CM-G7` / `ADR-0368`】期待値を 24 → 25 へ書き換えた。**
  // **旧行の逐語**: `expect(MCP_ENTRY_POINTS).toHaveLength(24);`
  // **【2026-08-25。`V10-M30-T02`。台帳 `CM-G37` / `ADR-0378`】期待値を 25 → 26 へ書き換えた。**
  // **旧行の逐語**: `expect(MCP_ENTRY_POINTS).toHaveLength(25);`
  // **26本目は `set_comment_visibility`(コメントの出し入れを切り替える更新系)1本である。**
  expect(MCP_ENTRY_POINTS).toHaveLength(26);
});

test("ADR-0176 限定2: 起動系の MCP ツールは1本も無い", () => {
  for (const forbidden of [
    "run_workflow",
    "run_function",
    "pause_workflow",
    "enable_workflow",
    "pause_function",
    "enable_function",
    "trigger_workflow",
  ]) {
    expect(MCP_ENTRY_POINTS).not.toContain(forbidden);
  }
});

test("ADR-0176 限定1: 手動起動の HTTP の口は1本だけである(一括起動・状態照会・取消の口が無い)", () => {
  const runEntries = HTTP_ENTRY_POINTS.filter((entry) => entry.includes("/actions/run"));
  expect(runEntries).toEqual(["POST /api/apps/:app_id/views/:view_id/actions/run"]);
  // **`GET`(状態照会)も `DELETE`(取り消し)も1本も無い。**
  expect(HTTP_ENTRY_POINTS.filter((entry) => entry.includes("/actions/"))).toHaveLength(1);
});

test("限定6: 全量表を持つファイルは1本だけである(表を2つに分けない)", () => {
  // **本ファイル自身が唯一の表である。** **同じ役目のファイルが増えたら、
  // 片方だけが更新される状態になる。**
  const self = readFileSync(join(import.meta.dir, "entry-point-inventory.test.ts"), "utf-8");
  expect(self).toContain("HTTP_ENTRY_POINTS");
  expect(self).toContain("MCP_ENTRY_POINTS");
});

// =====================================================================================
// **入口ごとの「アクセス権の判定を受けているか」の全量表**
// (`V8-M21` の後半。台帳 `J-G26` の限定採用 / `ADR-0176` 限定6)
//
// ## **`J-G26` の限定の逐語(これが仕様である)**
//
// > **`src/server/entry-point-inventory.test.ts` の1本に統合する。表を2つに分けない。
// > きっかけによって効いたり効かなかったりする経路を機械で表せる形にする**
//
// **着手前、この表は `src/server/access-control-paths.test.ts` に在った**(`V7-M3-T02` が
// 置き、`V8-M21` の前半が 8本 → 14本 にした)。**入口の一覧が2つのファイルに分かれており、
// 片方だけが更新されうる状態だった** —— **`ADR-0176` 限定6 が「入口の本数の全量表を1つだけ
// 持つ。表を2つに分けない」と定めているのと同じ危険である。**
// **本節への移設がその統合であり、`ROUTES` の行も `REGISTERED_ROUTES` の行も
// **1行も消していない**(そのまま移した。`trigger` の1キーだけを足した)。**
//
// **移設した検査**: `(A-1)` / `(A-2)` / `(A-3)` / `(B-1)` / `(B-2)` / `(B-3)`。
// **`access-control-paths.test.ts` に残したもの**: `(B-2b)` / `(B-4)` / `(B-5)` / `(C-*)` /
// `(D)(E)(F)`(**`ROUTES` を1度も参照しない検査**)。
//
// **【禁止】この表を見て「全部の入口に効く」と書かない**(`04-rbac-abac-baseline.md` §9 の 1)
// —— **素通りする経路は今日2本ある**(AI(MCP)= `D-V8-20` / 決まった時刻に動く処理 =
// `D-V8-33`)。**下の `(B-2)` がそれを機械で固定している。**
// =====================================================================================

const APP_PATH = join(SRC, "server", "app.ts");

/**
 * **判定の綴り**(`V8-M21` の後半。`src/server/access-control-paths.test.ts` から**写した**)。
 *
 * **【なぜ写しているのに「表を2つに分けた」ことにならないか】** —— **`J-G26` /
 * `ADR-0176` 限定6 が1本に保てと言っているのは**入口の一覧**であって、綴りの定数ではない。**
 * **綴りが食い違えば、どちらのファイルの検査も同時に赤くなる**(同じ実物を走査している)。
 * **入口の一覧そのもの(`REGISTERED_ROUTES` / `ROUTES`)は、このファイルにしか無い。**
 */
/** 判定の配管(`recordAccessJudge`)と判定そのもの(`judgeRecordAccess`)の綴り。 */
const JUDGE_PIPE = "recordAccessJudge(";
const JUDGE_HOME = "judgeRecordAccess(";
/** 引き継ぎ(`inherit_from`)を辿ってから各段で {@link JUDGE_HOME} を呼ぶ側。 */
const JUDGE_RESOLVER = "resolveRecordAccess(";
/** 面(役割に束ねた権限)と点(行ごとの付与)を `OR` で重ねる側。 */
const JUDGE_COMBINER = "resolveCombinedRecordAccess(";

/** 登録行の正規表現(`app.get("…"` / `app.post("…"` …)。**登録順に返す。** */
const ROUTE_PATTERN = /\bapp\.(get|post|patch|delete|put|all|options|head)\(\s*"([^"]+)"/g;

type Registration = { readonly key: string; readonly index: number };

function registrationsOf(source: string): Registration[] {
  const found: Registration[] = [];
  ROUTE_PATTERN.lastIndex = 0;
  let match = ROUTE_PATTERN.exec(source);
  while (match !== null) {
    found.push({ key: `${match[1]?.toUpperCase()} ${match[2]}`, index: match.index });
    match = ROUTE_PATTERN.exec(source);
  }
  return found;
}

/** ハンドラ1本の本文(登録行から次の登録行の直前まで。最後の1本はファイル末尾まで)。 */
function bodyOf(source: string, registrations: Registration[], key: string): string {
  const at = registrations.findIndex((registration) => registration.key === key);
  if (at < 0) {
    throw new Error(`経路 "${key}" が app.ts に見つからない`);
  }
  const start = registrations[at]?.index ?? 0;
  const end = registrations[at + 1]?.index ?? source.length;
  return source.slice(start, end);
}

function judgedIn(body: string): boolean {
  return body.includes(JUDGE_PIPE) || body.includes(JUDGE_HOME);
}

/**
 * **`src/server/app.ts` が登録する HTTP 経路の全量**(2026-08-08 実測)。
 *
 * **この一覧は固定値である。** **`app.ts` に経路を1本足すと、下の (A-1) が赤くなる** ——
 * **足した人は、その経路が行を返す / 書く / 消すのかを判断し、`ROUTES` の側にも1行足す
 * ことになる。** **これが「新しいハンドラが増えたときに検査が赤くなる形」の実体である。**
 */
const REGISTERED_ROUTES: readonly string[] = [
  "POST /api/apps/:app_id/views/:view_id/actions/run",
  "GET /api/apps",
  "GET /api/apps/:app_id/manifest",
  // **【`V8-M21` の後半 / 台帳 `J-G24b` / ユーザ決定 `D-V8-34`】が足した1本。**
  // **未ログインへ渡る最小限**(アプリ名と、未ログインでも見せると決めた画面の名前だけ)。
  // **行を返す口だが、**レコードを1件も返さない** —— 下の判定の全量表(`ROUTES`)には
  // 足していない。** **理由**: **アクセス権の判定を受ける対象は「行を返す / 書く / 消す」
  // 経路であり、この口はアプリの定義の一部(2つの名前)しか返さないためである。**
  // **【隠さない】** **この口が未ログインに渡すものが正しいかは、`ROUTES` ではなく
  // `src/server/auth-boundary.test.ts` の `#26` が本文ごと固定する。**
  "GET /api/apps/:app_id/public",
  "GET /api/apps/:app_id/tables/:table_id/records",
  "GET /api/apps/:app_id/tables/:table_id/records/:record_id",
  // **【`V7-M5-T02`(`Z-G19`)が足した1本。旧の一覧から1行も消していない】**
  // **「誰にも見えない行」を見つける運営専用の口である**(**読取専用**。
  // **同じパスに `POST` / `PATCH` / `DELETE` を1本も生やしていない**ことは
  // `src/server/record-access-orphans.test.ts` の (E-1)(E-2) が固定する)。
  // **`/records` の下ではなく兄弟のパスに置いた** —— 単件 `GET` の `:record_id` と
  // ルート照合がぶつからないようにするためである(実測は同テストの (I-1)〜(I-3))。
  "GET /api/apps/:app_id/tables/:table_id/unreachable-records",
  "POST /api/apps/:app_id/tables/:table_id/records",
  "PATCH /api/apps/:app_id/tables/:table_id/records/:record_id",
  "DELETE /api/apps/:app_id/tables/:table_id/records/:record_id",
  "POST /api/apps/:app_id/batch",
  "POST /api/apps/:app_id/files",
  "GET /api/apps/:app_id/files/:file_id",
  // **【2026-08-14。`V8-M8` / 台帳 `Q-G1`】集計表の口を1本足した。****並びは
  // `app.ts` の登録順そのものなので、`custom.css` の直前に入る。**
  "GET /api/apps/:app_id/views/:view_id/report",
  "GET /api/apps/:app_id/views/:view_id/custom.css",
];

/**
 * **`app.ts` の登録行では切り出せない入口の出どころ**(`V8-M21` が足した)。
 *
 * **受信口・自動処理・島は `app.ts` に1行も無い** —— **受信口は
 * `src/server/inbound-route.ts`、自動処理と島は `src/kernel/workflow-runner.ts` に在る。**
 * **そこで「どのファイルの、どの入口の中を見るか」を行そのものに持たせた** ——
 * **表を2本に割らないためである**(`ADR-0176` 限定6 と同じ作法)。
 *
 * **`from` から次の `\n}\n` までをその入口の本文とする**(`(C-2)` が
 * `owner-scope.ts` の関数本文を切り出すのに使っているのと同じ数え方である)。
 */
type RouteSource = {
  readonly file: string;
  /** その入口の始まりの綴り。 */
  readonly from: string;
  /** **その本文に在れば「判定を受けている」とみなす綴り**(1つでも在れば真)。 */
  readonly judge: readonly string[];
};

/**
 * **`V8-M21` が配線した3経路と、素通りする2経路が名指しする判定の綴り。**
 *
 * **どれも `src/server/owner-scope.ts` の既存の述語に届く** ——
 * **`inboundAccessDenied` は `creatorGrantPlan` を、`judgeAutomationWrite` は
 * `creatorGrantPlan` と `resolveRecordAccess` を呼ぶ**(下の (B-4) が固定する)。
 */
const AUTOMATION_JUDGE_SPELLINGS: readonly string[] = [
  "inboundAccessDenied(",
  "judgeAutomationWrite(",
  "judgeOutputTableReplace(",
  JUDGE_HOME,
  JUDGE_RESOLVER,
  "creatorGrantPlan(",
  // **【`V8-M31-T07` が足した1綴り。旧文を1バイトも消していない】**
  // **旧: この配列は6要素で、`JUDGE_COMBINER` が入っていなかった**
  //   (`"inboundAccessDenied("` / `"judgeAutomationWrite("` / `"judgeOutputTableReplace("` /
  //    `JUDGE_HOME` / `JUDGE_RESOLVER` / `"creatorGrantPlan("` の6つ。**1つも消していない**)。
  // **`V8-M31` が MCP の書込に配線したのは合成の判定(面 = 役割に束ねた権限 と
  //   点 = 行ごとの付与 を `OR` で重ねる側)であり、その綴りは
  //   `resolveCombinedRecordAccess(` である。** **`resolveRecordAccess(` を部分文字列として
  //   含まない**(`resolve` の直後が `Combined`)ので、足さないと配線しても数えられない。
  // **【この1綴りを足しても、素通しの行は素通しのまま数えられる】** ——
  //   **`runScheduledWorkflow`(`no: 13`)の本文には、この6+1綴りが今日も1つも無い**
  //   (実測。だから (B-2) は `no: 13` を `judged: false` として捕まえ続ける)。
  JUDGE_COMBINER,
];

/**
 * **きっかけ**(`V8-M21` の後半 / 台帳 `J-G26` の限定「**きっかけによって効いたり効かなかったり
 * する経路を機械で表せる形にする**」)。
 *
 * **これが要る理由は実物にある** —— **`src/kernel/workflow-runner.ts` の同じワークフローの
 * しくみが、きっかけによって判定を受けたり受けなかったりする。**
 * **登録起動(`on_create` / `on_update`)は判定を受け、時刻起動(`schedule`)は素通りする**
 * (`D-V8-33` / 台帳 `J-G22b` = 保留 / `docs/plan/undecided.md` の `U-3`)。
 * **ファイル名だけでは、この割れを表せない。**
 */
type EntryTrigger = "http" | "manual" | "inbound" | "on_create/on_update" | "schedule" | "mcp";

const ROUTES: readonly {
  readonly no: number;
  readonly name: string;
  readonly trigger: EntryTrigger;
  readonly key: string;
  readonly expected: "wired" | "pending";
  readonly wiredBy: string;
  /** **`app.ts` 以外に在る入口**(`V8-M21`)。**省略なら `app.ts` の登録行から切り出す。** */
  readonly source?: RouteSource;
}[] = [
  {
    no: 1,
    name: "一覧 GET",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "http",
    key: "GET /api/apps/:app_id/tables/:table_id/records",
    expected: "wired",
    wiredBy: "V7-M2-T02",
  },
  {
    no: 2,
    name: "単件 GET",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "http",
    key: "GET /api/apps/:app_id/tables/:table_id/records/:record_id",
    expected: "wired",
    wiredBy: "V7-M2-T02",
  },
  {
    no: 3,
    name: "POST",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "http",
    key: "POST /api/apps/:app_id/tables/:table_id/records",
    expected: "wired",
    wiredBy: "V7-M3-T02",
  },
  {
    no: 4,
    name: "PATCH",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "http",
    key: "PATCH /api/apps/:app_id/tables/:table_id/records/:record_id",
    expected: "wired",
    wiredBy: "V7-M2-T02",
  },
  {
    no: 5,
    name: "DELETE",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "http",
    key: "DELETE /api/apps/:app_id/tables/:table_id/records/:record_id",
    // **【`V7-M3-T06` による更新。旧文を1バイトも消していない】**
    // **旧: `expected: "pending"` / `wiredBy: "V7-M3-T06(未着手)"`。**
    // **`V7-M3-T06` が行ごとのアクセス権の `delete` を配線したので、宣言どおり (B-2) が
    // 赤くなり、ここを `"wired"` に書き換えた** —— **検査は1本も消していない。**
    expected: "wired",
    wiredBy: "V7-M3-T06",
  },
  {
    no: 6,
    name: "画面の操作起点",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "manual",
    key: "POST /api/apps/:app_id/views/:view_id/actions/run",
    expected: "wired",
    wiredBy: "V7-M3-T02",
  },
  {
    no: 7,
    name: "バッチ",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "http",
    key: "POST /api/apps/:app_id/batch",
    expected: "wired",
    wiredBy: "V7-M3-T02",
  },
  {
    no: 8,
    name: "ファイル配信",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "http",
    key: "GET /api/apps/:app_id/files/:file_id",
    // **【`V7-M3-T07` による更新。旧文を1バイトも消していない】**
    // **旧: `expected: "pending"` / `wiredBy: "V7-M3-T07(未着手)"`。**
    // **`V7-M3-T07` がファイル配信に判定を配線したので、宣言どおり (B-2) が赤くなり、
    //   ここを `"wired"` に書き換えた** —— **検査は1本も消していない。**
    // **これで 8/8 が「呼んでいる」側に入った。**
    expected: "wired",
    wiredBy: "V7-M3-T07",
  },
  // ===================================================================================
  // **【`V8-M21` が足した6行】** **`D-V8-18`(判定が効く入口)。旧の8行は1バイトも
  // 書き換えていない。**
  //
  // **根拠は台帳 `docs/adr/0007-vocabulary-governance.md` §8 の次の単位である**:
  //  - **`J-G21`**(受信口。**限定採用**)/ **`J-G22a`**(登録をきっかけに動く処理。**限定採用**)
  //  - **`J-G23`**(コードの島。**限定採用**)/ **`J-G22b`**(決まった時刻に動く処理。**保留**)
  // **ユーザ決定は `D-V8-18` / `D-V8-20`(AI は常に管理者)/ `D-V8-33`(時刻起動は素通し)。**
  // **メインの裁定は `R-8`(fail-closed に倒れることを先に認める)。**
  // **`ADR` 番号は本タスクでは1つも採番していない**(ADR の起草は `docs/` の担当である)。
  // ===================================================================================
  {
    no: 9,
    name: "受信口",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "inbound",
    key: "POST /inbound/:endpoint_id",
    // **`app.ts` には1行も無い**(`src/server/inbound-route.ts` が登録する)。
    expected: "wired",
    wiredBy: "V8-M21(台帳 J-G21)",
    source: {
      file: join(SRC, "server", "inbound-route.ts"),
      from: 'app.post("/inbound/:endpoint_id"',
      judge: AUTOMATION_JUDGE_SPELLINGS,
    },
  },
  {
    no: 10,
    name: "登録をきっかけに動く処理(create_record / update_record)",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "on_create/on_update",
    key: "workflow-runner: runAction",
    expected: "wired",
    wiredBy: "V8-M21(台帳 J-G22a)",
    source: {
      file: join(SRC, "kernel", "workflow-runner.ts"),
      from: "function runAction(",
      judge: AUTOMATION_JUDGE_SPELLINGS,
    },
  },
  {
    no: 11,
    name: "コードの島(write_ops)",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "on_create/on_update",
    key: "workflow-runner: applyIslandWriteOps",
    expected: "wired",
    wiredBy: "V8-M21(台帳 J-G23)",
    source: {
      file: join(SRC, "kernel", "workflow-runner.ts"),
      from: "function applyIslandWriteOps(",
      judge: AUTOMATION_JUDGE_SPELLINGS,
    },
  },
  {
    no: 12,
    name: "コードの島(output_table 全置換)",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "on_create/on_update",
    key: "workflow-runner: runRunFunction",
    // **全置換は「既存行を全部消してから書き直す」であり、`run_function` の中で
    //   **削除**が起きる唯一の場所である**(ワークフローの語彙に `delete_record` は無い)。
    // **`clearOutputTable` そのものは1バイトも変えず、その手前に関門を置いた。**
    expected: "wired",
    wiredBy: "V8-M21(台帳 J-G23)",
    source: {
      file: join(SRC, "kernel", "workflow-runner.ts"),
      from: "function runRunFunction(",
      judge: AUTOMATION_JUDGE_SPELLINGS,
    },
  },
  {
    no: 13,
    name: "決まった時刻に動く処理",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "schedule",
    key: "workflow-runner: runScheduledWorkflow",
    // **【素通し。塞いでいない】** **ユーザ決定 `D-V8-33` の逐語「時刻で動く処理だけは
    //   今日どおり素通し」/ 台帳 `J-G22b` = **保留** / 受け皿は `docs/plan/undecided.md` の `U-3`。**
    // **配線した人はここが赤くなる** —— **そのときは `U-3` を外す手続きが先である。**
    expected: "pending",
    wiredBy: "(素通し。D-V8-33 / J-G22b = 保留 / U-3)",
    source: {
      file: join(SRC, "kernel", "workflow-runner.ts"),
      from: "export function runScheduledWorkflow(",
      judge: AUTOMATION_JUDGE_SPELLINGS,
    },
  },
  {
    no: 14,
    name: "AI(MCP)",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "mcp",
    key: "mcp/tools/write: registerWriteTools",
    // **【素通し。塞いでいない】** **ユーザ決定 `D-V8-20`(常に管理者として扱う)。**
    // **`CP-V8-AUTHZ` の完了条件5 が「守らない経路を名指しし、実際に素通りすることを
    //   実測で示す」ことを要求している** —— **本行はその名指しの側であり、実測は
    //   `V8-M24` が持つ。** **本ファイルは `src/mcp/` を1バイトも編集していない(読むだけ)。**
    // **【`V8-M31-T07` による更新。旧文を1バイトも消していない】**
    // **旧: `expected: "pending"` / `wiredBy: "(素通し。D-V8-20)"`。**
    // **`D-V8-20` は `D-V8-43`(AI 経由の素通りを塞ぐ)に引き直された。**
    // **`V8-M31` が `registerWriteTools` に名乗り(`ST_MCP_ACTOR`)と行の判定を配線したので、
    //   宣言どおり (B-2) が赤くなり、ここを `"wired"` に書き換えた** ——
    //   **検査は1本も消していない。`ROUTES` の行数も 14 のまま動かしていない。**
    // **【誇張しない】** **`"wired"` になったのは「AI が名乗った主体の権限の範囲でしか
    //   動かなくなった」までである。** **その主体を誰にするかは起動する人が自由に選べる
    //   (`D-V8-54` = 認可であって認証ではない)。** **`undo` / `delete_app` は
    //   行の判定を1度も通らない。**
    expected: "wired",
    wiredBy: "V8-M31(ST_MCP_ACTOR。D-V8-43 / D-V8-46 / D-V8-54)",
    source: {
      file: join(SRC, "mcp", "tools", "write.ts"),
      from: "export function registerWriteTools(",
      judge: AUTOMATION_JUDGE_SPELLINGS,
    },
  },
  {
    no: 15,
    name: "集計表 GET",
    /** **きっかけ**(同じファイルの内側でも判定の有無が割れる軸)。 */
    trigger: "http",
    key: "GET /api/apps/:app_id/views/:view_id/report",
    // **【`V8-M10-T03` が足した1行。旧の14行は1バイトも書き換えていない】**
    //
    // ## **【素通しとして数えられていなかった期間を名指しする】**
    // **`V8-M8`(2026-08-14)が集計表の口を `app.ts` に登録し、`HTTP_ENTRY_POINTS`(50本)にも
    //   `REGISTERED_ROUTES` にも1行足した。** **しかし判定の全量表(この `ROUTES`)には
    //   足さなかった** —— **`ROUTES` は14本のままで、集計表の口は1度も現れなかった。**
    // **その結果、`V8-M8` 着手から `V8-M10-T03` までのあいだ、この台帳は緑のまま
    //   「素通りしている口が1本ある」ことを1文字も語っていなかった。**
    //   **(B-2) は `expected: "pending"` の行しか捕まえないので、
    //   **表に載っていない口は「未配線」としてすら数えられない。**
    // **`V8-M9`(結合)も同じまま引き継いだ** —— **結合を足したときも `ROUTES` は14本。**
    // **数えられていなかった期間**: **`V8-M8` の着手(2026-08-14)〜 `V8-M10-T03`(2026-08-15)。**
    //   **その間、集計表の口は誰が要求しても同じ数を返していた**
    //   (実測は `v8-m10.md` §2-6 の「着手前は3人とも1バイト同一」)。
    //
    // **【今日は `"wired"` である】** **`V8-M10-T03` が母集団の判定を配線した。**
    // **綴りを1つも足していない** —— **`judgedIn()`(`access-control-paths.test.ts:122`-`:141`)が
    //   数えるのは `recordAccessJudge(` と `judgeRecordAccess(` の2つだけで、直後の `(` まで
    //   含む完全一致である。** **集計表のハンドラに一覧とまったく同じ配管
    //   (`const judge = recordAccessJudge(…)`)を書いたので、そのまま数えられる。**
    // **【誇張しない】** **`"wired"` になったのは**起点の表**についてだけである** ——
    //   **結合先の表は今日も素通しで全件読む**(`Q-G14` = `V8-M10-T04`)。
    //   **この表はその割れを表せない**(1経路 = 1行なので)。
    // **【`V8-M13-T02`(台帳 `Q-G28`)による更新。旧文を1バイトも消していない】**
    // **旧: この行には `source` が無く、判定は登録行から次の登録行までの本文
    //   (= ハンドラの中)から数えていた。**
    // **`Q-G28`(MCP から集計を読む)の限定5 が「可視性の判定を必ず通す」と定めており、
    //   MCP から `computeReport()` を直接呼ぶと注入を1ミリも通らない。** **そこで注入と
    //   上限の判定を `src/server/app.ts` の `readVisibleReport()`(モジュール直下の
    //   名前つき関数)へ切り出し、**HTTP と MCP が同じ1本を呼ぶ**形にした。**
    // **その結果、判定の呼び出しはハンドラの本文の外(同じファイルの中)へ移った** ——
    //   **`source` で「どの関数の中を見るか」を名指しする。** **これは受信口 / 自動処理 /
    //   島の3経路で既に使っている形と同じであり、綴り(`judge`)も `judgedIn()` が数える
    //   2つ(`recordAccessJudge(` / `judgeRecordAccess(`)から1つも増やしていない。**
    // **【誇張しない】** **`source` を持つ行がすべて `app.ts` の外に在る、とは今日は
    //   言えない** —— **この1本だけは `app.ts` の中の関数を指している。**
    //   **(A-3) のテスト名(「app.ts の外の6経路」)はその意味で字面が古い。**
    //   **名前は1バイトも書き換えず、期待値だけを直してある。**
    expected: "wired",
    wiredBy: "V8-M10-T03(台帳 Q-G13 / Q-G15)",
    source: {
      file: join(SRC, "server", "app.ts"),
      from: "export function readVisibleReport(",
      judge: [JUDGE_PIPE, JUDGE_HOME],
    },
  },
];

/**
 * **その行の入口の本文**(`V8-M21`)。**`app.ts` の行は今日どおり登録行から切り出し、
 * それ以外の行は `source` が名指しするファイルの入口から切り出す。**
 */
async function bodyForRoute(
  route: (typeof ROUTES)[number],
  appSource: string,
  registrations: Registration[],
): Promise<string> {
  if (route.source === undefined) {
    return bodyOf(appSource, registrations, route.key);
  }
  const text = await Bun.file(route.source.file).text();
  const at = text.indexOf(route.source.from);
  if (at < 0) {
    throw new Error(`入口 "${route.source.from}" が ${route.source.file} に見つからない`);
  }
  const end = text.indexOf("\n}\n", at);
  return text.slice(at, end < 0 ? text.length : end);
}

/** **その行が判定を受けているか。** **`app.ts` 以外の行は自分の綴りで数える。** */
function judgedForRoute(route: (typeof ROUTES)[number], body: string): boolean {
  return route.source === undefined
    ? judgedIn(body)
    : route.source.judge.some((spelling) => body.includes(spelling));
}

describe("V7-M3-T02 (A): app.ts の経路の全列挙", () => {
  // **【`V7-M5-T02`(`Z-G19`)による更新。旧文を1バイトも消していない】**
  // **旧の名前**: `test("(A-1) 登録されている経路は 12 本ちょうどで、一覧と1件も
  // 食い違わない(1本増えたら赤)", …)`。**旧の期待値**: `expect(keys.length).toBe(12);`。
  // **宣言どおり、経路を1本足したのでこの検査が実際に赤くなり、`REGISTERED_ROUTES` の側にも
  // 1行足した**(**足した1本は行を返す `GET` であり、書く / 消す口ではない**)。
  // **検査は1本も消しておらず、`skip` にもしておらず、条件も緩めていない。**
  // **【`V8-M21` の後半による更新。旧文を1バイトも消していない】**
  // **旧の名前**: `test("(A-1) 登録されている経路は 13 本ちょうどで、一覧と1件も食い違わない
  // (1本増えたら赤)", …)`。**旧の期待値**: `expect(keys.length).toBe(13);`。
  // **宣言どおり、経路を1本足したのでこの検査が実際に赤くなり、`REGISTERED_ROUTES` の側にも
  // 1行足した**(**足した1本は `GET /api/apps/:app_id/public`。行を1件も返さない読取の口である**)。
  // **検査は1本も消しておらず、`skip` にもしておらず、条件も緩めていない。**
  test("(A-1) 登録されている経路は 14 本ちょうどで、一覧と1件も食い違わない(1本増えたら赤)", async () => {
    const source = await Bun.file(APP_PATH).text();
    const keys = registrationsOf(source).map((registration) => registration.key);
    expect(keys).toEqual([...REGISTERED_ROUTES]);
    // **【2026-08-14。`V8-M8`。台帳 `Q-G1`】期待値を 14 → 15 へ書き換えた。**
    // **旧行の逐語**: `expect(keys.length).toBe(14);`
    // **足したのは集計表の読取の口1本だけである**(`app.ts` に登録した `GET` 1本)。
    expect(keys.length).toBe(15);
  });

  // **【`V8-M21`(台帳 `J-G21` / `J-G22a` / `J-G23` / `J-G22b` / `D-V8-18` / `D-V8-20` /
  //   `D-V8-33`)による更新。旧文を1バイトも消していない】**
  //
  // **旧の名前**: `test("(A-2) 8経路の一覧は、登録されている経路の部分集合である
  // (名前のずれを捕まえる)", …)`。
  // **旧の中身(逐語)**:
  //   `for (const route of ROUTES) { expect({no, exists: keys.has(route.key)}).toEqual({no, exists: true}); }`
  //   `expect(ROUTES.length).toBe(8);`
  //
  // **`ROUTES` に `app.ts` の外の入口(受信口 / 自動処理 / 島 / 時刻起動 / AI)が入ったので、
  //   「`app.ts` の登録行の部分集合である」は `app.ts` の8行についてだけ成り立つ。**
  // **【緩めていない。要求を2本増やした】** —— **(1) `app.ts` の行はちょうど8本であること、
  //   (2) `app.ts` の外の行は、名指ししたファイルにその入口が実在すること**(下の (A-3))。
  test("(A-2) app.ts の8経路は登録されている経路の部分集合である(名前のずれを捕まえる)", async () => {
    const source = await Bun.file(APP_PATH).text();
    const keys = new Set(registrationsOf(source).map((registration) => registration.key));
    const inAppTs = ROUTES.filter((route) => route.source === undefined);
    for (const route of inAppTs) {
      expect({ no: route.no, exists: keys.has(route.key) }).toEqual({ no: route.no, exists: true });
    }
    // **【`V8-M10-T03` による更新。旧文を1バイトも消していない】**
    // **旧の期待値(逐語)**: `expect(inAppTs.length).toBe(8);` / `expect(ROUTES.length).toBe(14);`
    // **理由は「実物が変わった」側である**(「数え方が古くなった」ではない)——
    //   **`app.ts` の中に在って判定を受ける経路が1本増えた**(集計表 `GET`)。
    // **【緩めていない】** **`app.ts` の登録は 15本のままである**((A-1) は1バイトも
    //   動かしていない)—— **増えたのは「判定の全量表に載っている本数」のほうであり、
    //   その差(登録15 − 判定表9)は今日も他の口が判定の対象外であることを表している。**
    // **【`V8-M13-T02`(台帳 `Q-G28`)による更新。旧文を1バイトも消していない】**
    // **旧の期待値(逐語)**: `expect(inAppTs.length).toBe(9);`
    // **理由は「実物が変わった」側である** —— **集計表 `GET` の判定が、ハンドラの本文から
    //   `app.ts` の中の名前つき関数(`readVisibleReport()`)へ移った。**
    //   **`inAppTs` は「`source` を持たない行」なので、その1行がこちらから外れた。**
    // **【緩めていない】** **`ROUTES.length` は 15 のままであり、集計表 `GET` は今日も
    //   (B-1) の側で `judged: true` を要求されている**(見る場所が変わっただけである)。
    expect(inAppTs.length).toBe(8);
    // **表は1本のままである**(`ADR-0176` 限定6 の「表を2つに分けない」)。
    expect(ROUTES.length).toBe(15);
  });

  test("(A-3) app.ts の外の6経路は、名指ししたファイルにその入口が実在する", async () => {
    const outside = ROUTES.filter((route) => route.source !== undefined);
    // **【`V8-M13-T02`(台帳 `Q-G28`)による更新。旧文を1バイトも消していない】**
    // **旧の期待値(逐語)**: `expect(outside).toHaveLength(6);`
    // **7本目は集計表 `GET` の `readVisibleReport()` であり、**`app.ts` の中**に在る** ——
    //   **テスト名の「app.ts の外の6経路」は字面として今日は古い。**
    //   **名前は1バイトも書き換えていない**(このリポジトリの作法。訂正は追記)。
    // **【緩めていない】** **下の for は「名指ししたファイルにその入口が実在する」ことを
    //   7行すべてに掛けており、条件を1つも外していない。**
    expect(outside).toHaveLength(7);
    for (const route of outside) {
      const text = await Bun.file((route.source as RouteSource).file).text();
      expect({
        no: route.no,
        found: text.includes((route.source as RouteSource).from),
      }).toEqual({ no: route.no, found: true });
    }
  });
});

describe("V7-M3-T02 (B): 入口が判定を受けているかを1本ずつ数える", () => {
  test("(B-1) 配線済みと宣言した経路は、ハンドラの中で判定を呼んでいる", async () => {
    const source = await Bun.file(APP_PATH).text();
    const registrations = registrationsOf(source);
    const measured = await Promise.all(
      ROUTES.filter((route) => route.expected === "wired").map(async (route) => ({
        no: route.no,
        name: route.name,
        judged: judgedForRoute(route, await bodyForRoute(route, source, registrations)),
      })),
    );
    // **【`V7-M3-T06` による更新。旧文を1バイトも消していない】**
    // **旧の期待値は6行で、`{ no: 5, name: "DELETE", judged: true }` が入っていなかった。**
    // **【`V8-M21` による更新。旧文を1バイトも消していない】**
    // **旧の期待値は8行で、下の 9〜12 が入っていなかった。**
    // **足した4行は `D-V8-18` の3経路である**(島は `write_ops` と `output_table` 全置換の
    // **2つの入口**を持つので4行になる)。
    expect(measured).toEqual([
      { no: 1, name: "一覧 GET", judged: true },
      { no: 2, name: "単件 GET", judged: true },
      { no: 3, name: "POST", judged: true },
      { no: 4, name: "PATCH", judged: true },
      { no: 5, name: "DELETE", judged: true },
      { no: 6, name: "画面の操作起点", judged: true },
      { no: 7, name: "バッチ", judged: true },
      // **【`V7-M3-T07` が足した1行】** —— **8/8 になった。**
      { no: 8, name: "ファイル配信", judged: true },
      // **【`V8-M21` が足した4行】**
      { no: 9, name: "受信口", judged: true },
      { no: 10, name: "登録をきっかけに動く処理(create_record / update_record)", judged: true },
      { no: 11, name: "コードの島(write_ops)", judged: true },
      { no: 12, name: "コードの島(output_table 全置換)", judged: true },
      // **【`V8-M31-T07` が足した1行。旧文を1バイトも消していない】**
      // **旧の期待値は12行で、`{ no: 14, name: "AI(MCP)", judged: true }` が入っていなかった**
      //   (`no: 14` は (B-2) = 未配線の側に載っていた)。
      // **`no: 13`(時刻起動)は今日も (B-2) の側である** —— **足したのは1行だけである。**
      { no: 14, name: "AI(MCP)", judged: true },
      // **【`V8-M10-T03` が足した1行。旧文を1バイトも消していない】**
      // **旧の期待値は13行で、`{ no: 15, name: "集計表 GET", judged: true }` が
      //   入っていなかった** —— **`ROUTES` にその行が無かったからである**
      //   (**「未配線」としてすら数えられていなかった**。上の `no: 15` の注記)。
      { no: 15, name: "集計表 GET", judged: true },
    ]);
  });

  test("(B-2) 未配線と宣言した2本は、今日ほんとうに呼んでいない(配線されたらここが赤くなる)", async () => {
    const source = await Bun.file(APP_PATH).text();
    const registrations = registrationsOf(source);
    const measured = await Promise.all(
      ROUTES.filter((route) => route.expected === "pending").map(async (route) => ({
        no: route.no,
        name: route.name,
        wiredBy: route.wiredBy,
        judged: judgedForRoute(route, await bodyForRoute(route, source, registrations)),
      })),
    );
    // **【この期待値は「今日はまだ守られていない」ことの記録である。緑であることを
    //   「安全だ」と読まないこと。】** **`DELETE` は `delete` を持たない人でも通り、
    //   ファイル配信は行が見えない人にも実体を返す。**
    // **【`V7-M3-T06` による更新。旧文を1バイトも消していない】**
    // **旧: `[{ no: 5, name: "DELETE", wiredBy: "V7-M3-T06(未着手)", judged: false },
    //        { no: 8, name: "ファイル配信", wiredBy: "V7-M3-T07(未着手)", judged: false }]`。**
    // **`DELETE` は `V7-M3-T06` が配線したので (B-1) 側へ移った。** **残る未配線は1本である。**
    // **【`V7-M3-T07` による更新。旧文を1バイトも消していない】**
    // **旧: `[{ no: 8, name: "ファイル配信", wiredBy: "V7-M3-T07(未着手)", judged: false }]`。**
    // **未配線の経路は今日0本である** —— **`measured` は空配列になった。**
    // **【この検査を消していない理由】** **9本目の経路を足した人が `ROUTES` に
    //   `"pending"` の行を書いたとき、この検査がその行を捕まえる側に残っている。**
    // **【`V8-M21` による更新。旧文を1バイトも消していない】**
    // **旧の期待値**: `expect(measured).toEqual([]);`(**未配線0本**)。
    // **`V8-M21` が「素通りする2経路」を同じ表に載せたので、この検査がそれを捕まえる側に
    //   戻った** —— **どちらもユーザ決定で素通しと決まっているものである**
    //   (`D-V8-33` = 時刻起動 / `D-V8-20` = AI)。**塞いだのではなく、
    //   **塞いでいないことを機械で固定した**。**
    // **【禁止】この2行を「まだ手が回っていない」と読み替えない** ——
    //   **時刻起動は台帳 `J-G22b` が **保留** と判定し、受け皿は `docs/plan/undecided.md` の
    //   `U-3` である。** **AI は `D-V8-20` が「常に管理者として扱う」と決めたものである。**
    // **【`V8-M31-T07` による更新。旧文を1バイトも消していない】**
    // **旧の期待値(逐語)**:
    // ```
    // expect(measured).toEqual([
    //   {
    //     no: 13,
    //     name: "決まった時刻に動く処理",
    //     wiredBy: "(素通し。D-V8-33 / J-G22b = 保留 / U-3)",
    //     judged: false,
    //   },
    //   { no: 14, name: "AI(MCP)", wiredBy: "(素通し。D-V8-20)", judged: false },
    // ]);
    // ```
    // **`V8-M31` が AI(MCP)に判定を配線したので、`no: 14` は (B-1) 側へ移った。**
    // **【素通りは今日 1本である。0本ではない】** —— **残る1本は時刻起動(`no: 13`)であり、
    //   `D-V8-33` / `J-G22b` = 保留 / `U-3` によって今日も塞いでいない。**
    // **この検査は消していない** —— **`no: 13` を捕まえ続け、10本目の経路を `"pending"` で
    //   足した人も同じように捕まえる。**
    expect(measured).toEqual([
      {
        no: 13,
        name: "決まった時刻に動く処理",
        wiredBy: "(素通し。D-V8-33 / J-G22b = 保留 / U-3)",
        judged: false,
      },
    ]);
  });

  test("(B-3) 判定の配管の呼び出しは、すべて配線済みと宣言した経路の中にある(数も突き合わせる)", async () => {
    const source = await Bun.file(APP_PATH).text();
    const registrations = registrationsOf(source);
    // **【`V8-M21` による更新。旧文を1バイトも消していない】**
    // **旧**: `ROUTES.filter((route) => route.expected === "wired")`。
    // **本検査は `app.ts` の中の呼び出しの総数を突き合わせるものなので、`app.ts` の外の
    //   行(受信口 / 自動処理 / 島)を外す。** **数(8 / 8 / 2 / 2)は1つも動かしていない** ——
    //   **`V8-M21` は `app.ts` を1バイトも触っていないからである。**
    // **【`V8-M13-T02`(台帳 `Q-G28`)による更新。旧文を1バイトも消していない】**
    // **旧(逐語)**:
    //   `const wired = ROUTES.filter(`
    //   `  (route) => route.expected === "wired" && route.source === undefined,`
    //   `).map((route) => ({`
    //   `  name: route.name,`
    //   `  body: bodyOf(source, registrations, route.key),`
    //   `}));`
    // **`app.ts` の中の判定が1件、ハンドラの本文から名前つき関数
    //   (`readVisibleReport()`)へ移った** —— **旧の絞り(`source === undefined`)のままだと、
    //   その1件だけが「ハンドラの外の呼び出し」として数えられ、下の
    //   `pipeCalls === pipeInHandlers` が 8 / 7 で割れる。**
    // **【緩めていない。むしろ数える範囲を実物に合わせた】** —— **外すのは今日も
    //   `app.ts` の外のファイル(受信口 / 自動処理 / 島)だけである。**
    //   **`app.ts` の中の行は、登録行から切り出すか名前つき関数から切り出すかの違いだけで、
    //   1行も落としていない。** **下の突き合わせが守っている命題(「`app.ts` の中の
    //   配管の呼び出しは、すべて宣言した経路の中にある」)は1ミリも弱めていない。**
    const wired = await Promise.all(
      ROUTES.filter(
        (route) =>
          route.expected === "wired" &&
          (route.source === undefined || route.source.file === APP_PATH),
      ).map(async (route) => ({
        name: route.name,
        body: await bodyForRoute(route, source, registrations),
      })),
    );
    const countIn = (text: string, needle: string): number => text.split(needle).length - 1;
    // **定義そのもの(`function recordAccessJudge(`)は呼び出しではないので数えない。**
    const definitions = countIn(source, `function ${JUDGE_PIPE}`);
    expect(definitions).toBe(1);
    const pipeCalls = countIn(source, JUDGE_PIPE) - definitions;
    const pipeInHandlers = wired.reduce((sum, route) => sum + countIn(route.body, JUDGE_PIPE), 0);
    // **実物の総数と、ハンドラの中で数えた数が一致する** = **ハンドラの外に呼び出しが1件も無い。**
    // **【`V7-M3-T06` による更新。旧文を1バイトも消していない】**
    // **旧: `expect({ pipeCalls, pipeInHandlers }).toEqual({ pipeCalls: 6, pipeInHandlers: 6 });`。**
    // **`DELETE` に配管の呼び出しが1件増えた**(6 → 7)。
    // **【`V7-M3-T07` による更新。旧文を1バイトも消していない】**
    // **旧: `{ pipeCalls: 7, pipeInHandlers: 7 }`(その前は 6 / 6)。**
    // **ファイル配信に配管の呼び出しが1件増えた**(7 → 8)。**走査そのものは
    //   `isFileReferencedByVisibleRow`(ハンドラの外)に在るが、述語を組む呼び出しは
    //   ハンドラの中に書いてある** —— **だから「ハンドラの外に呼び出しが1件も無い」は
    //   今日も成り立つ。**
    // **【`V8-M10-T02`(台帳 `Q-G16a`)による更新。旧文を1バイトも消していない】**
    // **旧: `expect({ pipeCalls, pipeInHandlers }).toEqual({ pipeCalls: 8, pipeInHandlers: 8 });`**
    //   (その前は 7 / 7、さらにその前は 6 / 6)。
    // **理由は「実物が変わった」側である**(「数え方が古くなった」ではない)——
    //   **レコード一覧のハンドラに在った配管の呼び出し2件(個人スコープの分岐と行アクセス権の
    //   分岐)が、母集団の判定を1本に集めたことで**1件**になった**(8 → 7)。
    // **【緩めていない】** **この検査が守っているのは「ハンドラの外に呼び出しが1件も無い」
    //   ことであり、`pipeCalls === pipeInHandlers` はそのまま成り立っている。**
    //   **判定を受ける経路の本数は1本も減っていない** —— **レコード一覧は今日も配管を
    //   通っており、`judgedIn()` の (B-2) が緑のままである。**
    // **【`V8-M10-T03`(台帳 `Q-G13`)による更新。旧文を1バイトも消していない】**
    // **旧: `expect({ pipeCalls, pipeInHandlers }).toEqual({ pipeCalls: 7, pipeInHandlers: 7 });`**
    //   (その前は 8 / 8、その前は 7 / 7、さらにその前は 6 / 6)。
    // **理由は「実物が変わった」側である** —— **集計表のハンドラに配管の呼び出しが
    //   1件増えた**(7 → 8)。**一覧とまったく同じ2行を書いた**(綴りを1つも足していない)。
    // **【緩めていない】** **`pipeCalls === pipeInHandlers` は今日も成り立つ** ——
    //   **増えた1件はハンドラの中に在り、`ROUTES` の `no: 15` として宣言してある。**
    expect({ pipeCalls, pipeInHandlers }).toEqual({ pipeCalls: 8, pipeInHandlers: 8 });

    // **判定そのものの呼び出し**: 配管の中に1件 + `POST` に1件 + バッチの create op に1件。
    const homeDefinition = countIn(source, `export function ${JUDGE_HOME}`);
    expect(homeDefinition).toBe(0); // 定義は `owner-scope.ts` に在る(`app.ts` には無い)
    const homeCalls = countIn(source, JUDGE_HOME);
    const homeInHandlers = wired.reduce((sum, route) => sum + countIn(route.body, JUDGE_HOME), 0);
    // **配管の中の1件はハンドラの外にある**(`recordAccessJudge` の定義は登録行より前)。
    // **【`V7-M4-T02`(`Z-G14`)による更新。旧文を1バイトも消していない】**
    // **旧: `expect({ homeCalls, homeInHandlers }).toEqual({ homeCalls: 3, homeInHandlers: 2 });`。**
    // **配管が `judgeRecordAccess` を直接呼ぶのをやめ、`resolveRecordAccess`(引き継ぎを
    //   辿ってから同じ `judgeRecordAccess` を各段で呼ぶ)を呼ぶ形になった**(3 → 2)。
    // **`app.ts` に残る2件は `POST` とバッチの `create` の下見であり、どちらもハンドラの
    //   中にある** —— **したがって「配管の中の1件はハンドラの外にある」は今日は当たらず、
    //   `homeCalls` と `homeInHandlers` が一致する。**
    // **【判定の家が2本に割れていないことは、緩めずに別に測る】** —— **下の (C-2) が
    //   `owner-scope.ts` の `resolveRecordAccess` の中で `judgeRecordAccess` が呼ばれて
    //   いることを固定する**(**app.ts から消えた1件の行き先を名指しする**)。
    expect({ homeCalls, homeInHandlers }).toEqual({ homeCalls: 2, homeInHandlers: 2 });
  });
});

// -------------------------------------------------------------------------------------
// **2つの一覧を突き合わせる**(`J-G26` の「表を2つに分けない」の実体)
// -------------------------------------------------------------------------------------

test("J-G26: 判定の全量表の HTTP の行は、上の入口の全量表に必ず載っている(名前のずれを捕まえる)", () => {
  // **同じファイルに2つの配列が在っても、突き合わせが無ければ「2つの表」である。**
  // **この検査が両者を1本に縛る** —— **片方だけを直すと赤くなる。**
  const httpRows = ROUTES.filter(
    (route) =>
      route.trigger === "http" || route.trigger === "manual" || route.trigger === "inbound",
  );
  // **【`V8-M10-T03` による更新。旧文を1バイトも消していない】**
  // **旧の期待値(逐語)**: `expect(httpRows.length).toBe(9);`
  // **理由は「実物が変わった」側である** —— **判定の全量表に集計表の `GET` を1行足した。**
  // **【緩めていない】** **下の突き合わせ(`HTTP_ENTRY_POINTS` に必ず載っている)は
  //   1件のずれも許さずに今日も全行に掛かっており、足した1行も `HTTP_ENTRY_POINTS`
  //   (`:173`)に既に載っている** —— **`V8-M8` は入口の全量表には足していたのに、
  //   判定の全量表には足していなかった。** **今日その差が消えた。**
  expect(httpRows.length).toBe(10);
  for (const route of httpRows) {
    expect({ no: route.no, listed: HTTP_ENTRY_POINTS.includes(route.key) }).toEqual({
      no: route.no,
      listed: true,
    });
  }
});

test("J-G26: きっかけで割れる経路が機械で表せている(同じファイル・同じしくみ・違う結果)", () => {
  // **登録起動と時刻起動は、どちらも `src/kernel/workflow-runner.ts` の中に在る。**
  // **ファイル名では区別できない** —— **区別するのは `trigger` の1キーである。**
  const inRunner = ROUTES.filter(
    (route) => route.source?.file === join(SRC, "kernel", "workflow-runner.ts"),
  );
  expect(inRunner.map((route) => ({ trigger: route.trigger, expected: route.expected }))).toEqual([
    { trigger: "on_create/on_update", expected: "wired" },
    { trigger: "on_create/on_update", expected: "wired" },
    { trigger: "on_create/on_update", expected: "wired" },
    // **【素通し。塞いでいない】** **同じファイルの中で、きっかけだけが違う。**
    { trigger: "schedule", expected: "pending" },
  ]);
  // **素通りするきっかけは2つちょうどである**(時刻起動と AI)。
  // **【`V8-M31-T07` による更新。旧文を1バイトも消していない】**
  // **旧(逐語)**: `).toEqual(["mcp", "schedule"]);`(**素通りは2つ**)。
  // **`V8-M31` が AI(MCP)に名乗りと判定を配線したので、`"mcp"` が `"pending"` の集合から
  //   外れた。**
  // **【素通りは今日 1本である。0本ではない】** —— **残る1本は時刻起動(`"schedule"`)で
  //   あり、`D-V8-33`(時刻で動く処理だけは今日どおり素通し)/ `J-G22b` = 保留 /
  //   受け皿 `docs/plan/undecided.md` の `U-3` によって、今日も塞いでいない。**
  // **【禁止】これを「全部の入口で権限が効く」と読み替えないこと。**
  expect(
    ROUTES.filter((route) => route.expected === "pending")
      .map((route) => route.trigger)
      .sort(),
  ).toEqual(["schedule"]);
});

test("J-G26: 判定の家の綴りは1本に閉じている(配管が呼ぶのは合成の1本である)", async () => {
  // **`JUDGE_COMBINER` をこの表のファイルでも1度使い、綴りが古びたら赤くなるようにする。**
  const source = readFileSync(APP_PATH, "utf-8");
  expect(source.includes(JUDGE_COMBINER)).toBe(true);
  expect(source.includes(JUDGE_RESOLVER)).toBe(false);
});
