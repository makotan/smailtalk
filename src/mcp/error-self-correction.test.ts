/**
 * エラーのLLM自己修正性(V0-P5-T05 / 計画 R11)。
 *
 * 完了条件は「不正diff(型名間違い・参照切れ)に対するツールエラーに
 * **パス・理由・許可値**が含まれ、Claude Code がエラーを読んで
 * **追加の人間の助けなしに**修正版diffを再適用できる」こと。
 *
 * ## このテストが「自己修正できる」をどう機械的に示すか
 *
 * 「エラーに path と allowed_values が入っている」だけをアサートしても、
 * それが**自己修正に足りる**ことの証明にはならない。人間(やテストの作者)が
 * 正解を知っているせいで、実際には情報が足りていないのに通ってしまうからである。
 *
 * そこでこのテストは往復そのものを機械化する。すなわち
 *
 *   1. わざと壊れた diff を送る
 *   2. 返ってきた **`ValidationError` オブジェクトの中身だけ**を入力として、
 *      修正版 diff を機械的に組み立てる
 *   3. 再適用して成功することを確かめる
 *
 * を1本のテストで通す。**2 の段階でテスト外の知識(「正しい型名は text だ」
 * 「参照先は books にすべきだ」)を一切使わない**ことが要点で、修正版を組み立てる
 * ヘルパ(`setAtPointer` / `replaceDisallowedValues`)はどれも `ValidationError` の
 * `path` / `message` / `allowed_values` / `hint` しか読まない。もしエラーに情報が足りなければ、ここで組み立てが破綻して
 * テストが落ちる —— それが「追加の人間の助けなしに」の機械的な定義である。
 *
 * ## 検証する5ケース
 *
 * 1. フィールド型名の間違い(`"strig"`)   … enum違反 → 許可値7種
 * 2. 参照切れ(存在しない `reference_table`) … 参照整合性違反 → 実在テーブルID
 * 3. 破壊的操作(`remove_field`)           … op enum違反 → additive 4種
 * 4. `intent` の欠落・空文字                … 引数空間の必須違反
 * 5. 存在しない `app_id`                    … 実在app_id一覧
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DIFF_OPS, FIELD_TYPES, type Manifest, type ValidationError } from "../kernel/index.ts";
import { seedSession } from "../server/test-helpers.ts";
import { createMcpServer } from "./server.ts";

const APP_ID = "book-tracker";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";

/**
 * **【`V8-M31` 第3波。名乗りを足しただけで、期待値は1つも変えていない】**
 *
 * `V8-M31` が MCP に**名乗り**(どの利用者として動くか)を入れたので、
 * `createMcpServer` に `actor` を渡さないと23本のツールがすべて `isError` になる。
 * **【2026-08-16 訂正(`V8-M13-T04`)。直前の1行を1バイトも書き換えていない】この「23本」は今日は24本である**
 * (`V8-M13-T02` が `read_report` を足した)。**渡さないと全部が `isError` になることは1ミリも変わっていない。**
 * **【2026-08-24 訂正(`V10-M12-T01`。`ADR-0368`)。直前の1行を1バイトも書き換えていない】直前の「24本」は今日は25本である**
 * (`V10-M12-T01` が `list_comments` を足した)。**渡さないと全部が `isError` になることは今日も1ミリも変わっていない。**
 * **【2026-08-26 訂正(`V10-M34-T01`。台帳 `CM-G45` / `ADR-0379`)。直前の1行を1バイトも書き換えていない】直前の「25本」は今日は26本である**
 * (`V10-M30-T02` が `set_comment_visibility` を足した)。**渡さないと全部が `isError` になることは今日も1ミリも変わっていない。**
 * **このファイルが測っているのは「エラーだけを読んで直せるか」であって権限ではない** ——
 * よって `seedSession` の既定(`owner`)で1人だけ作り、拒否の理由が
 * 「権限が無い」に化けないようにしてある。
 */
const ACTOR = "mcp-actor";

let dataRoot = "";
let client: Client;
let closeConnection: () => Promise<void>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-self-correct-"));
  const server = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, actor: ACTOR });
  client = new Client({ name: "self-correction-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // 逐次 await するとハンドシェイクが噛み合わずデッドロックする(計画の確定事項)。
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  closeConnection = async () => {
    await client.close();
    await server.close();
  };

  await call("create_app", { name: "蔵書管理", app_id: APP_ID });
  // **アプリが出来た直後に、名乗った利用者を実在させる**(`create_app` は名乗りだけで通るが、
  // 以降の `apply_diff` は「そのアプリに登録済みか」を解決する)。
  seedSession(dataRoot, APP_ID, { username: ACTOR });
  await callOk("apply_diff", {
    app_id: APP_ID,
    diff: {
      diff_id: "d-001-books",
      intent: "本を記録するテーブルを作りたい",
      operations: [
        {
          op: "add_table",
          table: {
            id: "books",
            name: "本",
            fields: [{ id: "title", name: "タイトル", type: "text" }],
          },
        },
      ],
    },
  });
});

afterEach(async () => {
  await closeConnection();
  await rm(dataRoot, { recursive: true, force: true });
});

// --- MCP 呼び出しヘルパ ----------------------------------------------------------

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function callOk(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await call(name, args);
  expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

/** `content[0]` のテキストを取り出す(型は union なので絞り込む)。 */
function textOf(result: CallToolResult): string {
  const first = result.content?.[0];
  expect(first, "content が空です").toBeDefined();
  expect(first?.type).toBe("text");
  const text = (first as { text?: unknown } | undefined)?.text;
  expect(typeof text).toBe("string");
  return String(text);
}

/**
 * 失敗結果からエラー配列を取り出し、**両方の経路**で同じものが届くことを確かめる。
 *
 * `structuredContent` だけを埋めるクライアント実装もあれば、`content` のテキストしか
 * 会話に差し込まないクライアント実装もある。LLM が**テキスト側しか見ない**場合に
 * 情報が欠けていては自己修正できないので、ここで両者の一致を毎回検査する。
 */
function errorsOf(result: CallToolResult): ValidationError[] {
  expect(result.isError).toBe(true);

  const structured = result.structuredContent as { errors?: ValidationError[] } | undefined;
  expect(structured?.errors, `structuredContent に errors が無い: ${textOf(result)}`).toBeDefined();
  const errors = structured?.errors ?? [];
  expect(Array.isArray(errors)).toBe(true);
  expect(errors.length).toBeGreaterThan(0);

  // テキスト側の JSON が structuredContent と同一であること。
  const parsed = JSON.parse(textOf(result)) as { errors?: ValidationError[] };
  expect(parsed.errors).toEqual(errors);

  return errors;
}

/** 全エラーが「パス・理由」を持つこと(完了条件の前半)。 */
function expectPathAndMessage(errors: ValidationError[]): void {
  for (const error of errors) {
    // RFC 6901 JSON Pointer。空文字も RFC 上は「文書全体」を指す正当な値だが、
    // それでは位置が特定できず自己修正の起点にならないので非空を要求する。
    expect(error.path.length, `path が空: ${JSON.stringify(error)}`).toBeGreaterThan(0);
    expect(error.path.startsWith("/"), `path が JSON Pointer でない: ${error.path}`).toBe(true);
    expect(error.message.trim().length, `message が空: ${JSON.stringify(error)}`).toBeGreaterThan(
      0,
    );
  }
}

// --- JSON Pointer / 差分の機械的な書き換え ----------------------------------------
//
// ここから下のヘルパは、修正版 diff を組み立てるために **`ValidationError` の中身しか
// 参照しない**。正しい型名や正しいテーブルIDをリテラルで書かないことが、
// 「追加の人間の助けなしに」を成立させている。

/** RFC 6901 のエスケープを戻しつつ Pointer をセグメントに分解する。 */
function parsePointer(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** Pointer の指す位置に値を書き込む(途中の要素が無ければ落とす)。 */
function setAtPointer(root: unknown, pointer: string, value: unknown): void {
  const segments = parsePointer(pointer);
  const last = segments.pop();
  expect(last, `Pointer が空: ${pointer}`).toBeDefined();
  let node: unknown = root;
  for (const segment of segments) {
    node = Array.isArray(node)
      ? node[Number(segment)]
      : (node as Record<string, unknown> | null)?.[segment];
    expect(node, `${pointer} の途中 "${segment}" に到達できません`).toBeDefined();
  }
  if (Array.isArray(node)) {
    node[Number(last)] = value;
  } else {
    (node as Record<string, unknown>)[String(last)] = value;
  }
}

/**
 * オブジェクト木を歩き、名前が `property` で値が `allowed` に含まれないものを
 * `allowed[0]` に差し替える。差し替えた件数を返す。
 *
 * 参照切れ(ケース2)の修正に使う。`path` が使えないときの最後の手段であり、
 * それでも「property 名 = path の末尾セグメント」「候補 = allowed_values」という
 * **エラーから取れる情報だけ**で成立している点は変わらない。
 */
function replaceDisallowedValues(node: unknown, property: string, allowed: string[]): number {
  if (Array.isArray(node)) {
    return node.reduce<number>(
      (sum, item) => sum + replaceDisallowedValues(item, property, allowed),
      0,
    );
  }
  if (typeof node !== "object" || node === null) {
    return 0;
  }
  let replaced = 0;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === property && typeof value === "string" && !allowed.includes(value)) {
      (node as Record<string, unknown>)[key] = allowed[0];
      replaced += 1;
      continue;
    }
    replaced += replaceDisallowedValues(value, property, allowed);
  }
  return replaced;
}

/** 差分をディープコピーする(元の差分を壊さずに修正版を作るため)。 */
function cloneDiff(diff: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(diff)) as Record<string, unknown>;
}

// --- ケース1: フィールド型名の間違い ----------------------------------------------

const WRONG_TYPE_DIFF: Record<string, unknown> = {
  diff_id: "d-002-memo",
  intent: "本に自由記述のメモ欄を付けたい",
  operations: [
    { op: "add_field", table: "books", field: { id: "memo", name: "メモ", type: "strig" } },
  ],
};

test("フィールド型名を間違えたdiffは、パス・理由・許可値9種を持つエラーになる", async () => {
  const errors = errorsOf(await call("apply_diff", { app_id: APP_ID, diff: WRONG_TYPE_DIFF }));
  expectPathAndMessage(errors);

  expect(errors).toHaveLength(1);
  const error = errors[0];
  expect(error?.path).toBe("/operations/0/field/type");
  // 理由は「何が悪いか」を値そのものを引用して言うこと。
  expect(error?.message).toContain("strig");
  // enum / const 違反には必ず許可値が入る(errors.ts の契約)。
  expect(error?.allowed_values).toBeDefined();
  expect(error?.allowed_values).toEqual([...FIELD_TYPES]);
  // V2-M2 / ADR-0035: image が8種目として加わった。**V5-M16 / ADR-0161: file が9種目。**
  expect(error?.allowed_values).toHaveLength(9);
});

test("フィールド型名の間違いは、エラーの情報だけで修正版diffを組み立てて再適用できる", async () => {
  const errors = errorsOf(await call("apply_diff", { app_id: APP_ID, diff: WRONG_TYPE_DIFF }));
  const error = errors[0];
  expect(error).toBeDefined();

  // ---- ここから先はエラーオブジェクトの中身だけで組み立てる ----
  // `path` が diff 空間を指しているので、そのまま Pointer として適用できる。
  // 許可値のどれを選ぶかは LLM の裁量だが、ここでは「先頭を選ぶ」という
  // テスト外の知識を要しない規則を使う。
  const allowed = error?.allowed_values ?? [];
  expect(allowed.length).toBeGreaterThan(0);
  const corrected = cloneDiff(WRONG_TYPE_DIFF);
  setAtPointer(corrected, String(error?.path), allowed[0]);
  // ---- ここまで ----

  const ok = await callOk("apply_diff", { app_id: APP_ID, diff: corrected });
  const manifest = ok.manifest as Manifest;
  const memo = manifest.app.tables[0]?.fields.find((field) => field.id === "memo");
  expect(memo).toBeDefined();
  expect(allowed).toContain(String(memo?.type));
});

// --- ケース2: 参照切れ ------------------------------------------------------------

const BROKEN_REFERENCE_DIFF: Record<string, unknown> = {
  diff_id: "d-003-author",
  intent: "本に著者への参照を付けたい",
  operations: [
    {
      op: "add_field",
      table: "books",
      field: {
        id: "author",
        name: "著者",
        type: "reference",
        reference_table: "authors",
      },
    },
  ],
};

/**
 * 【重要 / 計画 R11】参照切れの `path` は **diff 空間ではなくマニフェスト空間**を指す。
 *
 * `applyDiff` は operations を畳み込んで**適用後マニフェスト**を作り、それに対して
 * 参照整合性を検査する(`src/kernel/apply-diff.ts`)。したがって返る `path` は
 * `/app/tables/0/fields/1/reference_table` のように**結果マニフェスト上の位置**であり、
 * LLM が送った diff(`/operations/0/field/reference_table`)を根としない。
 *
 * これは自己修正しようとする LLM が最も混乱しやすい箇所である。素直に
 * 「path の位置を直す」と考えると、自分の送った JSON にその位置は存在せず、手が止まる。
 * カーネルはこの食い違いを消せない(どの operation が原因かの逆算は推測になり、
 * 外れたときのほうが有害)ので、代わりに `annotateAppliedManifestError` が
 * **hint に「パスの根が違う」注記を追記する**という設計になっている。
 *
 * よってこのケースで自己修正の生命線になるのは `path` ではなく **`hint` と
 * `allowed_values`** である。下のテストはその2つが実際に存在し、かつそれだけで
 * 修正版を組み立てられることを確かめる。
 */
test("参照切れのエラーは、マニフェスト空間のパスであることをhintで明示し、実在テーブルIDを許可値に持つ", async () => {
  const errors = errorsOf(
    await call("apply_diff", { app_id: APP_ID, diff: BROKEN_REFERENCE_DIFF }),
  );
  expectPathAndMessage(errors);

  expect(errors).toHaveLength(1);
  const error = errors[0];

  // path は「送った diff」ではなく「適用後マニフェスト」を根とする。
  expect(error?.path).toBe("/app/tables/0/fields/1/reference_table");
  expect(error?.path.startsWith("/operations")).toBe(false);

  expect(error?.message).toContain("authors");

  // hint が無いと、上の path は LLM にとって迷子の座標になる。存在と非空は必須。
  expect(error?.hint, "参照切れに hint が無い(R11)").toBeDefined();
  expect((error?.hint ?? "").trim().length).toBeGreaterThan(0);
  // 「パスの根が違う」ことが hint で伝わっていること。
  expect(error?.hint).toContain("diff");

  // 許可値は実在テーブルID。ここでは books のみが存在する。
  expect(error?.allowed_values).toBeDefined();
  expect(error?.allowed_values).toEqual(["books"]);
});

test("参照切れは、エラーの情報だけで修正版diffを組み立てて再適用できる", async () => {
  const errors = errorsOf(
    await call("apply_diff", { app_id: APP_ID, diff: BROKEN_REFERENCE_DIFF }),
  );
  const error = errors[0];
  expect(error).toBeDefined();

  // ---- ここから先はエラーオブジェクトの中身だけで組み立てる ----
  // path はマニフェスト空間なので `setAtPointer` は使えない(使うと diff の
  // 途中に到達できず落ちる)。代わりに使えるのは
  //   - path の**末尾セグメント** = 直すべきプロパティ名(reference_table)
  //   - allowed_values            = そこに入れてよい値の全集合
  // の2つだけ。これで diff 側の該当プロパティを特定して差し替える。
  const segments = parsePointer(String(error?.path));
  const property = segments[segments.length - 1];
  expect(property).toBeDefined();
  const allowed = error?.allowed_values ?? [];
  expect(allowed.length, "allowed_values が空だと修正先を選べない").toBeGreaterThan(0);

  const corrected = cloneDiff(BROKEN_REFERENCE_DIFF);
  const replaced = replaceDisallowedValues(corrected, String(property), allowed);
  expect(replaced, "diff 内に直すべきプロパティを見つけられなかった").toBe(1);
  // ---- ここまで ----

  const ok = await callOk("apply_diff", { app_id: APP_ID, diff: corrected });
  const manifest = ok.manifest as Manifest;
  const author = manifest.app.tables[0]?.fields.find((field) => field.id === "author");
  expect(author).toBeDefined();
  expect(author?.type).toBe("reference");
  expect(allowed).toContain(
    String((author as { reference_table?: string } | undefined)?.reference_table),
  );
});

// --- ケース3: 破壊的操作 ----------------------------------------------------------

/**
 * **V1-M1-T03(ADR-0010)で題材と主張を入れ替えた。**
 *
 * 旧: 「削除など破壊的な操作は、additive4種を許可値として示すエラーになる」——
 * `remove_field` が語彙内になったので、題材そのものが成立しない。
 *
 * 新: このケースが本当に測っていたのは「**語彙外の op を投げた AI が、1往復で
 * 自己修正できる情報を受け取れるか**」である。その主張は M1 後も無傷であり、
 * **むしろ難しくなった** —— 「できない」ではなく「できるが綴りが違う」を
 * 伝えなければならない。題材は M1 後も語彙外である `rename_field` にする。
 */
test("語彙外の op は、許可値と『正しい書き方』を示すエラーになる(1往復で直せること)", async () => {
  const errors = errorsOf(
    await call("apply_diff", {
      app_id: APP_ID,
      diff: {
        diff_id: "d-004-rename",
        intent: "タイトル欄の名前を変えたい",
        operations: [{ op: "rename_field", table: "books", field: "title", to: "headline" }],
      },
    }),
  );
  expectPathAndMessage(errors);

  // op が語彙外のとき、その operation については op のエラーだけが残る
  // (分岐の副産物を出すと原因が埋もれるため。ajv-error-adapter.ts 参照)。
  expect(errors).toHaveLength(1);
  const error = errors[0];
  expect(error?.path).toBe("/operations/0/op");
  expect(error?.message).toContain("rename_field");
  expect(error?.allowed_values).toEqual([...DIFF_OPS]);
  // 許可値が16種であり、破壊的4種・remove_view・ワークフロー3種・関数3種が実際に
  // 含まれていること(V1-M2-T07 / ADR-0013 §4c、V1-M6-T05 / ADR-0024 §4c、
  // **V3-M1-T03 / ADR-0047 §4c が16種目 set_theme を足した**)。
  // **ここは `DIFF_OPS` を経由せず数を直書きしているので自動追随しない**
  // (審査記録 docs/plan/v3/records/v3-m1-gate-a-theme.md §10 の #12。見落としやすい)。
  // **【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)。**
  // **直上のコメントが「自動追随しない。見落としやすい」と予告していたとおり、ここは赤くなった。**
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】17 → 18(`set_roles` が18種目)。**
  // **直上のコメントが「自動追随しない。見落としやすい」と予告していたとおり、ここは今回も赤くなった。**
  // **期待値だけを実体に合わせた。検査は消していない。**
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】18 → 17**(`set_user_kinds` を撤去した)。
  // **旧(逐語)**: `expect(error?.allowed_values).toHaveLength(18);`
  // **直上のコメントが「自動追随しない。見落としやすい」と予告していたとおり、ここは今回も赤くなった** ——
  // **語彙が**増えた**ときだけでなく**減った**ときにも赤くなることが、今日はじめて実測された。**
  expect(error?.allowed_values).toHaveLength(17);
  for (const op of [
    "remove_field",
    "remove_table",
    "change_table",
    "change_field",
    "remove_view",
    "add_workflow",
    "update_workflow",
    "remove_workflow",
    "add_function",
    "update_function",
    "remove_function",
  ]) {
    expect(error?.allowed_values ?? []).toContain(op);
  }
  // **「できないから諦めろ」ではなく「この op でこう書け」を言えていること。**
  // ここが言えないと、AI は rename_* の別名を発明し続ける(F-19 の経路)。
  expect(error?.hint).toContain("change_field");
  expect(error?.hint).toContain("changes.id");
  // 既に適用済みの変更を戻す唯一の答えは undo。
  expect(error?.hint).toContain("undo");
});

// --- ケース4: intent の欠落・空文字 -----------------------------------------------
//
// ここは zod の入力検証に横取りされると英語のメッセージだけが返り、
// `structuredContent` も `allowed_values` も無くなる。`errorsOf` が両経路の一致を
// 見ているので、退行すればこのテストが落ちる(tools/write.ts の intent の注記を参照)。

test("intentが空文字のdiffは、引数空間のパスを持つ統一形式エラーになる", async () => {
  const errors = errorsOf(
    await call("apply_diff", {
      app_id: APP_ID,
      diff: { diff_id: "d-005-empty", intent: "   ", operations: [] },
    }),
  );
  expectPathAndMessage(errors);

  expect(errors).toHaveLength(1);
  expect(errors[0]?.path).toBe("/diff/intent");
  expect(errors[0]?.message).toContain("空");
  expect(errors[0]?.hint).toBeDefined();
});

test("intentが無いdiffは、引数空間のパスを持つ統一形式エラーになる", async () => {
  const errors = errorsOf(
    await call("apply_diff", {
      app_id: APP_ID,
      diff: { diff_id: "d-005-missing", operations: [] },
    }),
  );
  expectPathAndMessage(errors);

  expect(errors).toHaveLength(1);
  expect(errors[0]?.path).toBe("/diff/intent");
  expect(errors[0]?.message).toContain("intent");
  expect(errors[0]?.hint).toBeDefined();
});

// --- ケース5: 存在しない app_id ---------------------------------------------------

test("存在しないapp_idは、実在するapp_id一覧を許可値として返す", async () => {
  const errors = errorsOf(
    await call("apply_diff", {
      app_id: "book-trakcer",
      diff: {
        diff_id: "d-006-typo",
        intent: "メモ欄を足したい",
        operations: [
          { op: "add_field", table: "books", field: { id: "memo", name: "メモ", type: "text" } },
        ],
      },
    }),
  );
  expectPathAndMessage(errors);

  expect(errors).toHaveLength(1);
  const error = errors[0];
  expect(error?.path).toBe("/app_id");
  expect(error?.message).toContain("book-trakcer");
  expect(error?.allowed_values).toEqual([APP_ID]);
});

test("存在しないapp_idは、エラーの許可値だけで正しいapp_idを選び直して再適用できる", async () => {
  const diff: Record<string, unknown> = {
    diff_id: "d-007-typo",
    intent: "メモ欄を足したい",
    operations: [
      { op: "add_field", table: "books", field: { id: "memo", name: "メモ", type: "text" } },
    ],
  };
  const errors = errorsOf(await call("apply_diff", { app_id: "book-trakcer", diff }));

  // ---- エラーオブジェクトの中身だけで修正する ----
  const allowed = errors[0]?.allowed_values ?? [];
  expect(allowed.length).toBeGreaterThan(0);
  const ok = await callOk("apply_diff", { app_id: allowed[0], diff });
  // ---- ここまで ----

  const manifest = ok.manifest as Manifest;
  expect(manifest.app.tables[0]?.fields.map((field) => field.id)).toContain("memo");
});
