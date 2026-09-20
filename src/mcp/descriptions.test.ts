/**
 * ツール説明文の語彙境界記述の検証(V0-P5-T04 / 計画 R12)。
 *
 * T04 の完了条件は「全ツールの description が3点(語彙の全範囲 / できないことの例 /
 * 範囲外要求への振る舞い指示)を満たし、チェックリストレビューを通過している」である。
 * **チェックリストの機械化がこのファイルの役割**で、人間のレビュー結果は
 * `docs/evidence/cp-5-t04-checklist.md` にある。
 *
 * 設計上の要点が3つある。
 *
 * 1. **`tools/list` 越しに見る。** 定数やソースを直接読むのではなく、実際に MCP
 *    クライアントを繋いで `listTools()` の結果を検査する。LLM が受け取るのは
 *    まさにこの JSON であり、`describeTool()` を通し忘れたツールが1つでもあれば
 *    ここで落ちる。ソースを読むテストでは「登録し忘れ」を検出できない。
 *
 * 2. **エクスポート定数そのものを照合する(R12)。** 「削除」「代替案」といった
 *    それらしい部分文字列で見ると、文言を書き換えたときにテストが素通りする
 *    (= 検証が形骸化する)。`VOCABULARY_SCOPE` / `CANNOT_DO` /
 *    `OUT_OF_SCOPE_BEHAVIOR` を丸ごと `toContain` する。
 *
 * 3. **共通文言だけの description を不合格にする。** 3定数を貼っただけなら
 *    30アサーションは全部通る。それでは「このツールが何をするか」が消え、
 *    LLM は道具を選べない。共通部分を除いた**ツール固有部分が空でなく、かつ
 *    全ツールで相異なる**ことまで見る。
 *
 * ## `V6-M12`(`H-G11` / `H-G12` / `ADR-0287`)で、見る対象が変わった
 *
 * **上の 1 / 2 / 3 の3点は今日もそのまま効いている。** **変わったのは「何が全ツールに
 * 貼られているか」だけである** —— 2026-08-07 まで `describeTool()` は3定数の全文
 * (41,683文字)を23ツール全部に貼っていたが、今日貼るのは
 * `VOCABULARY_ENTRY_POINT`(語彙の名前の一覧)と `SKILL_GUIDE`(説明書への誘導)で、
 * **3定数の全文はちょうど1ツール(`apply_diff`)に載る。**
 * **「ちょうど1本」を数える検査は、旧テストに無かったものである。**
 */
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DRY_RUN_NOTE } from "../kernel/index.ts";
import { createMcpServer, MCP_SERVER_NAME } from "./server.ts";
import { registerReadTools } from "./tools/read.ts";
import {
  AFTER_DELETE_GUIDE,
  APPLY_DIFF_OP_EXAMPLES,
  CANNOT_DO,
  CANNOT_DO_INDEX,
  DELETE_APP_SHOW_CONTENTS_FIRST,
  DELETE_RECORD_SHOW_TARGET_FIRST,
  DESTRUCTIVE_CHANGE_FLOW,
  DESTRUCTIVE_SUBSTITUTE_CONSENT,
  INTENT_VERBATIM,
  OUT_OF_SCOPE_BEHAVIOR,
  PREVIEW_URL_VERBATIM,
  RECORD_WRITE_NOT_IN_CHANGELOG,
  RECORD_WRITE_SELF_REPORT,
  RECORD_WRITE_SYSTEM_TABLE_READONLY,
  SAMPLE_DATA_NO_ESCAPE,
  SKILL_GUIDE,
  SKILL_POINTER,
  UNDO_ROLLBACK_LIMIT,
  VOCABULARY_ENTRY_POINT,
  VOCABULARY_RESOURCE_POINTER,
  VOCABULARY_RESOURCE_URIS,
  VOCABULARY_SCOPE,
  WORKFLOW_HISTORY_TABLE_TEMPLATE,
} from "./vocabulary.ts";

/**
 * 公開するツールの全集合(v0 の10個 + V1-M0-T01 で足した2個)。
 *
 * 件数だけでなく**名前の集合そのもの**を固定する。件数だけを見ていると、
 * ツールを1つ消して1つ足したときに「10個ある」まま素通りしてしまい、
 * 説明文レビュー済みでない新ツールが混入する。
 */
const EXPECTED_TOOL_NAMES = [
  "list_apps",
  "get_manifest",
  "get_changelog",
  "get_preview_url",
  "list_records",
  "preview_undo",
  // V1-M9-T05(ADR-0032)。redo の事前確認(参照系)。preview_undo と同じ UndoPreview を返す。
  "preview_redo",
  "create_app",
  "apply_diff",
  "undo",
  // V1-M9-T05(ADR-0032)。直前の undo をやり直す。ADR-0004 §1 の明示的な改訂(門A)。
  "redo",
  "insert_sample_data",
  // V1-M0-T01(F-13 / F-37)。カーネルに既にある updateRecord / deleteRecord への
  // 入口を開けただけで、カーネル語彙(リソース種 / フィールド型 / diff op)は増えていない。
  "update_record",
  "delete_record",
  // V2-M4-T01(ADR-0039。EC-G7 バッチ原子書込)。複数レコード(create/update)を1
  // IMMEDIATE トランザクションで全成功か全失敗で書く。カーネル関門 `writeRecords` を通り、
  // HTTP `POST /apps/:id/batch` と同じ振る舞い(ADR-0003 §7)。カーネル語彙は増えていない。
  "write_records",
  // V1-M9-T09(ADR-0031)。アプリ単位の完全削除。カーネルに新設した `deleteApp` への
  // 入口(門A 審査済み)。取り消せない(スナップショットごと消える)ので、説明文に不可逆性と
  // 「消える中身を先に人間に見せる」規律を焼き込む(`DELETE_APP_SHOW_CONTENTS_FIRST`)。
  "delete_app",
  // V1-M1-T02(ドライラン機構)。**参照系**である ―― 本体を1バイトも変えない。
  // 登録先が read.ts であることと `WRITE_TOOLS` に入れないことは一体の判断で、
  // 根拠は ADR-0010 Consequences と `docs/plan/v1/records/v1-m1-t02.md` §1-1。
  // **【2026-08-25 追記(`V10-M28-T02` / `ADR-0376`)。上の3行を1バイトも消していない】**
  // **登録先は参照系のままである**(下の「dry_run_diff は参照系として登録されている」が
  // 今日も緑である)。**変えたのは中身ではなく**誰が呼べるか**であり、
  // `apply_diff` と同じ `app` × `write` の判定が掛かるようになった。**
  // **「参照系 = 誰でも呼べる」ではない** —— **参照系かどうかは「本体を変えるか」の話である。**
  "dry_run_diff",
  // V1-M4-T04(ADR-0020 §2b・§5)。接続(capability)の**申請**ツール。AI が到達できる
  // 上限は「pending な申請の作成」までで、**発行(connections への書き込み)は owner の
  // HTTP 操作だけが行う**(§8c-3。MCP / apply_diff に発行経路を1本も結線しない)。
  "request_connection",
  // V1-M5-T04(ADR-0021 §2b・§5)。AI capability の**申請**ツール。request_connection と
  // 同型 —— AI が到達できるのは申請までで、発行・上限変更は owner の HTTP だけ(§8c-3)。
  "request_ai_capability",
  // V2-M5-T01(ADR-0041 限定1)。受信口(inbound capability)の**申請**ツール。request_connection の
  // 鏡写し —— AI が到達できるのは申請までで、発行(inbound_endpoints への書き込み)は owner の
  // HTTP 操作だけ(発行経路を MCP / apply_diff に1本も結線しない)。
  "request_inbound_endpoint",
  // V3-M5-T01(ADR-0055 限定5)。逃げ道(任意 CSS)の**申請**ツール。request_connection の
  // 3例目 —— AI が到達できるのは申請までで、**CSS の本文を書けるのは owner の HTTP だけ**
  // (発行経路を MCP / apply_diff に1本も結線しない)。申請に本文の引数を置いていないのも
  // 同じ理由である(引数に置けば「AI が書いた CSS が pending に載る」= 経路が半分できる)。
  "request_custom_css",
  // V1-M8-T02(ADR-0025 §10)。要件定義書の生成ツール。**参照系**である ——
  // 生成物を保存せず、DB もファイルも1バイトも変えない(限定4 / 限定12)。
  "generate_requirements_doc",
  // V3-M5-T04(`D-G10a` / ADR-0056)。マニフェストに載る調整の蓄積を数えて昇格を**提案**する
  // **参照系**ツール。**提案するだけで1バイトも書き込まない**(昇格の書き込みは apply_diff)。
  // **カーネル語彙は1つも増えていない** —— 読むのは既存のマニフェストだけで、
  // 閾値はコード定数(`DRIFT_PROMOTION_THRESHOLD`)である。
  "report_drift",
  // V8-M13-T02(台帳 `Q-G28` = 限定採用(門A)。門A 本審査 = `V8-M7`)。集計表を1枚
  // 計算して返す **参照系**ツール。**読むだけで、書込の口を1つも作っていない**(限定3)。
  // **集計の計算を `src/mcp/` に1行も書いていない**(限定4)—— 呼ぶのは
  // `src/server/app.ts` の `readVisibleReport()` であり、**HTTP の集計表の口と同じ1本**
  // である(限定5: 可視性の判定を必ず通す)。**カーネル語彙は1つも増えていない。**
  "read_report",
  // V10-M12-T01(台帳 `CM-G7` = 限定採用(門A)。門A 本審査 = `V10-M9`。`ADR-0368`)。
  // 積まれたコメントを読み出す **参照系**ツール。**読むだけで、書込の口を1つも作っていない**
  // (限定2)。**可否の条件式を1行も書いていない**(限定3)—— 呼ぶのは
  // `src/server/comment-visibility.ts` の `visibleComments()` **1本だけ**である。
  // **カーネル語彙は1つも増えていない。**
  "list_comments",
  // V10-M30-T02(台帳 `CM-G37` = 限定採用(門A)。門A 本審査 = `V10-M29`。`ADR-0378`)。
  // アプリごとのコメントの出し入れを切り替える **更新系**ツール。**書く先は `apps` 表の
  // 列2本ちょうどで、道具の中に器を1本も作っていない**(限定6)。**可否の条件式を1行も
  // 書いていない**(限定4)—— 呼ぶのは `src/mcp/tools/write.ts` の `denyAppSettingWrite()`
  // **1本だけ**であり、`apply_diff` / `delete_app` と同じ壁である。
  // **名乗りを渡す引数を1本も置いていない**(限定3)。**カーネル語彙は1つも増えていない。**
  "set_comment_visibility",
] as const;

/** クライアントとサーバを直結する(両 `connect` は必ず `Promise.all`。逐次だとデッドロック)。 */
async function connectInMemory(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({
    dataRoot: "data",
    previewBaseUrl: "http://127.0.0.1:3000",
  });
  const client = new Client({ name: "descriptions-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * `tools/list` を引いて ツール名 → description の Map にする。
 *
 * description は SDK の型上 `string | undefined` なので、ここで文字列に
 * 正規化しておく(未設定は空文字になり、後続のアサーションで落ちる)。
 * `noNonNullAssertion` が error なので `!` は使わない。
 */
async function fetchDescriptions(): Promise<Map<string, string>> {
  const { client, close } = await connectInMemory();
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((tool) => [tool.name, tool.description ?? ""]));
  } finally {
    await close();
  }
}

/**
 * `resources/read` の戻りから本文を取り出す。
 *
 * **MCP の `contents` は「文字の資源(`text`)」か「バイト列の資源(`blob`)」のどちらかで、
 * 型の上では和である。** **今日ここが返すのは必ず `text` の側だが、`blob` が来た日に
 * 黙って空文字にならないよう、判別してから読む。**
 */
function resourceText(contents: readonly unknown[]): string {
  const [first] = contents;
  if (typeof first === "object" && first !== null && "text" in first) {
    return String((first as { text: unknown }).text);
  }
  return "";
}

/**
 * **`V17-M0-T01e`**: `resources/list` の URI 一覧と、`resources/read` の本文を取る。
 *
 * **`tools/list` から外した全文の**行き先**を、同じ形で測るための台である** ——
 * **測る対象が `tools/list` から `resources/read` へ移っただけで、測るのはやめていない。**
 */
async function fetchResources(): Promise<{ uris: string[]; textOf: Map<string, string> }> {
  const { client, close } = await connectInMemory();
  try {
    const { resources } = await client.listResources();
    const textOf = new Map<string, string>();
    for (const resource of resources) {
      const read = await client.readResource({ uri: resource.uri });
      textOf.set(resource.uri, resourceText(read.contents));
    }
    return { uris: resources.map((resource) => resource.uri), textOf };
  } finally {
    await close();
  }
}

/** Map から必ず文字列を取り出す(見つからなければ空文字 = アサーションで落ちる)。 */
function descriptionOf(descriptions: Map<string, string>, name: string): string {
  return descriptions.get(name) ?? "";
}

test("公開ツールはちょうど23個で、名前の集合が計画どおりである", async () => {
  const descriptions = await fetchDescriptions();

  // V1-M9-T05(ADR-0032)で redo / preview_redo の2本が加わり 17 → 19。
  // V2-M4-T01(ADR-0039)で write_records(バッチ原子書込)が加わり 19 → 20。
  // V2-M5-T01(ADR-0041)で request_inbound_endpoint(受信口の申請)が加わり 20 → 21。
  // V3-M5-T01(ADR-0055)で request_custom_css(逃げ道の申請)が加わり 21 → 22。
  // **増えたのは申請1本だけである** —— 発行(CSS の本文を置く)側のツールは0本のまま。
  // V3-M5-T04(ADR-0056 / `D-G10a`)で report_drift(逸脱の集計)が加わり 22 → 23。
  // **増えたのは参照系1本だけである** —— 書き込み系は0本のまま(昇格は既存の apply_diff)。
  // V8-M13-T02(ADR は `V8-M13-T07` が起草する)で read_report(集計表を読む)が
  // 加わり 23 → 24。**増えたのは参照系1本だけである** —— 書き込み系は0本のまま。
  // **【`ADR-0176` 限定2 / `ADR-0327` の「23本」は、今日この行によって偽になった】**
  // **テスト名は1バイトも書き換えていない**(「ちょうど23個」は 2026-08-14 までの事実)。
  // **旧行の逐語**: `expect(descriptions.size).toBe(23);`
  // V10-M12-T01(`ADR-0368`)で list_comments(コメントを読む)が加わり 24 → 25。
  // **増えたのは参照系1本だけである** —— 書き込み系は0本のまま。
  // **旧行の逐語**: `expect(descriptions.size).toBe(24);`
  // V10-M30-T02(`ADR-0378`)で set_comment_visibility(コメントの出し入れを切り替える)が
  // 加わり 25 → 26。**増えたのは更新系1本だけである** —— **参照系は0本のまま。**
  // **旧行の逐語**: `expect(descriptions.size).toBe(25);`
  expect(descriptions.size).toBe(26);
  expect([...descriptions.keys()].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
});

// --- V3-M5-T01: 逃げ道について AI に開いている口は申請1本だけ(ADR-0055 限定5)-----------
//
// **`src/server/escape-hatch-issuance.test.ts` と同型の検査である。**あちらがソースの上で
// 「`putEscapeHatchBody` / `issueEscapeHatchAsset` を呼ぶ製品コードは owner ルートと store
// 自身だけ」を固定するのに対し、ここは **LLM が実際に受け取る `tools/list` の側**から
// 「発行に見える口が1つも無い」ことを固定する。**説明文は担保ではない**(F-41)ので、
// 見るのは文言ではなく**ツールの集合**である。

test("V3-M5-T01: 逃げ道に触れる公開ツールは request_custom_css の1本だけである(経路の不在)", async () => {
  const descriptions = await fetchDescriptions();
  const names = [...descriptions.keys()];

  // 逃げ道(custom css)に触れる口はちょうど1本。
  expect(names.filter((name) => name.includes("custom_css"))).toEqual(["request_custom_css"]);

  // **逃げ道に触れる口のうち、申請でないものが1つも無い。**将来 `issue_custom_css` /
  // `upload_custom_css` / `delete_escape_hatch_asset` のような名前を足した日に、ここが落ちる。
  expect(
    names.filter((name) => /(css|style|hatch)/.test(name) && !name.startsWith("request_")),
  ).toEqual([]);
});

test("V3-M5-T01: request_custom_css の説明文は CSS 本文を受け取らないことと owner 専用であることを述べる", async () => {
  const descriptions = await fetchDescriptions();
  const description = descriptionOf(descriptions, "request_custom_css");

  // **これは担保ではなく正直さである**(F-41 の教訓: 説明文は担保にならないが、正直さは要る)。
  // 担保の側は上の「経路の不在」と escape-hatch-issuance.test.ts が持つ。
  expect(description).toContain("申請");
  expect(description).toContain("CSS の本文はこの申請に含められません");
  expect(description).toContain("1ピクセルも変わりません");
});

test("V3-M5-T01: request_custom_css の入力スキーマに CSS 本文の引数が1つも無い", async () => {
  const { client, close } = await connectInMemory();
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "request_custom_css");
    const properties = (tool?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    // **引数は4つだけ。**本文(css / style / body / content)を受ける引数を置いていない ——
    // 置けば「AI が書いた CSS が pending テーブルに載る」= 本体を書く経路が MCP 側に半分できる。
    expect(Object.keys(properties).sort()).toEqual(["app_id", "name", "purpose", "views"]);
  } finally {
    await close();
  }
});

// --- 2点 × 全ツール + 全文 × 1ツール ------------------------------------------------
//
// ツールごとに test() を分けているのは、落ちたときに「どのツールの説明文が
// どれを欠いているか」がテスト名だけで分かるようにするため。
// チェックリストの1行 = 1テスト、という対応にしてある。
//
// ## `V6-M12-T01`(`H-G11` / `ADR-0287`)で、貼るものが 3定数 → 2定数 + 全文1本 に変わった
//
// **2026-08-07 まで、ここは「3定数 × 23ツール」= 69本だった。**
// **`describeTool()` が23ツール全部に 41,683文字を貼っていたので、それが正だった。**
// **今日の正は「入口(`VOCABULARY_ENTRY_POINT`)+ 誘導(`SKILL_GUIDE`)が23ツール全部に載り、
// 3定数の全文がちょうど1ツールに載る」である**(`H-G11` 限定1・限定2 / `H-G12` 限定2)。
//
// **【期待値を緩めていない】** 検査の形は3点とも保っている ——
// (1) `tools/list` 越しに見る / (2) エクスポート定数そのものを照合する(R12。
// 「それらしい部分文字列」で見ない)/ (3) 共通文言だけの description を不合格にする。
// **さらに1点強くした** —— **全文を載せるツールの本数を「ちょうど1本」で固定する。**
// 0本になれば「全文がどこにも無い」= `H-G12` 限定2 の違反、2本以上になれば複写の再発である。
// **どちらも旧テストは検出できなかった**(旧テストは「全ツールに在る」しか見ていない)。
//
// ## `V10-M21-T01`(`FU-G14`)で、誘導の**中身**が本数で割れた。上の行は1バイトも消していない
//
// **上の段落が書いている「入口(`VOCABULARY_ENTRY_POINT`)+ 誘導(`SKILL_GUIDE`)が
// 23ツール全部に載り」は、2026-08-21 以降は偽である。**
// **今日の正**: **入口は24本すべてに載る(ここは1本も減っていない)。**
// **誘導は、`apply_diff` 1本だけが全文(`SKILL_GUIDE`)を受け取り、
// 残る23本は短い1文(`SKILL_POINTER`)を受け取る。**
//
// **【期待値を緩めていない】** **23本の側でも「載っている」ことを定数そのもので照合し(R12)、
// さらに `SKILL_GUIDE` が**載っていない**ことまで見る。** ここを見ないと、
// 差し替えが黙って戻っても赤くならない(= `FU-G14` が浮かせた原資が黙って消える)。
// **`apply_diff` の側は全文をそのまま照合する** —— 全文がどこにも無い状態を作らない、
// という `H-G12` 限定2 の担保は今日も同じである。

/**
 * 語彙境界の全文を載せるツール。**`H-G12` の限定2 の到達性の担保である。**
 *
 * **`apply_diff` である理由**: 語彙(リソース種・フィールド型・差分操作)を実際に
 * 書き換える唯一のツールがこれで、`update_view` の受付キーの列挙(限定5)の
 * 置き場でもある。**説明書(skill)を読めない MCP クライアントは、ここを開けば
 * 今日までと同じ全文に到達できる。**
 *
 * **【`V10-M21-T01`(`FU-G14`)で宣言の位置だけを上に移した。中身は1バイトも変えていない】**
 * **下のループが「このツールかどうか」で検査を割るようになり、ループは module の評価時に
 * 走るので、宣言がループより後ろに在ると TDZ(初期化前アクセス)で落ちる。**
 * **移したのは行の位置だけで、値も doc も同じである。**
 */
const FULL_VOCABULARY_TOOL = "apply_diff";

for (const name of EXPECTED_TOOL_NAMES) {
  test(`${name} の description に語彙の入口(VOCABULARY_ENTRY_POINT)が含まれる`, async () => {
    const descriptions = await fetchDescriptions();
    expect(descriptionOf(descriptions, name)).toContain(VOCABULARY_ENTRY_POINT);
  });

  if (name === FULL_VOCABULARY_TOOL) {
    test(`${name} の description には説明書への誘導が全文(SKILL_GUIDE)で載る`, async () => {
      const descriptions = await fetchDescriptions();
      expect(descriptionOf(descriptions, name)).toContain(SKILL_GUIDE);
    });
  } else {
    test(`${name} の description には短い誘導(SKILL_POINTER)が載り、全文(SKILL_GUIDE)は載らない`, async () => {
      const descriptions = await fetchDescriptions();
      const description = descriptionOf(descriptions, name);
      expect(description).toContain(SKILL_POINTER);
      expect(description).not.toContain(SKILL_GUIDE);
    });
  }
}

// **【`V17-M0-T01e`(`ADR-0413`)。下の3本のテスト名は1バイトも書き換えていない】**
// **「載せるツールはちょうど1本(`apply_diff`)である」は 2026-09-07 から字面として偽である。**
// **語彙境界の3定数は `tools/list` から外れ、MCP の resource へ移った** ——
// **今日「ちょうど1本」なのは道具ではなく resource の側である。**
//
// **【期待値を緩めていない。3点に増やした】**
// **(i) `tools/list` に載る道具が **0本**であること**(移送が本当に起きたこと。
//     ここが緩むと、全文が黙って `tools/list` へ戻っても赤くならない)
// **(ii) `resources/list` に**ちょうど1本**在ること**
// **(iii) `resources/read` の戻りが定数と**逐語一致**(`===`)すること**
//
// **`H-G12` 限定2 が守っていた形(0本でも2本でも赤くなる)は resource 側で保っている** ——
// **0本 = 全文がどこにも無い / 2本以上 = 複写の再発**、どちらも (ii) が赤くする。
//
// **【失うもの。丸めない】** **`resources/read` を1度も呼ばないクライアントには、
// 語彙境界の全文は今日以降届かない。** **接続しただけで必ず届く、ではなくなった。**
for (const [label, shared, uri] of [
  ["v0語彙の全範囲(VOCABULARY_SCOPE)", VOCABULARY_SCOPE, VOCABULARY_RESOURCE_URIS.scope],
  ["できないことの具体例(CANNOT_DO)", CANNOT_DO, VOCABULARY_RESOURCE_URIS.cannotDo],
  [
    "範囲外要求への振る舞い指示(OUT_OF_SCOPE_BEHAVIOR)",
    OUT_OF_SCOPE_BEHAVIOR,
    VOCABULARY_RESOURCE_URIS.outOfScope,
  ],
] as const) {
  test(`${label} を載せるツールはちょうど1本(${FULL_VOCABULARY_TOOL})である`, async () => {
    const descriptions = await fetchDescriptions();
    // (i) **`tools/list` に載る道具は0本である。**
    const carriers = EXPECTED_TOOL_NAMES.filter((name) =>
      descriptionOf(descriptions, name).includes(shared),
    );
    expect(carriers).toEqual([]);
    // **代わりに `apply_diff` が案内を受け取っていること**(全文の代わりに何が在るか)。
    expect(descriptionOf(descriptions, FULL_VOCABULARY_TOOL)).toContain(
      VOCABULARY_RESOURCE_POINTER,
    );

    const { uris, textOf } = await fetchResources();
    // (ii) **`resources/list` にちょうど1本**(0本でも2本でも赤くなる)。
    expect(uris.filter((listed) => listed === uri)).toEqual([uri]);
    // (iii) **`resources/read` の戻りが定数と逐語一致する**(`toContain` ではない)。
    expect(textOf.get(uri)).toBe(shared);
  });
}

// --- `V10-M21-T02`(`FU-G14`): 削除の後の行き先の意味が、接続しただけの AI に届く ---------
//
// **`CP-V10-FOLLOWUP` 条件12 が要求する形の検査である。**
// **着手前の実測**: 接続直後に AI へ渡る文字列の中で `after_delete` は **2回**現れるが、
// **2回とも `apply_diff` 1本の description の中の「`update_view` に書けるキーの一覧の
// 中の1語」であり、意味・書ける画面・値域・既定を述べた文は 0文字だった。**
//
// **【期待値を緩めていない】** 上のブロックと同じ3点を保っている ——
// (1) `tools/list` 越しに見る / (2) **エクスポート定数そのもの**を照合する(R12。
// 「それらしい部分文字列」で見ない)/ (3) **載る先を1本に固定する** ——
// 2本以上になれば、`V10-M21-T01` が畳んだばかりの複写の再発である。
//
// **3本目は文字列そのものの性質を見る**(限定9)—— **散文に数字を1文字も書かない。**
// 数を焼き込めば、画面の種別や語彙の本数が動いた日に、この散文だけが古い数を主張する。

test(`${FULL_VOCABULARY_TOOL} の description に after_delete の意味を述べた散文(AFTER_DELETE_GUIDE)が定数そのもので載る`, async () => {
  const descriptions = await fetchDescriptions();
  expect(descriptionOf(descriptions, FULL_VOCABULARY_TOOL)).toContain(AFTER_DELETE_GUIDE);
});

test("after_delete の散文(AFTER_DELETE_GUIDE)が載るのは apply_diff だけで、残りの道具には1本も載らない", async () => {
  const descriptions = await fetchDescriptions();
  const carriers = EXPECTED_TOOL_NAMES.filter((name) =>
    descriptionOf(descriptions, name).includes(AFTER_DELETE_GUIDE),
  );
  // 0本 = 意味がどこにも届いていない(条件12 の違反)。2本以上 = 散文を全ツールへ複写した。
  expect(carriers).toEqual([FULL_VOCABULARY_TOOL]);
});

test("after_delete の散文(AFTER_DELETE_GUIDE)は数字を1文字も含まない(FU-G14 限定9)", () => {
  expect(/[0-9０-９]/.test(AFTER_DELETE_GUIDE)).toBe(false);
});

// --- 共通文言だけの description を不合格にする ----------------------------------------

/**
 * 共通文言を取り除いた、そのツール固有の説明部分を返す。
 *
 * **`V6-M12-T01`**: 取り除く対象に `VOCABULARY_ENTRY_POINT` / `SKILL_GUIDE` を足した。
 * **3定数も引き続き取り除く** —— `apply_diff` はそれらを今も受け取るためで、
 * 除かないと `apply_diff` だけ「固有部が 41,683文字ある」ことになって検査が形骸化する。
 *
 * **【`V10-M21-T01`(`FU-G14`)で `SKILL_POINTER` を足した。上の行は1バイトも消していない】**
 * **`SKILL_GUIDE` も引き続き取り除く** —— 今日それを受け取るのは `apply_diff` 1本だけだが、
 * 除かないとその1本の固有部に全文が混ざり、共通部を除く検査の意味が消える。
 * **23本の側は `SKILL_POINTER` を除かないと、共通の66文字が固有部に居座る。**
 * **並び順に意味がある**: `SKILL_GUIDE` を先に除く。`SKILL_POINTER` は
 * `SKILL_GUIDE` の部分文字列ではないので取り違えは起きないが、
 * 「全文を先に、短い方を後に」という順を保っておく。
 */
function specificPartOf(description: string): string {
  return [
    VOCABULARY_SCOPE,
    CANNOT_DO,
    OUT_OF_SCOPE_BEHAVIOR,
    VOCABULARY_ENTRY_POINT,
    SKILL_GUIDE,
    SKILL_POINTER,
  ]
    .reduce((text, shared) => text.replace(shared, ""), description)
    .trim();
}

test("全ツールの description に、共通文言を除いたツール固有の説明が存在する", async () => {
  const descriptions = await fetchDescriptions();
  // **`V6-M12-T01`**: 全ツールに貼られる共通部が 3定数 → 2定数に変わったので、
  // 下限もそれに合わせる。**下限そのものを外していない** ——
  // 「共通文言だけの description」を不合格にするというこの検査の目的は変えていない。
  //
  // **【`V10-M21-T01`(`FU-G14`)で組み立て先を差し替えた。上の3行は1バイトも消していない】**
  // **24本すべてに載る共通部は、今日は「入口 + `SKILL_POINTER`」である**
  // (`SKILL_GUIDE` の全文は `apply_diff` 1本にしか載らないので、24本共通の下限には使えない)。
  // **【正直に書く】この差し替えで下限は下がる** —— `SKILL_GUIDE`(321文字)が
  // `SKILL_POINTER`(66文字)に替わるぶんだけ、この検査は弱くなった。
  // **弱くならない書き方を採らなかった理由**: ツールごとに下限を変えると
  // 「`apply_diff` を除いて」という但し書きを持つ検査になり、
  // 但し書きは次のツールが増えたときに黙って広がる(`vocabulary.ts` の `describeTool` の
  // doc が名指しで避けている型である)。**固有部が空でないことを見る次の行が、
  // 下限とは独立にこの検査の目的を担保している。**
  const sharedLength = VOCABULARY_ENTRY_POINT.length + SKILL_POINTER.length;

  for (const name of EXPECTED_TOOL_NAMES) {
    const description = descriptionOf(descriptions, name);
    // 共通部分より確実に長い = 固有の説明が乗っている。
    expect(description.length).toBeGreaterThan(sharedLength);
    expect(specificPartOf(description).length).toBeGreaterThan(0);
  }
});

test("ツール固有の説明は10ツールすべてで異なる(共通文言への潰れ込みが無い)", async () => {
  const descriptions = await fetchDescriptions();
  const specifics = EXPECTED_TOOL_NAMES.map((name) =>
    specificPartOf(descriptionOf(descriptions, name)),
  );

  expect(new Set(specifics).size).toBe(EXPECTED_TOOL_NAMES.length);
});

// --- サーバ全体の instructions との整合(T04 レビュー) --------------------------------
//
// T01 で書いた instructions は vocabulary.ts より前に存在しており、語彙を手書きで
// 重複させていた。T04 で3定数に差し替えたので、その状態を固定する。ここが崩れると
// 「サーバの指示は削除できると読めるが、ツール説明文はできないと言う」といった
// 食い違いが起き、LLM はどちらを信じるか分からなくなる。

// --- V0-P7-T04: 実地観察(docs/v0-findings.md §3)由来の追記を固定する ----------------
//
// ここから下は「v0 の実地でAIが実際に外した箇所」に対する説明文の手当てである。
// **どれも目視では守れない。** 説明文は将来 v1 で必ず書き換えられ、そのとき
// この5行は「冗長だから」という理由で真っ先に落ちる候補になる。
// `docs/v0-findings.md` §7 の退行チェックリストが名指ししている項目でもあるので、
// R12 と同じやり方 —— **エクスポート定数そのものを照合する** —— で固定する。
// それらしい部分文字列で見ると、言い回しを変えたときにテストが素通りしてしまう。
//
// 対応: F-22 / F-23 / F-24 / F-26 / F-33。F-25 は説明文ではなくエラー hint なので
// `tools/list` には現れず、`tools/write.test.ts` 側で固定している。

/**
 * `tools/list` を引いて ツール名 → inputSchema の JSON 文字列にする。
 *
 * F-22 の手当ては**引数 `intent` の `describe`** に置く。description ではなく
 * inputSchema に載るので、上の `fetchDescriptions()` では見えない。
 * LLM は `tools/list` の JSON を丸ごと受け取るため、引数の説明も同じ効き方をする。
 * その到達経路まで含めて検証したいので、スキーマを JSON 化して照合する。
 */
async function fetchInputSchemas(): Promise<Map<string, string>> {
  const { client, close } = await connectInMemory();
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((tool) => [tool.name, JSON.stringify(tool.inputSchema)]));
  } finally {
    await close();
  }
}

test("F-22: apply_diff の intent 引数の説明に、逐語で書けという指示が含まれる", async () => {
  const schemas = await fetchInputSchemas();
  // JSON.stringify は日本語をエスケープしない(bun/JS の既定)ので素の部分文字列で照合できる。
  expect(schemas.get("apply_diff") ?? "").toContain(INTENT_VERBATIM);
});

// **【V3-M1-T06 で改名した。本マイルストーンの増分ではない既存の陳腐化である。】**
// 旧テスト名は「**8つの op すべての**最小 JSON 例が含まれる」だったが、
// **ADR-0010(8種)の時代から陳腐化していた** —— このテストが名指しで照合しているのは
// additive 4 + 破壊的 4 + ワークフロー3 = 11種であって「すべて」ではなく、
// `DIFF_OPS` は ADR-0013 で12種・ADR-0024 で15種・ADR-0047 で16種になっている。
// **`set_theme` が作った問題ではない**(V3-M1-T03 段階B が実測で見つけて申し送った)。
// **数を書き換えるのではなく、このテストが実際に見ているものに名前を合わせた** ——
// 数を書くとまた同じ形で古くなる。真の照合(`DIFF_OPS` の全要素を覆うこと)は
// `vocabulary.test.ts` の「APPLY_DIFF_OP_EXAMPLES は DIFF_OPS の全 op に最小 JSON 例を持つ」にある
// (そちらは `DIFF_OPS` を import しているので自動追随する)。
test("F-23: apply_diff の description に op の最小 JSON 例が届いている(全 op の網羅照合は vocabulary.test.ts)", async () => {
  const descriptions = await fetchDescriptions();
  const description = descriptionOf(descriptions, "apply_diff");

  expect(description).toContain(APPLY_DIFF_OP_EXAMPLES);
  // 定数の中身そのものも検証する。ここが T04 の要点で、update_view だけが
  // 「対象を指す view(文字列)+ 変更内容 changes」という二層構造を持つ。
  // 例を1つでも落とすと、LLM は他の op から形を類推して必ず外す(F-4 / F-23)。
  //
  // **`DIFF_OPS` を真とみなす照合は `vocabulary.test.ts` に置いてある。**
  // ここで `DIFF_OPS` を import しないのは、ADR-0009 限定2 の
  // 「`src/kernel/` の外から値として import されるシンボル」のスナップショット
  // (`scripts/kernel-import-snapshot.txt`)を増やさないためである。
  // 同じ真偽を2箇所で確かめる価値より、境界の台帳を増やさないことを優先した。
  for (const op of ["add_table", "add_field", "add_view", "update_view"]) {
    expect(APPLY_DIFF_OP_EXAMPLES).toContain(`"op": "${op}"`);
  }
  for (const op of ["remove_field", "remove_table", "change_table", "change_field"]) {
    expect(APPLY_DIFF_OP_EXAMPLES).toContain(`"op": "${op}"`);
  }
  // V1-M2-T07(ADR-0013 §4c): ワークフロー3種。**ここも手書きのままにしてある** ——
  // 上のコメントのとおり、`DIFF_OPS` を import すると ADR-0009 限定2 の
  // スナップショットが増えるからである。真の照合は `vocabulary.test.ts` にある。
  for (const op of ["add_workflow", "update_workflow", "remove_workflow"]) {
    expect(APPLY_DIFF_OP_EXAMPLES).toContain(`"op": "${op}"`);
  }
  expect(APPLY_DIFF_OP_EXAMPLES).toContain('"changes"');
});

test("V1-M1-T06: op 例の注意書きが、ADR-0010 §1 が増やした field キーの非対称を書いている", () => {
  // `field` の意味は op によって違う —— `add_field` では**フィールド定義そのもの**、
  // `remove_field` / `change_field` では**フィールドIDの文字列**である。
  // `table` キーが `add_table` / `add_field` で既に持っていた非対称を、
  // ADR-0010 §1 が1つ増やした(schemas/diff.schema.json の `$comment` が明記)。
  // 書かないと、LLM は `add_field` の形から `remove_field` を類推して必ず外す。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("remove_field / change_field");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("フィールドIDの文字列");
});

test("F-24: insert_sample_data の description に日本語をエスケープするなという指示が含まれる", async () => {
  const descriptions = await fetchDescriptions();
  expect(descriptionOf(descriptions, "insert_sample_data")).toContain(SAMPLE_DATA_NO_ESCAPE);
});

test("F-24: エスケープ禁止の指示には、防止できないという限界が併記されている", () => {
  // 憲法6。この手当ては発生を減らすだけで、防止はできない —— エラーは MCP サーバに
  // 届く前のツール入力パース層で起きており、この層では捕捉できない。
  // 「限界を書く」ことまで込みで T04 の成果なので、限界の記述もテストで固定する。
  expect(SAMPLE_DATA_NO_ESCAPE).toContain("この指示でも防ぎきれません");
});

test("F-26: get_preview_url の description に、戻り値をそのまま引用せよという指示が含まれる", async () => {
  const descriptions = await fetchDescriptions();
  expect(descriptionOf(descriptions, "get_preview_url")).toContain(PREVIEW_URL_VERBATIM);
});

test("F-33: 破壊的な要求を代替案で置き換えるときは適用前に同意を取る、が apply_diff に載る", async () => {
  const descriptions = await fetchDescriptions();

  // **`V6-M12-T01`(`H-G11`)で、載る先が 23ツール → 1ツール(apply_diff)に減った。**
  // **理由**: この文は `OUT_OF_SCOPE_BEHAVIOR` に組み込んであり、その定数が
  // 全ツール貼りから `apply_diff` 1本へ移ったため。**この文自体は1バイトも変えていない。**
  //
  // **【これは損失である。丸めない】** **`H-G13`(`V6-M12-T04`)が数えた損失の1件で、
  // `docs/plan/v6/records/v6-m12.md` §6 に「23ツール → 1ツール」として記録してある。**
  // **F-33 は v0 の実地観察(`docs/v0-findings.md` §3)由来の手当てであり、
  // 「破壊的な代替に黙って倒す」という実際に起きた失敗への歯止めである。**
  // **`DESTRUCTIVE_CHANGE_FLOW` は `instructions` に全文が残っているので、
  // 破壊的な op の手順そのものは接続直後に今も届く**(そちらは1文字も外していない)。
  // **【`V17-M0-T01e`(`ADR-0413`)。上の逐語もテスト名も1バイトも書き換えていない】**
  // **「apply_diff に載る」は 2026-09-07 から偽である。** `OUT_OF_SCOPE_BEHAVIOR` は
  // `tools/list` から外れ、MCP の resource(`vocabulary://out-of-scope`)へ移った。
  //
  // **【接続直後には届かなくなった。これは損失である】**
  // **`DESTRUCTIVE_SUBSTITUTE_CONSENT`(1,451文字)は `OUT_OF_SCOPE_BEHAVIOR` の 45% を占め、
  // v0 の実地観察(`docs/v0-findings.md` §3)由来の歯止めである** ——
  // 「元に戻せない変更の前に `dry_run_diff` で影響行数を見せてから同意を取る」
  // 「`undo` は差分の逆適用ではない」「`undo` の前に `preview_undo` を呼ぶ」。
  // **今日まで接続しただけで必ず届いていたこの手当ては、今日以降
  // `resources/read` を呼んだクライアントにしか届かない。**
  // **`instructions` に残る `DESTRUCTIVE_CHANGE_FLOW` は代替にならない**
  // (点検者の実測で、両者の重なりは 0.7%)。**「軽微」とは書かない。**
  //
  // **【期待値を緩めていない】** 届く先が変わっただけで、**届いていることは今日も
  // 逐語で測る** —— 下の2本が (i) resource の戻りに載ること (ii) 定数の中に在ること。
  expect(descriptionOf(descriptions, "apply_diff")).not.toContain(DESTRUCTIVE_SUBSTITUTE_CONSENT);
  const { textOf } = await fetchResources();
  expect(textOf.get(VOCABULARY_RESOURCE_URIS.outOfScope)).toContain(DESTRUCTIVE_SUBSTITUTE_CONSENT);
  expect(OUT_OF_SCOPE_BEHAVIOR).toContain(DESTRUCTIVE_SUBSTITUTE_CONSENT);
});

test("F-33: 同意を求める範囲は破壊的要求の置き換えに限定され、全変更には広がっていない", () => {
  // **この限定が判断の中身である**(docs/v0-t04-record.md の F-33 を参照)。
  // 「適用前に必ず確認せよ」と一般化すると確認の往復が全面的に増えるが、
  // その体験コストは v0 で**測っていない**(F-34)。測っていないものを根拠に
  // 「増やしてよい」とは言えないので、範囲を破壊的要求の置き換えだけに絞った。
  // 将来この文言が「すべての変更で確認せよ」へ広がると、測っていないコストを
  // 黙って払うことになる。そうならないようテストで縛る。
  expect(DESTRUCTIVE_SUBSTITUTE_CONSENT).toContain("削除・リネーム・型変更");
  expect(DESTRUCTIVE_SUBSTITUTE_CONSENT).not.toContain("すべての変更");
});

test("F-33(V1-M1-T06 の置換): 判定の軸は『字義どおりか』ではなく『元に戻せるか』である", () => {
  // **ADR-0010 §6e の保つべき性質2。** V1-M0-T10 は「ユーザの承認が別の操作にずれるか」
  // という1軸だけを採った。そうできたのは **v0 では字義どおり実行できる操作がすべて
  // 非破壊だったため、2つの軸が常に一致していたから**である。
  // M1 が2軸を分離する —— `remove_field` は**字義どおりでずれは生じないが、
  // データの永久消失である**。T10 の論証をそのまま当てると「確認は要らない」になる。
  //
  // **軸を足すのではなく置き換える**(ADR-0010 §6e の性質2)。
  expect(DESTRUCTIVE_SUBSTITUTE_CONSENT).toContain("元に戻せるか");
  expect(DESTRUCTIVE_SUBSTITUTE_CONSENT).toContain("元に戻せない結果になる場合");

  // 「字義どおり実行できるかどうかではない」と明示的に否定していること。
  // ここを黙って落とすと、T10 の文言を読んだ記憶で古い軸に戻れてしまう。
  expect(DESTRUCTIVE_SUBSTITUTE_CONSENT).toContain("字義どおり");

  // 分岐の両側が文言に存在すること。片側だけだと基準が再び一方向に読める。
  // (a) 語彙に無いので代替する場合 = ずれが生じるので確認が要る(T04 の元の場面)
  expect(DESTRUCTIVE_SUBSTITUTE_CONSENT).toContain("語彙に無い");
  // (b) 元に戻せる変更 = 確認は要らない
  expect(DESTRUCTIVE_SUBSTITUTE_CONSENT).toContain("この確認は要りません");

  // 実地(001-t04-improvements ターン3)で争点になった発話そのものを例として持つこと。
  // **新しい軸でも結論は変わらない**(update_view の列外しは同じ op で戻せる)が、
  // 理由が変わる。例を落とすと、次に同じ場面が来たときに同じ争いが起きる。
  expect(DESTRUCTIVE_SUBSTITUTE_CONSENT).toContain("一覧から削除");

  // **保つべき性質3**: T10 が確認の代わりに入れた「事後報告の正確さ」の義務を消さない。
  expect(DESTRUCTIVE_SUBSTITUTE_CONSENT).toContain("何が残っているか");

  // **保つべき性質4**: undo で何が戻り何が戻らないかを併せて伝えること。
  expect(DESTRUCTIVE_SUBSTITUTE_CONSENT).toContain(UNDO_ROLLBACK_LIMIT);
});

// --- V1-M1-T06: 破壊的変更の推奨フローと undo の限界 -------------------------------------
//
// 計画書 §V1-M1-T06 の内容は「破壊的 diff の推奨フロー『dry_run → ユーザ確認 → apply →
// 検証 → 問題あれば undo』をツール説明文に焼き込む」ことである。
// **焼き込んだことは機械で固定できる。焼き込んだ結果 AI がその順で使うかは実地でしか
// 分からない**(証跡は `docs/evidence/cp-v1-1/transcripts/`)。ここは前者だけを見る。

// **【2026-08-25。`V10-M28-T04` の (c)。この検査は今日も緑であり、条件を1つも緩めていない】**
//
// **`DESTRUCTIVE_CHANGE_FLOW` は全ツールの説明に「まず `dry_run_diff`」を埋め込んでおり、
// 下の検査がその5語の順序を固定している。** **ところが `V10-M28-T02` が
// `dry_run_diff` に `app` × `write` の壁を足したので、**その権限を持たない相手は
// 第1段から進めない**。**
//
// **これは食い違いである。塞いでいない。** **5段は「破壊的な差分をどう扱うか」の手順で
// あって「誰がそれをできるか」を述べたものではなく、権限が無い相手にとっては
// 第1段の時点で断りが返る。** **断り文(`appChangeRuleRequiredError` の写し)は
// 直し方(`set_roles` で `target: "app"` / `can: ["write"]` を書く)を名指ししており、
// AI はそこから人間に依頼へ回れる** —— **手順の文言のほうは1バイトも変えていない。**
// **【禁止】これを「5段が通らなくなった」と書かない** —— **権限を持つ相手には今日も通る。**
test("V1-M1-T06: 推奨フローが5段すべてを、この順で述べている", () => {
  const flow = DESTRUCTIVE_CHANGE_FLOW;
  const steps = ["dry_run_diff", "同意", "apply_diff", "検証", "undo"];
  let cursor = -1;
  for (const step of steps) {
    const at = flow.indexOf(step, cursor + 1);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }
  // **ドライランを飛ばして直接 apply しないこと**が検証方法の明示要件である。
  expect(flow).toContain("この手順を飛ばして apply_diff を呼ばないこと");
  // 破壊的 op が名指しされていること(どの場面で使う手順かが決まらないと発火しない)。
  for (const op of ["remove_field", "remove_table", "change_table", "change_field"]) {
    expect(flow).toContain(op);
  }
});

test("V1-M1-T06: 推奨フローは confirm のようなフラグ引数を導入していない(F-38 / §7-4)", () => {
  // `DELETE_RECORD_SHOW_TARGET_FIRST` が明示した設計判断をフローでも保つ。
  // フラグを置くと「confirm を付ければ安全」という誤った学習を生む。
  expect(DESTRUCTIVE_CHANGE_FLOW).toContain("confirm のようなフラグ引数はありません");
});

test("V1-M1-T06: undo の限界(apply 以降のデータも消える)が定数として書かれている", () => {
  // `src/kernel/undo.ts` の直訳(ADR-0004 §4 / ADR-0010 §2(a))。
  // **undo は差分の逆適用ではなく、対象 apply の直前 DB 全体の書き戻しである。**
  // 「undo すれば戻せます」とだけ書くのは嘘になる。
  expect(UNDO_ROLLBACK_LIMIT).toContain("データベース全体を書き戻す");
  expect(UNDO_ROLLBACK_LIMIT).toContain(
    "apply 以降に追加・編集されたレコードは、undo すると一緒に消えます",
  );
  expect(UNDO_ROLLBACK_LIMIT).toContain("「undo すれば元に戻せます」とだけ説明してはいけません");
  // 実測を見せる手段(preview_undo)へ繋いでいること。
  expect(UNDO_ROLLBACK_LIMIT).toContain("preview_undo");
});

for (const name of ["apply_diff", "dry_run_diff", "undo"] as const) {
  test(`V1-M1-T06: ${name} の description に推奨フローが載る`, async () => {
    const descriptions = await fetchDescriptions();
    expect(descriptionOf(descriptions, name)).toContain(DESTRUCTIVE_CHANGE_FLOW);
  });

  test(`V1-M1-T06: ${name} の description に undo の限界が載る`, async () => {
    const descriptions = await fetchDescriptions();
    expect(descriptionOf(descriptions, name)).toContain(UNDO_ROLLBACK_LIMIT);
  });
}

test("V1-M1-T06: apply_diff の description が「破壊的 op は存在しない」と嘘をついていない", async () => {
  const descriptions = await fetchDescriptions();
  const description = descriptionOf(descriptions, "apply_diff");

  // T04 の時点では「operations に書けるのは4つだけ」「remove_field ... のような
  // 操作名は**存在しません**」と書いてあった。ADR-0010 が4 op を足した以上、これは嘘である。
  expect(description).not.toContain(
    "operations に書けるのは add_table / add_field / add_view / update_view の4つだけです",
  );
  expect(description).not.toContain(
    "remove_field / delete_table / rename_field / change_field_type のような操作名は**存在しません**",
  );
  // 実際に存在しない op 名(語彙外)は、引き続き名指しで否定してよい。
  expect(description).toContain("delete_table");
});

test("V1-M1-T06: サーバの instructions にも推奨フローが載る", async () => {
  // ツール説明文だけに置くと、AI が `tools/list` の1ツールぶんしか読まなかった場合に
  // 落ちる。instructions はセッション開始時に必ず渡る(server.ts:72-77)。
  const server = createMcpServer({ dataRoot: "data", previewBaseUrl: "http://127.0.0.1:3000" });
  const client = new Client({ name: "flow-instructions-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    expect(client.getInstructions() ?? "").toContain(DESTRUCTIVE_CHANGE_FLOW);
    // V1-M2-T07(ADR-0013 §10 項目5): ワークフロー3 op に課した1段の同意も、
    // 同じ定数に載せたので**この経路で必ず届く**。新しい定数を作らなかった理由がこれで、
    // 届いていることを部分文字列でも念のため名指ししておく(定数そのものの照合は上の行)。
    expect(client.getInstructions() ?? "").toContain("add_workflow");
  } finally {
    await client.close();
    await server.close();
  }
});

// --- V1-M0-T01: レコード訂正ツールの説明文3点を定数として固定する -----------------------
//
// **完了条件5** は「(a) システムテーブルには書けないこととその理由 /
// (b) `_changelog` に載らないこと / (c) 削除前に対象を人間に見せること が含まれ、
// **定数として置かれている**」ことを要求している(T04 が確立した方式。
// 目視レビューに依存させない)。ここがその機械化である。
//
// 加えて **完了条件6**(F-37 の「自分のミスを自ら申告する」が退行していないこと)の
// 説明文側の手当ても固定する。**ただし説明文はプロンプトであって強制力ではない**
// —— 実際に AI がそう振る舞うかは実地でしか分からない(§実地試行の項)。

const RECORD_WRITE_TOOLS = ["update_record", "delete_record"] as const;

for (const name of RECORD_WRITE_TOOLS) {
  test(`完了条件5a: ${name} の description に、システムテーブルへ書けない理由と判定順序が載る`, async () => {
    const descriptions = await fetchDescriptions();
    expect(descriptionOf(descriptions, name)).toContain(RECORD_WRITE_SYSTEM_TABLE_READONLY);
  });

  test(`完了条件5b: ${name} の description に、この操作が _changelog に載らないと載る`, async () => {
    const descriptions = await fetchDescriptions();
    expect(descriptionOf(descriptions, name)).toContain(RECORD_WRITE_NOT_IN_CHANGELOG);
  });

  test(`完了条件6: ${name} の description に、自分のミスを黙って直すなという指示が載る`, async () => {
    const descriptions = await fetchDescriptions();
    expect(descriptionOf(descriptions, name)).toContain(RECORD_WRITE_SELF_REPORT);
  });
}

test("完了条件5c: delete_record の description に、削除前に対象を人間へ見せよと載る", async () => {
  const descriptions = await fetchDescriptions();
  expect(descriptionOf(descriptions, "delete_record")).toContain(DELETE_RECORD_SHOW_TARGET_FIRST);
});

test("V1-M9-T09: delete_app の description に、消える中身を先に見せよの規律が載る", async () => {
  const descriptions = await fetchDescriptions();
  expect(descriptionOf(descriptions, "delete_app")).toContain(DELETE_APP_SHOW_CONTENTS_FIRST);
});

test("V1-M9-T09: delete_app の不可逆性の定数が、undo 不可・バックアップ非連動・提示同意を書いている", () => {
  // 目視レビューに依存させない(M0-T01 の方式)。文言そのものを照合する。
  // (1) 取り消せない・スナップショットごと消えて undo で戻らない。
  expect(DELETE_APP_SHOW_CONTENTS_FIRST).toContain("取り消せません");
  expect(DELETE_APP_SHOW_CONTENTS_FIRST).toContain("undo でも戻りません");
  // (2) バックアップは連動しない(最大7世代残りうる)。憲法6: 「あとで復元できます」を名指し禁止。
  expect(DELETE_APP_SHOW_CONTENTS_FIRST).toContain("バックアップ");
  expect(DELETE_APP_SHOW_CONTENTS_FIRST).toContain("説明してはいけません");
  // (3) 同意は提示で取り、confirm フラグは無い(delete_record / undo と同じ判断)。
  expect(DELETE_APP_SHOW_CONTENTS_FIRST).toContain("get_manifest");
  expect(DELETE_APP_SHOW_CONTENTS_FIRST).toContain("confirm のような引数はありません");
});

test("完了条件5a: システムテーブルの断り書きは、判定順序まで書いている(ADR-0006 §7)", () => {
  // 「書けません」とだけ書くと、LLM は「実在する _id を渡せば書けるのでは」と外挿する。
  // カーネルは読み取り専用の拒否を**レコードの存在確認より前**に置いており、
  // その順序を説明文が伝えていることが、完了条件2 の振る舞いと対になる。
  expect(RECORD_WRITE_SYSTEM_TABLE_READONLY).toContain("存在確認より前に拒否されます");
  expect(RECORD_WRITE_SYSTEM_TABLE_READONLY).toContain("再試行しても結果は変わりません");
  // 「なぜ書けないか」の理由が入っていること(完了条件5a の「理由付きで」)。
  expect(RECORD_WRITE_SYSTEM_TABLE_READONLY).toContain("読み取り専用");
});

test("完了条件5b: 既存の _changelog の断り書き(VOCABULARY_SCOPE)と矛盾していない", () => {
  // F-36。`VOCABULARY_SCOPE` の断り書きは実地で機能している(AI がこの知識で
  // 自分の成果物の欠陥を自力で発見した)ので**消さない**。T01 が足すのはその帰結だけで、
  // 範囲を広げも狭めもしない。両者が同じ範囲を語っていることを固定する。
  expect(VOCABULARY_SCOPE).toContain(
    "_changelog に載るのは create_app によるアプリ作成と apply_diff 経由の変更だけです",
  );
  expect(RECORD_WRITE_NOT_IN_CHANGELOG).toContain(
    "_changelog に載るのは create_app によるアプリ作成とapply_diff 経由のスキーマ変更だけ",
  );
  // 非対称(スナップショットも undo も無い)まで書いていること。
  expect(RECORD_WRITE_NOT_IN_CHANGELOG).toContain("undo でも元に戻せません");
  // 嘘の説明を名指しで禁じていること(憲法6)。
  expect(RECORD_WRITE_NOT_IN_CHANGELOG).toContain("説明してはいけません");
});

test("完了条件4: 同意はフラグ引数ではなく提示で取る、と説明文が明言している(F-38)", () => {
  // `preview_undo` → 人間に見せる → 同意 の形をそのまま踏襲する。
  // 文言から `list_records` が消えると、AI は「何を見せればよいか」を失う。
  expect(DELETE_RECORD_SHOW_TARGET_FIRST).toContain("list_records");
  expect(DELETE_RECORD_SHOW_TARGET_FIRST).toContain("confirm のような引数はありません");
});

test("完了条件6: 申告の指示は、訂正手段ができたことと結びつけて書かれている(F-37)", () => {
  // 「直せるようになった今も」が要点である。入口を開けたことこそが、
  // 「黙って直す」方向への動機を作る。そこを名指ししていないと、
  // 将来この行は「当たり前のこと」として削られる。
  expect(RECORD_WRITE_SELF_REPORT).toContain("直せるようになった今も");
  // 人間が直すための情報(_id)を渡す、という F-37 の実際の振る舞いを残す。
  expect(RECORD_WRITE_SELF_REPORT).toContain("_id");
});

/**
 * **`V6-M12-T03`(`H-G12` の限定1)の機械的な固定** —— 「`instructions` の構成要素の数を
 * 数える検査1本」がこれである。
 *
 * **2026-08-07 まで、このテストは「instructions もツール説明文と同じ3定数を使っている」
 * だった。** **`H-G12` は `instructions` に残すものを4つに限定したので、
 * 検査も「4つだけであること」を数える形に変える。**
 *
 * **【期待値を緩めていない】** 旧テストは「3定数が在る」しか見ておらず、
 * **何が在ってはいけないかを1つも見ていなかった。** 今日の検査は
 * **在るべき4つと、在ってはいけない3つの両方**を見る。
 */
test("V6-M12-T03: instructions の構成要素はちょうど4つで、限定1 が挙げた4つと一致する", async () => {
  const server = createMcpServer({ dataRoot: "data", previewBaseUrl: "http://127.0.0.1:3000" });
  const client = new Client({ name: "instructions-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const instructions = client.getInstructions() ?? "";

    // (i) サーバの名乗り1文 / (ii) 語彙の入口 / (iii) できないことの見出し /
    // (iv) DESTRUCTIVE_CHANGE_FLOW 全文。**この4つを "\n" で連結したものと完全一致する** ——
    // 5つ目を足した日も、順序を入れ替えた日も、ここが赤くなる。
    expect(instructions).toBe(
      [
        "SmAIltalk(スマイルトーク)のカーネルを操作する MCP サーバです。",
        VOCABULARY_ENTRY_POINT,
        CANNOT_DO_INDEX,
        DESTRUCTIVE_CHANGE_FLOW,
      ].join("\n"),
    );

    // **`DESTRUCTIVE_CHANGE_FLOW` は1文字も外れていない**(限定1 の (iv))。
    expect(instructions).toContain(DESTRUCTIVE_CHANGE_FLOW);

    // **3定数の全文は載っていない**(`H-G12` の目的そのもの)。
    // **ただし定数は削除していない** —— 到達先は `apply_diff` である(限定2。上の検査)。
    expect(instructions).not.toContain(VOCABULARY_SCOPE);
    expect(instructions).not.toContain(CANNOT_DO);
    expect(instructions).not.toContain(OUT_OF_SCOPE_BEHAVIOR);
  } finally {
    await client.close();
    await server.close();
  }
});

// --- V1-M1-T02: ドライラン機構の説明文と登録先 -----------------------------------------
//
// **登録先の判断がここで機械的に固定される。** `dry_run_diff` を read.ts に置くことと
// `scripts/mcp-trial/transcript.ts` の `WRITE_TOOLS` に入れないことは一体の判断であり
// (ADR-0010 Consequences / 記録 §1-1)、後者は `write-tools-drift.test.ts` の
// 「WRITE_TOOLS に参照系ツールが混ざっていない」が既に見張っている。
// **こちらは前者(参照系として登録されていること)を見張る。** 片側だけだと、
// 登録先を write.ts へ移した日に `WRITE_TOOLS` の側だけが赤くなり、
// 「WRITE_TOOLS に足せば緑になる」という誤った直し方へ誘導される。

test("V1-M1-T02: dry_run_diff は参照系(registerReadTools)として登録されている", async () => {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerReadTools(server, { dataRoot: "data", previewBaseUrl: "http://127.0.0.1:3000" });

  const client = new Client({ name: "read-tools-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("dry_run_diff");
  } finally {
    await client.close();
    await server.close();
  }
});

test("V1-M1-T02: dry_run_diff の description が、適用の成功を保証しないと述べている", async () => {
  const descriptions = await fetchDescriptions();
  // カーネルが返すレポートに載る注記そのもの(`DRY_RUN_NOTE`)を説明文にも載せる。
  // 別々の文言にすると、「ツール説明では保証しないと言い、レポートでは言わない」
  // (あるいはその逆)という食い違いが生まれる。
  expect(descriptionOf(descriptions, "dry_run_diff")).toContain(DRY_RUN_NOTE);
});

test("V1-M1-T02: dry_run_diff と apply_diff の diff 入力スキーマが完全に一致する", async () => {
  // **ドライランの存在意義は「同じ差分を送れば同じ結果になる」ことである。**
  // 入力スキーマがずれると、apply_diff には送れるがドライランには送れない差分
  // (あるいはその逆)が生まれ、推奨フロー「dry_run → apply」がその差分で切れる。
  // 両ツールの `diff` 引数は別々に定義されている(read.ts / write.ts)ので、
  // 手で写した事実がずれないことをここで機械的に見張る。
  const { client, close } = await connectInMemory();
  try {
    const { tools } = await client.listTools();
    const schemaOf = (name: string): unknown =>
      tools.find((tool) => tool.name === name)?.inputSchema.properties;
    const dryRun = schemaOf("dry_run_diff") as Record<string, unknown> | undefined;
    const apply = schemaOf("apply_diff") as Record<string, unknown> | undefined;

    expect(dryRun?.diff).toBeDefined();
    expect(dryRun?.diff).toEqual(apply?.diff);
    expect(dryRun?.app_id).toEqual(apply?.app_id);
  } finally {
    await close();
  }
});

// --- V1-M2-T02: 実行履歴テーブルの列の規約が、実際に AI へ届いていること -----------------
//
// **ADR-0013 §8c 問4 の決定により、この規約の在処はツール説明文しかない。**
// カーネルは履歴テーブルを1つも自動生成せず(限定8)、参照整合性が保証するのも
// 「テーブルが実在すること」だけである(§8d 限界1)。**説明文に届いていなければ、
// 規約は存在しないのと同じである。**
//
// **新しい配線は1本も足していない** —— `WORKFLOW_HISTORY_TABLE_TEMPLATE` は
// `APPLY_DIFF_OP_EXAMPLES` の末尾に連結してあり、既に `tools/write.ts:306` から
// `apply_diff` の description に届いている経路に相乗りしている
// (`DESTRUCTIVE_CHANGE_FLOW` が V1-M2-T07 で採ったのと同じ判断)。
// **ここで見るのは「相乗りが実際に効いていること」である。**

test("V1-M2-T02: apply_diff の description に履歴テーブルのひな形が丸ごと届いている", async () => {
  const descriptions = await fetchDescriptions();
  // R12: それらしい部分文字列ではなく、**エクスポート定数そのもの**を照合する。
  expect(descriptionOf(descriptions, "apply_diff")).toContain(WORKFLOW_HISTORY_TABLE_TEMPLATE);
});

test("V1-M2-T02: 履歴テーブルの5列すべてが apply_diff の description に現れる", async () => {
  const descriptions = await fetchDescriptions();
  const description = descriptionOf(descriptions, "apply_diff");
  // **`WORKFLOW_HISTORY_COLUMNS` を import していない。**理由は上の F-23 の
  // テストが `DIFF_OPS` について書いたものと同じで、ADR-0009 限定2 の
  // import スナップショット(`scripts/kernel-import-snapshot.txt`)を増やさないため。
  // **この5つは `src/kernel/workflow-runner.ts` からの手書きの複製であり、
  // 向こうを変えたらここも追随が要る。**
  for (const column of ["ran_at", "workflow", "trigger_type", "status", "error"]) {
    expect(description).toContain(`"id": "${column}"`);
  }
  // 型まで届いていること(列名だけ合っていても、型が違えば書き込みは失敗する)。
  expect(description).toContain('"id": "ran_at", "name": "実行時刻", "type": "date"');
  expect(description).toContain('"id": "error", "name": "エラー", "type": "long_text"');
});

test("V1-M2-T02: select を使うなという警告が apply_diff の description に現れる", async () => {
  const descriptions = await fetchDescriptions();
  const description = descriptionOf(descriptions, "apply_diff");
  // **AI が最も踏みやすい罠**(`src/kernel/records.ts:311-325` が実測の根拠)。
  // 弾かれた失敗を書く先がまた同じ列なので、失敗がどこにも残らない循環になる。
  expect(description).toContain("**status と trigger_type に select 型を使ってはいけません。**");
  // 【V4-M4-T03 / ADR-0072 限定6】**罠の説明文を弱めない。** 値が3つになったぶん圧力が
  // 上がったことを、記述の側に明記させる(ADR-0072 限定6 / 04 §3-5 #3)。
  /*
   * 【`V8-M42` / `F-G15` / `ADR-0333`。**旧の期待値2本を逐語で残す**】
   *
   *     expect(description).toContain(
   *       "**status も3値(success / failure / suppressed)なので、同じ危険がそのまま乗ります**",
   *     );
   *     // 履歴の5列の説明が3値を書いていること(`vocabulary.ts:959` の当たり先)。
   *     expect(description).toContain("status = success / failure / suppressed の3値、");
   *
   * **`status` に4値目 `no_target` が入った**(`ADR-0333` 限定2)。 **`ADR-0072` 限定6
   * (罠の説明文を弱めない)は今日も守られている** —— **「3値」を「4値」に直しただけで、
   * 警告の1文字も弱めていない。** **`ADR-0072` 限定2(4値目を足さない)は `ADR-0333` が
   * 引き直した**(双方向の `amended_by` を front matter に入れてある)。
   */
  expect(description).toContain(
    "**status も4値(success / failure / suppressed / no_target)なので、同じ危険がそのまま乗ります**",
  );
  // 履歴の5列の説明が4値を書いていること(`vocabulary.ts:959` の当たり先)。
  expect(description).toContain("status = success / failure / suppressed / no_target の4値、");
  // 【`V8-M42` / `F-G15` / `ADR-0333`】4値目が「失敗ではない」ことと、同じ日に再発火しうる
  // ことを、記述の側に書かせる(**書かないと AI は no_target を異常として扱う**)。
  expect(description).toContain(
    "**no_target は「対象表を指定した毎日の処理が、対象を1件も得られずに発火した」ことを表します**",
  );
  // 再発火の抑止が `suppressed` として残ることを書いていること(`:999` の当たり先)。
  expect(description).toContain(
    "2度目の発火は抑止され、**status = suppressed** として履歴に残ります",
  );
  // 読み手への案内が、失敗と抑止を取り違えさせない形になっていること(`:1002` の当たり先)。
  expect(description).toContain(
    "履歴に「深度上限」を含む failure や、「再発火」を含む suppressed が並んでいたら、",
  );
  expect(description).toContain("**その失敗の記録自体がどこにも残りません。**");
  /*
   * 【V1-M2-T05a で主張が反転した。】ここはもともと
   * 「規約が機械的に検査されないこと(§8d 限界1)を隠していない」ことを見ていた。
   * **D1 でその検査が実装されたので、古い申告が届き続けるほうが嘘になる。**
   * 反転した主張を同じ強さで、**tools/list に実際に届く経路で**固定する
   * (定数の中身は `vocabulary.test.ts` が見る。ここが見るのは配送である)。
   */
  expect(description).not.toContain(
    "**この規約が守られているかを機械的に検査する仕組みはありません。**",
  );
  expect(description).toContain("**この5列は差分の適用時に検査されます。**");
});

/**
 * V1-M2-T05e(T05a D2 の後継): 口ひげ記法についての説明が、
 * **制約導入後の事実のまま** `tools/list` まで届いていること。
 *
 * **T05a の時点では「直せなかった欠陥の申告」だった** —— スキーマの制約変更が
 * 門A 審査を要したため、説明文だけが唯一の防波堤だった。
 * **T05d が門A で限定採用し、T05e が実装したので、事実が変わった** ——
 * 今は差分ごと拒否される。**古い申告が届き続けるほうが有害である**(憲法6)。
 */
test("V1-M2-T05e: 口ひげ記法が拒否されるという事実が apply_diff の description に届く", async () => {
  const descriptions = await fetchDescriptions();
  const description = descriptionOf(descriptions, "apply_diff");
  // 記法の名指しは残っている(抽象的な「他の記法」では届かない)。
  expect(description).toContain("{{record.name}}");
  // **新しい事実**が届いていること。
  expect(description).toContain("拒否されます");
  // **古い嘘**が届いていないこと。
  expect(description).not.toContain("エラーになりません");
  expect(description).not.toContain("そのままレコードに書き込まれます");
});

// --- V1-M2-T03: 無限ループ防止が生んだ2つの限界が、実際に AI へ届いていること -------------
//
// **T03 判断2 は沈黙の破壊を1つ作った** —— 履歴テーブルを trigger.table に持つ
// ワークフローは、参照整合性を通り、適用も成功し、**しかし永久に発火しない。**
// エラーにならないので、AI もユーザも「動かない」ことに気づく手段が説明文しか無い。
// **説明文に届いていなければ、この限界は完全に沈黙する(憲法6)。**ここで見張る。
//
// **深度上限 20 と再発火抑止も同じ理由でここに要る** —— 履歴に status = failure が
// 並んだとき、AI がそれを「自分の書いたワークフローが互いを発火させている」と
// 読めなければ、直しようがない。

test("V1-M2-T03: 履歴テーブルがワークフローを発火させないことが description に届いている", async () => {
  const descriptions = await fetchDescriptions();
  const description = descriptionOf(descriptions, "apply_diff");
  expect(description).toContain(
    "**履歴テーブルへの書き込みは、どのワークフローも発火させません。**",
  );
  // **「受理されるが永久に発火しない」という、最も誤解の生まれやすい形を名指ししていること。**
  expect(description).toContain("永久に発火しません。**");
  // 静かに壊れることを隠していない。
  expect(description).toContain("**エラーにならず、ただ静かに動かない**");
});

test("V1-M2-T03: 連鎖の深度上限と再発火抑止が description に届いている", async () => {
  const descriptions = await fetchDescriptions();
  const description = descriptionOf(descriptions, "apply_diff");
  // **`WORKFLOW_MAX_DEPTH` を import していない。**理由は上の5列のテストと同じで、
  // ADR-0009 限定2 の import スナップショット(`scripts/kernel-import-snapshot.txt`)を
  // 増やさないため。**したがってこの "20" は手書きの複製であり、定数と自動では
  // 突き合わない。**定数を動かした者は `workflow-runner.test.ts` の
  // `expect(WORKFLOW_MAX_DEPTH).toBe(20)` で必ず赤を踏むので、そこからここへ来ること。
  expect(description).toContain("**20 段まで**です");
  // **黙って止まらない**ことが書かれていること(完了条件3 の、AI 側から見た姿)。
  expect(description).toContain("**status = failure の行が履歴に残ります**(黙って止まりません)");
  expect(description).toContain("**同じレコードは1回の操作で2度発火しません。**");
  // 失敗行を読んだ AI が原因に辿り着ける手掛かりが書かれていること。
  expect(description).toContain("**ワークフローが互いを発火させ合っていないか**");
});

// ---------------------------------------------------------------------------
// V3-M13-T04: ワークフローの失敗の意味論が AI へ届いている(ADR-0066 限定14)
//
// 限定14 の逐語: 「`VOCABULARY_SCOPE` / `CANNOT_DO` に「アクションが1つでも失敗したら、
// その書込は成立しない」ことと、**巻き戻らない経路(`schedule` / 外部送信キュー)**を
// 対で書く。**「全部巻き戻る」と書かない**」/ 機械的検査は「**巻き戻る経路と
// 巻き戻らない経路の両方が語彙記述に現れることを固定する検査**」。
//
// **`T13` の申し送りにより、巻き戻らない経路に「再発火抑止」が1項目増えている。**
// ---------------------------------------------------------------------------

test("V3-M13-T04: 語彙記述が、アクション失敗で発火元の書込が成立しないことを述べている", () => {
  expect(VOCABULARY_SCOPE).toContain(
    "**アクションが1つでも失敗すると、そのワークフローを発火させたレコード書込は成立しません**",
  );
  // 「巻き戻すかどうかを選べる」と外挿させない(ADR-0066 限定10: 失敗方針キーを足さない)。
  expect(VOCABULARY_SCOPE).toContain("巻き戻すかどうかをアプリごとに選ぶ設定はありません");
});

test("V3-M13-T04: 語彙記述が、巻き戻る経路を名指しで列挙している", () => {
  for (const entry of [
    "HTTP の単件 POST / PATCH",
    "write_records",
    "MCP の単件書込",
    "受信 capability",
  ]) {
    expect(VOCABULARY_SCOPE).toContain(entry);
  }
});

test("V3-M13-T04: 語彙記述が、巻き戻らない経路を対で書いている(「全部巻き戻る」と書かない)", () => {
  // (1) schedule / (2) 外部送信・AI 呼び出しの予約 / (3) 再発火抑止(T13 が足した1項目)。
  expect(VOCABULARY_SCOPE).toContain("**決まった時刻の発火(schedule)は巻き戻りません**");
  expect(VOCABULARY_SCOPE).toContain("**外部への送信予約と AI 呼び出しの予約は巻き戻りません**");
  expect(VOCABULARY_SCOPE).toContain(
    "**同じレコードが1回の操作で2度発火することを止める再発火抑止は「失敗」として数えません**",
  );
  // **深度上限は今日も失敗である**(ADR-0066 §改訂1 が狭めたのは抑止の側だけ)。
  expect(VOCABULARY_SCOPE).toContain("連鎖の深さの上限(20段)に当たった停止は失敗として数える");
  // 「全部巻き戻る」と読ませない一文が実在すること。
  expect(VOCABULARY_SCOPE).toContain("「全部巻き戻る」と読まないでください");
});

test("V4-M4-T03 / ADR-0072: 語彙記述が、抑止を `status = suppressed` として書いている", () => {
  // **この検査を足さないと「緑のまま嘘が固定される」**(ADR-0072 限定9)—— 上の
  // `V3-M13-T04` の3本が逐語で押さえているのは「抑止は失敗として数えません」までであり、
  // **その直後の括弧(実行履歴に何として残るか)を1文字も押さえていなかった。**
  // 実測: `vocabulary.ts:200` を書き換えても `bun test src/mcp/` は緑のままだった。
  expect(VOCABULARY_SCOPE).toContain(
    "(抑止は実行履歴に status = suppressed の行として残り、失敗としては数えません。発火元の書込は成立します)。",
  );
  // **抑止の行が「残る」ことを落とさない**(ADR-0072 限定5。選ばれなかった案は
  // 「履歴行ごと残さない」であり、記述がそちらに倒れていないことを固定する)。
  expect(VOCABULARY_SCOPE).toContain("として残り");
});

test("V3-M13-T04: 語彙記述が、失敗の記録は残ること(と、残らない1経路)を書いている", () => {
  expect(VOCABULARY_SCOPE).toContain("**失敗の実行履歴そのものは、発火元が巻き戻っても残ります**");
  // **バッチだけは消える。**ここを省くと逆向きの嘘になる(ADR-0066 限定5 / 限定8)。
  expect(VOCABULARY_SCOPE).toContain(
    "**ただしバッチ経路だけは、バッチ全体の巻き戻しで履歴の行も一緒に消えます。**",
  );
});

test("V3-M13-T04: CANNOT_DO が「失敗しても登録だけは残して」を、できないこととして書いている", () => {
  expect(CANNOT_DO).toContain("「ワークフローが失敗しても登録だけは残して」");
  expect(CANNOT_DO).toContain("特定のアクションだけ「失敗してもよい」と宣言する手段もありません");
  // できないことだけに倒さない —— schedule は今日も巻き戻らない(双方向)。
  expect(CANNOT_DO).toContain("決まった時刻の発火(schedule)は巻き戻らない");
});
