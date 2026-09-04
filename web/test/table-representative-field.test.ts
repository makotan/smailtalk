/**
 * 参照フィールドの表示に出す列を、テーブルごとに1本だけ宣言する
 * (`V4-M10-T24`。**`ADR-0080` = `V4-M8` 単位5 の再提出の限定採用。限定表10点**)。
 *
 * 目的(`ADR-0080` §S1 逐語): **「参照フィールドの選択肢と表示に出す列を、テーブルごとに
 * 1本だけ宣言したい。」**
 *
 * **この検査が固定するのは限定表の内側だけである**(`docs/adr/0080-table-representative-field.md` §3):
 *
 * | 限定 | ここで固定するもの |
 * |---|---|
 * | 1 | 足すキーは `$defs/table` に1本だけ(3 → 4)。`$defs` 28 を1つも増やさない |
 * | 2 | **値は自テーブルの `text` 型フィールドID を1本だけ**(配列にしない・`text` 以外を指せない) |
 * | 3 | `diff.schema.json` の `table_changes` にも同じキーを足す(2 → 3) |
 * | 5 | **既定は「変えない」** —— 書いていないテーブルの参照表示を1ミリも変えない |
 * | 7 | 予約規約フィールドを1本も足さない(`ADR-0080` の増分は0本) |
 * | 8 | `$defs/view_action.properties` は **3** のまま(`ADR-0045` の限定を1つも解かない) |
 *
 * ## この検査が言わないこと(誇張しない)
 *
 * - **`E-G35` の3症状のうち解けるのは1つだけである**(§S3 1)。**お届け先の初期表示も
 *   ポイント残高の表示も1ミリも解けない。** **【禁止】「フォームに別テーブルの値を運べる
 *   ようになった」と書かない。**
 * - **同じ `text` 列を2つの画面で別々に見せたい、という要求には答えられない**(§限界5)。
 * - **`representative_field` は参照される側が決める。参照する側は選べない。**
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RecordRow } from "../../src/kernel/records.ts";
import type { Manifest, Table } from "../../src/kernel/types.ts";
// **面がその項目を名指ししているかは、サーバと**同じ述語1本**を見る**(判定を2箇所に書かない)。
import { isRoleGovernedField } from "../../src/server/owner-scope.ts";
import {
  buildReferenceLabelIndex,
  referenceLabel,
  representativeField,
} from "../src/fields/reference-label.ts";

const REPO_ROOT = dirname(dirname(import.meta.dir));

function readSchema(name: string): {
  $defs: Record<string, { properties?: Record<string, unknown> }>;
} {
  return JSON.parse(readFileSync(join(REPO_ROOT, "schemas", name), "utf-8")) as {
    $defs: Record<string, { properties?: Record<string, unknown> }>;
  };
}

// --- (a) 増分の総量(限定1 / 限定3 / 限定8)-------------------------------------------

// 【`V7-M1-T02`】**テスト名の「4キー」を「6キー」へ是正した。** 旧: 「限定1: $defs/table.properties が
//   4キーで、4キー目は representative_field である」。**`V6-M3-T01`(4 → 5)が本体を動かしたときに
//   名前を直しておらず、着手前から名前と期待値が食い違っていた。****`representative_field` は
//   今日も4キー目のままである。****この行は `v7-m0.md` §4-3 の12箇所の列挙に入っていなかった**
//   (`V7-M1-T02` の記録に書いた)。
test("限定1: $defs/table.properties が 6キーで、4キー目は representative_field である", () => {
  const keys = Object.keys(readSchema("manifest.schema.json").$defs.table?.properties ?? {});
  // **【`V6-M3-T01` / `K-G6` / `ADR-0290` 限定1 で 4 → 5 に更新した】** 5キー目 `reference_search_fields`
  // (このテーブルが参照されたときの「探せる項目」の既定)が門A を通って増えた(`V6-M0` 単位B。判定 = 限定採用)。
  // **本 ADR の増分ではない。**
  // **【`V7-M1-T01` / `Z-G2` で 5 → 6 に更新した】** 6キー目 `access_control` が門A を通って
  // 増えた(`V7-M0`。判定 = 限定採用)。**本 ADR の増分ではない。**
  expect(keys).toHaveLength(6);
  expect(keys).toContain("representative_field");
});

// 【`V5-M29-T05`】**テスト名を書き換えた。** 旧: 「限定1: $defs の本数は 28 のまま(値は既存の
//   resource_id を $ref で受ける)」。**本数を測る `expect` が消えたのに、名前だけが本数を
//   主張する状態を残さないため(記録 §4-7)。**
test("限定1: 値は既存の resource_id を $ref で受ける", () => {
  // 【`V5-M29-T05` / `ADR-0250` 限定11】ここにあった「限定1: $defs の本数は 28 のまま」の検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `manifest.$defs:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  const prop = readSchema("manifest.schema.json").$defs.table?.properties?.representative_field as {
    $ref?: string;
  };
  expect(prop.$ref).toBe("#/$defs/resource_id");
});

test("限定3 / 限定4: diff.schema.json の table_changes が 5キーで、同じ定義を指している", () => {
  const props = readSchema("diff.schema.json").$defs.table_changes?.properties ?? {};
  // **【`V6-M3-T01` / `K-G6` / `ADR-0290` 限定11 で 3 → 4 に更新した】** 4つ目のキー
  // `reference_search_fields`(定義は manifest 側の `$ref`)が加わった。**本 ADR の増分ではない。**
  // **【`V7-M1-T03` / `Z-G37` で 4 → 5 に更新した】** 5つ目のキー `access_control`
  // (定義は同じく manifest 側の `$ref`)が門A を通って加わった。**本 ADR の増分ではない。**
  // **テスト名の「3キー」も同じ機会に「5キー」へ直した**(着手前は名前が3・期待値が4で食い違っていた)。
  expect(Object.keys(props)).toHaveLength(5);
  expect((props.representative_field as { $ref?: string }).$ref).toBe(
    "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/table/properties/representative_field",
  );
});

test("限定8: $defs/view_action.properties に本 ADR は1本も足していない(ADR-0045 の限定を1つも解かない)", () => {
  /*
   * **【V4-M20-T01 / ADR-0100 限定1 で 3 → 4 に更新した】**
   *
   * **増やしたのは本 ADR(`ADR-0080` = 代表フィールド)ではない。** 4キー目 `set`
   * (今開いているレコードの1フィールドを1つのリテラル値に書き換える2つ目の形)は
   * **`V4-M20` 単位A が門A の本審査を新規に通して足したものである**(判定 = 限定採用)。
   * **`V4-M20-T02`(`ADR-0101`)がさらに5キー目 `visible_when` を足した。**
   * **`ADR-0080` の増分は今日も 0 である。**
   * **固定の向き(5キー目が入ったら赤くなる)を1ミリも弱めていない。**
   *
   * **【`V5-M22-T01` / `L-G5` / `ADR-0173` 限定1 で 5 → 6 に更新した】**
   * **6キー目 `view`(行き先のビューID)も本 ADR が足したものではない** ——
   * **`V5-M20` 面2 が門A の本審査を新規に通して足した**(判定 = 限定採用)。
   * **`ADR-0080` の増分は今日も 0 である。**
   * **固定の向き(7キー目が入ったら赤くなる)を1ミリも弱めていない。**
   *
   * **【`V5-M23-T02` / `L-G14` / `ADR-0177` 限定1 で 6 → 7 に更新した】**
   * **7キー目 `audience`(この操作起点を見せる相手)も本 ADR が足したものではない** ——
   * **`V5-M20` 面4 が門A の本審査を新規に通して足した**(判定 = 限定採用)。
   * **`ADR-0080` の増分は今日も 0 である。**
   * **固定の向き(8キー目が入ったら赤くなる)を1ミリも弱めていない。**
   *
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174` 限定1 で 7 → 8 に更新した】**
   * **8キー目 `run`(起こす自動処理)も本 ADR が足したものではない** ——
   * **`V5-M20` 面3 が門A の本審査を新規に通して足した**(判定 = 限定採用)。
   * **`ADR-0080` の増分は今日も 0 である。**
   * **固定の向き(9キー目が入ったら赤くなる)を1ミリも弱めていない。**
   *
   * **【`V8-M20` / 台帳 `J-G29`(判定 = 廃止)/ 手続きは `ADR-0301` の追記。旧文を1バイトも
   * 書き換えていない】** **上に「7キー目」と書いた `audience`(この操作起点を見せる相手)は
   * 撤去された。** **`V8-M17` が `id` を足していたので、`$defs/view_action` の本数は
   * 9 → 8 である。** **代わりに担うのは `app.roles[].rules` の
   * `{ target: "table", ..., can: ["write"] }` と `{ target: "action", ..., can: ["read"] }`。**
   * **本ファイルには本数の `expect` が1つも残っていない**(中央 = `scripts/vocabulary-drift.test.ts`
   * へ移っている)ので、**この撤去で赤くなる `expect` はここには無い。**
   * **`ADR-0080` の増分は今日も 0 である。**
   */
  const props = readSchema("manifest.schema.json").$defs.view_action?.properties ?? {};
  // 【`V5-M29-T05` / `ADR-0250` 限定11】ここにあった「限定8: `$defs/view_action.properties` に
  //   本 ADR は1本も足していない(`ADR-0045` の限定を1つも解かない)」の検査
  //   (`expect(Object.keys(props).sort()).toEqual([...8件...])`)は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `manifest.$defs.view_action.properties:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  //   **直前の 3 → 8 の更新履歴のコメントは、跡として残してある。**
  //   **消したのは「ソートした名前集合」を測る形であり、中央は宣言順で突き合わせる**
  //   (**ソート順の一致そのものは、中央では測られない**)。
  // 代表フィールドの語は今日も view_action に1つも現れない(本 ADR の射程外である)。
  expect(Object.keys(props)).not.toContain("representative_field");
});

test("限定2: 値は単一の文字列であり、配列を書ける形になっていない", () => {
  const prop = readSchema("manifest.schema.json").$defs.table?.properties
    ?.representative_field as Record<string, unknown>;
  expect(prop.type).toBeUndefined();
  expect(prop.items).toBeUndefined();
  // `resource_id` は `type: "string"` の定義である(配列ではない)。
  const resourceId = readSchema("manifest.schema.json").$defs.resource_id as unknown as {
    type: string;
  };
  expect(resourceId.type).toBe("string");
});

// --- (b) 表示層のふるまい ---------------------------------------------------------------

const plan = (representative?: string): Table =>
  ({
    id: "plan",
    name: "コース",
    fields: [
      { id: "name", name: "コース名", type: "text" },
      { id: "summary", name: "内容", type: "text" },
      { id: "price", name: "金額", type: "number" },
    ],
    ...(representative === undefined ? {} : { representative_field: representative }),
  }) as unknown as Table;

const row = (extra: Record<string, unknown> = {}): RecordRow =>
  ({
    _id: "row-1",
    _created_at: "2026-08-03T00:00:00.000Z",
    _updated_at: "2026-08-03T00:00:00.000Z",
    name: "日々のだし便",
    summary: "毎回1166円 / 30日周期 / 最低継続2回",
    price: 1166,
    ...extra,
  }) as unknown as RecordRow;

test("宣言があればその列が代表値になる(これが目的である)", () => {
  expect(representativeField(plan("summary"))?.id).toBe("summary");
  expect(referenceLabel(plan("summary"), row())).toBe("毎回1166円 / 30日周期 / 最低継続2回");
});

test("限定5: 宣言が無ければ今日どおり最初の text フィールドである(既定は「変えない」)", () => {
  expect(representativeField(plan())?.id).toBe("name");
  expect(referenceLabel(plan(), row())).toBe("日々のだし便");
});

test("限定5: 索引(選択肢と一覧が共有する唯一の実装)にも同じ規則が効く", () => {
  const index = buildReferenceLabelIndex([{ table: plan("summary"), records: [row()] }]);
  expect(index.get("plan")?.get("row-1")).toBe("毎回1166円 / 30日周期 / 最低継続2回");
  const legacy = buildReferenceLabelIndex([{ table: plan(), records: [row()] }]);
  expect(legacy.get("plan")?.get("row-1")).toBe("日々のだし便");
});

test("限定2: text でない列を指しても採らない(今日どおり最初の text に倒れる)", () => {
  expect(representativeField(plan("price"))?.id).toBe("name");
});

// --- (c) (穴)適用時に拒否できていない ------------------------------------------------

test("(穴)実在しないフィールドIDを指した宣言は、差分では拒否されず表示だけが既定に倒れる", () => {
  // **`ADR-0080` 限定2 の第4列と `V4-M10-T24` 完了条件6 は「適用時に検査し、外れたら差分
  // 全体を拒否する」ことを求めている。** **それを置くには `src/kernel/referential-integrity.ts`
  // に差分が要り、限定6 / 完了条件7(`src/kernel/` に1バイトも差分を出さない)と正面から
  // 衝突する。** **`V4-M10` は限定6 に従って `src/kernel/` を1バイトも触っていないので、
  // これを実装できなかった。** **塞いでいないので実測で固定して残す。**
  expect(representativeField(plan("not-a-field"))?.id).toBe("name");
});

test("(穴)text フィールドを1本も持たないテーブルでは、宣言があっても _id に倒れる", () => {
  const numbersOnly = {
    id: "meter",
    name: "計測",
    fields: [{ id: "value", name: "値", type: "number" }],
    representative_field: "value",
  } as unknown as Table;
  expect(representativeField(numbersOnly)).toBeUndefined();
  expect(referenceLabel(numbersOnly, row())).toBe("row-1");
});

// --- (d) 完了条件8: 面が読取を許さない列を代表列に指せるか(実測)---------------------------
//
// **【`V8-M20` / 台帳 `J-G28`(判定 = 廃止)/ 手続きは `ADR-0301` で宣言の置き場を移した。
// 旧の見出しと旧のテスト名を1バイトも消していない】**
// **旧の見出し**: 「(d) 完了条件8: `field.audience` で落とした列を代表列に指せるか(実測)」。
// **旧のテスト名**: 「完了条件8: audience で落とされた列を代表列に指すと、値は漏れずに
// `_id` に倒れる」。
// **旧の題材**: 項目に `audience: ["owner"]` を直接書いていた。
// **今日**: 見せる相手を決めるのは `app.roles[].rules` の
// `{ target: "field", table: "plan", field: "secret", can: ["read"] }` である。
// **測っている問い(落ちた列を代表に指しても値は漏れず `_id` に倒れる)は1ミリも
// 変えていない** —— **穴も1件も塞いでいない。**

test("完了条件8: 面が読取を許さない列を代表列に指すと、値は漏れずに _id に倒れる", () => {
  // **指すこと自体は今日できる**(schema は役割の規則を見ない)。
  const table = {
    id: "plan",
    name: "コース",
    fields: [
      { id: "name", name: "コース名", type: "text" },
      { id: "secret", name: "内部メモ", type: "text" },
    ],
    representative_field: "secret",
  } as unknown as Table;
  // **その項目を面が名指ししている**(`owner` にだけ読取を許す)。
  const manifest = {
    app: {
      id: "plan-app",
      name: "コースの題材",
      tables: [],
      views: [],
      roles: [
        {
          id: "owner",
          rules: [{ target: "field", table: "plan", field: "secret", can: ["read"] }],
        },
      ],
    },
  } as unknown as Manifest;
  expect(isRoleGovernedField(manifest, "plan", "secret")).toBe(true);
  expect(representativeField(table)?.id).toBe("secret");
  // **しかし customer の読取応答からはサーバが `secret` を落とすので、表示層に値が届かない。**
  // **代表値が引けないときは `_id` を返す**(既存の規約)。**値は1文字も漏れない。**
  const projected = {
    _id: "row-1",
    _created_at: "2026-08-03T00:00:00.000Z",
    _updated_at: "2026-08-03T00:00:00.000Z",
    name: "日々のだし便",
  } as unknown as RecordRow;
  expect(referenceLabel(table, projected)).toBe("row-1");
});

// --- (e) 限定7: 予約規約フィールドを1本も足さない ----------------------------------------

test("限定7: 本 ADR の増分として予約規約フィールドを1本も足していない", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "server", "owner-scope.ts"), "utf-8");
  const declared = [...source.matchAll(/^export const ([A-Z_]+_FIELD) = "(st_[a-z_]+)";$/gm)].map(
    (m) => m[2] as string,
  );
  // **5本は `ADR-0077`(単位2)が採った分までである。** **`ADR-0080` の増分は0本である。**
  // **【`V8-M20` / 台帳 `J-G30`(判定 = 廃止)/ 手続きは `ADR-0301` で 5 → 4 に更新した】**
  // **旧の期待値**: `expect(declared).toHaveLength(5);`
  // **減った1本は `st_admin_readable`(運営が全員分を読めるか)である** ——
  // **代わりに担うのは `app.roles[].rules` の
  // `{ target: "table", table: <表ID>, can: ["read"] }` である。**
  // **残る4本(`st_owner` / `st_public` / `st_undeletable` / `st_no_direct_create`)は
  // 1本も消えていない。** **`ADR-0080` の増分は今日も0本である**(減らしたのは `V8-M20`)。
  // **【禁止の履行】これを「語彙が減った」という成果として書かない**(`ADR-0301` 限定10)。
  expect(declared).toHaveLength(4);
  expect(declared).not.toContain("st_admin_readable");
  expect(declared).not.toContain("st_representative_field");
});
