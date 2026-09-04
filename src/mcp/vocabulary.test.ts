/**
 * 語彙境界の共有定数のユニットテスト(V0-P5-T02 の基盤 / T04 の前提 / 計画 R12)。
 *
 * ここで確かめたいのは「文面が気に入るか」ではなく **`src/kernel/types.ts` の
 * 語彙配列と定数が同期していること**である。v0 の語彙が増減したとき、
 * ツール説明文だけが古い語彙を主張し続ける(= LLM に嘘を教える)状態を
 * 作らないために、定数は配列から組み立て、テストは配列側を真とみなす。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../auth/types.ts";
import { DIFF_OPS, FIELD_TYPES, RESOURCE_KINDS } from "../kernel/index.ts";
// **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】旧(逐語)**:
//     import { reservedRoleValues, roleValuesForKinds } from "../server/auth-routes.ts";
// **`roleValuesForKinds(kinds)` は引数の唯一の出所(`app.user_kinds`)ごと廃止され、
// 引数を持たない `baseRoleValues()` になった。****戻りは着手前に `kinds` が空だった
// ときとまったく同じ4値である。**
import { baseRoleValues, reservedRoleValues } from "../server/auth-routes.ts";
// V3-M3-T06(Δ5): 顧客から見たテーブルの可否の**実装の真**。記述側の錨に使う。
// V3-M8-T04(ADR-0061 限定13): 運営の行可視性の**実装の真**(`adminReadsAllRows` 1本)と、
// 3本目(V3-M8)/ 4本目(V4-M4 / ADR-0073)の予約規約フィールドの id を、記述側の錨に足す。
// **【`V8-M20`。台帳 `J-G30`(判定 = 廃止)。手続きは `ADR-0301`】**
// **`ADMIN_READABLE_FIELD` と `adminReadsAllRows` の import を落とした** ——
// **`src/server/owner-scope.ts` から実装ごと撤去されたためである**(残すと typecheck が赤い)。
// **代わりに立つのは「役割 × 対象(表)× 読取」であり、綴りを1つも持たない。**
// **したがって予約規約フィールドは 5本 → 4本 になった**(この import は今日4本のうち3本を運ぶ)。
import {
  // **`V7-M6-T04`(`Z-G29`)**: **説明文が言う「5段まで」の**実装の真**。**
  // **字面で 5 と書かず、実装の定数から引く**(改名・変更したら記述を直すまで赤くなる)。
  MAX_RECORD_ACCESS_INHERIT_DEPTH,
  NO_DIRECT_CREATE_FIELD,
  // **【`V8-M27-T04` / `T-G5`】`nonAdminTableAccess` の import は撤去した**(関数ごと消えた)。
  // **代わりに、消えていない予約規約の述語2本を引く。**
  OWNER_FIELD,
  PUBLIC_FIELD,
  personalOwnerField,
  publicField,
  // **【`V8-M20`。台帳 `J-G30`。ユーザ決定 `D-V8-35`】撤去した `adminReadsAllRows` の
  // 代わりに、所有の軸を越える例外の**今日の実装の真**をここから引く。**
  roleReadCrossesOwnerScope,
  UNDELETABLE_FIELD,
} from "../server/owner-scope.ts";
import { SYSTEM_TABLE_IDS } from "../shared/system-tables.ts";
import {
  APPLY_DIFF_OP_EXAMPLES,
  CANNOT_DO,
  CANNOT_DO_INDEX,
  CHANGE_FIELD_ACCEPTED_KEYS,
  CHANGE_TABLE_ACCEPTED_KEYS,
  DESIGN_ADJECTIVE_AXES,
  DESIGN_ADJECTIVE_PHRASES,
  DESIGN_ADJECTIVE_TABLE,
  DESIGN_ADJECTIVE_UNTOUCHED_SLOTS,
  DESTRUCTIVE_CHANGE_FLOW,
  describeTool,
  OUT_OF_SCOPE_BEHAVIOR,
  SKILL_GUIDE,
  SKILL_POINTER,
  UPDATE_VIEW_ACCEPTED_KEYS,
  VOCABULARY_ENTRY_POINT,
  VOCABULARY_SCOPE,
  WORKFLOW_HISTORY_TABLE_TEMPLATE,
} from "./vocabulary.ts";

// ---------------------------------------------------------------------------
// **【`V9-M11-T02` / 台帳 `X-G28` / `D-V9-21`】`docs/` を読む 11 test は、この
// ファイルから `tools/docs/vocabulary-docs.test.ts` へ切り出した。**
// ---------------------------------------------------------------------------
//
// **公開単位(`apps/smailtalk/`)の中の検査は、公開単位の外(正本のルート直下の
// `docs/`)を1バイトも読まない。** 着手前、このファイルは 219 test のうち **11 本**が
// `docs/manual.md` / `docs/mcp-quickstart.md` / `docs/adr/*.md` を fs で直読みしていた。
//
// **丸ごと移していない。****切り出した。** 残る **208 本**は `docs/` を1バイトも読まず、
// 公開単位の中の定数・正準スキーマ・ソースだけを見る —— 丸ごと移すと、その 208 本が
// 公開単位から消える。**切り出した位置には、1件ずつ行き先を名指しするコメントを残した。**
//
// **`docs/` を1バイトも複製していない**(`D-V9-21` 逐語「複製もしない」)。

test("VOCABULARY_SCOPE はカーネルのリソース種7種をすべて列挙している", () => {
  // V1-M2-T07(ADR-0013 §1): workflow が6種目として加わった。
  // V1-M6-T05(ADR-0024 §Decision): function が7種目として加わった。
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】`report_view`(集計表)が
  // 8種目として加わった。****期待値を 7 → 8 へ書き換えた。**
  // **旧行の逐語は `expect(RESOURCE_KINDS.length).toBe(7);` である。**
  // **テスト名(「…リソース種7種を…」)は書き換えていない** —— **この test が本当に
  // 測っているのは「`RESOURCE_KINDS` の全要素が `VOCABULARY_SCOPE` の説明文に載っていること」
  // であり、その主張は1ミリも弱めていない**(下の走査は1バイトも変えていない)。
  expect(RESOURCE_KINDS.length).toBe(8);
  for (const kind of RESOURCE_KINDS) {
    expect(VOCABULARY_SCOPE).toContain(kind);
  }
});

test("VOCABULARY_SCOPE はカーネルのフィールド型9種をすべて列挙している", () => {
  // V2-M2 / ADR-0035: image が8種目として加わった(EC-G3。商品画像)。
  // VOCABULARY_SCOPE の型数は FIELD_TYPES から動的に組み立てられるので自動追随する
  // (`vocabulary.ts` 本体の文言点検 Δ5 は V2-M2-T05 の担当)。
  expect(FIELD_TYPES.length).toBe(9); // 【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  for (const type of FIELD_TYPES) {
    expect(VOCABULARY_SCOPE).toContain(type);
  }
});

test("VOCABULARY_SCOPE は差分操作16種をすべて列挙している", () => {
  // V1-M1-T03(ADR-0010): additive 4種 + 破壊的4種 = 8種になった。
  // V1-M1(remove_view / ADR-0007 門A 限定採用): remove_view が加わって 9種。
  // V1-M2-T07(ADR-0013 §4c): ワークフロー3種が加わって 12種。
  // V1-M6-T05(ADR-0024 §4c): 関数3種が加わって 15種。
  // **V3-M1-T03(ADR-0047 §4c): set_theme が加わって 16種**(v3 が語彙の総量を
  // 初めて増やした。審査記録 docs/plan/v3/records/v3-m1-gate-a-theme.md §10 の規則1)。
  // 配列部分は DIFF_OPS から動的に組み立てているので自動追随する。
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 17 → 18 に書き換えた —— 18種目 `set_roles` を足したため。検査は消していない。**
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】期待値を 18 → 17 に**
  // **書き換えた。****旧行の逐語は `expect(DIFF_OPS.length).toBe(18);` である。**
  // **減らしたのは別の決定(`set_user_kinds` の廃止)である。****検査は消していない。**
  expect(DIFF_OPS.length).toBe(17); // 【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)/【`V8-M16`】17 → 18(`set_roles` が18種目)/【`V8-M29`】18 → 17(`set_user_kinds` を廃止)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  for (const op of DIFF_OPS) {
    expect(VOCABULARY_SCOPE).toContain(op);
  }
});

// --- V2-M2-T05: image 型が入った(EC-G3 / ADR-0035。Δ5 文言点検)---------------------
//
// **T01 で FIELD_TYPES に image が8種目として入った(ADR-0035 §1)。** 商品画像。
// `VOCABULARY_SCOPE` の型数(今日は「9種」)と型名は FIELD_TYPES から**動的に組み立てられる**
// ので自動追随する(vocabulary.ts:82 の `${FIELD_TYPES.length}種(${FIELD_TYPES.join(...)})`)。
// **T05 の Δ5 文言点検の結論**:
//   - 手書きの型数(「フィールド型は7種」)は他のどこにも無い(grep 該当なし)。
//   - 「画像/ファイルは扱えない/貼れない/保存できない」という断定は、image 追加前から
//     説明文に**存在しなかった**(M0 審査 S2 と同じ観測。grep 該当なし)。したがって
//     **書き換える文言は無かった**。
//   - 「外部からのデータ取り込み(受信)はありません」は、owner/editor が能動的に行う画像
//     アップロードとは別物(外部が到達する Webhook 受信 = EC-G4)なので**触らない**(真のまま)。
// **M3-T02 / V2-M1-T06 と同型の双方向の歯止めを置く。** 片方向だけだと逆向きの嘘に倒れる:
//   (a) 実装→記述: FIELD_TYPES に image がある以上、VOCABULARY_SCOPE に image が現れる。
//   (b) 記述→実装: 「フィールド型は7種」という古い型数の断定が(手書きで)復活しない。
//   (c) 記述→実装: 「画像/ファイルは扱えない」という嘘が説明文に静かに入らない(予防線)。

test("V2-M2-T05: FIELD_TYPES に image がある ⇔ VOCABULARY_SCOPE が image を列挙する(実装→記述の歯止め)", () => {
  // FIELD_TYPES(実装の真)に image が入った以上、VOCABULARY_SCOPE に image が現れること。
  // ここが食い違ったら(型を足したのに説明文に出ない、その逆)赤くなる。
  expect(FIELD_TYPES as readonly string[]).toContain("image");
  expect(VOCABULARY_SCOPE).toContain("image");
});

test("V2-M2-T05: VOCABULARY_SCOPE はフィールド型を9種と述べ、7種 / 8種という古い型数が復活していない(記述→実装の歯止め)", () => {
  // 型数は `FIELD_TYPES.length` から動的に組み立てられるので自動で「9種」になるが、
  // **手書きの「フィールド型は7種」がどこかに紛れ込む/戻ることを塞ぐ**(Δ5 の本体)。
  expect(FIELD_TYPES.length).toBe(9); // 【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  expect(VOCABULARY_SCOPE).toContain("フィールド型は9種"); // 【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  expect(VOCABULARY_SCOPE).not.toContain("フィールド型は7種");
});

test("V2-M2-T05: 説明文は画像/ファイルを「扱えない」と嘘をついていない(記述→実装の歯止め)", () => {
  // **点検結論**: image 追加前から画像/ファイルを否定する断定は無かった(書き換え不要)。
  // ここは将来 image を否定する文言が静かに入ることを止める予防線である。
  for (const lie of [
    "画像は扱えません",
    "画像を貼れません",
    "画像は保存できません",
    "画像・ファイルは扱えません",
    "ファイルは添付できません",
    "画像やファイルは扱えません",
  ]) {
    expect(CANNOT_DO).not.toContain(lie);
    expect(VOCABULARY_SCOPE).not.toContain(lie);
  }
  // **逆向きの嘘の非該当も固定する**: image アップロード(owner/editor の能動操作)を
  // 「受信(外部到達 Webhook)」と混同しない。**V2-M5(ADR-0041)で受信が実在した**ので、
  // 旧「外部からのデータ取り込み(受信)はありません」の全否定は嘘になった —— image 追加を理由に
  // この行を触ってはならない件は解消し、受信の正確な双方向歯止めは V2-M5-T04 が固定する。
  // ここでは image を否定する嘘が入っていない(上)ことだけを見て、受信の全否定が残っていない
  // ことを確認する。
  expect(CANNOT_DO).not.toContain("外部からのデータ取り込み(受信)はありません");
});

test("CANNOT_DO はできないことを具体例で列挙している", () => {
  for (const example of ["ワークフロー", "権限", "集計"]) {
    expect(CANNOT_DO).toContain(example);
  }
});

// --- M3-T02: アプリ単位の権限(owner/editor/viewer)が HTTP データ経路に入った(Δ5)------
//
// **T02 で「権限・アクセス制御は一切無い」という全否定が嘘になった。**
// アプリ単位のロール(閲覧/編集/管理)が HTTP のデータ経路に入り、owner がユーザに
// 割り当てる。ただし変わったのはこの全否定の1点だけである ——
//   - MCP/ローカル操作そのものには依然として権限制御が無い(stdio 直結。ADR-0005 §7)。
//   - AI が「画面ごと・項目ごとの表示権限」をマニフェストで設定する能力は依然として無い。
// **片方向だけ固定すると逆向きの嘘に倒れる**ので、T07 と同じく双方向で固定する。

test("M3-T02: CANNOT_DO は「権限・アクセス制御は無い」という全否定を主張していない(Δ5)", () => {
  // **文言そのものを禁止しておかないと、将来の編集で静かに戻ってくる。**
  expect(CANNOT_DO).not.toContain("権限・アクセス制御は無い");
  expect(CANNOT_DO).not.toContain("アクセス制御は無い");
});

test("V4-M3-T07: CANNOT_DO は、画面・項目単位の宣言が在ることと、守らない経路があることを両方述べている", () => {
  // **【V4-M3-T07 / `B-G1` / `B-G2` / ADR-0070 限定12 / ADR-0071 §Consequences による書き直し】**
  //
  // **旧テスト名**: 「M3-T02: CANNOT_DO は AI が画面・項目単位の表示権限を設定できないことを
  // 依然述べている」。**旧アサーション**: `expect(CANNOT_DO).toContain("画面・項目単位の表示権限を
  // マニフェストで定義することもできません")`。
  //
  // **この主張は V4-M3 の実装で偽になった** —— `$defs/view.audience`(`ADR-0070`)と
  // `$defs/field.audience`(`ADR-0071`)が門A の本審査を通って実在する。**逐語を残すと
  // 「緑のまま嘘が固定される」ので消した。**
  //
  // **代わりに双方向で固定する**(`ADR-0070` 限定12: 片方だけ書くと逆向きの嘘になる):
  //   (1) 画面単位・項目単位の宣言が**書けること**。
  //   (2) **守らない経路がある**こと(宣言の無い画面 / URL 直打ち / get_manifest / MCP)。
  // (1) 書けること。
  expect(CANNOT_DO).toContain("今日は、画面を名指しして見せる相手を書けます");
  expect(CANNOT_DO).toContain("項目(フィールド)単位でも、見せる相手を書けます");
  // (2) 守らない経路。**1つでも消えたら赤くなる。**
  // **【`V8-M20`。台帳 `J-G27` / `J-G28`(どちらも判定 = 廃止)。手続きは `ADR-0301`】**
  // **画面・項目の「見せる相手」を宣言するキーを撤去し、代わりに面(役割 × 対象 × 動詞)が
  // 立ったので、下の3行の期待値を書き換えた。****旧値をここに残す**(このリポジトリの作法):
  //   旧: `"audience を書かなかった画面は今日どおり全員に見えます"`
  //   新: `"どの役割の規則からも名指しされていない画面は、今日どおり全員に見えます"`
  //   旧: `"書き忘れた項目は今日どおり全員に出ます。既定は「出す」です"`
  //   新: `"どの規則からも名指しされていない項目は今日どおり全員に出ます。既定は「出す」です"`
  //   旧: `"あなたが list_records で読むときは audience の宣言を1つも見ません"`
  //   新: `"あなたが list_records で読むときは役割の規則を1つも見ません"`
  // **問いは1つも変わっていない** —— **「既定は開いているか」「MCP は見ないか」である。**
  expect(CANNOT_DO).toContain(
    "どの役割の規則からも名指しされていない画面は、今日どおり全員に見えます",
  );
  expect(CANNOT_DO).toContain(
    "画面を名乗らずにテーブルの URL を直接叩いた要求は、今日どおり通ります",
  );
  expect(CANNOT_DO).toContain("get_manifest は未ログインでも全画面の定義を返します");
  expect(CANNOT_DO).toContain(
    "どの規則からも名指しされていない項目は今日どおり全員に出ます。既定は「出す」です",
  );
  expect(CANNOT_DO).toContain("あなたが list_records で読むときは役割の規則を1つも見ません");
  // **撤去した4層の綴りが1つでも戻ったら赤くなる**(`V8-M20` の戻し防止)。
  expect(CANNOT_DO).not.toContain("audience");
  expect(CANNOT_DO).not.toContain("writable_by");
  // **旧逐語が復活したら赤くなる**(戻し防止。今日は偽である)。
  expect(CANNOT_DO).not.toContain(
    "画面・項目単位の表示権限をマニフェストで定義することもできません",
  );
  expect(CANNOT_DO).not.toContain("項目(フィールド)単位で隠す手段は今日も1つもありません");
  // T02 で入った正確な書き分け(HTTP データ経路のアプリ単位ロール)が書かれていること。
  // **V2-M1-T06 で3値(閲覧/編集/管理)→4値(+顧客)に更新した。** 旧文言の断片は
  // 下の V2-M1-T06 テストが名指しで禁じる(3値列挙が復活したら赤くなる)。
  // **【`V5-M17-T09` / `ADR-0158` 限定10 で書き換えた】旧逐語は
  // 「アプリ単位のロールが4種(閲覧 / 編集 / 管理 / 顧客)」だった。**
  // **偽になったのは「4種」という数である**(アプリが非運営の種類を最大8種まで名付けられる)。
  expect(CANNOT_DO).toContain("運営の予約ロールが3種(閲覧 / 編集 / 管理)");
  // MCP/ローカル操作そのものには依然として権限制御が無いこと(ADR-0005 §7)。
  expect(CANNOT_DO).toContain("MCP / ローカル操作そのものに権限制御は無く");
});

test("V4-M28-T02: CANNOT_DO は、隠した項目を読取の要求の条件に書けないことと、今日も漏れる経路を両方述べている", () => {
  // **【V4-M28-T02 / `D-V4-93` / `ADR-0120` 限定10(Δ5 の双方向)】**
  //
  // **旧逐語**: 「**その項目で絞り込む(filter)ことも並べ替える(sort)ことも今日どおりでき、**」。
  // **`ADR-0120`(門A 本審査 = 限定採用)が `ADR-0071` 限定4 を改訂し、`V4-M28-T01` が
  // 読取経路に実装したので偽になった。** **逐語を残すと「緑のまま嘘が固定される」ので消した。**
  //
  // **双方向で固定する**(片方だけ書くと逆向きの嘘になる):
  //   (1) **できなくなったこと** —— 読取の要求の条件に書けない / 相手を問わない(owner も同じ)。
  //   (2) **今日も漏れる経路** —— 画面(list_view)の filter / sort・作成/更新の応答・MCP。
  // (1) できなくなったこと。
  expect(CANNOT_DO).toContain("その項目を読み取りの要求の条件に書くことはできません");
  expect(CANNOT_DO).toContain("相手が誰でも同じで、管理(owner)でも書けません");
  // (2) 今日も漏れる経路。**1つでも消えたら赤くなる。**
  expect(CANNOT_DO).toContain(
    "ただし画面(list_view)の filter / sort に書くことは今日どおりでき、" +
      "その画面の並び順からは大小関係が今日も漏れます",
  );
  // **【V4-M35 / `ADR-0134` 限定12(Δ5 の是正)。反転した1行】**
  //
  // **反転前の逐語**(`V4-M28-T02` 以降 2026-08-04 まで緑だったもの。**1バイトも書き換えずに残す**):
  //
  // ```
  // expect(CANNOT_DO).toContain("作成・更新の応答には落ちません");
  // ```
  //
  // **なぜ反転したか**: **`ADR-0134`(`V4-M35` 門A 本審査 単位A = 限定採用)が、作成・更新・
  // まとめ書きの**成功**応答にも読取と同じ射影を掛けると決めた。** **同 限定12 は
  // 「`grep -c "作成・更新の応答には落ちません" src/mcp/vocabulary.ts` が **0**」を機械的検査に
  // 指定しているので、`vocabulary.ts` から旧逐語を消す必要がある** —— **逐語の保存先は
  // `docs/plan/v4/records/v4-m35.md` §10 である**(`ADR-0007` §6 規律1 の作法を、
  // grep が 0 を求める制約の下で満たす形)。
  //
  // **双方向で固定する**(`ADR-0049` 限定5 / `ADR-0052` / 審査記録 §6 の「直す形」):
  //   (1) **できなくなったこと** —— ブラウザからの書込の成功応答からも落ちる。
  //   (2) **今日も漏れる経路** —— MCP(`write_records`)/ 受信口 / ワークフロー / 島。
  //   (3) **書込の可否は1ミリも変わらない**(`ADR-0134` 限定7。単位C は保留)。
  expect(CANNOT_DO).toContain("ブラウザからの作成・更新・まとめ書きの成功応答からも落ちます");
  expect(CANNOT_DO).toContain(
    "MCP(write_records)の応答・受信口・ワークフロー・コードの島には1ミリも掛かりません",
  );
  // **【`V8-M20`。台帳 `J-G28`。手続きは `ADR-0301`】期待値を書き換えた。旧値を残す** ——
  //   旧: `"値を書き込めること自体は今日も止まりません"`
  //   新: `"値を書き込めること自体は、読める規則だけでは止まりません"`
  // **理由**: **「読める」と「書ける」が別のキーだったものが、同じ対象の別の動詞になった。**
  // **問いは1つも変わっていない** —— **読める側の宣言だけでは書込は止まらない、である。**
  expect(CANNOT_DO).toContain("値を書き込めること自体は、読める規則だけでは止まりません");
  // **旧逐語が復活したら赤くなる**(戻し防止。今日は偽である)。
  expect(CANNOT_DO).not.toContain("作成・更新の応答には落ちません");
  //   旧: `"あなたが list_records で読むときは audience の宣言を1つも見ません"`
  //   新: `"あなたが list_records で読むときは役割の規則を1つも見ません"`
  expect(CANNOT_DO).toContain("あなたが list_records で読むときは役割の規則を1つも見ません");
  // **旧逐語が復活したら赤くなる**(戻し防止。今日は偽である)。
  expect(CANNOT_DO).not.toContain(
    "その項目で絞り込む(filter)ことも並べ替える(sort)ことも今日どおりでき",
  );
});

test("V4-M2-T05: CANNOT_DO は、未ログインにも見せると宣言できることと、守らない経路を両方述べている", () => {
  // **【V4-M2-T05 / `B-G5` / `ADR-0074` 限定12(Δ5 の双方向)】**
  //
  // **`ADR-0074` 限定12 の逐語**: 「`CANNOT_DO` / `VOCABULARY_SCOPE` に『匿名にも見せると
  // 宣言できる』を書き、**同時に「守らない経路がある」(`GET /manifest` / MCP / 宣言して
  // いない画面)を1文字も消さずに書く。** 片方だけ書くと逆向きの嘘になる」。
  //
  // **旧文は列挙を「閲覧 / 編集 / 管理 / 顧客」の4値で書いていた。** 値域が5値になったので
  // **不完全になった**(嘘になったのではない)。**上の V4-M3-T07 の双方向の歯止めは1本も
  // 消していない** —— ここが足すのは匿名の分だけである。

  // **【`V8-M20`。台帳 `J-G27`(判定 = 廃止)。手続きは `ADR-0301`】**
  // **画面の「見せる相手」を宣言するキーは撤去され、未ログインは面の主体 `anonymous` として
  // 判定されるようになった。****この検査が問うていること(未ログインにも開けると書けるか /
  // 守らない経路を同じ段落で書いているか)は1つも変えていない。****旧値を全部残す**:
  //   旧: `"audience(閲覧 / 編集 / 管理 / 顧客 / 未ログイン の列挙)"`
  //   新: `"未ログインの人は anonymous という役割として判定されます"`
  //   旧: `"anonymous(未ログイン)と書いた画面だけは、ログインしていない人にも描かれます"`
  //   新: `"anonymous に read を書いた画面は、ログインしていない人にも描かれ、ログイン画面に導線が出ます"`
  //   旧: `"ログイン画面にその画面への導線が出ます"`(上の1本に畳んだ)
  //   旧: `"anonymous だけを書いた画面は、ログイン済みの誰にも見えません"`
  //   新: `"anonymous にだけ read を書いた画面は、ログイン済みの誰にも見えません"`
  //   旧: `"anonymous と書かなかった画面の定義も、未ログインでそのまま読めます"`
  //   新: `"規則で閉じた画面の定義も、未ログインでそのまま読めます"`
  //   旧: `"「宣言で隠す」は情報の遮断ではありません"` → 新: `"「規則で隠す」は情報の遮断ではありません"`
  //   旧: `"公開でないテーブルの画面を anonymous と書くと、画面は開けても中身は空か 401 になります"`
  //   新: `"公開でないテーブルの画面を anonymous に開くと、画面は開けても中身は空か 401 になります"`
  //   旧: `"あなたが list_records で読むときは audience の宣言を1つも見ません"`
  //   新: `"あなたが list_records で読むときは役割の規則を1つも見ません"`
  //
  // **【1本だけ、期待そのものが反転した。丸めない】**
  //   旧: `expect(CANNOT_DO).toContain("その画面を未ログインには1画面も見せません")`
  //   新: `expect(CANNOT_DO).toContain("名指しされていない画面は、未ログインの人にも並びます")`
  // **旧層の既定は「宣言の無い画面は未ログインに見せない」(閉じる側)だったが、面の既定は
  // 「規則を1本も書いていない対象は管轄外 = 全許可」(開く側)である**(裁定 `R-4`。
  // `web/src/auth/authz.tsx` の `canUseView` の注が「これを『同じ挙動を保った』と書かない」と
  // 自ら書いている)。**この反転を説明文が黙っていると、AI は未ログインから隠れているつもりで
  // 画面を作る。**

  // (1) 未ログインにも見せると宣言できること。
  expect(CANNOT_DO).toContain("未ログインの人は anonymous という役割として判定されます");
  expect(CANNOT_DO).toContain(
    "anonymous に read を書いた画面は、ログインしていない人にも描かれ、ログイン画面に導線が出ます",
  );
  // **`anonymous` はロールではない**(`ADR-0074` §3a-5。`ROLE_LABELS` は今日も4値)。
  expect(CANNOT_DO).toContain("anonymous はロールではありません");
  expect(CANNOT_DO).toContain(
    "anonymous にだけ read を書いた画面は、ログイン済みの誰にも見えません",
  );

  // (2) 守らない経路。**1つでも消えたら赤くなる。**
  //   (a) **既定が開く側へ反転したことを、説明文が名指しで書いていること。**
  expect(CANNOT_DO).toContain("名指しされていない画面は、未ログインの人にも並びます");
  expect(CANNOT_DO).toContain("未ログインから隠したい画面は、1画面ずつ規則で名指ししてください");
  //   (b) `GET /manifest` は今日も未認証で全ビュー定義を返す(限定9)。
  expect(CANNOT_DO).toContain("規則で閉じた画面の定義も、未ログインでそのまま読めます");
  expect(CANNOT_DO).toContain("「規則で隠す」は情報の遮断ではありません");
  //   (c) 画面を開けることと行が返ることは別である(§3a-2)。
  expect(CANNOT_DO).toContain(
    "公開でないテーブルの画面を anonymous に開くと、画面は開けても中身は空か 401 になります",
  );
  //   (d) 匿名に書込 UI を出さないのは画面の側の話で、止めているのはサーバである(限定6)。
  expect(CANNOT_DO).toContain("未ログインには書き込みの導線を1つも出しません");
  expect(CANNOT_DO).toContain("止めているのは画面ではなくサーバです");
  //   (e) MCP は1ミリも見ない(`ADR-0070` 限定8 を引き継ぐ。上のテストと重ねて持つ)。
  expect(CANNOT_DO).toContain("あなたが list_records で読むときは役割の規則を1つも見ません");

  // **旧の列挙が復活したら赤くなる**(戻し防止)。**綴りごと禁じる**(`V8-M20`)。
  expect(CANNOT_DO).not.toContain("audience(");
});

// --- V10-M11-T03: 未ログインが書ける口が1本だけ在ることと、止められないこと(Δ5)-----------
//
// **`ADR-0367` 限定6 の逐語**: 「**止められないことを、製品が配る説明の側に書く**
// (「未ログインの書き込みには、送ってくる相手を特定する手がかりも、回数の制限も1つも
// ありません」を `CANNOT_DO` に1文で置く。憲法6)」。
// **この検査は、その1文が在ることを固定する側である。** **【禁止】これを
// 「荒らし対策を入れた」と読まない** —— **入れていない。入れていないことを書いただけである。**

test("V10-M11-T03: CANNOT_DO は、未ログインが書ける唯一の口と、そこに回数の制限も名乗りも1つも無いことを述べている", () => {
  // (i) **未ログインが書ける口が今日1本だけ在ること**(コメント)。
  expect(CANNOT_DO).toContain("訂正します。上の (f) は今日は一部が偽です");
  expect(CANNOT_DO).toContain("画面へのコメントだけは、ログインしていない人でも書けます");
  expect(CANNOT_DO).toContain("未ログインで書ける口は今日この1本ちょうど");
  // (ii) **そこには回数の制限も名乗りの記録も1つも無いこと。**
  expect(CANNOT_DO).toContain("回数の制限も1つもありません");
  expect(CANNOT_DO).toContain("誰が書いたのかを後から知る手立ても1つもありません");
  // **読取を1ミリも開けていないこと**(`ADR-0367` 限定2 / 限界5)。
  expect(CANNOT_DO).toContain("書いた本人も自分のコメントを1件も読み返せません");

  // **旧文を1バイトも消していない**(この訂正は (f) の直後に**足した**ものである)。
  expect(CANNOT_DO).toContain("未ログインには書き込みの導線を1つも出しません");
  // **順序** —— **訂正は (f) の後に在る**(前に置くと、読む相手に旧文だけが先に届く)。
  expect(CANNOT_DO.indexOf("訂正します。上の (f) は今日は一部が偽です")).toBeGreaterThan(
    CANNOT_DO.indexOf("未ログインには書き込みの導線を1つも出しません"),
  );
});

// --- V2-M1-T06: customer ロール + 公開閲覧(未認証 GET)が入った(Δ5)----------------
//
// **T01〜T05 で CANNOT_DO のロール記述が3点にわたって嘘になった:**
//   1. ロールは4値(customer 追加)。「閲覧/編集/管理」の3種列挙は不完全な嘘。
//   2. customer は顧客セルフサインアップで**本人が自己付与**する。「owner がユーザに
//      割り当てます」を全ロールに掛けると嘘になる(customer だけは owner を経ない)。
//   3. 「読取は認証済みの全ロールが同じものを読める」も嘘 —— 未認証の公開 GET
//      (st_public の行)と、customer の運営テーブル遮断(403)が入った。
// **M3-T02 と同型の双方向の歯止めを置く。** 片方向だけ固定すると逆向きの嘘に倒れる。
// 実装(ROLE_VALUES / Role 型)と記述が食い違ったら赤くなる形にする。

/**
 * ロール識別子 → CANNOT_DO に現れる日本語ラベル。`Record<Role, string>` なので、
 * `Role` 型に5番目のロールを足すと**このマップが tsc で落ちる**(記述の更新を強制する)。
 */
const ROLE_LABELS: Record<string, string> = {
  owner: "管理",
  editor: "編集",
  viewer: "閲覧",
  customer: "顧客",
};

/**
 * **【`V5-M17-T09` / `G-G5` / `ADR-0158` 限定10 で置き換えた。旧テスト名と旧本体を先に書く】**
 *
 * **旧テスト名**: 「V2-M1-T06: CANNOT_DO は ROLE_VALUES の全ロールのラベルに言及している
 * (実装→記述の歯止め)」。**旧本体**は `expect([...ROLE_VALUES].sort()).toEqual([...4値])` と
 * `expect(CANNOT_DO).toContain("アプリ単位のロールが4種(閲覧 / 編集 / 管理 / 顧客)")` を持っていた。
 *
 * **置き換えた理由**: **`ROLE_VALUES` はアプリごとに変わる値になった**(予約3ロール +
 * 宣言された種類)。**「全ロールのラベルが説明文に現れる」は、宣言された種類については
 * 原理的に成立しない** —— **AI 向け説明文はアプリを1つも見ずに固定文として作られるからである。**
 *
 * **`ADR-0158` 限定10 の逐語**: 「**`src/mcp/vocabulary.ts:877` の「`ROLE_VALUES`(実装の真)の
 * 全ロールのラベルが `CANNOT_DO` に現れること」という機械的検査は、宣言値を含む形へ置き換える**」。
 *
 * **置き換え後に測ること**: **(1) 予約3ロールのラベルは今日も全部現れる**(実装 → 記述)。
 * **(2) 「宣言が無いアプリの4値目 = `customer`」のラベルも現れる。**
 * **(3) 説明文が「宣言できる」という事実そのものを述べている**(記述 → 実装)。
 *
 * **【この置き換えで測れなくなったこと。隠さない】** **アプリが宣言した種類の表示名が
 * 説明文に現れるかどうかは、1件も測れない。** **現れない** —— 固定文だからである。
 */
test("V5-M17-T09: CANNOT_DO は予約3ロールと既定の1本目のラベルに言及している(実装→記述の歯止め)", () => {
  expect([...reservedRoleValues()].sort()).toEqual(["editor", "owner", "viewer"]);
  // **【`V8-M29` 第2波】旧(逐語)**: `for (const role of roleValuesForKinds([])) {`
  for (const role of baseRoleValues()) {
    expect(CANNOT_DO).toContain(ROLE_LABELS[role] as string);
  }
  // **運営が3種であることと、それ以外がアプリの宣言であることを明示している。**
  expect(CANNOT_DO).toContain("運営の予約ロールが3種(閲覧 / 編集 / 管理)");
  expect(CANNOT_DO).toContain("アプリが自分で名付けた非運営の利用者の種類");
  // **旧の「4種」断定が復活したら赤くなる**(戻し防止)。
  expect(CANNOT_DO).not.toContain("アプリ単位のロールが4種(閲覧 / 編集 / 管理 / 顧客)");
});

test("V5-M17-T09: CANNOT_DO は宣言の限界を4点とも述べている(記述→実装の歯止め)", () => {
  // **`ADR-0158` の限定表が「これを超えない」と決めた4点。1つでも消えたら赤くなる。**
  expect(CANNOT_DO).toContain("app の user_kinds");
  expect(CANNOT_DO).toContain("上限は8種です"); // 限定3
  expect(CANNOT_DO).toContain("どれも customer とまったく同じに固定されています"); // 限定2
  expect(CANNOT_DO).toContain("owner / editor / viewer は予約語"); // 限定1
  // **差分操作で書けないという今日の限界**(`DIFF_OPS` は 16 のまま = 限定6)。
  // **【`V5-M17b` / `ADR-0248` 限定11 で反転した】** **旧行の逐語は
  // `expect(CANNOT_DO).toContain("利用者の種類を足す差分操作は1つも無く");` である。**
  // **今日は書ける** —— `ADR-0248` が17種目 `set_user_kinds` を通した。
  // **双方向の歯止めにする** —— **できる側(op 名)とできない側(消す手段が無い /
  // 種類ごとの規則が書けない)を両方固定する。**
  expect(CANNOT_DO).not.toContain("利用者の種類を足す差分操作は1つも無く");
  expect(CANNOT_DO).toContain("差分操作 set_user_kinds で書き込めます");
  expect(CANNOT_DO).toContain("宣言を「無い状態」へ戻す op はありません");
  expect(CANNOT_DO).toContain("種類ごとに違う規則を宣言するキーも1つもありません");
});

test("V2-M1-T06: CANNOT_DO は3値のロール列挙という嘘を主張していない(記述→実装の歯止め)", () => {
  // **嘘だった断定そのもの**が復活したら落ちる。M3-T02 が置いた旧文言(3値列挙 +
  // 全ロールを owner が割り当てるという断言)を名指しで禁じる。
  expect(CANNOT_DO).not.toContain(
    "アプリ単位のロール(閲覧 / 編集 / 管理。owner がユーザに割り当てます)",
  );
  expect(CANNOT_DO).not.toContain("(閲覧 / 編集 / 管理。owner がユーザに割り当てます)");
});

test("V2-M1-T06: CANNOT_DO は customer が自己サインアップで自己付与される事実に触れている", () => {
  // 逆向きの嘘(「全ロールを owner が割り当てる」)の歯止め。customer は owner を
  // 経ずに本人が名乗る、という T01/T02 の事実が書かれていること。
  // **【`V5-M17-T09`】「顧客セルフサインアップ」→「セルフサインアップ」。**
  // **経路の名前から種類の名前が外れた**(`G-G6`。HTTP パスも `/auth/customer/...` →
  // `/auth/signup/...`)。**自己付与という事実そのものは1文字も消していない。**
  expect(CANNOT_DO).toContain("セルフサインアップの別経路");
  expect(CANNOT_DO).toContain("自己付与");
  // 3値(閲覧/編集/管理)は owner が割り当てる、という限定つきの記述が残っていること
  // (owner 割り当て自体は3値については依然として真なので、消しすぎない)。
  expect(CANNOT_DO).toContain("owner がユーザに割り当てます");
});

test("V2-M1-T06: CANNOT_DO は公開閲覧(未認証 GET)と customer の運営テーブル遮断に触れている", () => {
  // T04(未認証の公開 GET・st_public)と T03(customer の運営テーブル 403)が入った
  // ことで、「読取は認証済みの全ロールが読める」建て付けが不正確になった。その2点が
  // 書かれていること(逆向きの嘘=「全部読める」を塞ぐ)。
  expect(CANNOT_DO).toContain("未認証");
  expect(CANNOT_DO).toContain("公開指定");
  // 公開しても書込は開かない(read-only)ことを述べている。
  expect(CANNOT_DO).toContain("書込は一切公開しません");
  // customer は自分の行と公開行しか読めず、運営テーブルは 403 で遮断される。
  expect(CANNOT_DO).toContain("運営テーブルは 403");
});

/**
 * **V1-M1-T06 が T03 の申し送りを解消した(Δ5)。テストは「印」から「歯止め」へ置き換える。**
 *
 * T03 が置いたテストは、`CANNOT_DO` が「削除は語彙に無い」「リネームは語彙に無い」
 * 「型変更は語彙に無い」と主張していることを**嘘のまま固定**していた。
 * `CANNOT_DO` を直した瞬間に赤くなることが目的であり、実際に赤くなった
 * (`docs/plan/v1/records/v1-m1-t06.md` §6)。**削除して緑にしたのではなく、
 * T03 の doc コメントが指示したとおり「このテストごと書き換えた」。**
 *
 * **置き換え後に見張るもの**は逆向きである:
 *
 * 1. **3つの嘘の断定が復活していないこと。** 部分文字列「削除」ではなく、
 *    嘘だった断定そのもの(「(削除は語彙に無い)」等)が無いことを見る。
 *    新しい `CANNOT_DO` は §6c の限界を語るために「削除」という語自体は使うので、
 *    語の有無で見ると必ず誤判定する。
 * 2. **ADR-0010 §6c の限界が書かれていること。** 「**消したフィールドの値だけを戻す手段は
 *    無い。undo は DB 全体を巻き戻す**」。ADR は「これを `CANNOT_DO` に書くこと」を
 *    T06 への要求として名指ししている。書かないと AI は「スナップショットがあるので
 *    戻せます」と説明しうる —— それは嘘である。
 */
test("CANNOT_DO は削除・リネーム・型変更を「語彙に無い」と主張していない(T03 の申し送りの解消)", () => {
  for (const op of ["remove_field", "remove_table", "change_table", "change_field"]) {
    expect(DIFF_OPS as readonly string[]).toContain(op);
  }
  // 嘘だった断定そのもの。復活したらここで落ちる。
  for (const lie of [
    "削除は語彙に無い",
    "リネームは語彙に無い",
    "型変更は語彙に無い",
    "「フィールドを削除して」",
    "「テーブルを消して」",
    "「フィールド名を変えて」",
    "「テーブルをリネームして」",
    "「この項目を数値型にして」",
  ]) {
    expect(CANNOT_DO).not.toContain(lie);
  }
});

test("CANNOT_DO は ADR-0010 §6c の限界(消した値だけは戻せない)を書いている", () => {
  expect(CANNOT_DO).toContain("消したフィールドの値だけを戻す手段はありません");
  expect(CANNOT_DO).toContain("undo はデータベース全体を巻き戻します");
  // 「スナップショットがあるので戻せます」という嘘を名指しで禁じていること(憲法6)。
  expect(CANNOT_DO).toContain("説明してはいけません");
});

test("CANNOT_DO はアプリ削除を「語彙に無い」と主張していない(V1-M9-T09 / ADR-0031。双方向の歯止め)", () => {
  // delete_app が語彙に入ったので、旧断定「アプリを消す操作だけは語彙に無い」は嘘になった。
  // remove_view / remove_field 群と同じ双方向規律 —— **嘘だった断定そのもの**が復活したら落ちる。
  for (const lie of ["アプリを消す操作だけは語彙に無い", "アプリを消す操作は語彙に無い"]) {
    expect(CANNOT_DO).not.toContain(lie);
  }
  // **逆向きの嘘(「何でも消せる」)も禁じる。** 不可逆性と同意の条件を必ず残していること。
  expect(CANNOT_DO).toContain("取り消せません");
  expect(CANNOT_DO).toContain("undo でも戻りません");
  expect(CANNOT_DO).toContain("同意を得てから delete_app");
});

/**
 * `VOCABULARY_SCOPE` の**散文部分**が 8 op に追随していること(Δ5)。
 *
 * 配列部分は `DIFF_OPS` から組み立てるので自動追随するが、
 * 「差分は additive(足すだけ)です」という散文は追随しない(ADR-0010 §2(e))。
 * **配列だけを見るテストでは、この嘘を検出できない。**
 */
test("VOCABULARY_SCOPE の散文は差分を additive と言っていない(Δ5)", () => {
  expect(VOCABULARY_SCOPE).not.toContain("差分は additive(足すだけ)です");
  expect(VOCABULARY_SCOPE).not.toContain(
    "既存の定義を削除・リネーム・型変更する操作は語彙に存在せず",
  );
  // 破壊的 op があること、そして undo の実体(DB 全体の書き戻し)を述べていること。
  expect(VOCABULARY_SCOPE).toContain("既存の定義とデータを実際に変更・削除します");
  expect(VOCABULARY_SCOPE).toContain("データベース全体の書き戻し");
});

/**
 * op の最小 JSON 例が `DIFF_OPS` の全要素を覆っていること(V1-M1-T06)。
 *
 * **真の照合をここに置いた理由。** 同じことを `descriptions.test.ts` や
 * `tools/write.test.ts` でも書けるが、そちらは `DIFF_OPS` を import していない ——
 * import すると ADR-0009 限定2 のスナップショット
 * (`scripts/kernel-import-snapshot.txt` = **カーネル境界を跨ぐ値の台帳**)が増える。
 * **本タスクは MCP 層の説明文の課題であり、境界の台帳を増やす理由が無い。**
 * このファイルは既に `DIFF_OPS` を import しているので、ここが唯一の置き場になる。
 *
 * 手書きの列挙にすると、op を足した日に「宣言した4つは全部ある」まま素通りする ——
 * **T03 が `CANNOT_DO` で起こしたのと同じ壊れ方である。**
 */
test("APPLY_DIFF_OP_EXAMPLES は DIFF_OPS の全 op に最小 JSON 例を持つ", () => {
  // **V3-M1-T03(ADR-0047): 16種目 set_theme が加わった**(§10 の規則1)。
  // **このループは数値の更新だけでは緑にならない** —— 16種目の例を
  // `APPLY_DIFF_OP_EXAMPLES` に足す必要がある(審査記録 §10 の規則1 は数値の更新しか
  // 書いておらず、ループの含意を書き落としていた。経緯は
  // docs/plan/v3/records/v3-m1-t03a.md の申し送りにある)。
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 17 → 18 に書き換えた —— 18種目 `set_roles` を足したため。検査は消していない。**
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】期待値を 18 → 17 に**
  // **書き換えた。****旧行の逐語は `expect(DIFF_OPS.length).toBe(18);` である。**
  // **減らしたのは別の決定(`set_user_kinds` の廃止)である。****検査は消していない。**
  expect(DIFF_OPS.length).toBe(17); // 【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)/【`V8-M16`】17 → 18(`set_roles` が18種目)/【`V8-M29`】18 → 17(`set_user_kinds` を廃止)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  for (const op of DIFF_OPS) {
    expect(APPLY_DIFF_OP_EXAMPLES).toContain(`"op": "${op}"`);
  }
});

// --- V1-M2-T07: ワークフロー語彙(ADR-0013 §10)-------------------------------------
//
// **片方向だけ固定すると、逆向きの嘘に倒れる。**ADR-0013 §10 は「全部消すと逆向きの
// 嘘になる」と名指しした —— 「自動化は無い」を消しただけでは「メールが送れる」に
// 読める文面が通ってしまう。**両方向を別々のテストで固定する。**

test("V1-M2-T07: CANNOT_DO は「自動化は無い」という嘘を主張していない(Δ5)", () => {
  // M2 後、`apply_diff` は add_workflow を受理する。この時点で
  // 「ワークフロー・自動化は無い」は嘘であり、憲法6 に反する。
  // **文言そのものを禁止しておかないと、将来の編集で静かに戻ってくる**
  // (`APPLY_DIFF_OP_EXAMPLES` の「配列ではない」と同じ壊れ方)。
  expect(CANNOT_DO).not.toContain("ワークフロー・自動化は無い");
  expect(CANNOT_DO).not.toContain("自動化は無い");
  expect(CANNOT_DO).not.toContain("ワークフローは無い");
  // 「毎朝バッチで処理して」は schedule トリガーでできるようになったので落とした。
  expect(CANNOT_DO).not.toContain("毎朝バッチで処理して");
});

test("V1-M4-T04: CANNOT_DO は外部送信を『無い』と嘘をつかず、capability で門番されると述べている(Δ5)", () => {
  // **M4(ADR-0020)後、call_external + 人間(owner)発行の接続で外部送信が起こり得る。**
  // 「外部への送信はありません」「外部システム連携は無い」は**嘘になったので禁止する** ——
  // 自動化を実在化したとき(上のテスト)と同じ**双方向の歯止め**。片方向だけ消すと逆向きの
  // 嘘に倒れる(ADR-0013 §10)。将来の編集でこの全否定が静かに戻らないよう固定する。
  expect(CANNOT_DO).not.toContain("外部への送信はありません");
  expect(CANNOT_DO).not.toContain("外部システム連携は無い");
  // できることは具体的に述べる: create/update は同じアプリのテーブルへ書く(嘘の否定に倒れない)。
  expect(CANNOT_DO).toContain("同じアプリの中のテーブルだけ");
  // **新しい真実(§2b の構造論証)を述べていること**: 発行は人間のみ・AI は申請だけ・
  // 接続なしは実行層で遮断。これらが「できないことをプロンプトでなく構造で正直に言う」中身。
  expect(CANNOT_DO).toContain("接続を発行できるのは人間(owner)だけ");
  expect(CANNOT_DO).toContain("request_connection で申請することしかできません");
  expect(CANNOT_DO).toContain("カーネルの実行層で遮断されます");
  // call_external は依然「送信専用」(応答本文の取り込み = R2-b は無い)。ここは真の否定なので残す。
  // **ただし V2-M5(ADR-0041)で「人間発行の inbound capability + 署名付き Webhook」の受信経路が
  // 入った**ので、旧「外部からのデータ取り込み(受信)はありません」の全否定はもう主張しない
  // (受信の双方向歯止めは V2-M5-T04 が固定)。
  expect(CANNOT_DO).toContain("call_external は依然送信専用");
  expect(CANNOT_DO).not.toContain("外部からのデータ取り込み(受信)はありません");
});

test("V1-M5-T04: 語彙説明は AI 呼び出しを『無い』と嘘をつかず、capability と上限で門番されると述べている(Δ5)", () => {
  // **M5(ADR-0021)後、ai_transform + 人間(owner)発行の AI capability で AI 呼び出しが起こり得る。**
  // アクションは4種になった。VOCABULARY_SCOPE / CANNOT_DO がそれを正直に述べていること。
  // **V1-M6-T05(ADR-0024): run_function が5種目として加わったので「の5種」になった。**
  expect(VOCABULARY_SCOPE).toContain(
    "create_record / update_record / call_external / ai_transform / run_function の5種",
  );
  // AI 呼び出しは capability + 上限に縛られ、遮断は実行層で行われる(プロンプト依存ではない)。
  expect(VOCABULARY_SCOPE).toContain(
    "request_ai_capability で申請できるだけで発行も上限変更もできず",
  );
  expect(VOCABULARY_SCOPE).toContain("カーネルの実行層で遮断され、記録されます");
  // 出力を信頼しない(検証してフォールバック)。
  expect(VOCABULARY_SCOPE).toContain("AI の出力はそのまま信頼せず");
  // CANNOT_DO: AI は申請まで、上限変更も人間だけ。
  expect(CANNOT_DO).toContain("request_ai_capability で申請することしかできません");
  expect(CANNOT_DO).toContain("上限を変更できるのも人間だけです");
  // _ai_usage の集計軸(アプリ別・ユーザ別)に言及している。
  expect(VOCABULARY_SCOPE).toContain("app_id / actor で絞ってアプリ別・ユーザ別に集計できます");
});

// --- V1-M6-T05: 関数リソース(コードの島)と run_function が入った(ADR-0024。Δ5)------
//
// **T05 で「集計・グラフは無い」という全否定が一部嘘になった。**
// 集計値(合計・件数・平均)は、関数リソース(コードの島)の JS コードで集計し、出力を
// テーブルへ書いて既存ビューで見せる形(run_function アクションで発火)でなら表現できる。
// ただし **(a) カーネル自体は集計語彙(count / group by / sum)を1つも持たない** ——
// 集計は宣言では書けず島のコードとして書く —— **(b) グラフ描画は依然として無い**(表示層)。
// **片方向だけ固定すると逆向きの嘘に倒れる**ので、T07 / M4 / M5 と同じく双方向で固定する。

test("V1-M6-T05: CANNOT_DO は「集計・グラフは無い」という全否定を主張していない(Δ5)", () => {
  // **文言そのものを禁止しておかないと、将来の編集で静かに戻ってくる。**
  expect(CANNOT_DO).not.toContain("集計・グラフは無い");
  expect(CANNOT_DO).not.toContain("(集計・グラフはありません)");
});

test("V1-M6-T05: CANNOT_DO は集計値を島のコードで表現できることを正直に述べている", () => {
  // できるようになったこと: 関数リソース(コードの島)の出力をテーブルに書いてビューで見せる形。
  expect(CANNOT_DO).toContain("関数リソース(コードの島)を作り");
  expect(CANNOT_DO).toContain("run_function");
  // **誇張しない**: 「何でも集計できる」ではなく、集計ロジックは島のコードとして自分で書く。
  expect(CANNOT_DO).toContain("集計ロジックは島のコードとして自分で書く必要があります");
});

/**
 * **【V4-M23-T04 / `D-V4-89` / `E-G31` / ADR-0104 限定12 で差し替えた。検査は消していない】**
 *
 * **旧い逐語「count / group by / sum をカーネルに書くことはできません」は今日は嘘である** ——
 * **門A の本審査(V4-M23 単位A-2。4回目の審査 = 3回目の再提出。判定 = 限定採用)が
 * `list_view` の `sum_field` を通し、一覧の合計だけがカーネル語彙になった。**
 * **旧い逐語を検査から外すかわりに、「何が今日も書けないか」を同じ強さで固定する** ——
 * **`group by` / 平均 / 最小 / 最大 は今日も1つも書けない**(限定2 / 限定8)。
 * **【禁止】「集計できるようになった」と読める文面にしない**(限定12)。
 */
test("V4-M23-T04: CANNOT_DO は「開いたのは合計1つだけ」と述べ、group by / 平均を今日も否定している", () => {
  // **開いた分**(嘘を残さない)。
  expect(CANNOT_DO).toContain("一覧の合計(list_view の sum_field)");
  // **開いていない分**(逆向きの嘘に倒さない)。**「何でも集計できる」と読める文面にしない。**
  expect(CANNOT_DO).toContain("group by / 平均 / 最小 / 最大 をカーネルに書くことはできません");
  // **旧い全否定の逐語が戻ってきたら赤くなる**(静かに古い嘘へ戻らないための歯止め)。
  expect(CANNOT_DO).not.toContain("count / group by / sum をカーネルに書くことはできません");
});

test("V4-M23-T04: VOCABULARY_SCOPE も同じ2点を述べている(要旨と詳細で食い違わせない)", () => {
  expect(VOCABULARY_SCOPE).toContain(
    "カーネルが持つ集計語彙は一覧の合計(list_view の sum_field)1つだけ",
  );
  expect(VOCABULARY_SCOPE).not.toContain(
    "カーネル自体は集計語彙(count / group by / sum)を1つも持たず",
  );
});

test("V4-M23-T04: 合計の母集団と限界を、AI 向けの説明文が明記している", () => {
  // **母集団**(限定5)—— 「今見えているページの合計」ではない。
  expect(VOCABULARY_SCOPE).toContain("画面に出る「全 N 件」とまったく同じ集合");
  // **1画面1列**(限定3)。
  expect(VOCABULARY_SCOPE).toContain("1画面で合計できる列は1本だけ");
  // **MCP の list_records はこの宣言を1つも見ない**(ADR-0104 §限界8。黙って効かないままにしない)。
  expect(VOCABULARY_SCOPE).toContain("list_records は sum_field を1つも見ません");
});

test("V1-M6-T05: CANNOT_DO はカーネルに集計語彙が無いこと・グラフが依然不可なことを述べている", () => {
  // **【V4-M23-T04 で1行だけ差し替えた】** 旧行 `expect(CANNOT_DO).toContain("count / group by /
  // sum をカーネルに書くことはできません")` は、`ADR-0104` が合計を通したので今日は赤くなる。
  // **同じ主張のうち今日も真な部分を、上の `V4-M23-T04` の検査が引き受けている。**
  // **グラフ描画は依然として無い**(表示層。関数の出力も数値であって描画ではない)。
  expect(CANNOT_DO).toContain("グラフの描画は依然としてありません");
  expect(CANNOT_DO).toContain("「グラフにして」は、この形でも実現できません");
});

test("V1-M6-T05: VOCABULARY_SCOPE は run_function と関数リソースを正直に述べている", () => {
  // run_function は関数を実行し、出力を output_table に全置換で書く。
  expect(VOCABULARY_SCOPE).toContain("run_function は関数リソース(コードの島)を実行し");
  expect(VOCABULARY_SCOPE).toContain("output_table に**全置換**で書きます");
  // **【V4-M23-T04 / ADR-0104 限定12 で差し替えた。検査は消していない】** 旧行は
  // `expect(VOCABULARY_SCOPE).toContain("カーネル自体は集計語彙(count / group by / sum)を
  // 1つも持たず")` だった。**合計だけが門A を通ったので今日は赤くなる。**
  // **カーネルが持つ集計語彙は合計1つだけである**(ADR-0024 の縛りのうち、今日も生きている分)。
  expect(VOCABULARY_SCOPE).toContain(
    "カーネルが持つ集計語彙は一覧の合計(list_view の sum_field)1つだけ",
  );
  // 関数 op(add/update/remove_function)にも言及している。
  for (const op of ["add_function", "update_function", "remove_function"]) {
    expect(VOCABULARY_SCOPE).toContain(op);
  }
});

test("V1-M2-T07 / V3-M1-T06: VOCABULARY_SCOPE の危険度の説明が5群すべてに言及している", () => {
  // ADR-0012 が2分法 → 3分法にし、ADR-0013 §10 項目4 が3分法 → 4分法にした。
  // **V3-M1-T06(ADR-0047): `set_theme` が5群目になって 4分法 → 5分法になった** ——
  // `set_theme` は既存4群のどれにも属さない(定義もデータも消さないが、ビューの表示設定でもなく、
  // 適用後に動き続けるものでもない)。**4群のままだと、どの群にも属さない op が列挙だけされる。**
  // **3群 / 4群に戻ると、AI は add_workflow を add_field と同じ軽さで扱う(または set_theme を見失う)。**
  // **【`V5-M17b` / `ADR-0248`】5群 → 6群。** **旧行の逐語は
  // `expect(VOCABULARY_SCOPE).toContain("差分操作は5つに分かれます");` である。**
  // **`set_user_kinds` は既存5群のどれにも属さない**(定義もデータも消さず、画面の
  // 表示設定でもなく、適用後に動き続けるものでもなく、見た目でもない)。
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】6群 → 7群。****旧行の逐語は
  // `expect(VOCABULARY_SCOPE).toContain("差分操作は6つに分かれます");` である。**
  // **`set_roles` は既存6群のどれにも属さない**(定義もデータも消さず、画面の表示設定でも、
  // 適用後に動き続けるものでも、見た目でも、利用者の種類の宣言でもない)。検査は消していない。
  expect(VOCABULARY_SCOPE).toContain("差分操作は7つに分かれます");
  expect(VOCABULARY_SCOPE).not.toContain("差分操作は5つに分かれます");
  expect(VOCABULARY_SCOPE).not.toContain("差分操作は4つに分かれます");
  expect(VOCABULARY_SCOPE).not.toContain("差分操作は3つに分かれます");
  // (1) 足すだけ / (2) 画面の定義だけを消す / (3) 定義とデータを変える / (4) 自動化 / (5) 見た目 / (6) 利用者の種類。
  expect(VOCABULARY_SCOPE).toContain("新しい定義を足すだけ");
  expect(VOCABULARY_SCOPE).toContain("画面の定義だけを消します");
  expect(VOCABULARY_SCOPE).toContain("既存の定義とデータを実際に変更・削除します");
  expect(VOCABULARY_SCOPE).toContain("自動化(ワークフロー)の定義");
  expect(VOCABULARY_SCOPE).toContain("アプリの見た目(テーマ)を差し替えます");
  // 4群目の性質(適用後も動き続ける / remove しても書かれた行は残る)を述べていること。
  expect(VOCABULARY_SCOPE).toContain("適用が終わったあとも動き続けます");
  expect(VOCABULARY_SCOPE).toContain("既に書いた行も実行履歴も残ります");
  // 5群目の性質(データを失わない = undo で戻せる)を述べていること。
  expect(VOCABULARY_SCOPE).toContain("undo で前のテーマに戻せます");
  // **6群目**(`V5-M17b` / `ADR-0248`)—— 見出しと、性質(全体差し替え / 戻す手段が無い)。
  expect(VOCABULARY_SCOPE).toContain("このアプリが扱う「利用者の種類」の宣言を差し替えます");
  expect(VOCABULARY_SCOPE).toContain("undo で前の宣言に戻せます");
  expect(VOCABULARY_SCOPE).toContain("宣言を「無い状態」へ戻す手段はありません");
});

test("V1-M2-T07: 破壊的フローはワークフロー3 op に5段ではなく1段の同意を課す", () => {
  // ADR-0013 §10 項目5。**5段には加えない**(元に戻せる)が、
  // **確認不要にもしない**(適用後に動き続ける / 静かに止まる)。
  // 破壊的 op の名指しは4つのままであることも同時に固定する。
  expect(DESTRUCTIVE_CHANGE_FLOW).toContain(
    "破壊的な op は remove_field / remove_table / change_table / change_field の4つです",
  );
  for (const op of ["add_workflow", "update_workflow", "remove_workflow"]) {
    expect(DESTRUCTIVE_CHANGE_FLOW).toContain(op);
  }
  expect(DESTRUCTIVE_CHANGE_FLOW).toContain(
    "何がいつ動くようになるか/動かなくなるかを名指しで伝え、同意を得てください",
  );
  // `DELETE_RECORD_SHOW_TARGET_FIRST` と同じ設計判断(フラグ引数を置かない)を保つ。
  expect(DESTRUCTIVE_CHANGE_FLOW).toContain("confirm のようなフラグ引数はありません");
  // 「今までの分も消える」という嘘を禁じていること(remove_workflow は行を消さない)。
  expect(DESTRUCTIVE_CHANGE_FLOW).toContain(
    "既に書かれた行と実行履歴は残るので、「今までの分も消えます」と説明してはいけません",
  );
});

// **配送の確認は `descriptions.test.ts` にある。**この1段は新しい export 定数ではなく
// `DESTRUCTIVE_CHANGE_FLOW` の末尾に置いたので、同ファイルの既存4テスト
// (apply_diff / dry_run_diff / undo の description + サーバの instructions が
// **定数そのもの**を含むこと)が、そのまま「届いていること」の歯止めになる。
// **新しい定数を作っていれば、その4本の配線をやり直す必要があった。**

test("OUT_OF_SCOPE_BEHAVIOR は正直な拒否と代替案提示の両方を指示している", () => {
  expect(OUT_OF_SCOPE_BEHAVIOR).toContain("できない");
  expect(OUT_OF_SCOPE_BEHAVIOR).toContain("代替案");
});

/**
 * **`V6-M12-T01`(`H-G11` / `ADR-0287`)で、既定の貼り付け内容が変わった。**
 *
 * **2026-08-07 まで、このテストは「describeTool はツール固有の説明に3要素をすべて追記する」
 * だった。** **`H-G11` は貼る先を1本も減らさずに貼る中身だけを差し替えたので、
 * 検査も「何を貼るか」の側を差し替える。**
 *
 * **【期待値を緩めていない】** R12(エクスポート定数そのものを照合する)は保っている。
 * **さらに1点強くした** —— **既定モードで3定数が貼られて**いない**ことも見る。**
 * ここが緩むと、複写が黙って戻っても赤くならない。
 *
 * ## **`V10-M21-T01`(`FU-G14`)で、既定が貼る「誘導」が別の定数になった。上は1バイトも消していない**
 *
 * **上の doc が書いている「入口と誘導(`SKILL_GUIDE`)」の後半は、2026-08-21 以降は偽である。**
 * **今日の既定が貼るのは `VOCABULARY_ENTRY_POINT` と `SKILL_POINTER`(66文字)であり、
 * `SKILL_GUIDE`(321文字)は `withFullVocabulary` を渡した1本にしか載らない。**
 * **貼る先は今日も1本も減っていない**(`H-G11` 限定2 の「貼る中身を差し替えるだけ」)。
 * **ここでも1点強くした** —— **既定モードで `SKILL_GUIDE` が貼られて**いない**ことを見る。**
 */
test("describeTool は既定でツール固有の説明に入口と短い誘導を追記する(誘導の全文も3定数も貼らない)", () => {
  const description = describeTool("テスト用のツール説明。");
  expect(description).toContain("テスト用のツール説明。");
  // R12: 部分文字列の勘ではなく、エクスポート定数そのものが含まれることを見る。
  expect(description).toContain(VOCABULARY_ENTRY_POINT);
  expect(description).toContain(SKILL_POINTER);
  // **`FU-G14` が浮かせた原資が黙って消えるのを、ここで止める。**
  expect(description).not.toContain(SKILL_GUIDE);
  // **複写の再発をここで止める。**
  expect(description).not.toContain(VOCABULARY_SCOPE);
  expect(description).not.toContain(CANNOT_DO);
  expect(description).not.toContain(OUT_OF_SCOPE_BEHAVIOR);
});

test("describeTool は withFullVocabulary を渡したときだけ3定数の全文を追記する", () => {
  // **`H-G12` の限定2 の到達性**: 説明書(skill)を読めないクライアントのために、
  // `tools/list` の中に全文が必ず1本は在る状態を作る。その入口がこの引数である。
  const description = describeTool("テスト用のツール説明。", { withFullVocabulary: true });
  expect(description).toContain("テスト用のツール説明。");
  expect(description).toContain(VOCABULARY_SCOPE);
  expect(description).toContain(CANNOT_DO);
  expect(description).toContain(OUT_OF_SCOPE_BEHAVIOR);
  // 誘導は全文を貼る側にも載せる(説明書の存在は、全文を読んだ AI にも伝えたい)。
  expect(description).toContain(SKILL_GUIDE);
  // **`V10-M21-T01`(`FU-G14`)で足した**: 全文分岐は短い誘導(`SKILL_POINTER`)を貼らない。
  // 両方貼ると、この1本だけが同じ趣旨の文を二重に持つ(= 畳んだはずの複写が1本ぶん戻る)。
  expect(description).not.toContain(SKILL_POINTER);
});

test("V6-M12-T01: 入口は語彙の名前の全量を持ち、貼る量は全文より小さい", () => {
  // **これは上限検査ではない**(上限検査は `H-G14` = `V6-M13-T02` が別に置く)。
  // **ここで見るのは「差し替えた結果が、差し替え前より確かに小さい」という事実だけ**で、
  // 数値の閾値を1つも置いていない。**比べているのは実物どうしである。**
  expect(describeTool("").length).toBeLessThan(
    describeTool("", { withFullVocabulary: true }).length,
  );
  // 入口は語彙の**名前の全量**を持つ(件数だけに丸めていない)。
  for (const name of [...RESOURCE_KINDS, ...FIELD_TYPES, ...DIFF_OPS]) {
    expect(VOCABULARY_ENTRY_POINT, name).toContain(name);
  }
});

test("V6-M12-T03: CANNOT_DO_INDEX は CANNOT_DO の見出しを機械的に引き写している", () => {
  const headings = CANNOT_DO.match(/【[^】]+】/g) ?? [];
  // 見出しが1つも取れない書式になったら、この検査が先に赤くなる。
  expect(headings.length).toBeGreaterThan(0);
  for (const heading of headings) {
    expect(CANNOT_DO_INDEX, heading).toContain(heading);
  }
  // **本文は載せない**(載せたら `H-G12` の目的が消える)。
  expect(CANNOT_DO_INDEX).not.toContain(CANNOT_DO);
  // **「ここに書いていない = できる」と読ませないための一文が在る**(憲法6)。
  expect(CANNOT_DO_INDEX).toContain("ここに書いていないことを「できる」と読まないでください");
});

test("V6-M12-T01: UPDATE_VIEW_ACCEPTED_KEYS は VOCABULARY_SCOPE の描画を1バイトも変えていない", () => {
  // **`H-G12` の限定5**: 列挙を消さない・件数に丸めない。
  expect(VOCABULARY_SCOPE).toContain(
    `${UPDATE_VIEW_ACCEPTED_KEYS.join(" / ")} の${UPDATE_VIEW_ACCEPTED_KEYS.length}キーだけ`,
  );
  // 切り出し前の逐語(切り出し前の `src/mcp/vocabulary.ts:136`)がそのまま在ることを、
  // 字面でも押さえる。**逐語が1文字でも動いたらここが赤くなる。**
  // **【`V6-M2-T04` / `K-G3` / `ADR-0289` 限定1 で末尾に1キー足した】** 24キー目
  // `reference_pickers` と「24キーだけ」への更新である。**足したのは列挙の末尾1語と
  // 件数だけで、文の形は1バイトも変えていない。****件数に丸めていない。**
  // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` §4a 限定2 で末尾にもう1キー足した】**
  // **25キー目 `after_delete`(削除が成立したあとの行き先。`detail_view` にだけ書ける)と
  // 「25キーだけ」への更新である。****足したのは列挙の末尾1語と件数だけで、文の形は
  // 1バイトも変えていない。****件数に丸めていない。**
  // **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` §4b 限定1 で末尾にもう1キー足した】**
  // **26キー目 `flow`(一続きの流れの中の段。`list_view` / `form` / `detail_view` の
  // 3種別に書ける)と「26キーだけ」への更新である。****足したのは列挙の末尾1語と件数
  // だけで、文の形は1バイトも変えていない。****件数に丸めていない。**
  expect(VOCABULARY_SCOPE).toContain(
    "update_view は既存ビューの表示名・表示設定(name / columns / sort / filter / fields / preset_column_align / preset_column_width / preset_pager_position / preset_label_placement / preset_field_columns / preset_image_size / preset_text_preview / preset_list_shape / custom_css / menu_listed / field_groups / modal / search_fields / page_size / preset_density / after_save / sum_field / actions / reference_pickers / after_delete / flow の26キーだけ)",
  );
  // 重複が無い(同じキーを2度書いていない)。
  expect(new Set(UPDATE_VIEW_ACCEPTED_KEYS).size).toBe(UPDATE_VIEW_ACCEPTED_KEYS.length);
});

// --- システムテーブル(ADR-0006 §10)------------------------------------------------

test("VOCABULARY_SCOPE はシステムテーブル2つを名指しで説明している", () => {
  for (const id of SYSTEM_TABLE_IDS) {
    expect(VOCABULARY_SCOPE).toContain(id);
  }
  expect(VOCABULARY_SCOPE).toContain("読み取り専用");
  // list_view / detail_view からは見えるが form は作れない(ADR-0006 §8 L2)。
  expect(VOCABULARY_SCOPE).toContain("form");
});

test("VOCABULARY_SCOPE は _changelog が apply_diff 経由の変更しか含まないと断っている", () => {
  // ここを書かないと、画面が「全変更履歴」に見えて嘘になる(ADR-0006 Consequences)。
  expect(VOCABULARY_SCOPE).toContain("apply_diff 経由");
});

test("VOCABULARY_SCOPE は create_app によるアプリ作成を例外として断っている(V1-M0-T05)", () => {
  // F-36: この文は AI の口を通してユーザに伝わることが実測されている。
  // create_app が第0行を書くようになった以上、断り書きを正確にしないと
  // AI が不正確な説明をユーザにする(ADR-0007 Δ5)。
  expect(VOCABULARY_SCOPE).toContain("create_app");
  // 本体の警告(それ以外の経路は記録されない)は弱めない。
  expect(VOCABULARY_SCOPE).toContain("それ以外の経路で入った変更は記録されない");
});

// --- V1-M2-T02: 実行履歴テーブルの列の規約(ADR-0013 §8c 問4 / §8d)--------------------
//
// **この規約の在処はツール説明文しかない。**カーネルは履歴テーブルを1つも自動生成せず
// (限定8)、参照整合性が保証するのも「テーブルが実在すること」だけである(§8d 限界1)。
// **したがって定数の中身が薄れることは、規約が消えることと同じである。**
//
// ここは文字列としての中身を見る。**「ひな形どおりに作れば実際に動く」ことの検証は
// `tools/write.test.ts` にあり**(ひな形の JSON を apply_diff へ流し、そのテーブルへ
// ワークフローが履歴を書けることまで見る)、**列IDと型の実装との一致はそちらが本命**である。

test("WORKFLOW_HISTORY_TABLE_TEMPLATE は5列すべてを列IDと型の組で書いている", () => {
  // **手書きの複製である。**`src/kernel/workflow-runner.ts` の
  // `WORKFLOW_HISTORY_COLUMNS` を値として import していない(ADR-0009 限定2 の
  // import スナップショットを増やさないため。`descriptions.test.ts:232-236` の方針)。
  // **`WORKFLOW_HISTORY_COLUMNS` を変えたら、ここと定数の両方に追随が要る。**
  const columns: [string, string][] = [
    ["ran_at", "date"],
    ["workflow", "text"],
    ["trigger_type", "text"],
    ["status", "text"],
    ["error", "long_text"],
  ];
  expect(columns).toHaveLength(5);
  for (const [id, type] of columns) {
    expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain(`"id": "${id}"`);
    expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain(`"${id}", "name"`);
    expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain(`"type": "${type}" }`);
  }
});

test("WORKFLOW_HISTORY_TABLE_TEMPLATE は status / trigger_type に select を使うなと書き、理由も書いている", () => {
  // **AI が最も踏みやすい罠である。**`select` は options と1文字でも違えば
  // 書き込みが弾かれ(`src/kernel/records.ts:311-325`)、**その失敗を書く先が
  // また同じ列**なので、失敗がどこにも残らない循環が起きる。
  // 「使うな」だけ書いて理由を落とすと、AI は「見た目が良いから」と外挿して破る。
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain(
    "**status と trigger_type に select 型を使ってはいけません。**",
  );
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("1文字違うだけで書き込みが弾かれます");
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("**その失敗の記録自体がどこにも残りません。**");
});

test("WORKFLOW_HISTORY_TABLE_TEMPLATE は all-or-nothing だと書いている", () => {
  // 「書ける列だけ書く」ではない(`workflow-runner.ts` の `writeHistory` の実装)。
  // 1列でも欠ければ `validateInput` が拒否し、行は1つも書かれない。
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain(
    "**列が1つでも足りないと、履歴は1行も書かれません。**",
  );
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("all-or-nothing");
  // 最も知りたい1行だけが落ちる、という壊れ方まで書く(憲法6)。
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("最初の失敗が起きた瞬間");
});

// ---------------------------------------------------------------------------
// V1-M2-T08 単位2: schedule が「実装されていない」という嘘の復活を止める
//
// **T08 完了の瞬間に「schedule トリガーの発火はまだ実装されていません」は嘘になる。**
// T07 が CANNOT_DO に置いた歯止めと同じ形で、**双方向に**固定する ——
// 片方向だけだと逆向きの嘘(「schedule は何でもできる」)に倒れる。
// ---------------------------------------------------------------------------

test("V1-M2-T08: WORKFLOW_HISTORY_TABLE_TEMPLATE は schedule が未実装だと言っていない", () => {
  // **文言そのものを禁止しておかないと、将来の編集で静かに戻ってくる。**
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).not.toContain(
    "schedule トリガーの発火はまだ実装されていません",
  );
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).not.toContain("まだ実装されていません");
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).not.toContain("将来 schedule が加わっても");
  // trigger_type に実際に書かれる値が3種であることを述べている。
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("on_create / on_update / schedule");
});

test("V1-M2-T08: WORKFLOW_HISTORY_TABLE_TEMPLATE は schedule の代償を隠していない", () => {
  // 逆向きの嘘の歯止め。**発火済み判定が履歴テーブルにしか無い**ことの帰結を
  // AI に伝えないと、「古い履歴を消す」提案が二重発火を生む(ADR-0013 §6c 代償2)。
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("この履歴テーブルを読んで行われます");
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain(
    "**履歴の行を delete_record で消すと、その日のうちに二重に発火します。**",
  );
  // 停止中に到来した発火の扱い(T08 判断2)。**取り戻さないことを書く。**
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("日をまたいだ分は失われ");
  // タイムゾーンはマニフェストに書けない(判断1。スキーマを1バイトも増やしていない)。
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("**マニフェストにタイムゾーンは書けません。**");
});

test("WORKFLOW_HISTORY_TABLE_TEMPLATE は add_workflow と同じ差分で add_table せよと書いている", () => {
  // ADR-0013 限定8: **カーネルはテーブルを1つも自動生成しない。**
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("**カーネルはこのテーブルを作りません。**");
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("同じ差分の中で add_table して");
});

/**
 * 【V1-M2-T05a で主張が反転した。元のテストの意図は残してある。】
 *
 * このテストはもともと **§8d 限界1(「列構成は誰も検査しない」)を説明文が
 * 隠していないこと**を固定していた。**D1 でその限界が閉じたので、
 * 同じ assertion を残すことは「もう真でないことを説明文に書かせ続ける」ことになる。**
 *
 * **限界の申告を消したのではなく、限界そのものが無くなった。**
 * したがってここでは**反転した主張**を同じ強さで固定する ——
 * 「検査されない」と書いていないこと(古い嘘が残らないこと)と、
 * 「差分の適用時に検査される」と書いていること(新しい事実が届いていること)。
 *
 * **もし D1 の検査を将来外すなら、このテストは再び反転させなければならない。**
 * 説明文とカーネルの実装が食い違ったら、AI は説明文ではなく実際の挙動に従い、
 * その食い違いは誰にも見えないまま残る(T05 で実測されたとおりである)。
 */
test("WORKFLOW_HISTORY_TABLE_TEMPLATE は §8d 限界1 が閉じたことを反映している", () => {
  // 古い申告が1つも残っていないこと。
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).not.toContain(
    "**この規約が守られているかを機械的に検査する仕組みはありません。**",
  );
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).not.toContain("「history_table が実在すること」だけ");
  // 新しい事実が書かれていること。
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("差分の適用時に検査されます");
  // **「なぜこうなったか」を残す。**規約が守られなかったときに何が起きるのかを
  // AI が知らないまま「検査があるから安心」と外挿しないため。
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("履歴が1行も残らず");
});

test("WORKFLOW_HISTORY_TABLE_TEMPLATE は既存の配送経路(APPLY_DIFF_OP_EXAMPLES)に載っている", () => {
  // **新しい配線を1本も足していないことの機械的な確認。**
  // `server.ts` の join にも registerTool にも手を入れていないので、
  // 「書いたが誰にも渡っていない定数」にならないためには、既に届いている
  // 文字列の一部であることが必要十分である。
  // **実際に tools/list まで届くことの確認は `descriptions.test.ts` にある。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(WORKFLOW_HISTORY_TABLE_TEMPLATE);
});

// ---------------------------------------------------------------------------
// V1-M2-T05 単位A: アクションが boolean / number / date に書けないことの歯止め
//
// **T04 が実測で発見した限界であり、ADR にも説明文にも1行も書かれていなかった。**
// `schemas/manifest.schema.json` の `$defs/action_value` が `"type": "string"` で
// 閉じている(ADR-0013 限定12)ことの帰結である。経路は2つあり、**危険なのは後者**:
//   1. JSON で `true` / `3` と書く → スキーマが差分ごと拒否する(作れない)
//   2. 文字列で `"true"` / `"3"` と書く → **差分は通るが実行時に弾かれる**
// 経路2 は「通ったから動く」という誤解を生むので、双方向に固定する ——
// 片方向(「書けません」)だけだと、AI は文字列という逃げ道を自分で発明する。
// ---------------------------------------------------------------------------

test("V1-M2-T05: APPLY_DIFF_OP_EXAMPLES は values が文字列型に閉じていることを書いている", () => {
  // 経路1。**スキーマが拒否する**ことを名指しする。
  // **T05c 追補で `date` を外した。**T04 が実測したのは boolean と number だけで、
  // `date` は誰も試さないまま「書けない」側に数えられていた(下の追補ブロック参照)。
  // **V1-M9-T13 (2) で「一切書けない」という過剰宣言を「型が合う値だけ書ける」へ精密化した。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "boolean 列に書けるのは boolean 型の値だけ、number 列に書けるのは number 型の値だけ",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "型が合わない値は適用時に拒否され、型が合う値だけが書ける",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("true や 3 とそのまま書くと");
  expect(APPLY_DIFF_OP_EXAMPLES).toMatch(/差分ごと拒否される/);
});

// ---------------------------------------------------------------------------
// V1-M2-T05c 追補: **`date` についての嘘**の歯止め(双方向)
//
// ## 経緯 —— 実測されていない主張が2世代引き継がれた
//
// - **T04 が実測したのは `boolean` と `number` の2つだけ**である。
// - **`date` は誰も試していない。**それを T05 単位A が「boolean / number / date」と
//   3つに広げて書き、この定数(`vocabulary.ts`)と
//   `src/kernel/ajv-error-adapter.ts` の hint の両方に載せた。
// - **T05c 件1 は `select` の嘘だけを直し、`date` の記述は従来のまま維持した。**
//   T05c 記録 §4-2 が「`date` はいまも未検証」と自分で申告している。
// - 2世代あとの追補で、ようやく実測された。**嘘だった。**
//
// ## 実測(実カーネル + 実 SQLite。推測ではない)
//
//   date 列に "2026-07-20"                 → 受理
//   date 列に "2026-07-20T10:00:00.000Z"   → 受理
//   date 列に "$record.<date フィールド>"   → 受理(他の日付列から写せる)
//   date 列に "きのう"                      → 実行時に拒否
//     履歴 error: フィールド "d" の値 "きのう" は ISO8601 形式の日付ではありません。
//
// **`date` は `select` と同じ形の話**である ——「書けるが、値の形が合っていないと
// 実行時に弾かれる」。**2つを1つの規則としてまとめて説明する**(AI が覚える規則を
// 増やさないため)。したがって以下は date と select を同じ検査で固定する。
// ---------------------------------------------------------------------------

test("V1-M2-T05c: APPLY_DIFF_OP_EXAMPLES は date に書けないという嘘を書いていない", () => {
  // 旧文面そのもの。復活したら赤にする。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain(
    "**boolean / number / date 型の列に値を書けません。**",
  );
  // 言い回しを変えた同じ嘘も塞ぐ:date を「書けない」側に並べない。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toMatch(/date[^。]*型の列に値を書けません/);
  expect(APPLY_DIFF_OP_EXAMPLES).not.toMatch(/date[^。]*列には、ワークフローから値を書けません/);
});

test("V1-M2-T05c: APPLY_DIFF_OP_EXAMPLES は date / select に書けること、形が合う値に限ることを言う", () => {
  // 「書ける」側の事実。
  expect(APPLY_DIFF_OP_EXAMPLES).toMatch(/date \/ select[^。]*書けます/);
  // date の条件は ISO8601 形式であること(実例つき)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("ISO8601");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("2026-07-20");
  // select の条件は options に一致すること(T05c 件1 の事実。壊さない)。
  expect(APPLY_DIFF_OP_EXAMPLES).toMatch(/options[^。]*一致/);
  // $record.<日付フィールド> で他の日付列から写せること(実測済み)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("$record.<日付フィールド>");
  // **boolean / number の文字列逃げ道と同じ壊れ方**であること(差分は通る → 実行時に弾かれる)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("形がずれると差分は通り");
  expect(APPLY_DIFF_OP_EXAMPLES).toMatch(/実行時[^。]*弾かれ/);
});

test("V1-M2-T05 / V1-M9-T13 (2): APPLY_DIFF_OP_EXAMPLES は文字列の逃げ道が適用時に塞がれることを書いている", () => {
  // **V1-M9-T13 (2) で経路2(文字列の逃げ道)も適用時に塞いだ。**
  // 以前は「差分は通るが実行時に弾かれる」だったが、いまは型不整合として
  // 適用時に拒否される。旧文言(「差分は通ります」)が残ると逆に嘘になるので、
  // 新しい事実を固定する。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain('"true" や "3" のように文字列で書くと');
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("その差分は適用時に拒否されます");
  // 旧文言(実行時まで通ってしまう)が復活したら赤にする。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain(
    '"true" や "3" のように文字列で書くと差分は通ります',
  );
  // 型が合う参照なら書けるという正しい行き先を示していること。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("$record.<boolean 列>");
});

test("V1-M2-T05 / V1-M9-T13 (2): APPLY_DIFF_OP_EXAMPLES は代わりにできることを書いている", () => {
  // 「できません」で終わらせない。**V1-M9-T13 (2) 以降は行き先が2つある** ——
  // (1) 型が合う値なら boolean/number 列にも書ける($record.<同型の列>)、
  // (2) 固定値でやりたいなら text 列に書く。最も踏みやすい具体例(既読フラグ)を残す。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("boolean 列ではなく text 列");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("$record.<boolean 列>");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("既読フラグ");
});

// ---------------------------------------------------------------------------
// V1-M2-T05a D2: `$record.` 以外の記法は「置換されずにそのまま書き込まれる」
//
// **これは直せなかった欠陥の申告である。**`$defs/action_value` は `$` で始まらない
// 文字列をリテラルとして受理するので、`{{record.name}}` のような口ひげ記法は
// **その文字列がそのままレコードに書き込まれる。**差分検証もカーネルも警告を出さない。
// 制約を足すにはスキーマの変更(門A 審査)が要るため、T05a では説明文で手当てする。
//
// **実地で3試行中3試行が踏んだ**(証跡 `docs/evidence/cp-v1-2/transcripts/001..003`。
// 003 の受付記録には `room_name: "{{record.room_name}}"` という行が実在する)。
// **「こう書けます」ではなく「こう間違えた」を書く**のが効く、という判断で書いている。
// ---------------------------------------------------------------------------

test("V1-M2-T05a: 口ひげ記法そのものを字面で示している(記法の名指しは残す)", () => {
  // 誤った記法そのものを字面で示す。**抽象的な「他の記法」では届かない。**
  // **T05e で結末だけが変わった**(黙って書き込まれる → 差分ごと拒否される)。
  // 名指しする、という T05a の判断そのものは正しかったので残す。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("{{record.name}}");
});

test("V1-M2-T05a: 警告は『実地で3回起きた』という事実を伴っている", () => {
  // **一般論にしない。**実測の事実が入っていること。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("3試行すべて");
});

// ---------------------------------------------------------------------------
// V1-M2-T05e / T05d 完了条件7: **T05a の説明文は、T05e によって嘘になった**
//
// T05a が書いた「**エラーになりません**」「**そのままレコードに書き込まれます**」
// 「**$ で始まらない文字列はすべてリテラル(固定文字列)として扱われる**」は、
// `$defs/action_value` に `else: {"pattern": "^[^{}]*$"}` が入った今、**すべて偽である。**
//
// **T05c が確立した規律**:「実装より狭い/広い限界を宣言することも嘘である。」
// **古い限界申告を残すことは、嘘を教えることと同じである(憲法6)。**
// 直さないと、T05c が2件直した「実装と食い違う説明文」の3件目を自分で作ることになる。
//
// 以下は双方向の歯止め ——(a) 嘘が戻らない /(b) 新しい事実が消えない /
// (c) **直したことで新しい嘘を作っていない**(完了条件7 の後段)。
// ---------------------------------------------------------------------------

test("V1-M2-T05e (a): 『エラーにならない / 黙って書き込まれる』という嘘が戻っていない", () => {
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("エラーになりません");
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("そのままレコードに書き込まれます");
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("静かに積まれていきます");
});

test("V1-M2-T05e (a): 『$ で始まらない文字列はすべてリテラル』という嘘が戻っていない", () => {
  // **これが T05d §8-3 / 完了条件7 が名指しした1文である。**
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain(
    "$ で始まらない文字列はすべてリテラル(固定文字列)として扱われる",
  );
});

test("V1-M2-T05e (b): 口ひげ記法は差分ごと拒否される、という新しい事実を書いている", () => {
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("拒否されます");
});

test("V1-M2-T05e (b): 正しい形($record.<フィールドID> と $record._id)を字面で示している", () => {
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("$record.<フィールドID>");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("$record._id");
});

test("V1-M2-T05e (b): 連結できないことを書いている(D2-b は保留のままである)", () => {
  // **T05d §8-2 の代償。**「壊れる」が「できない」に変わっただけで、要求は残っている。
  // ここを書かないと、AI は連結を試み、拒否され、理由が分からないまま
  // 「誰の申し込みか載せる手段は無い」の誤った断定へ戻る(実測 2/6)。
  expect(APPLY_DIFF_OP_EXAMPLES).toMatch(/つなげ|連結/);
});

test("V1-M2-T05e (c): 新しい嘘を作っていない —— 波括弧を外せ、とは書いていない", () => {
  // 従うと `record.name` になり、**それはリテラルとして通り、黙って書き込まれる。**
  expect(APPLY_DIFF_OP_EXAMPLES).not.toMatch(/波括弧を(外し|取り除い|削除し)て(ください|下さい)/);
});

test("V1-M2-T05e (c): 新しい嘘を作っていない —— 波括弧以外の記法まで拒否すると言っていない", () => {
  // **限定13: 拒否するのは `{` と `}` の2文字だけである。**
  // 「テンプレート記法は全部だめ」と書くと、実装より**広い**限界の宣言になり、
  // それも嘘である(T05c の規律)。`<%= %>` や `%...%` は今日も通る。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("テンプレート記法はすべて");
});

// ---------------------------------------------------------------------------
// V1-M2-T05a D1: 履歴テーブルの列は**機械的に検査されるようになった**
//
// `WORKFLOW_HISTORY_TABLE_TEMPLATE` は長らく「この規約が守られているかを機械的に
// 検査する仕組みはありません」「参照整合性が保証するのは history_table が実在する
// ことだけ」と書いていた。**D1 でこれは事実でなくなった。**
// **説明文に古い限界申告が残るのは、嘘を教えることと同じである(憲法6)。**
// ---------------------------------------------------------------------------

test("V1-M2-T05a: 履歴テーブルのひな形は『検査されない』という古い申告を残していない", () => {
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).not.toContain("機械的に検査する仕組みはありません");
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).not.toContain(
    "「そのテーブルが正しい形をしていること」は保証しません",
  );
});

test("V1-M2-T05a: 履歴テーブルのひな形は、列が違うと差分が拒否されると書いている", () => {
  // **「書かないと動かない」から「書かないと作れない」へ意味が変わった。**
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("差分が拒否されます");
});

test("V1-M2-T05a: 列を**足す**のは今でも許されることを書いている(検査の強さの申告)", () => {
  // 検査は「ちょうど5列」ではなく「少なくとも5列」である。
  // ここを書かないと、AI は add_field で足した列を消しに行く。
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("足す");
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("add_field");
});

// --- V2-M3-T05: 計算・条件・制約(EC-G5 / G6 / G8)が入った(ADR-0036/0037/0038。Δ5)-----
//
// **T01 で when(条件分岐)/ T02 で write_back(run_function の record 書き戻し=Route B)/
// T03 で unique(一意制約)が正準スキーマ(schemas/manifest.schema.json)に入った。**
// 説明文(vocabulary.ts)が実装と食い違ったら落ちる**双方向の歯止め**を置く
// (V2-M2-T05 / V2-M1-T06 / M3-T02 と同型。片方向だけだと逆向きの嘘に倒れる)。
// 実装の真は正準スキーマそのものを読んで固定する(`workflow-schema.test.ts` と同じ作法。
// DIFF_OPS 等のように kernel から import すると ADR-0009 限定2 の import スナップショットが
// 増えるので、ここは JSON を直読みする)。

// biome-ignore lint/suspicious/noExplicitAny: 正準スキーマの構造を動的に辿るため
type Any = any;

/** 正準スキーマ(実装の真)を読む。`workflow-schema.test.ts` の canonicalSchema と同型。 */
function manifestSchema(): Any {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"), "utf-8"),
  ) as Any;
}

test("V2-M3-T05: schema に when がある ⇔ 説明文が when(最小述語・演算子/論理結合なし)を述べる(EC-G5)", () => {
  // 実装の真: T01 で workflow_action に when が入った。無くなれば(記述だけ残れば)ここが落ちる。
  const when = manifestSchema().$defs.workflow_action.properties.when;
  expect(when).toBeDefined();
  // 実装→記述: when がある以上、説明文が when と最小述語1形 {field, equals} を述べる。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("when(実行条件)");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("{field, equals}");
  // **演算子・論理結合を作っていないことの明記**(ADR-0036 §3 限定1。ここが Δ5 の核心)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "比較(lt/gt/lte/gte)・論理結合(and/or)・else・ネスト・条件式は1つも書けない",
  );
  // skip が履歴に loud に残る(黙って何もしないワークフローにしない。憲法6)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("スキップは実行履歴に loud に残る");
  /*
   * schedule × when は apply 時拒否(fail-closed)。
   *
   * 【V3-M10-T01 / `D-G16a` / ADR-0063 限定8 で期待値を更新した。検査は消していない】
   * - **更新前**: `"schedule トリガー(トリガー元レコードが無い)に when を付けると apply 時に拒否される"`
   * - **更新後**: 下の2本(`table` の無い schedule では今日どおり拒否される / `table` が
   *   在れば書ける)。**拒否の記述を消したのではなく、拒否が当たる条件を書き足した。**
   */
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "table を書かない schedule トリガー(トリガー元レコードが無い)に when を付けると apply 時に拒否される",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("table を書いた schedule では when を書ける");
});

/*
 * V3-M10-T01(`D-G16a`。ADR-0063 限定8)—— **双方向の歯止め**。
 *
 * 限定8 が課したのは「実装後に嘘になる記述を書き換える」ことである。片方向だけだと
 * 逆向きの嘘(「schedule は何でもできる」)に倒れるので、**実装→記述**と
 * **記述→実装**を対で置く(`V1-M2-T08` の schedule の前例と同型)。
 *
 * **(c) の沈黙**(`VOCABULARY_SCOPE` / `CANNOT_DO` が `schedule` × `$record.` の
 * 制限を1文字も述べていないこと)を射程に入れるか否かの判定は **T05** の仕事である
 * (`v3-m10.md` §2a-5 / §2-0b 2)。**T01 はここでその判定を先取りしない。**
 */
test("V3-M10-T01: schema が schedule × table を許す ⇔ 説明文が「table は書けない」と言っていない(ADR-0063 限定8)", () => {
  // 実装の真: `allOf` の schedule 分岐から `"table": false` が消えている。
  const trigger = manifestSchema().$defs.workflow_trigger as Any;
  const scheduleBranch = (trigger.allOf as Any[]).find(
    (branch) => branch.if.properties.type.const === "schedule",
  ) as Any;
  expect(scheduleBranch.then.properties?.table).toBeUndefined();

  // 実装 → 記述: 「table は書けない」は**嘘になった**ので、1件も残っていない。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("毎日その時刻に1回)が必須(table は書けない)");
  // 記述 → 実装: 行を対象にできることと、その上限が述べられている。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("table を書くとその表の行を1件ずつ処理する");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("1回の発火で処理できるのは 1000 行まで");
  // **「毎日1回」は変わっていない**(ADR-0063 限定2。cron / 曜日 / 間隔は0件のまま)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("cron 式や曜日・月・「5分ごと」の指定は無い");
});

// **【V3-M13-T09 による期待値の更新】** **`write_back` 側の主張は1つも落としていない** ——
// 落としたのは「モードは2つ」という数え上げだけであり、**3つ目(`write_ops`。ADR-0067 =
// 門A 本審査4回目の限定採用)が入ったことで説明文の側の逐語が変わった。**
// **実装の誤りではなく、門A を通った増分の反映である。**
test("V2-M3-T05 / V3-M13-T09: schema に write_back / write_ops がある ⇔ 説明文が run_function の3モードを述べる(EC-G6 / D-G15)", () => {
  // 実装の真: T02 で run_function に write_back(const "$record")が入った。
  const writeBack = manifestSchema().$defs.workflow_action.properties.write_back;
  expect(writeBack).toBeDefined();
  // 固定形 "$record" のみ = 別テーブル・別行を指せない(クロス行更新は M4)。
  expect(writeBack.const).toBe("$record");
  // 実装→記述: 2モード(output_table 全置換 / write_back 書き戻し)が述べられている。
  expect(VOCABULARY_SCOPE).toContain("トリガー元レコード自身への書き戻し");
  expect(VOCABULARY_SCOPE).toContain("write_back");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("run_function には3つのモードがあり排他である");
  // 第3のモード(ADR-0067)。**実装(schema の write_ops)と説明文が両向きで一致すること。**
  const writeOps = manifestSchema().$defs.workflow_action.properties.write_ops;
  expect(writeOps.const).toBe(true);
  expect(VOCABULARY_SCOPE).toContain("島が返した更新操作の配列をそのまま適用する");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain('"write_ops": true');
  // **できないことの側も対で書かれている**(限定 A11: apply 時の検査が op に及ばない)。
  expect(VOCABULARY_SCOPE).toContain("この op には差分適用時(apply)の事前検査が1つも効きません");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("write_ops の op には apply 時の検査が1つも効かない");
  // output_table 全置換モードの記述を壊していない(既存テストと重複するが Δ5 の要)。
  expect(VOCABULARY_SCOPE).toContain("output_table に**全置換**で書きます");
});

test("V2-M3-T05: write_back を足しても action_value(限定12)の『計算手段なし』は真のまま(EC-G6 逆向きの歯止め)", () => {
  // **action_value を1バイトも触っていない**ことを schema 側で固定する ——
  // string 型に閉じ、$ 参照は $record 形のみ、else は波括弧を禁じるだけ(式言語を持たない)。
  const actionValue = manifestSchema().$defs.action_value;
  expect(actionValue.type).toBe("string");
  expect(actionValue.then.pattern).toBe("^\\$record\\.(_id|[a-z][a-z0-9_-]*)$");
  // 「値を計算する手段はこの語彙には無い / 式・関数・文字列連結は1つも無い」は依然真(限定12 不変)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("式・関数・文字列連結は1つも無い");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("値を計算する手段はこの語彙には無い");
  // **誤読させない工夫**: 行内演算は島の JS で行い write_back で書き戻す、と明確化されている
  // (「計算手段なし」と「write_back で計算値を書ける」がどの層の話かを取り違えさせない)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "run_function の write_back でトリガー元レコードへ書き戻す",
  );
  expect(VOCABULARY_SCOPE).toContain(
    "action_value)には演算・式・文字列連結が1つも無く(限定12 不変)",
  );
});

test("V2-M3-T05: schema に field.unique がある ⇔ 説明文が unique(単一列・非DDL・書込時検査)を述べる(EC-G8)", () => {
  // 実装の真: T03 で field に unique(boolean)が入った。
  const unique = manifestSchema().$defs.field.properties.unique;
  expect(unique).toBeDefined();
  // **【V4-M10-T07 / E-G66 / ADR-0078 による更新】** **値域が boolean から
  // [true, false, "owner"] の列挙に広がった**(限定2: 有限の列挙で機械的に閉じる)。
  // **キーは1つも増えていない**(限定1)。
  expect(unique.enum).toEqual([true, false, "owner"]);
  // 実装→記述: unique の性質(単一列・DDL 制約にしない・アプリ層書込時検査)が述べられている。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("unique はフィールドの一意制約である");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("単一列のみ");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("アプリ層の書込時検査で担保する");
  // **【V4-M10-T07 / ADR-0078 による更新】** 旧文「unique を false→true にする後付けで、
  // 既存データに重複があれば〜」は、値域が広がったので「false から true / "owner" に〜
  // そのスコープの中に既存の重複があれば〜」に書き換えた。**趣旨(後付けは部分適用しない)
  // は1ミリも変わっていない。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "そのスコープの中に既存の重複があれば差分全体が拒否される",
  );
  // change_field の changes キー列挙が更新され、旧列挙が残っていない(双方向)。
  // **【V4-M10-T01 / ADR-0076 限定9 による更新】** **8つ目(`writable_by`)が入ったので
  // 「7つだけ」は偽になった。** **「効かない」ことも同時に述べていることを固定する** ——
  // 片方だけだと「後から付けられる」という逆向きの嘘になる。
  // **【V4-M10-T46 / ADR-0086 限定8・限定12 による更新】** **9つ目(`unit`)が入ったので
  // 「8つだけ」は偽になった。** **`unit` は `writable_by` と違って効く**ので、
  // **効く側と効かない側を両方名指ししていることを固定する**(片方だけだと嘘になる)。
  // **【V4-M16-T10 / `P-G28` + `P-G22` / ADR-0090 限定10 による更新】** **10つ目
  // (`emphasis`)が入ったので「9つだけ」は偽になった。** **`emphasis` も `unit` と
  // 同じく change_field で効く**(カーネルの `buildChangedField` が値を運ぶ)ので、
  // **今日も効かない `writable_by` と並べて両方を名指ししていることを固定する。**
  // **【V4-M19-T07 / ADR-0119 限定1 で 10個 → 11個 に更新した】** 11つ目
  // (`hide_when_empty`)が入ったので「10個だけ」は偽になった。**`hide_when_empty` も
  // `unit` / `emphasis` と同じく change_field で効く**(カーネルの `buildChangedField` が
  // 値を運ぶ)ので、**今日も効かない `writable_by` と並べて両方を名指ししていることを
  // 固定する。****本 ADR の増分ではない(このテストが守るのは ADR-0071 / ADR-0078)。**
  // **【`V6-M6-T01` / `K-G1` / `K-G7` / `K-G21a` で 11個 → 13個 に更新した】**
  // **12つ目(`reference_picker`)と13つ目(`reference_search_fields`)が入ったので
  // 「11個だけ」は偽になった。** **偽であった期間を隠さない** —— **`V6-M1` から `V6-M5` まで
  // 5マイルストーンのあいだ、この1文は嘘のまま緑だった**(`v6-m1.md` §5-1 の #1 が最初に
  // 見つけ、`v6-m5.md` §5-1 の #1 まで5回申し送られた)。**この検査が旧文を `toContain` で
  // 固定していたことが、嘘を緑のまま保った仕組みそのものである。**
  // **【並びが変わった。隠さない】** **旧文は `options / required` の順、新文は
  // スキーマの順(`required / options`)である。** 下の
  // 「散文の列挙が `schemas/diff.schema.json` と順序ごと一致する」検査が正を持つ。
  // **【`V8-M20`。台帳 `J-G28`(判定 = 廃止)。手続きは `ADR-0301`】13個 → 12個 に更新した。**
  // **`schemas/diff.schema.json` の `$defs/field_changes/properties` から、項目の
  // 「書ける相手」の8つ目のキーが撤去されたためである。****旧値をここに残す**:
  //   旧: `"change_field は id / name / type / required / options / reference_table / unique /
  //        writable_by / unit / emphasis / hide_when_empty / reference_picker /
  //        reference_search_fields の13個だけで、"`
  //   新: 同じ並びから8つ目を抜いた12個。
  // **並びとキーの正は `schemas/diff.schema.json` であり、下の「順序ごと一致する」検査が持つ。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "change_field は id / name / type / required / options / reference_table / unique / unit / emphasis / hide_when_empty / reference_picker / reference_search_fields の12個だけで、",
  );
  // **旧文(13個の版・11個の版)が1文字も残っていないこと**(双方向)。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("の13個だけで、それ以外のキーを書くと");
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("11個だけで、それ以外のキーを書くと");
  // **`reference_picker` / `reference_search_fields` も change_field で効くことを述べている。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**reference_picker は change_field で効きます**");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**reference_search_fields は change_table でも change_field でも効きます**",
  );
  // **【`V8-M20`。台帳 `J-G28`】期待値を書き換えた。旧値を残す** ——
  //   旧: `"**unit は change_field で効きます**(writable_by とはここが違います)"`
  //   新: `"**unit は change_field で効きます**"`
  // **括弧の中の対比は、比べる相手(効かないキー)が撤去されたので書けない** ——
  // **今日 `field_changes` に「受理はされるが値が残らない」キーは1本も無い。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**unit は change_field で効きます**");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**emphasis も change_field で効きます**");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**hide_when_empty も change_field で効きます**");
  // **【`V8-M20`】「効かないキーが1本ある」を述べる検査を、「1本も無い」+「代わりの在り処」
  // を述べる検査に置き換えた。旧値を残す** ——
  //   旧: `expect(...).toContain("**ただし writable_by は今日 change_field では効きません**")`
  // **代わりに立つのは「役割 × 対象(項目)× 書込」であり、差し替えは `set_roles` である
  // (`ADR-0301` 限定8 が「代わりに何が担うか」を書けと定めている)。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**書いたキーはどれも適用後マニフェストに残ります**(「受理はされるが値が残らない」キーは今日1本もありません)。",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**それは役割の規則(app.roles[].rules)の側で、対象 field に can: write と書きます**",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain(
    "change_field は id / name / type / options / required / reference_table / unique の7つだけ",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain(
    "change_field は id / name / type / options / required / reference_table の6つだけ",
  );
  // **【V4-M10-T07 / ADR-0078 による追記】** **値域が1語広がったことを記述が述べている
  // ことと、今日も書けないもの(列名・複合ユニーク)を同時に述べていることを固定する。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain('**値域は true / false に加えて "owner" を書ける**');
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**スコープに使えるのは持ち主の1つだけで、列名は1文字も書けない**",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**この窓はスコープを付けても1ミリも狭まらない。**");
});

// --- V5-M16-T07: 9種目 `file` の説明(`G-G12` / `G-G13` / `ADR-0161` 限定11。Δ5)-------
//
// **`VOCABULARY_SCOPE` の型数と型名は `FIELD_TYPES` から自動で追随する**(上の V2-M2-T05 の
// 歯止めが見ている)。**しかし「image と file は何が違うか」は自動では出ない。**
// **黙って似た型を2つ並べると、AI は「PDF を画面に埋め込める」「未ログインの人にも配れる」と
// 外挿する** —— どちらも今日は成り立たない。**だからここで文面を固定する。**
test("V5-M16-T07: VOCABULARY_SCOPE は file と image の違いを3点とも述べている", () => {
  // (0) 型として列挙されている(自動追随の側)。
  expect(VOCABULARY_SCOPE).toContain("フィールド型は9種");
  expect(VOCABULARY_SCOPE).toContain("file");
  // (1) 受け入れる種類の制限が0件であること。
  expect(VOCABULARY_SCOPE).toContain("**file は種類を1つも制限しません**");
  // (2) 大きさの上限が違うこと(実数を書く。丸めない)。
  expect(VOCABULARY_SCOPE).toContain("20,000,000 バイト");
  expect(VOCABULARY_SCOPE).toContain("5 MiB");
  // (3) **必ずダウンロードになること。** これを書かないと AI が埋め込めると外挿する。
  expect(VOCABULARY_SCOPE).toContain("file は必ずダウンロードになります");
  expect(VOCABULARY_SCOPE).toContain("**file をブラウザの中で開くことはできません**");
  // **「種類を制限する代わりに落とす」と書いてある**(4種限定の言い換えではない)。
  expect(VOCABULARY_SCOPE).toContain("種類を制限する代わりに「必ず落とす」ことで塞いでいます");
  // 未認証配信しないこと(image より狭い)。
  expect(VOCABULARY_SCOPE).toContain("**file は未ログインの人には1件も配信されません**");
  // 多値が無いこと / 変換が無いこと。
  expect(VOCABULARY_SCOPE).toContain("1項目1ファイル");
  expect(VOCABULARY_SCOPE).toContain("**サムネイル・プレビュー・変換・圧縮は1つもありません。**");
});

test("V5-M16-T07: 「フィールド型は8種のまま」という現在形の主張が MCP の説明文に1件も残っていない", () => {
  expect(VOCABULARY_SCOPE).not.toContain("フィールド型は8種");
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("フィールド型は8種");
});

test("V2-M3-T05: unique は型ではなく制約 —— unique はフィールド型を1つも増やしていない(EC-G8)", () => {
  // unique を足してもフィールド型は増えない(ADR-0038: 制約であって型ではない)。
  expect(FIELD_TYPES.length).toBe(9); // 【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  expect(FIELD_TYPES as readonly string[]).not.toContain("unique");
  expect(VOCABULARY_SCOPE).toContain("フィールド型は9種"); // 【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  // schema 側でも unique は field_type の enum ではなく独立した boolean プロパティである。
  const fieldTypeEnum = manifestSchema().$defs.field_type.enum as string[];
  expect(fieldTypeEnum).not.toContain("unique");
  // 【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。
  expect(fieldTypeEnum.length).toBe(9);
});

// --- V2-M4-T04: 原子性バッチ(EC-G7)/ target 語彙拡張(EC-G13)が入った(ADR-0039/0040。Δ5)---
//
// **T01 でバッチ API(writeRecords 公開面 + write_records ツール)/ T02 で update_record の
// target 3形(自己 / 参照先行 / 定数 UUID)が正準スキーマ・カーネル公開面に入った。**
// 説明文(vocabulary.ts)が実装(バッチ公開面・target pattern・action enum)と食い違ったら
// 落ちる**双方向の歯止め**を置く(V2-M3-T05 / V2-M2-T05 と同型。片方向だけだと逆向きの嘘に倒れる)。
// 実装の真は正準スキーマ + カーネル/MCP のソースを直読みして固定する(DIFF_OPS 等を import すると
// ADR-0009 限定2 の import スナップショットが増えるので、JSON/ソースを直読みする)。

/**
 * カーネル/MCP のソースを直読みする(schema を直読みする manifestSchema と同型)。
 *
 * **根は移した公開単位(`apps/smailtalk/`)である** —— `src/mcp/` から2つ上げる。
 * **`import.meta.dir` から数える**(cwd 相対だと `bun test` を打つ場所で結果が変わる)。
 */
function readSrc(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, "..", "..", ...parts), "utf-8");
}

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った `docs/` を直読みする補助関数 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

test("V2-M4-T04 (a): target pattern が $record.<field> を許す ⇔ 説明文が参照先行更新・単一ホップ・実行時行実在未保証を述べる(EC-G13)", () => {
  // 実装の真: target は $defs/action_value を共有し、pattern が $record.<field> を許す(ADR-0040)。
  const actionValue = manifestSchema().$defs.action_value;
  expect(actionValue.then.pattern).toBe("^\\$record\\.(_id|[a-z][a-z0-9_-]*)$");
  // 正準スキーマの target description も3形/単一ホップ/実行時行実在未保証を述べる(実装の真)。
  const targetDesc = manifestSchema().$defs.workflow_action.properties.target.description as string;
  expect(targetDesc).toContain("$record.<reference フィールドID>");
  expect(targetDesc).toContain("単一ホップ");
  expect(targetDesc).toContain("実行時に実在するかは保証しない");
  // 実装→記述: 説明文が3形・参照先の別テーブル行・単一ホップ・実行時行実在未保証を述べる。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("$record.<reference フィールドID>");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("参照先の別テーブルの行");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("単一参照フィールドの1ホップのみ");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("実行時に参照先の『行』が実在するかは保証しない");
  // join・多段($record.a.b)を作っていないことの明記(ADR-0040 限定2。ここが Δ5 の核心)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("join・多段($record.a.b)");
  // 記述→実装(逆向きの嘘の歯止め): 「target は values の値と同じ語彙」という旧文言が復活していない。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("target は values の値と同じ語彙");
  // "bogus" が「適用時には通る」という旧 T-2 文言(D2-a 選択肢A で apply 拒否になった今は嘘)が残っていない。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain(
    '**"bogus" のような波括弧を含まない自由な文字列は適用時には通る**',
  );
});

test("V2-M4-T04 (b): バッチ経路が実在(write_records ツール / writeRecords 公開面)⇔ 説明文がバッチ(明示リスト・CAS・全成功/全失敗)を述べる(EC-G7)", () => {
  // 実装の真: カーネルにバッチ公開関数 writeRecords があり、MCP に write_records ツールがある(ADR-0039)。
  expect(readSrc("src", "kernel", "batch.ts")).toContain("export function writeRecords");
  expect(readSrc("src", "mcp", "tools", "write.ts")).toContain('"write_records"');
  // 実装→記述: VOCABULARY_SCOPE がバッチ経路(明示リスト・CAS・全成功/全失敗・両経路)を述べる。
  expect(VOCABULARY_SCOPE).toContain("全成功か全失敗");
  expect(VOCABULARY_SCOPE).toContain("write_records");
  expect(VOCABULARY_SCOPE).toContain("POST /apps/:id/batch");
  expect(VOCABULARY_SCOPE).toContain("明示的に列挙した有限個");
  expect(VOCABULARY_SCOPE).toContain("if_match");
  // 記述→実装(逆向きの嘘の歯止め): where 句/条件付き一括/全件更新・反復/ループが「無い」ことを述べる。
  expect(VOCABULARY_SCOPE).toContain("where 句・条件付き一括更新・全件更新は無く");
  expect(VOCABULARY_SCOPE).toContain("反復・ループ・制御構造をカーネルは1つも持ちません");
});

test("V2-M4-T04 (c): schema の action enum が5種 ⇔ 説明文の action 列挙が5種(旧2種が残っていない。M3-T05 申し送りの解消)", () => {
  // 実装の真: workflow_action.action.enum は5種(create_record/update_record/call_external/ai_transform/run_function)。
  const actionEnum = manifestSchema().$defs.workflow_action.properties.action.enum as string[];
  expect([...actionEnum].sort()).toEqual([
    "ai_transform",
    "call_external",
    "create_record",
    "run_function",
    "update_record",
  ]);
  // 実装→記述: VOCABULARY_SCOPE も APPLY_DIFF_OP_EXAMPLES(注11)も5種を列挙する。
  expect(VOCABULARY_SCOPE).toContain(
    "create_record / update_record / call_external / ai_transform / run_function の5種",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "create_record / update_record / call_external / ai_transform / run_function の5種",
  );
  // 記述→実装(M3-T05 申し送りの解消): 注11 の旧「2種だけ」が残っていない(機械的に固定)。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("action は create_record / update_record の2種だけ");
});

test("V2-M4-T04 (d): バッチ/target を足しても action_value(限定12)の『計算手段なし』は真のまま(逆向きの歯止め)", () => {
  // **action_value を1バイトも触っていない**ことを schema 側で固定する ——
  // string 型に閉じ、$ 参照は $record 形のみ、else は波括弧を禁じるだけ(式言語を持たない)。
  const actionValue = manifestSchema().$defs.action_value;
  expect(actionValue.type).toBe("string");
  expect(actionValue.then.pattern).toBe("^\\$record\\.(_id|[a-z][a-z0-9_-]*)$");
  expect(actionValue.else.pattern).toBe("^[^{}]*$");
  // 「値を計算する手段はこの語彙には無い / 式・関数・文字列連結は1つも無い」は依然真(限定12 不変)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("式・関数・文字列連結は1つも無い");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("値を計算する手段はこの語彙には無い");
  // **誤読させない工夫**: バッチも target 拡張も action_value を触っていない(どの層の話かを取り違えさせない)。
  // バッチの演算は呼び出し側、target は values と同じ pattern を共有し pattern 自体を変えていない。
  expect(VOCABULARY_SCOPE).toContain("action_value(限定12)も式言語も1バイトも触りません");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "action_value(values / target の値語彙)は1バイトも変わっておらず",
  );
});

// --- V2-M5-T04: Webhook 受信(inbound capability)が入った(EC-G4 / ADR-0041。Δ5)-------
//
// **T01〜T03 で受信が実在した:** 人間(owner)が発行した受信口(inbound capability)の下で、
// 署名付き Webhook(HMAC-SHA256 を実行層が書込直前に検証)を書込先テーブル1つへ1行 create
// できる(`POST /inbound/:endpoint_id` / inbound-route.ts / inbound-store.ts / inbound-verify.ts)。
// したがって「外部からのデータ取り込み(受信)はありません」(旧 vocabulary.ts:146/297-298/1228)は
// **嘘になった**。**ADR-0013 §10 / 送信側(V1-M4-T04)と同型の双方向の歯止め**を置く ——
// 片方向だけ消すと逆向きの嘘に倒れる(「受信は一切ない」も「AI が何でも受信できる」も避ける)。
// 非対称が核心:
//   - 受信は**できる**(人間発行の inbound capability + 署名付き Webhook + 書込先テーブル1つへ1行 create)。
//   - **AI は受信口を発行できない**(発行は owner の UI 操作だけ・MCP / apply_diff に発行経路なし)。
//     V2-M5-T01 で申請ツール(request_inbound_endpoint)を結線したので、AI は**申請だけできる** ——
//     送信 request_connection の鏡写しである(申請できる／発行はできない、の非対称を正確に述べる)。
//   - **call_external は依然「送信専用」**(応答本文の取り込み = R2-b は無い)。
//   - 受信の書込は**署名検証を通ったものだけ**・**演算/条件/連結なし**($record と同形)。
//   - **任意の外部データ取り込み(CSV・外部データ読み込み)は依然できない**(署名付き Webhook の限定経路だけ)。

test("V2-M5-T04 (できる側): 説明文は受信を『無い』と嘘をつかず、人間発行の inbound capability + 署名付き Webhook で起こり得ると述べている(Δ5)", () => {
  // **ADR-0041 後、受信が実在する。** 旧「受信はありません / 受信は語彙に無い」の全否定は
  // 嘘になったので**禁止する**(送信側 V1-M4-T04 と同型の双方向の歯止め)。将来この全否定が
  // 静かに戻らないよう固定する。
  expect(VOCABULARY_SCOPE).not.toContain("外部からのデータ取り込み(受信)はありません");
  expect(CANNOT_DO).not.toContain("外部からのデータ取り込み(受信)はありません");
  expect(CANNOT_DO).not.toContain("外部からアプリへ取り込む経路は語彙にありません");
  expect(OUT_OF_SCOPE_BEHAVIOR).not.toContain("受信は語彙に無い");
  // できることは具体的に述べる: 人間発行の inbound capability + 署名付き Webhook + 1行 create。
  expect(VOCABULARY_SCOPE).toContain("受信口(inbound capability)");
  expect(VOCABULARY_SCOPE).toContain("署名付き Webhook");
  expect(VOCABULARY_SCOPE).toContain("書込先テーブル1つへ1行");
});

test("V2-M5-T04 (できない側): 説明文は『AI は受信口を申請できるだけで発行できない・call_external は送信専用・応答取り込みなし・署名検証を通ったものだけ』を述べている(逆向きの歯止め)", () => {
  // **逆向きの嘘(「AI が何でも受信できる」)に倒さない。** 非対称を固定する ——
  // 発行は人間のみ・AI は申請だけ(発行経路なし) / call_external は送信専用 / 応答取り込みなし /
  // 署名検証を通ったものだけ・演算条件なし。**将来 AI 発行へ緩めたら落ちる。**
  // (a) 受信口の発行は人間(owner)のみ。V2-M5-T01 で申請ツールを結線したので、AI は
  //     request_inbound_endpoint で**申請できるだけ**(発行はできない)—— 送信 request_connection と同型。
  //     「作る経路はありません」という強い全否定ではなく、「申請だけ・発行はできない」を正確に述べる。
  expect(VOCABULARY_SCOPE).toContain("受信口を発行できるのは人間(owner)だけ");
  expect(VOCABULARY_SCOPE).toContain(
    "AI は request_inbound_endpoint で受信口を申請することしかできません",
  );
  // (b) call_external は依然送信専用・応答本文の取り込み(R2-b)なし。
  expect(VOCABULARY_SCOPE).toContain("call_external は依然「送信専用」");
  expect(VOCABULARY_SCOPE).toContain("応答本文をアプリ内テーブルへ取り込む経路はありません");
  // (c) 受信の書込は署名検証を通ったものだけ・演算/条件/連結なし($record と同形)。
  expect(VOCABULARY_SCOPE).toContain("署名検証を通ったものだけ");
  expect(VOCABULARY_SCOPE).toContain("演算・条件・連結を持たず");
  // (d) 任意の外部データ取り込み(CSV・外部データ読み込み)は依然できない(限定経路だけ)。
  expect(CANNOT_DO).toContain("任意の外部データ取り込みはできません");
});

test("V2-M5-T04 (action 5種): 受信を足しても workflow action は5種のまま(受信は HTTP ルートでワークフローアクションでない)", () => {
  // 受信は `POST /inbound/:endpoint_id`(サーバ層の HTTP ルート)であって、workflow の
  // アクションではない。**action enum に6種目を1つも足していない**ことを schema 側で固定する
  // (V2-M4-T04 (c) の action 5種を M5 でも維持)。将来 receive/webhook 等の action が
  // 紛れ込んだら落ちる。
  const actionEnum = manifestSchema().$defs.workflow_action.properties.action.enum as string[];
  expect([...actionEnum].sort()).toEqual([
    "ai_transform",
    "call_external",
    "create_record",
    "run_function",
    "update_record",
  ]);
  // 説明文も5種のまま(受信を足しても6種目を列挙していない)。
  expect(VOCABULARY_SCOPE).toContain(
    "create_record / update_record / call_external / ai_transform / run_function の5種",
  );
  // 受信をアクションだと誤読させる文言が無い(受信は HTTP ルートであってアクションでない)。
  for (const bogus of ["receive_record", "receive_webhook", "inbound_create", "アクションは6種"]) {
    expect(VOCABULARY_SCOPE).not.toContain(bogus);
  }
});

// --- V2-M6-T05: 一覧/フィルタ/詳細の語彙拡張(EC-G11/G12/G14/G17)が入った(ADR-0042〜0045。Δ5)---
//
// **T01 でブール式フィルタ($defs/filter_leaf / filter_node)/ T02 でページネーション
// (offset+limit+total)/ T03 で detail_view の related(子一覧埋め込み)/ T04 で detail_view の
// actions(プリフィル遷移)が正準スキーマ・カーネル/MCP 公開面に入った。** 説明文(vocabulary.ts /
// schema description)が実装と食い違ったら落ちる**双方向の歯止め**を置く(V2-M5-T04 / V2-M4-T04 /
// V2-M3-T05 と同型。片方向だと逆向きの嘘に倒れる)。実装の真は正準スキーマ + カーネル/MCP のソースを
// 直読みして固定する(kernel を import すると ADR-0009 限定2 の import スナップショットが増えるため)。

test("V2-M6-T05 (EC-G12): filter の葉演算子はちょうど5種・ブール結合はちょうど3種で、schema 構造と description・実装が一致する", () => {
  const schema = manifestSchema();
  // 実装の真: 葉演算子 = filter_leaf.properties から field を除いた集合(ちょうど5種)。
  const leafOps = Object.keys(schema.$defs.filter_leaf.properties).filter((k) => k !== "field");
  expect([...leafOps].sort()).toEqual(["contains", "equals", "gte", "in", "lte"]);
  // oneOf で「1葉につき演算子ちょうど1つ」を強制している(葉ごとに required 1つ)。
  const oneOfKeys = (schema.$defs.filter_leaf.oneOf as Any[]).map((b) => b.required[0]);
  expect([...oneOfKeys].sort()).toEqual(["contains", "equals", "gte", "in", "lte"]);
  // ブール結合 = filter_node.anyOf のうち葉以外(and/or/not)ちょうど3種。
  const combinators = (schema.$defs.filter_node.anyOf as Any[])
    .filter((b) => b.required)
    .map((b) => b.required[0]);
  expect([...combinators].sort()).toEqual(["and", "not", "or"]);
  // 実装↔記述: filter の description が5演算子・3結合を述べる(嘘に倒れない)。
  const filterDesc = schema.$defs.filter.description as string;
  expect(filterDesc).toContain("equals/contains/gte/lte/in");
  expect(filterDesc).toContain("and/or/not");
  // カーネルの葉演算子集合(実装の真)も同じ5種で、schema と実装が割れない。
  expect(readSrc("src", "kernel", "records.ts")).toContain(
    'LEAF_OPERATORS = ["equals", "contains", "gte", "lte", "in"]',
  );
});

test("V2-M6-T05 (EC-G12 逆向き): filter を『等値のみ』と嘘をつく旧断定が schema にも vocabulary にも残っていない —— しかしクエリ言語は過剰約束しない", () => {
  const schema = manifestSchema();
  const filterDesc = schema.$defs.filter.description as string;
  // v0 の全否定(等値のみ)が静かに戻らないよう固定する(EC-G12 で嘘になった)。
  for (const lie of ["単純な等値条件のみ", "等値条件のみを扱い", "等値のみ"]) {
    expect(filterDesc).not.toContain(lie);
    expect(VOCABULARY_SCOPE).not.toContain(lie);
    expect(APPLY_DIFF_OP_EXAMPLES).not.toContain(lie);
  }
  // 逆向きの嘘(「何でも絞り込める」)にも倒さない —— like/regex/between/is_null/join/select/group_by は
  // 1つも足していない(ADR-0043 §3a。有限の演算子集合に閉じる)。
  expect(schema.$defs.filter_leaf.$comment).toContain("like/regex/between/is_null");
  expect(schema.$defs.filter_node.$comment).toContain("xor/nand/implies を足してはならない");
});

test("V2-M6-T05 (Δ5 when): filter がブール式化しても when は等値1形に据え置き —— 『$defs/filter と同型』の旧断定が消えている", () => {
  // Δ5 の核心: vocabulary.ts の「when は $defs/filter と同型」は filter がブール式化した今
  // 不正確なので消した。when が filter のブール式に釣られて広がっていないことを固定する。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("when は $defs/filter と同型");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("when は等値の最小述語1形 {field, equals}");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("filter 全体と同型ではない");
  // 実装の真: when は依然 {field, equals} のみ(演算子なし。filter_leaf の5演算子を1つも持たない)。
  const when = manifestSchema().$defs.workflow_action.properties.when;
  expect([...when.required].sort()).toEqual(["equals", "field"]);
  expect(Object.keys(when.properties).sort()).toEqual(["equals", "field"]);
  for (const op of ["contains", "gte", "lte", "in", "and", "or", "not"]) {
    expect(when.properties[op]).toBeUndefined();
  }
});

test("V2-M6-T05 (EC-G11): 一覧読取は offset/limit/total を持つ —— ツール記述が『全件返すだけ』に倒れていない", () => {
  // 実装の真: カーネル records.ts が offset/limit を検証し、LIMIT / OFFSET で切り出す。
  //
  // **【SQ-M4 で指す先を移した】** かつては `read-records.ts` の `slicePage`(メモリ上で
  // 配列を切る2つ目の実装)を指していた。**システムテーブルの読取を SQL へ一本化した
  // ときにその実装ごと消えた** —— 今日はシステムテーブルもユーザテーブルも、この1本の
  // 検証と1本の LIMIT / OFFSET を通る。**検査の目的(ツール記述が『全件返すだけ』に
  // 倒れていないことを実装で裏づける)は変えていない。**
  const recordsSrc = readSrc("src", "kernel", "records.ts");
  expect(recordsSrc).toContain('validatePageParam("limit"');
  expect(recordsSrc).toContain('validatePageParam("offset"');
  expect(recordsSrc).toContain(" LIMIT ?");
  expect(recordsSrc).toContain(" OFFSET ?");
  // 2つ目の切り出しが `read-records.ts` に戻っていない(経路が再び割れない)。
  expect(readSrc("src", "kernel", "read-records.ts")).not.toContain("slicePage");
  // MCP の list_records ツール記述が limit/offset とページ送り・total を述べる。
  const readToolSrc = readSrc("src", "mcp", "tools", "read.ts");
  expect(readToolSrc).toContain("limit で1ページ分を取り、offset を増やして続きを取得");
  expect(readToolSrc).toContain("total は常にテーブル全体の件数");
  expect(readToolSrc).toContain("total は絞られない");
});

test("V2-M6-T05 (EC-G17): detail_view は related(子一覧埋め込み)を持てる —— 『自レコードのみ』の全否定に倒れず、しかし join/多段には広げていない", () => {
  const schema = manifestSchema();
  // 実装の真: related_list が入り、detail_view の properties に related($ref)がある。
  const related = schema.$defs.related_list;
  expect(related).toBeDefined();
  expect([...related.items.required].sort()).toEqual(["columns", "table", "via"]);
  expect(schema.$defs.view.properties.related.$ref).toBe("#/$defs/related_list");
  // 1ホップのみ(via = 子テーブル上の単一 reference)。join・参照展開・孫・多段は無い(過剰約束しない)。
  expect(related.$comment).toContain("1ホップ");
  expect(related.$comment).toContain("join・参照展開");
  expect(related.$comment).toContain("孫・多段には広げない");
  // related は detail_view でだけ許す —— list_view / form の分岐では related:false。
  const [listBranch, formBranch, detailBranch] = schema.$defs.view.allOf as Any[];
  expect(listBranch.then.properties.related).toBe(false);
  expect(formBranch.then.properties.related).toBe(false);
  // detail_view の分岐は related を false にしていない(= 書ける)。base の自レコード側は不変。
  expect(detailBranch.then.properties.related).toBeUndefined();
  // **V3-M2-T01(ADR-0050)で detail_view 分岐に list 専用プリセット3軸の false 宣言が
  // 増えた。** `related` / `actions` の扱い(detail_view では false にしない = 書ける)は
  // 1バイトも変わっていない —— 増えたのは「detail_view では書けない」側の宣言だけである。
  // **【V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定2 で1本増えた】** 8つ目の
  // `preset_` キー(一覧の器の形)も detail_view では `false` である。
  // **`related` / `actions` の扱い(detail_view では `false` にしない = 書ける)は
  // 今日も1バイトも変わっていない。**
  // **【V4-M18-T03 / `P-G14` の (C) 側 / ADR-0095 限定6 で1本増えた】** `modal`
  // (重ねて出す宣言)も detail_view では `false` である。**`related` / `actions` の
  // 扱いは今日も1バイトも変わっていない。**
  // **【V4-M22-T01 / `E-G7` の (C) 側 / ADR-0112 限定3 で1本増えた】** `search_fields`
  // (検索の対象にする列)も detail_view では `false` である。**`related` / `actions` の
  // 扱いは今日も1バイトも変わっていない。**
  // **【V4-M22-T05 / ADR-0113 限定7 で1本増えた】** `page_size`(1ページに出す件数)も
  // detail_view では `false` である(書けるのは list_view だけ)。**`related` / `actions` の
  // 扱いは今日も1バイトも変わっていない。**
  // **【V4-M20-T04 / `E-G34` / ADR-0102 限定3 で1本増えた】** `after_save`(保存が成立した
  // あとに行く画面)も detail_view では `false` である(書けるのは form だけ)。
  // **`related` / `actions` の扱いは今日も1バイトも変わっていない。**
  // **【V4-M23-T01 / `D-V4-89` / ADR-0104 限定4 で1本増えた】** `sum_field`(合計を
  // 出す列。**28キー目**)は `list_view` でだけ書けるので、`detail_view` 分岐でも `false` である。
  // **【V5-M22-T04 / `L-G7` / ADR-0173 で1本増えた。ただし `false` ではない】** `actions` が
  // `detail_view` 分岐に現れた。**`related` / `actions` の扱い(detail_view では書ける)は
  // 今日も真である** —— **足したのは `items.properties.view: false` の1点だけで、これは
  // 3形目(行き先の宣言)を詳細画面で閉じるものである**(`L-G7` = **却下**。
  // `docs/plan/v5/records/v5-m20.md` §2-2)。**既存2形(遷移 / 値の書換)は1バイトも
  // 変わっていない。****`related` は今日も `detail_view` 分岐に現れない。**
  // **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1 で1本減った】**
  // **旧行の逐語**: 期待値の2本目に `"after_save",` が並んでいた。
  // **門A の本審査(`V10-M0` 群A。判定 = 限定採用)が `detail_view` 分岐の
  // `"after_save": false,` を外した** —— **詳細画面の書換ボタン(`set` 形)が成立した
  // あとの行き先を書けるようにするためである。****これは閉じる側ではなく開く側の差であり、
  // 本テストで `detail_view` 分岐の宣言が減るのはこれが初めてである。**
  // **`related` / `actions` の扱いは今日も1バイトも変わっていない。**
  expect([...Object.keys(detailBranch.then.properties)].sort()).toEqual([
    "actions",
    "columns",
    "filter",
    "modal",
    "page_size",
    "preset_column_align",
    "preset_column_width",
    "preset_list_shape",
    "preset_pager_position",
    // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定4 で足した】** detail_view 分岐に
    // `reference_pickers`(参照項目の選び方の、入力画面ごとの上書き)の `false` が現れた
    // (`form` でだけ書ける)。**これも閉じる側の差である。****`related` は今日も
    // `detail_view` 分岐に現れない。**
    "reference_pickers",
    // **【2026-08-14。`V8-M8` / 台帳 `Q-G1` / 門A 本審査 = `V8-M7` で足した】** detail_view
    // 分岐に29キー目 `report`(集計表の中身)の `false` が現れた(`report_view` でだけ
    // 書ける)。**これも閉じる側の差である。****`related` は今日も detail_view 分岐に
    // 現れない。**
    "report",
    "search_fields",
    "sort",
    "sum_field",
  ]);
  expect(detailBranch.then.properties.actions).not.toBe(false);
  expect(detailBranch.then.properties.actions.items.properties.view).toBe(false);
});

test("V2-M6-T05 (EC-G14): detail_view は actions(プリフィル遷移)を持てる —— 遷移だけの旧断定に倒れず、しかしプリフィルは _id 1つに閉じる", () => {
  const schema = manifestSchema();
  // 実装の真: view_action / view_actions が入り、detail_view の properties に actions($ref)がある。
  const action = schema.$defs.view_action;
  expect(action).toBeDefined();
  /*
   * **【V4-M20-T01 / ADR-0100 限定1 で `required` が `oneOf` へ移った】**
   *
   * **操作起点の形は列挙された有限の2形になった**(門A の本審査。判定 = 限定採用)——
   * (i) 遷移(`form` + `prefill`。**この形は1バイトも変わっていない**)/
   * (ii) 値の書換(`set`)。**トップの `required` は2形に分かれたので消え、代わりに
   * `oneOf` の各分岐が `required` を持つ。**
   * **`additionalProperties: false` は1バイトも外していない。**
   * **固定の向き(3つ目の形が入ったら赤くなる)を弱めていない** —— `oneOf` の本数を
   * ちょうど2に固定する。
   *
   * **【`V5-M22-T01` / `L-G5` / `L-G6` / `ADR-0173` 限定1 で 2 → 3 に更新した】**
   * **上の「ちょうど2に固定する」は今日から偽である。** **3形目(行き先の宣言 =
   * `view` 1キー)が `V5-M20` 面2 の門A 本審査を通って入った**(判定 = 限定採用)。
   * **この検査は「3つ目の形が入ったら赤くなる」ことで役目を果たした** —— **赤く
   * なったので、門A を通したうえで基準値を上げた。****旧文を1バイトも消していない。**
   * **置き換えとなる新しい向き: 4つ目の形が入ったら赤くなる。**
   *
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174` 限定1 で 3 → 4 に更新した】**
   * **上の「4つ目の形が入ったら赤くなる」は役目を果たした** —— **赤くなったので、
   * 門A の本審査(`ADR-0174`)を通したうえで基準値を上げた。****旧文を1バイトも消していない。**
   * **置き換えとなる新しい向き: 5つ目の形が入ったら赤くなる。**
   */
  expect(action.required).toBeUndefined();
  expect(action.oneOf).toHaveLength(4);
  expect([...action.oneOf[0].required].sort()).toEqual(["form", "prefill"]);
  expect([...action.oneOf[1].required].sort()).toEqual(["set"]);
  expect([...action.oneOf[2].required].sort()).toEqual(["view"]);
  expect([...action.oneOf[3].required].sort()).toEqual(["run"]);
  expect(action.additionalProperties).toBe(false);
  expect(schema.$defs.view.properties.actions.$ref).toBe("#/$defs/view_actions");
  // プリフィルは参照フィールド1つだけ({field} のみ・値を書く場所を持たない = _id に固定)。
  const prefill = action.properties.prefill;
  expect([...prefill.required].sort()).toEqual(["field"]);
  expect(Object.keys(prefill.properties)).toEqual(["field"]);
  expect(prefill.additionalProperties).toBe(false);
  expect(prefill.$comment).toContain("値を書く場所を持たない");
  expect(prefill.$comment).toContain("複数フィールドのプリフィルは作らない");
  // actions は detail_view でだけ許す —— list_view / form の分岐では actions:false。
  /*
   * **【V5-M21-T01 / `L-G1` / ADR-0171 で書き換えた】** 上の1行は **今日は form に
   * ついてだけ真である。** **`ADR-0171`(門A / 判定 = 限定採用)が `list_view` 分岐の
   * `"actions": false,` を解いた。****旧文を1バイトも消していない。**
   * **一覧に書けるのは遷移の形だけである** —— **set 形は `ADR-0171` 限定10 の順序拘束
   * (`ADR-0175` の規則が実装されるまで実装しない)により `items.properties.set: false`
   * で閉じてある。**
   */
  /*
   * **【`V5-M22-T04` / `L-G7` / `ADR-0173` で書き換えた】** 着手前の最終行は逐語
   * `expect(detailBranch.then.properties.actions).toBeUndefined();` であった。
   * **今日は `undefined` ではない** —— **3形目だけを `items.properties.view: false` で
   * 閉じてある**(`L-G7` = **却下**)。**`detail_view` に `actions` を書けること自体は
   * 1バイトも変わっていない。****非対称が残る**: **一覧の行からは任意の一覧・詳細を
   * 指せるが、詳細画面からは今日どおり参照セルと左ナビしか無い。**
   */
  const [listBranch, formBranch, detailBranch] = schema.$defs.view.allOf as Any[];
  expect(listBranch.then.properties.actions).not.toBe(false);
  /*
   * **【`V5-M25-T07` / `L-G3` による追随。旧を隠さない】** **旧(逐語)**:
   * `expect(listBranch.then.properties.actions.items.properties.set).toBe(false);`
   * `expect(listBranch.then.properties.actions.items.properties.view).toBeUndefined();`
   * **`ADR-0171` 限定10 の順序拘束が `V5-M25-T03` により解けたので、`items` ごと外した。**
   * **`form` 分岐の `false` は1バイトも解いていない**(下の行が今日も固定する)。
   */
  expect(listBranch.then.properties.actions.items).toBeUndefined();
  expect(formBranch.then.properties.actions).toBe(false);
  expect(detailBranch.then.properties.actions).not.toBe(false);
  expect(detailBranch.then.properties.actions.items.properties.view).toBe(false);
});

// 【`V5-M29-T05`】**テスト名を書き換えた。** 旧: 「V2-M6-T05 (語彙総量不変): 一覧/フィルタ/詳細の
//   拡張はリソース7種・フィールド型8種を1つも増やしておらず、使う diff op も v2 完了時点の集合に
//   収まっている」。**`RESOURCE_KINDS` / `FIELD_TYPES` の本数を測る `expect` が消えたのに、
//   名前だけが本数を主張する状態を残さないため(記録 §4-7)。**
test("V2-M6-T05 (語彙総量不変): 一覧/フィルタ/詳細の拡張は使う diff op が v2 完了時点の集合に収まっており、説明文の総量宣言も動いていない", () => {
  // filter 演算子・ページネーション・related・actions は既存リソース(view / read 経路)の中の
  // 拡張であって、新しいリソース種・フィールド型・diff op ではない(カーネル語彙総量は不変)。
  // 【`V5-M29-T05` / `ADR-0250` 限定11】ここにあった「新しいリソース種・フィールド型…ではない
  //   (カーネル語彙総量は不変)」を `RESOURCE_KINDS` の本数で固定していた検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `RESOURCE_KINDS:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T05` / `ADR-0250` 限定11】同じ位置にあった `FIELD_TYPES` の本数を固定していた検査も
  //   `scripts/vocabulary-drift.test.ts` へ移した(一覧の `FIELD_TYPES:` で始まる行)。
  //   **総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // **規則2(docs/plan/v3/records/v3-m1-gate-a-theme.md §10)による書き換え。**
  // 旧い形は `expect(DIFF_OPS.length).toBe(15)` だったが、それが見ていたのは
  // 「**現在の語彙総数**」であって、この検査の主張(「**V2-M6 の拡張が語彙を1つも
  // 増やしていない**」)ではない。15 を 16 に書き換えると v2 の主張の担保が消えるので、
  // 「**V2-M6 の拡張を使うのに必要な op が v2 完了時点の集合に収まっている**」へ
  // 主張を合わせ直す。**V2-M6 は専用 op を1つも作らなかった** —— 一覧の絞り込み・
  // ページネーション・関連表示・操作起点はすべて**ビュー定義の中のキー**であり、
  // 書き込みに使うのは既存の `add_view` / `update_view` だけである。
  const diffOpsAtV2Completion = [
    "add_table",
    "add_field",
    "add_view",
    "update_view",
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
  ];
  expect(diffOpsAtV2Completion).toHaveLength(15);
  for (const op of ["add_view", "update_view"]) {
    expect(diffOpsAtV2Completion).toContain(op);
  }
  // v2 完了時点の op が1つも失われていないこと(v3 は足すだけで、消していない)。
  for (const op of diffOpsAtV2Completion) {
    expect([...DIFF_OPS] as string[]).toContain(op);
  }
  // **V2-M6 が「専用 op を作らなかった」ことの裏返し** —— 機能名を持つ op が
  // 1つも生えていないこと(生えたら、それは V2-M6 の判断が後から覆されたということである)。
  for (const forbidden of ["update_filter", "add_related", "add_action", "set_page_size"]) {
    expect([...DIFF_OPS] as string[]).not.toContain(forbidden);
  }
  // **【`V5-M17b` / `ADR-0248`】** **v2 完了時点の集合(15)は1バイトも動かしていない** ——
  // **`set_user_kinds` は v2 の主張とは無関係に、別の門A 判定で足された17種目である。**
  // 説明文の総量宣言も 7 / 8 / 15 のまま(旧い/新しい数え間違いが紛れ込んでいない)。
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】7 → 8。**
  // **旧行の逐語は `expect(VOCABULARY_SCOPE).toContain("リソースは7種");` である。**
  // **`VOCABULARY_SCOPE` 側は `RESOURCE_KINDS.length` から組み立てるので自動的に8種になる。**
  // **この行が固定していたのは「**v2 の決定**が語彙を増やさなかったこと」であり、
  // 8種目 `report_view` を足したのは別の決定である。****検査は消していない。**
  expect(VOCABULARY_SCOPE).toContain("リソースは8種");
  expect(VOCABULARY_SCOPE).toContain("フィールド型は9種"); // 【`V5-M16` / `ADR-0161`】8 → 9(`file` が9種目)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  // **規則1(#4)**: これは「今日の語彙が何種か」を主張する散文の照合なので、数値を更新する
  // (`VOCABULARY_SCOPE` 側は `DIFF_OPS.length` から組み立てるので自動的に16種になる)。
  // **【`V5-M17b` / `ADR-0248`】16 → 17。** **旧行の逐語は
  // `expect(VOCABULARY_SCOPE).toContain("差分操作は16種");` である。**
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】17 → 18。****旧行の逐語は
  // `expect(VOCABULARY_SCOPE).toContain("差分操作は17種");` である。**検査は消していない。
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】18 → 17。****旧行の逐語は
  // `expect(VOCABULARY_SCOPE).toContain("差分操作は18種");` である。****検査は消していない。**
  // **`VOCABULARY_SCOPE` の側は `DIFF_OPS.length` から組み立てるので自動追随した** ——
  // **説明文の散文(`src/mcp/vocabulary.ts` の固定文字列)は本波では1バイトも触っていない**
  // (波及は `V8-M32` の担当)。
  expect(VOCABULARY_SCOPE).toContain("差分操作は17種");
  // schema 側の view_type / field_type enum も増えていない(related/actions は view の中のキー)。
  // **【2026-08-14。`V8-M8`。台帳 `Q-G1`。門A 本審査 = `V8-M7`】期待値に `report_view` を足した。**
  // **旧行の逐語**: `expect((manifestSchema().$defs.view_type.enum as string[]).sort()).toEqual([`
  // `"detail_view", "form", "list_view",` `]);`
  // **書き換えた理由**: この行が固定していたのは「**v2 の決定**(一覧/フィルタ/詳細の拡張)が
  // `view_type` を1つも増やさなかったこと」であり、**4種目を足したのは別の決定である。**
  // **`field_type` の enum は今日も1つも増えていない**(すぐ上の行が測っている)。
  expect((manifestSchema().$defs.view_type.enum as string[]).sort()).toEqual([
    "detail_view",
    "form",
    "list_view",
    "report_view",
  ]);
});

// --- V3-M1-T06: アプリ単位テーマ(有限25スロット)が入った(ADR-0046 / 0047 / 0048。Δ5)---
//
// **T03 でマニフェストにテーマの置き場と差分操作 `set_theme` が入り、T04 でそれが実際に
// 画面へ当たった**(chromium 実測)。この時点で `CANNOT_DO` の
// 「(見た目のカスタマイズは無い)」という**全否定は嘘になった。**
//
// **だが全部消すと逆向きの嘘になる**(ADR-0013 §10 が名指しした形)——
// 依然できないのは **任意の CSS / 画面のレイアウト・列幅・段組 / グラフ描画 /
// プラットフォームの外枠(シェル)の見た目 / ダークモード / レスポンシブ**であり、
// できるようになったのは**有限個のスロットに実値を埋めること**だけである。
// **したがって両方向を別々のテストで固定する**(M3-T02 / V2-M1-T06 / V2-M5-T04 と同型)。
//
// **数の照合を「散文」に任せない。** `VOCABULARY_SCOPE` は `DIFF_OPS` から組み立てる
// 部分は自動追随するが、**スロット数(25)は散文であり追随しない** ——
// `src/mcp/vocabulary.ts` はカーネルからスロット集合を値として import できない
// (ADR-0009 限定2 の import スナップショットが増える)。そこで**正準スキーマを
// このテストが読み、散文の数と突き合わせる**(`readFileSync` + `JSON.parse` のみ)。

/** 差分スキーマ(実装の真)を読む。`manifestSchema()` と同型。 */
function diffSchema(): Any {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "schemas", "diff.schema.json"), "utf-8"),
  ) as Any;
}

/** `$defs/theme`(= スロットの表)のキー集合。**実装の真**。 */
function themeSlotNames(): string[] {
  return Object.keys(manifestSchema().$defs.theme.properties).sort();
}

test("V3-M1-T06 (記述→実装): CANNOT_DO は「見た目のカスタマイズは無い」という全否定を主張していない(Δ5)", () => {
  // **文言そのものを禁止しておかないと、将来の編集で静かに戻ってくる。**
  // T04 が chromium で「マニフェストの配色が画面に出る」ことを実測した以上、この全否定は嘘である。
  for (const lie of [
    "見た目のカスタマイズは無い",
    "見た目のカスタマイズはありません",
    "見た目は指定できません",
    "配色は指定できません",
  ]) {
    expect(CANNOT_DO).not.toContain(lie);
    expect(VOCABULARY_SCOPE).not.toContain(lie);
    expect(OUT_OF_SCOPE_BEHAVIOR).not.toContain(lie);
  }
  // 総括の側(「これら…は存在しない機能で、回避策もありません」)から「見た目」が外れていること。
  expect(CANNOT_DO).not.toContain("任意の外部データ取り込み・見た目・画面/項目単位の権限");
});

test("V3-M1-T06 (実装→記述): 説明文は有限スロットのテーマ(set_theme)で指せるものを述べている", () => {
  // 実装の真: `set_theme` が `DIFF_OPS` にあり、`$defs/app.properties.theme` が実在する。
  expect([...DIFF_OPS] as string[]).toContain("set_theme");
  expect(manifestSchema().$defs.app.properties.theme).toBeDefined();
  // 記述: できることを具体的に述べる(全否定を消しただけで終わらせない)。
  expect(VOCABULARY_SCOPE).toContain("set_theme");
  expect(VOCABULARY_SCOPE).toContain("アプリの見た目(テーマ)");
  expect(CANNOT_DO).toContain("アプリ単位のテーマ(set_theme)");
});

test("V3-M1-T06 (数の照合): 散文のスロット数が $defs/theme のキー数と一致する(散文は自動追随しない)", () => {
  // **実装の真**: `$defs/theme` の properties キー集合(= スロット集合)。
  const slots = themeSlotNames();
  expect(slots.length).toBe(25);
  // 散文の数がスキーマと食い違ったら赤くなる。**ここが本タスクの「文言と語彙定数の照合」である。**
  expect(VOCABULARY_SCOPE).toContain(`スロットは${slots.length}個`);
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(`${slots.length}スロット`);
  // 旧い数(スロット総数28 = テーマ対象外3件を含む数)が紛れ込んでいないこと。
  expect(VOCABULARY_SCOPE).not.toContain("スロットは28個");
  // **AI はスロットを増やせない**(D-1)。実装の真はスキーマの閉じ方であり、記述はそれを述べる。
  expect(manifestSchema().$defs.theme.additionalProperties).toBe(false);
  expect(VOCABULARY_SCOPE).toContain("スロットを増やせません");
  // 部分テーマを作らない(required == properties)= 「1つ変えるだけでも全部書く」。
  expect(manifestSchema().$defs.theme.required.length).toBe(slots.length);
  expect(VOCABULARY_SCOPE).toContain("部分更新はできません");
});

test("V3-M1-T06 (逆向きの歯止め): 依然できないこと(任意 CSS・レイアウト・グラフ・シェル・ダークモード)が消えていない", () => {
  // **「見た目が自由に指定できるようになった」に倒れないための固定。**
  expect(CANNOT_DO).toContain("任意の CSS");
  // **【V3-M2-T05 で差し替えた】** 旧行は `toContain("レイアウトを2カラムにして")` で、
  // **「レイアウトは今日もできない」ことの証拠として使っていた。** ADR-0050 の軸5
  // (`preset_field_columns`)が入った時点でその読みは偽になり、**緑のまま意味を失った。**
  // 代わりに**今日も本当にできないこと**(選択肢の外)を固定する。
  expect(CANNOT_DO).toContain("選択肢の外は書けません");
  // グラフは依然として無い(V1-M6-T05 の固定と重なるが、テーマの追加で緩んでいないことを見る)。
  expect(CANNOT_DO).toContain("グラフの描画は依然としてありません");
  // T04 が実測した「当たらない範囲」が書かれていること(誇張の防止)。
  expect(CANNOT_DO).toContain("プラットフォームの外枠(シェル)");
  expect(CANNOT_DO).toContain("フォームコントロール");
  // ダークモード / レスポンシブは1つも足していない(ADR-0046 限定5)。
  //
  // **【V4-M55 が 2026-08-04 に追記。門外 Δ7 / 限定採用。記録 =
  // `docs/plan/v4/records/v4-m55.md`】上の1文は2つの事実を1文に丸めており、
  // レスポンシブの側は今日から偽である** —— **2026-08-04 実測: `web/src/styles.css` には
  // 幅の条件の `@media` が2本ある**(`web/src/styles.css` 逐語 `@media (min-width: 40rem)` /
  // `@media (min-width: 64rem)`。どちらも `.shell` の `padding` だけを変える)。
  // **足したのは `ADR-0089`**(`V4-M15-T07` / `D-V4-44`。2026-08-03)**で、同 ADR §Context 2 は
  // 逐語で「`ADR-0046` 限定5 を緩めている。緩めていないふりをしない」と書いている。**
  //
  // **一方でダークモードの側は今日も真である** —— 配色設定のメディア特性
  // (`prefers-color-scheme`)もテーマ切り替えの属性セレクタも1つも足しておらず、
  // `ADR-0089` が射程を引き直したのは**幅の条件の `@media` の分だけ**である。
  // **段組数・列幅が画面幅に追随しないことも今日も真である**(`:2174` の `expect` が見ている
  // 逐語がそれである)。**したがって下の `expect` は1バイトも変えない** ——
  // 見ているのは `CANNOT_DO` に「ダークモード」の語が在ることであり、そちらは今日も真だからである。
  // **旧文を1バイトも消していない**(`D-V4-188`。直し方は `ADR-0156` / `ADR-0157` と同じ形)。
  expect(CANNOT_DO).toContain("ダークモード");
  // 読めない配色は拒否される(fail-closed。D-M1-4)—— 「何色でも指定できる」に倒れない。
  expect(VOCABULARY_SCOPE).toContain("読めない配色は適用が拒否されます");
});

test("V3-M1-T06 (Δ5 (i)): 危険度の分類が5群になり、DIFF_OPS の全 op が分類の散文の中に現れる", () => {
  // **`set_theme` は既存4群のどれにも属さない**(定義もデータも消さないが、ビューの表示設定でもない)。
  // 4群のままだと、`set_theme` はどの群にも入らないまま説明文に列挙だけされる = 現に不完全である。
  // **【`V5-M17b` / `ADR-0248`】5群 → 6群。****この検査の予告どおりに 17種目が来た** ——
  // 直下のコメント逐語「手書きの列挙にすると、17種目を足した日に…素通りする」。
  // **範囲切り出しの形だったので、`set_user_kinds` の説明を足さないと実際に赤くなった。**
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】6群 → 7群。****旧行の逐語は
  // `expect(VOCABULARY_SCOPE).toContain("差分操作は6つに分かれます");` である。**
  // **`set_roles` は既存6群のどれにも属さない**(定義もデータも消さず、画面の表示設定でも、
  // 適用後に動き続けるものでも、見た目でも、利用者の種類の宣言でもない)。検査は消していない。
  expect(VOCABULARY_SCOPE).toContain("差分操作は7つに分かれます");
  expect(VOCABULARY_SCOPE).not.toContain("差分操作は5つに分かれます");
  expect(VOCABULARY_SCOPE).not.toContain("差分操作は4つに分かれます");
  expect(VOCABULARY_SCOPE).not.toContain("差分操作は3つに分かれます");
  // **分類の散文の範囲を切り出し、全 op がその中に現れることを見る。**
  // 手書きの列挙にすると、18種目を足した日に「宣言した6群は全部ある」まま素通りする。
  // **【`V8-M16`】切り出しの始点も 6 → 7 に追随させた(本体が「7つに分かれます」になったため)。**
  const start = VOCABULARY_SCOPE.indexOf("差分操作は7つに分かれます");
  const end = VOCABULARY_SCOPE.indexOf("ワークフローのアクションは");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const classification = VOCABULARY_SCOPE.slice(start, end);
  for (const op of DIFF_OPS) {
    expect(classification).toContain(op);
  }
  // **上のループだけでは足りない**(わざと壊して確認した)—— (1) の説明が「差し替えは (5) の
  // set_theme です」と参照しているので、**5群目の見出しから `set_theme` を落としても
  // 名前は範囲内に残り、ループは緑のままになる。** そこで**群の見出しが op を名指ししていること**を
  // 別に固定する。5群目は `set_theme` ただ1つの群である。
  expect(classification).toContain("(5) set_theme は");
  // **6群目も同じ形で固定する**(`V5-M17b` / `ADR-0248`)。
  expect(classification).toContain("(6) set_user_kinds は");
  // **7群目も同じ形で固定する**(`V8-M16` / `J-G1b` / `D-V8-31`)。
  expect(classification).toContain("(7) set_roles は");
});

test("V3-M1-T06 (Δ5 (ii)): 「形の注意」の宣言件数と、番号付きの注意の実数が一致する", () => {
  // **`set_theme` の形の注意を足したので件数も直す。** 件数と中身が割れたら赤くなる形にする
  // (`APPLY_DIFF_OP_EXAMPLES` の「4つの op」が ADR-0010 以降ずっと嘘だったのと同じ壊れ方を防ぐ)。
  const stated = Number(/形の注意が(\d+)ある/.exec(APPLY_DIFF_OP_EXAMPLES)?.[1] ?? "0");
  expect(stated).toBe(15);
  for (let n = 1; n <= stated; n++) {
    expect(APPLY_DIFF_OP_EXAMPLES).toContain(`(${n})`);
  }
  // 宣言した数より多く書かれていない(番号を足したのに件数を直し忘れたら赤)。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain(`(${stated + 1})`);
});

test("V3-M1-T06: set_theme の形の注意が「全スロット必須・全体差し替え・式なし・拒否」を述べている", () => {
  // 25スロット全部が必須(部分テーマを作らない。ADR-0047 2026-07-25 追記(2))。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("set_theme の theme は");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("全体差し替え");
  // 値域(限定6): calc( / var( / {{ / $record. は1つも書けない = ADR-0013 限定12 を破っていない。
  for (const forbidden of ["calc(", "var(", "{{", "$record."]) {
    expect(APPLY_DIFF_OP_EXAMPLES).toContain(forbidden);
  }
  // fail-closed(D-M1-4): 閾値未満は差分全体が拒否され、部分適用しない。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("コントラスト");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("差分全体が拒否");
});

// **V3-M2-T01(ADR-0050)でテスト名と期待値を更新した。** 旧名は「…5キーと一致し」。
// `$defs/view_changes` にプリセット7キーが門A を通って増えたので、5キーちょうどではなくなった。
// **固定の向き(説明文の列挙とスキーマのキー集合を一致させる)は1バイトも変えていない。**
// **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359`。テスト名の食い違いを先に申告する】**
// **着手前のこのテスト名は「15キー」であり、実測(着手前 25)と食い違っていた** ——
// **名前が `V3-M5-T02` 前後の値で止まっており、その後の更新に1度も追随していなかった。**
// **本タスクが26キー目を足すので、その食い違いも同時に直す。**
// **数の正は下の期待値の側であり、名前は読み手のための写しである。**
test("V3-M2-T01 + V3-M5-T02: update_view の表示設定の列挙が view_changes の26キーと一致し、テーマを含まないと述べている", () => {
  // **実装の真**: `update_view` が差し替えられるのは `$defs/view_changes` のキーだけである。
  const changes = diffSchema().$defs.view_changes;
  // **【V4-M23-T01 / `D-V4-89` / `E-G31` / ADR-0104 限定1 で 21 → 22 に更新した】**
  // 22キー目 `sum_field`(合計を出す列。**list_view でだけ書ける**)が加わった。
  // **列挙を消さずに1行足して更新した** —— 固定の向きは1バイトも変えていない。
  // **【V5-M21-T03 / `L-G4` / ADR-0172 限定1 で 22 → 23 に更新した】** 23キー目 `actions`
  // (操作起点。**list_view / detail_view で書ける**)が加わった。**列挙を消さずに1行足して
  // 更新した** —— 固定の向きは1バイトも変えていない。**`related` / `audience` は今日も無い。**
  expect([...Object.keys(changes.properties)].sort()).toEqual([
    "actions",
    // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` §4a 限定2・限定10 で 25 → 26 に
    // 更新した】** 26キー目 `after_delete`(削除が成立したあとの行き先。**detail_view でだけ
    // 書ける**。**行き先にできるのは `list_view` / `report_view` だけである**)が加わった。
    // **列挙を消さずに1行足して更新した** —— 固定の向きは1バイトも変えていない。
    // **見せ方のキーではない** —— **意味は遷移である**(`after_save` と同じ)。
    "after_delete",
    // **【V4-M20-T04 / `E-G34` / ADR-0102 限定1 で 20 → 21 に更新した】** 21キー目
    // `after_save`(保存が成立したあとに行く画面。**form でだけ書ける**)が加わった。
    // **【2026-08-20。`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1】直前の逐語
    // 「form でだけ書ける」は今日は偽である** —— **門A の本審査(`V10-M0` 群A。判定 = 限定採用)が
    // `detail_view` 分岐の `"after_save": false,` を外した。****今日は `form` と
    // `detail_view` の2種別で書ける**(`list_view` / `report_view` には今日も書けない)。
    // **旧文を1バイトも消していない。**
    // **列挙を消さずに1行足して更新した** —— 固定の向きは1バイトも変えていない。
    // **見せ方のキーではない** —— **意味は遷移である。**
    "after_save",
    "columns",
    // **V3-M5-T02(D-G5 / ADR-0055 改訂1)で13キー目に増えた**(逃げ道の参照)。
    // **列挙を消さずに1行足して更新した** —— 固定の向き(説明文とスキーマを一致させる)は
    // 1バイトも変えていない。
    "custom_css",
    // **V4-M16-T12(`P-G17` の (C) 側 / ADR-0092 限定2)で15キー目に増えた**
    // (詳細画面の項目のまとまり。**detail_view でだけ書ける**)。**列挙を消さずに1行足して
    // 更新した** —— 固定の向き(説明文とスキーマを一致させる)は1バイトも変えていない。
    "field_groups",
    "fields",
    "filter",
    // **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` §Decision 2 で 26 → 27 に
    // 更新した】** 27キー目 `flow`(一続きの流れの中の段。**`list_view` / `form` /
    // `detail_view` の3種別で書ける**。**集計表には書けない**)が加わった。
    // **列挙を消さずに1行足して更新した** —— 固定の向きは1バイトも変えていない。
    // **見せ方のキーではない** —— **意味は並びの中の位置である。**
    "flow",
    // **V4-M10-T45(E-G12 / ADR-0084 限定6)で14キー目に増えた**(画面一覧への掲載の可否)。
    // **列挙を消さずに1行足して更新した** —— 固定の向きは1バイトも変えていない。
    "menu_listed",
    // **V4-M18-T03(`P-G14` の (C) 側 / ADR-0095 限定6)で17キー目に増えた**
    // (重ねて出す宣言。**form でだけ書ける**)。**列挙を消さずに1行足して更新した** ——
    // 固定の向き(説明文とスキーマを一致させる)は1バイトも変えていない。
    "modal",
    "name",
    // **【V4-M22-T05 / ADR-0113 限定2 で 18 → 19 に更新した】** `update_view` にも19キー目
    // `page_size`(1ページに出す件数。**list_view でだけ書ける**)が加わった。**列挙を消さずに
    // 1行足して更新した** —— 固定の向き(説明文とスキーマを一致させる)は1バイトも変えていない。
    "page_size",
    "preset_column_align",
    "preset_column_width",
    // **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** 20キー目 `preset_density`
    // (画面の詰まり具合。**3種すべてで書ける**)が加わった。**列挙を消さずに1行足して
    // 更新した** —— 固定の向き(説明文とスキーマを一致させる)は1バイトも変えていない。
    // **本 ADR の増分ではない。**
    "preset_density",
    "preset_field_columns",
    "preset_image_size",
    "preset_label_placement",
    // **V4-M16-T13(`P-G24` の (C) 側 / ADR-0093 限定2)で16キー目に増えた**
    // (一覧の器の形。**list_view でだけ書ける**)。**列挙を消さずに1行足して更新した** ——
    // 固定の向き(説明文とスキーマを一致させる)は1バイトも変えていない。
    "preset_list_shape",
    "preset_pager_position",
    "preset_text_preview",
    // **【`V6-M2-T02` / `K-G3` / `ADR-0289` 限定1 で 23 → 24 に更新した】** 24キー目
    // `reference_pickers`(参照項目の選び方の、入力画面ごとの上書き。**form でだけ書ける**)が
    // 加わった。**列挙を消さずに1行足して更新した** —— 固定の向きは1バイトも変えていない。
    "reference_pickers",
    // **【2026-08-14。`V8-M8`(台帳 `Q-G1`。門A 本審査 = `V8-M7`)で25キー目に増えた】**
    // (集計表の中身。**`report_view` でだけ書ける**)。**列挙を消さずに1行足して更新した**
    // —— 固定の向き(説明文とスキーマを一致させる)は1バイトも変えていない。
    "report",
    // **V4-M22-T01(`E-G7` の (C) 側 / ADR-0112 限定2)で18キー目に増えた**
    // (検索の対象にする列。**list_view でだけ書ける**)。**列挙を消さずに1行足して
    // 更新した** —— 固定の向き(説明文とスキーマを一致させる)は1バイトも変えていない。
    "search_fields",
    "sort",
    // **【V4-M23-T01 / `D-V4-89` / `E-G31` / ADR-0104 限定1 で 21 → 22 に増えた】**
    // (合計を出す列。**list_view でだけ書ける**)。**列挙を消さずに1行足して更新した** ——
    // 固定の向き(説明文とスキーマを一致させる)は1バイトも変えていない。
    "sum_field",
  ]);
  expect(changes.additionalProperties).toBe(false);
  // 記述: 15キーちょうどを列挙し、**テーマのスロットはここに書けない**ことを述べる
  // (テーマはビュー単位ではなくアプリ単位である = ADR-0047 限定1。**プリセットは
  // テーマではない** —— 色・書体・長さの実値を1つも持たず、値域はすべて enum である)。
  expect(VOCABULARY_SCOPE).toContain("name / columns / sort / filter / fields");
  for (const key of [
    "preset_column_align",
    "preset_column_width",
    "preset_pager_position",
    "preset_label_placement",
    "preset_field_columns",
    "preset_image_size",
    "preset_text_preview",
  ]) {
    expect(VOCABULARY_SCOPE, key).toContain(key);
  }
  // **V3-M2-T05 で字面を直した**(旧: 「見た目のスロットはここに書けません」)—— プリセットは
  // 見た目でありながら**ここに書ける**ので、旧字面のままだと逆向きの嘘になる。書けないのは
  // **テーマのスロット(配色・書体・余白の実値)**だけである。
  expect(VOCABULARY_SCOPE).toContain("配色・書体・余白のスロットはここに書けません");
  // 逆向き: ビュー単位テーマが生えていないこと(生えたら ADR-0047 §3a 3 の門を通していない)。
  expect(manifestSchema().$defs.view.properties.theme).toBeUndefined();
});

test("V3-M1-T06: OUT_OF_SCOPE_BEHAVIOR は「見た目の変更の代わりに columns と sort」という旧代替案を主張していない", () => {
  // **旧文言は「見た目は変えられないから代わりに項目と並び順を変える」だった。**
  // 配色・書体・余白は**代替ではなく本当に変えられる**ので、この代替案は嘘である。
  expect(OUT_OF_SCOPE_BEHAVIOR).not.toContain(
    "見た目の変更の代わりに、ビューの columns と sort で表示する項目と並び順を変える",
  );
  // 新しい代替案: 配色・書体・余白なら set_theme で実際に変えられる(代替ではない)と述べ、
  // **レイアウト(段組・列幅)と任意 CSS についてだけ代替案を出す**。
  expect(OUT_OF_SCOPE_BEHAVIOR).toContain("set_theme");
  expect(OUT_OF_SCOPE_BEHAVIOR).toContain("レイアウト");
});

// --- V3-M1-T06 条件14: `update_view` が差し替えられるキーの列挙を、文書側にも固定する -------
//
// **これは v2 由来の陳腐化であり `set_theme` 起因ではない。** ADR-0042 が `limit`、ADR-0044 が
// `related`、ADR-0045 が `actions` を**ビュー定義**に足したとき、**`$defs/view_changes` は
// 広げなかった**(意図的な限定である)。ところが `docs/manual.md` §4.3 の表は
// 「`update_view` は …/ `actions` / `related` / `limit` を差し替える」と書いており、
// **`actions` / `related` / `limit` を `update_view` で差し替えようとすると実際には拒否される。**
//
// **上の「V3-M1-T06: update_view の表示設定の列挙が…」は `src/mcp/vocabulary.ts`(AI が読む
// 説明文)側を固定している。ここは同じ5キーを利用者向け文書側にも掛ける** —— 片側だけ
// 固定すると、もう片方が黙って食い違う(それが今回まさに起きていたことである)。
//
// **正準スキーマを `readFileSync` で読むだけで、import は1つも増やしていない。**

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った 補助関数 `enumeratedViewChangeKeys` は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った test「V3-M2-T01 (条件10) + V3-M5-T02」 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った test「V3-M1-T06 (条件14 逆向き)」 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

// --- V3-M2-T05: 画面ごとのプリセット(7軸19値)が入った(ADR-0050 / 0051。Δ5)---------------
//
// **T01 で `$defs/view` と `$defs/view_changes` にプリセットの7キーが入り、T02〜T04 でそれが
// 実際に画面へ当たった**(chromium 実測。19値すべて)。この時点で
// 「段組・列幅・寄せを指す語彙は1つもなく」「画面ごとの見た目も指定できません」という
// **全否定は嘘になった。**
//
// **だが全部消すと逆向きの嘘になる**(V3-M1-T06 と同じ形)—— 依然できないのは
// **任意の CSS / ピクセル座標・絶対配置 / レスポンシブ・ダークモード / 入力フォームの見せ方 /
// 1ページの件数 / 画面ごとの配色 / 02 §1 の (C) 群22軸**であり、できるようになったのは
// **7つの軸を、画面ごとに、有限の選択肢(全部で19)から選ぶこと**だけである。
// **したがって両方向を別々のテストで固定する。**
//
// **数の照合を「散文」に任せない。** 軸の数(7)も値の総数(19)も `src/mcp/vocabulary.ts` の
// 散文であり自動追随しない(スロット数25 と同じ形)。**正準スキーマをこのテストが読み、
// 散文の数と突き合わせる**(`readFileSync` + `JSON.parse` のみ。**import は1つも増やさない** ——
// 増やすと `scripts/kernel-import-snapshot.txt` が動く)。

/** `$defs/view` のプリセットキー(実装の真)。 */
function presetKeys(): string[] {
  return Object.keys(manifestSchema().$defs.view.properties)
    .filter((key: string) => key.startsWith("preset_"))
    .sort();
}

/** 7軸の enum 値を軸ごとに返す(列ごとのマップは `additionalProperties` の側にある)。 */
function presetEnums(): Record<string, unknown[]> {
  const properties = manifestSchema().$defs.view.properties;
  const out: Record<string, unknown[]> = {};
  for (const key of presetKeys()) {
    const schema = properties[key];
    const valueSchema = schema.type === "object" ? schema.additionalProperties : schema;
    out[key] = valueSchema.enum as unknown[];
  }
  return out;
}

test("V3-M2-T05 (記述→実装): 説明文は「レイアウト/画面ごとの見せ方は指定できない」という全否定を主張していない(Δ5)", () => {
  // **文言そのものを禁止しておかないと、将来の編集で静かに戻ってくる**(V3-M1-T06 と同じ規律)。
  // T02〜T04 が chromium で19値すべての描画差を実測した以上、これらの全否定は嘘である。
  for (const lie of [
    "段組・列幅・寄せ・要素の配置を指す語彙は1つもなく",
    "レイアウト(段組・列幅・寄せ・要素の配置)を指す語彙も",
    "画面ごとの見た目も指定できません",
    "レイアウト(段組・列幅・寄せ)と任意の CSS は語彙に無いので",
    "画面のレイアウトと任意の CSS はありません",
    "レイアウトは指定できません",
    "画面ごとには何も指定できません",
  ]) {
    expect(VOCABULARY_SCOPE, lie).not.toContain(lie);
    expect(CANNOT_DO, lie).not.toContain(lie);
    expect(OUT_OF_SCOPE_BEHAVIOR, lie).not.toContain(lie);
  }
  // 総括の側からも「画面レイアウト」の全否定が外れていること(**任意の CSS は残す**)。
  expect(CANNOT_DO).not.toContain("任意の CSS と画面レイアウト・画面/項目単位の権限");
});

// **【V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定1 による更新】** 8つ目の軸
// (`preset_list_shape`。一覧の器の形)が門A の本審査(`V4-M14` 本審査② の単位11。
// 判定 = 限定採用 / 審査記録 = `docs/plan/v4/records/v4-m14-gate-a-list-shape.md`)を
// 通ったので 7 → 8 にした。**固定の向き(スキーマに在るキーは説明文にも必ず現れる)は
// 1バイトも変えていない。**
// **【V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1 で 8 → 9 に更新した】** 9つ目の軸
// (`preset_density`。画面の詰まり具合)が門A の本審査(V4-M19 単位C。2回目の審査。
// 判定 = 限定採用)を通った。**本 ADR の増分ではない。**
test("V3-M2-T05 (実装→記述): 説明文が8つのプリセットキーと各軸の選択肢を名指ししている", () => {
  const keys = presetKeys();
  expect(keys.length).toBe(9);
  // 実装→記述: スキーマに在るキーは、AI が読む説明文にも必ず現れる。
  for (const key of keys) {
    expect(VOCABULARY_SCOPE, key).toContain(key);
  }
  // 各軸の**文字列の**選択肢がすべて説明文に現れる(数値の 1 / 2 は下の段組の記述が持つ)。
  const enums = presetEnums();
  for (const [key, values] of Object.entries(enums)) {
    for (const value of values) {
      if (typeof value !== "string") continue;
      expect(VOCABULARY_SCOPE, `${key}=${value}`).toContain(value);
    }
  }
  // 段組数は整数 enum なので、値そのものではなく「1 / 2」という書き方で述べる。
  expect(enums.preset_field_columns).toEqual([1, 2]);
  expect(VOCABULARY_SCOPE).toContain("項目の段組数(1 / 2)");
});

// **【V4-M10-T36 / `E-G13` / ADR-0085 限定3・限定9 による更新】** 軸7 の値域が 3 → 4 に
// なったので、テスト名と期待値を 19 → 20 にした。**軸の本数(7)は1つも動いていない** ——
// **8つ目の軸を足す提案は今日も `ADR-0050` §3a 3 の門A である**(`ADR-0085` §Decision 5 の 1)。
// **仕掛けは意図どおり働いた** —— 散文が黙って古くならず、この検査が赤で止めた。
// **【V4-M16-T13 / ADR-0093 限定1 / 限定3 による更新】** 8つ目の軸(2値)が入ったので、
// テスト名と期待値を 7軸20値 → 8軸22値 にした。**仕掛けは今日も意図どおり働いた** ——
// 散文が黙って古くならず、この検査が赤で止めた。
// **【V4-M19-T03 / ADR-0118 限定1 / 限定3 による更新】** 9つ目の軸(2値)が入ったので、
// テスト名と期待値を 8軸22値 → 9軸24値 にした。**仕掛けは今日も意図どおり働いた** ——
// 散文が黙って古くならず、この検査が赤で止めた。**本 ADR の増分ではない。**
test("V3-M2-T05 (数の照合): 散文の「8軸・全部で22の選択肢」がスキーマの実数と一致する", () => {
  const enums = presetEnums();
  const axes = Object.keys(enums).length;
  const total = Object.values(enums).reduce((sum, values) => sum + values.length, 0);
  expect(axes).toBe(9);
  expect(total).toBe(24);
  // **散文の数がスキーマと食い違ったら赤くなる**(スロット数25 の照合と同じ形)。
  expect(VOCABULARY_SCOPE).toContain(`${axes}軸・全部で${total}の選択肢`);
  expect(CANNOT_DO).toContain(`全部で${total}`);
  // 誤った数(メインが T04 の指示で書いた 21)が紛れ込んでいないこと。
  expect(VOCABULARY_SCOPE).not.toContain("全部で21");
  expect(CANNOT_DO).not.toContain("全部で21");
});

test("V3-M2-T05 (逆向きの歯止め): 「レイアウトが自由に指定できる」に倒れていない", () => {
  // **「有限の選択肢の中だけ」を外した書き方を禁止する。**
  for (const overclaim of [
    "レイアウトを自由に",
    "見た目を自由に",
    "自由に指定できます",
    "好きなように配置",
    "任意のレイアウト",
    "CSS を書けます",
  ]) {
    expect(VOCABULARY_SCOPE, overclaim).not.toContain(overclaim);
    expect(CANNOT_DO, overclaim).not.toContain(overclaim);
    expect(OUT_OF_SCOPE_BEHAVIOR, overclaim).not.toContain(overclaim);
  }
  // **依然できないことが具体で残っていること**(消えたら「何でもできる」に倒れる)。
  expect(CANNOT_DO).toContain("任意の CSS");
  expect(CANNOT_DO).toContain("ピクセル座標");
  expect(CANNOT_DO).toContain("絶対配置");
  expect(CANNOT_DO).toContain("ダークモード");
  expect(CANNOT_DO).toContain("レスポンシブ");
  // 段組も列幅も画面幅に追随しない(`@media` を1つも足していない。ADR-0050 限定9)。
  // **【V4-M53 が 2026-08-04 に追記。門A / 限定採用。ADR-0157】上のコメントの括弧の中は
  // 今日から偽である** —— **2026-08-04 実測: `web/src/styles.css:913` / `:919` に幅の条件の
  // `@media` が2本ある**(`(min-width: 40rem)` / `(min-width: 64rem)`。どちらも `.shell` の
  // `padding` だけを変える)。**足したのは `ADR-0089`**(`V4-M15-T07` / `D-V4-44`。2026-08-03)。
  // **一方で帰結(段組も列幅も画面幅に追随しない)は今日も真である** —— **段組・列幅の規則は
  // 2本の `@media` の内側に1つも入っていない**(`web/test/preset-boundary.test.ts` の `(vi-5)`)。
  // **したがって下の `expect` の逐語は1バイトも変えない。旧文も1バイトも消していない。**
  expect(CANNOT_DO).toContain("画面幅に追随しない");
  // 1ページの件数は今日も指定できない(ADR-0042 限定6 / §3a-4 は1バイトも動いていない)。
  expect(CANNOT_DO).toContain("1ページの件数");
});

test("V3-M2-T05 (実装→記述): 画面ごとの配色は今日もできない(ビュー単位テーマが生えていない)", () => {
  // 実装の真: `$defs/view` にテーマのキーが1つも無い(ADR-0047 限定1 の趣旨。ADR-0050 の4点目)。
  const viewKeys = Object.keys(manifestSchema().$defs.view.properties);
  expect(viewKeys.filter((key) => key.includes("theme"))).toEqual([]);
  // 記述: **プリセットが入ってもテーマはアプリ単位のままである**ことを述べる。
  expect(CANNOT_DO).toContain("画面ごとの配色は今もできません");
  expect(VOCABULARY_SCOPE).toContain("テーマは**アプリ単位**です");
});

/**
 * **【`V4-M16-T11` / `P-G29` / `ADR-0091` 限定8 で書き換えた】**
 *
 * **着手前の本テストは題「form には7軸とも書けない ⇔ 説明文が『入力フォームの見せ方は
 * 選べません』と述べる」で、form 分岐の7キーすべてが `false` であることを見ていた。**
 * **`ADR-0091`(門A / 判定 = 限定採用)が2軸を通したので、その形では実装と食い違う。**
 *
 * **見る向き(実装 → 記述)は1バイトも変えていない** —— **今日の実装(2軸だけ書ける)と、
 * 今日の説明文(2軸だけ書けると述べる)が食い違わないことを、両側から見る。**
 */
test("V4-M16-T11 (実装→記述): form に書けるのは2軸だけ ⇔ 説明文が「残る6軸は選べない」と述べる", () => {
  // 実装の真1: `$defs/view` の `allOf` の form 分岐が**残る5キーだけ**を `false` にしている。
  const branches = manifestSchema().$defs.view.allOf;
  const form = branches.find((branch: Any) => branch.if?.properties?.type?.const === "form");
  expect(form).toBeDefined();
  // **【V4-M19-T03 / ADR-0118 限定1 / 限定6 で3軸目が通った】** `preset_density`
  // (画面の詰まり具合)は**プリセットが1軸も当たらない form こそ当たり先の1つ**として
  // 3種すべてに通した(限定6)。**`残る6軸`(旧5軸から `ADR-0093` で6軸になった集合)は
  // 1バイトも動いていない** —— `preset_density` はその6軸に元から居ない(本 ADR で
  // 新規に増えた9つ目の軸である)。**本 ADR の増分ではない。**
  const passed = ["preset_label_placement", "preset_field_columns", "preset_density"];
  for (const key of presetKeys()) {
    if (passed.includes(key)) {
      // **通した3軸は分岐から消えている**(`false` のままだと「書けるが拒否される」)。
      expect(form.then.properties[key], key).toBeUndefined();
    } else {
      expect(form.then.properties[key], key).toBe(false);
    }
  }
  // 実装の真2: **`ADR-0091` の増分は今日も0キー0値である**(限定1 / 限定2)。
  // **【V4-M16-T13 / ADR-0093 限定1 で 7 → 8 に更新した】** 軸を増やしたのは `ADR-0093` の
  // 側であって `ADR-0091` ではない。**`ADR-0093` は form に1軸も通していない**ので、
  // form で書けない軸は 5 → 6 になった。
  // **【V4-M19-T03 / ADR-0118 限定1 で 8 → 9 に更新した】** 9つ目の軸(画面の詰まり具合)が
  // 門A を通って増えた。**本 ADR の増分ではない。**
  expect(presetKeys()).toHaveLength(9);
  // 記述1: できないことの側に、フォームが名指しで残っている(残る6軸は今日も書けない)。
  expect(CANNOT_DO).toContain("入力フォームの見せ方");
  expect(CANNOT_DO).toContain("残る6軸");
  // 記述2: **「1軸も書けない」という旧い言い方が復活していないこと**(双方向の歯止め)。
  expect(CANNOT_DO).not.toContain("7軸が1つも書けない");
  expect(VOCABULARY_SCOPE).not.toContain("入力フォーム(form)には1軸も書けません");
  // 記述3: **通した3軸が語彙の説明に名指しで載っていること**(できることを隠さない)。
  // **【V4-M19-T03 / ADR-0118 限定1 で「2軸だけ」が「3軸だけ」になった】** `preset_density`
  // が3軸目として加わった。**本 ADR の増分ではない。**
  expect(VOCABULARY_SCOPE).toContain("項目名と値の向きと項目の段組数と画面の詰まり具合の3軸だけ");
});

test("V3-M2-T05 (1a): プリセットのキーを前進で消す手段が語彙に無い ⇔ 説明文がそれを述べる", () => {
  // 実装の真1: **キーを消す差分操作を1つも足していない**(`DIFF_OPS` は16のまま)。
  // **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 17 → 18 に書き換えた —— 18種目 `set_roles` を足したため。検査は消していない。**
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】期待値を 18 → 17 に**
  // **書き換えた。****旧行の逐語は `expect(DIFF_OPS.length).toBe(18);` である。**
  // **減らしたのは別の決定(`set_user_kinds` の廃止)である。****検査は消していない。**
  expect(DIFF_OPS.length).toBe(17); // 【`V5-M17b` / `ADR-0248`】16 → 17(`set_user_kinds` が17種目)/【`V8-M16`】17 → 18(`set_roles` が18種目)/【`V8-M29`】18 → 17(`set_user_kinds` を廃止)。**この行が固定していたのは「その決定が語彙を増やさなかったこと」であり、増やしたのは別の決定である。**
  expect([...DIFF_OPS].filter((op) => op.includes("preset"))).toEqual([]);
  // 実装の真2: **「既定へ戻す」を表す値が enum に1つも無い**(足すのは ADR-0050 §3a 3 の門A)。
  for (const [key, values] of Object.entries(presetEnums())) {
    for (const reset of ["default", "none", "unset", "auto", "reset"]) {
      expect(values as unknown[], `${key} の ${reset}`).not.toContain(reset);
    }
  }
  // 実装の真3: **null を書いて消すこともできない**(値域が enum なので null は型不正で拒否される)。
  const changes = diffSchema().$defs.view_changes.properties;
  for (const key of presetKeys()) {
    expect(changes[key], key).toBeDefined();
    expect(JSON.stringify(changes[key]), key).not.toContain('"null"');
  }
  // 記述: 外せないことと、外す唯一の道(undo)を述べる。
  expect(VOCABULARY_SCOPE).toContain("一度書いたプリセットのキーは、前進では外せません");
  expect(VOCABULARY_SCOPE).toContain("消すには undo");
});

test("V3-M2-T05 (1a): 「書く前の見え方へ前進で戻せるか」が軸ごとに違うことを具体で述べている", () => {
  // **「戻せる」でも「戻せない」でも丸めない**(chromium 実測。V3-M2-T05 の記録 §3)。
  // 戻せる側(既定と同じ描画になる値が enum に在る)。
  expect(VOCABULARY_SCOPE).toContain("項目名と値の向き(inline)");
  expect(VOCABULARY_SCOPE).toContain("image の表示サイズ(original)");
  expect(VOCABULARY_SCOPE).toContain("long_text の切り詰め長(standard)");
  // 戻せない側(既定がどの enum 値とも一致しない / 一致しないことを実測した)。
  expect(VOCABULARY_SCOPE).toContain("件数表示とページャの位置");
  expect(VOCABULARY_SCOPE).toContain("項目の段組数は戻せません");
  // 逆向き: 「いつでも元に戻せます」と丸めていないこと。
  expect(VOCABULARY_SCOPE).not.toContain("いつでも元に戻せます");
});

test("V3-M2-T05 (1a): 型とプリセットの対応をスキーマが1つも検査していない ⇔ 説明文がそれを述べる", () => {
  // **実装の真**: `$defs/view`(プリセットの置き場)は**フィールド型の名前を1つも参照していない。**
  // 参照が0件である以上、「image 列が無い画面に image のサイズを書けない」形は作りようがない。
  const view = manifestSchema().$defs.view;
  /**
   * **JSON Schema 自身の `type` キーワードが取る原始型の名前**(2026-08-03 実測で
   * `$defs/view` に現れるのは object / array / string / integer / boolean の5つ)。
   *
   * **【V4-M10-T45 / `E-G12` / ADR-0084 による更新】** **`menu_listed` が
   * `{"type": "boolean"}` なので、素朴な文字列検索では `FIELD_TYPES` の `boolean` に
   * 当たってしまう。** **これは偶然の同名であって、フィールド型への参照ではない** ——
   * `"type": "boolean"` は「この JSON 値は真偽値である」という schema の語であり、
   * 「このフィールドは boolean 型である」ではない。**そこで `type` キーワードの値が
   * 原始型の名前であるときだけ印に置き換える。** **本テストが守る主張(プリセットの置き場が
   * フィールド型を1つも参照していない)は1ミリも緩んでいない** —— `enum` / `const` /
   * `$ref` / プロパティ名の側は1バイトも除いていない。
   */
  const JSON_SCHEMA_PRIMITIVES = ["object", "array", "string", "integer", "number", "boolean"];
  const strip = (node: Any): Any => {
    if (Array.isArray(node)) return node.map(strip);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => key !== "$comment" && key !== "description")
          .map(([key, value]) => [
            key,
            key === "type" && typeof value === "string" && JSON_SCHEMA_PRIMITIVES.includes(value)
              ? "<json-schema-primitive>"
              : strip(value),
          ]),
      );
    }
    return node;
  };
  const structure = JSON.stringify(strip(view));
  for (const type of FIELD_TYPES) {
    expect(structure, type).not.toContain(`"${type}"`);
  }
  // 記述: **書けるが効かない組み合わせがある**ことを正直に述べる(憲法6)。
  expect(VOCABULARY_SCOPE).toContain("型とプリセットの対応は1つも検査しません");
});

test("V3-M2-T05 (逆向き): OUT_OF_SCOPE_BEHAVIOR が7軸を「代替案」として扱っていない", () => {
  // **旧文言は「レイアウトは語彙に無いので columns と sort を代わりに出す」だった。**
  // 7軸は代替ではなく本当に選べるので、この案内は嘘である。
  expect(OUT_OF_SCOPE_BEHAVIOR).not.toContain(
    "それに対しレイアウト(段組・列幅・寄せ)と任意の CSS は語彙に無いので",
  );
  // 新しい案内: 7軸は update_view で実際に変える / 代替案が要るのは選択肢の外だけである。
  expect(OUT_OF_SCOPE_BEHAVIOR).toContain("update_view");
  expect(OUT_OF_SCOPE_BEHAVIOR).toContain("選択肢の外");
  // **代替案そのものが消えていないこと**(逆向き)—— columns / sort の案は今も要る。
  expect(OUT_OF_SCOPE_BEHAVIOR).toContain("columns と sort");
});

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った test「V3-M2-T05 (文書側)」 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

// --- V3-M3-T06(ADR-0053 / Δ5): ロールに応じた画面の出し分けが入ったことの双方向の歯止め ----
//
// **何が起きたか**: `V3-M3-T04`(D-G12b。ユーザ決定 D-M3-1 =「隠す」)が
// 「顧客に 403 になるテーブルの画面を一覧に出さない」を入れた。その結果 `CANNOT_DO` の総括
// 「これら(… **画面/項目単位の権限**)は**存在しない機能**で、ツールの組み合わせによる
// 回避策もありません」は**偽になった** —— 画面単位の可視性は実在し、しかも当たり先は
// AI が既存語彙(`add_field` の text / boolean)で足せる予約規約フィールドで動く。
//
// **全部消すと逆向きの嘘になる**(「画面ごとに可視ロールを指定できる」)ので、
// **M3-T02 / V2-M1-T06 / V3-M1-T06 / V3-M2-T05 と同型の双方向**で固定する:
//   (a) 実装→記述: 出し分けが実在することと、その当たり先(`st_owner` / `st_public`)が
//       消えないこと。判定の真は `nonAdminTableAccess` 1本なので、そこから引く。
//   (b) 記述→実装: 旧総括の字面が復活しないこと。
//   (c) 逆向き: 「画面ごとの権限が作れる」に倒れないこと —— 顧客限定であること・
//       項目単位は今日も無いこと・**UI が隠すことは遮断ではない**ことが消えないこと。

/** 検査用の最小テーブル(判定に効くのはフィールドの id / type / required だけである)。 */
function tableWithFields(fields: { id: string; type: string; required?: boolean }[]) {
  return {
    id: "t",
    name: "T",
    // biome-ignore lint/suspicious/noExplicitAny: 判定に効く3属性だけを持つ最小形
    fields: fields as any,
    // biome-ignore lint/suspicious/noExplicitAny: 同上
  } as any;
}

test("V3-M3-T06 (a): nonAdminTableAccess の3分類 ⇔ CANNOT_DO がその3つを述べている(実装→記述の歯止め)", () => {
  // **実装の真**: 顧客から見たテーブルの可否は `nonAdminTableAccess` 1本で決まる
  // (`src/server/owner-scope.ts`)。web はこれを再実装せず import している(V3-M3-T04 の案(i))。
  //
  // =====================================================================================
  // **【`V8-M27-T04`(2026-08-11)。台帳 `T-G5` / ユーザ決定 `D-V8-38`。
  //   期待値を反転させた。旧の期待値を逐語で残す。検査は消していない】**
  //
  // **旧の期待値(逐語)**:
  //   expect(nonAdminTableAccess(tableWithFields([{ id: OWNER_FIELD, type: "text" }]))).toBe("scoped");
  //   expect(nonAdminTableAccess(tableWithFields([{ id: PUBLIC_FIELD, type: "boolean" }]))).toBe("public");
  //   expect(nonAdminTableAccess(tableWithFields([{ id: "title", type: "text" }]))).toBe("denied");
  //
  // **`nonAdminTableAccess` は撤去された** —— **「実装の真」を引く先が無くなったので、
  // 実装の側は「予約規約フィールドの定数がまだ在ること」で引く**(記述が指しているのは
  // その2本の綴りであり、そちらは1バイトも変わっていない)。
  //
  // **記述の側は旧文を1バイトも消していない**(このリポジトリの作法)ので、
  // **旧の4本の `toContain` はそのまま残す** —— **その代わり、日付つきの訂正が
  // 本文に在ることを新しく要求する。** **訂正を書かずに旧文だけを残したら赤になる。**
  // =====================================================================================
  expect(OWNER_FIELD).toBe("st_owner");
  expect(PUBLIC_FIELD).toBe("st_public");

  // **記述の側**: 3分類の当て先(予約規約フィールドの id)が定数と逐語で一致すること。
  // 実装側で id を改名すると、記述を直すまで赤のままになる。
  expect(CANNOT_DO).toContain(OWNER_FIELD);
  expect(CANNOT_DO).toContain(PUBLIC_FIELD);
  // denied のテーブルは 403 で遮断され、**その画面が一覧に並ばない**(V3-M3-T04)。
  expect(CANNOT_DO).toContain("運営テーブルは 403");
  expect(CANNOT_DO).toContain("顧客には、上で 403 になる運営テーブルの画面が一覧に並びません");
  // **【`V8-M27-T04`】旧文の直後に日付つきの訂正が在ること(旧文を残す作法の対)。**
  expect(CANNOT_DO).toContain(
    "**(2026-08-11 の訂正)直前の2文は今日は正しくありません** —— " +
      "**「運営かどうか」でテーブルの可否を決める仕組みは撤去されました。**",
  );
  expect(CANNOT_DO).toContain(
    "**(2026-08-11 の訂正)直前の1文は今日は正しくありません** —— " +
      "**画面が一覧に並ぶかどうかを決めるのは、役割ごとの規則(app.roles[].rules)です。**",
  );
  expect(CANNOT_DO).toContain(
    "**(2026-08-11 の訂正)直前の括弧の中は今日は正しくありません** —— " +
      "**「顧客なら運営テーブルは 403」という判定は撤去されました。**",
  );
});

test("V3-M3-T06 (b): CANNOT_DO の総括から「画面単位の権限は存在しない」という旧字面が消えている(記述→実装の歯止め)", () => {
  // **旧文言(ADR-0052 が置いたもの)**:
  //   「これら(グラフ・任意の外部データ取り込み・任意の CSS と選択肢の外のレイアウト・
  //     画面/項目単位の権限)は存在しない機能で、ツールの組み合わせによる回避策もありません」
  // **V3-M3-T04 の後は偽である。**復活したら赤になる。
  expect(CANNOT_DO).not.toContain("画面/項目単位の権限)は存在しない機能");
  expect(CANNOT_DO).not.toContain("画面/項目単位の権限");
  // 新しい総括は「項目単位」と「AI が宣言する画面単位」に狭めてある(どちらも今日も真)。
  expect(CANNOT_DO).toContain("項目単位の権限と、AI が宣言する画面単位の表示権限");
});

test("V3-M3-T06 (c) → V4-M3-T07: 射程を誇張せず、逆向きの嘘にも倒れていない", () => {
  // **【V4-M3-T07 による書き直し】** 旧 1 と 3 の逐語は偽になったので上のテストが引き取った。
  // **ここに残すのは、今日も真である射程の主張と、消してはならない正直さの2点である。**
  //
  // 1. **規約の反映による出し分けの射程は今日も customer 限定である**(V3-M0 審査記録 §5 S3-5)。
  //    **画面ごとの出し分けはそれとは別の仕組みであり、混ぜて書かない。**
  expect(CANNOT_DO).toContain(
    "**規約の反映で減るのは顧客のときだけです**(閲覧 / 編集 / 管理では1画面も減りません)",
  );
  // **【`V8-M20`。台帳 `J-G27` / `J-G28`。手続きは `ADR-0301`】期待値を書き換えた。旧値を残す** ——
  //   旧: `"audience を書いた画面は、そこに挙げなかった相手からは誰であっても減ります"`
  //   新: `"役割の規則が名指しした画面は、その規則で許されていない相手からは誰であっても減ります"`
  //   旧: `"**audience を書いても、テーブルの URL そのものが閉じるわけではありません**"`
  //   新: `"**項目や画面に規則を書いても、テーブルの URL そのものが閉じるわけではありません**"`
  // **後者は 2026-08-10 に実物で確かめたうえで書き足しがある** —— **テーブルを閉じるのは
  // 対象 table の規則だけで、そのときの応答は 403 ではなく「一覧は空・単件は 404」である**
  // (`src/server/app.ts` の逐語「読めない表は 403 にしない —— 応答から落とす」)。
  expect(CANNOT_DO).toContain(
    "役割の規則が名指しした画面は、その規則で許されていない相手からは誰であっても減ります",
  );
  // 2. **UI が隠すことを遮断と読ませない**(最終防衛線はサーバの 403 である。ADR-0053:41)。
  expect(CANNOT_DO).toContain("画面に出さないことは遮断ではありません");
  expect(CANNOT_DO).toContain(
    "**項目や画面に規則を書いても、テーブルの URL そのものが閉じるわけではありません**",
  );
  expect(CANNOT_DO).toContain("その場合でも応答は 403 ではなく、一覧が空・単件が 404 になります");
  // 3. **AI が既存語彙で可視性を動かせてしまうことを隠さない**(憲法6。誇張の反対向き)。
  expect(CANNOT_DO).toContain("AI が足した1フィールドで顧客に見える画面が変わることはあります");
});

test("V3-M3-T06 (d): 「可視ロールを書くキーは無い」⇔ $defs/view のキー集合が増えていない", () => {
  // 上の (c) 1 の文を、スキーマの実物に錨で留める。**案(iii)(`view.roles`)を採れば
  // Δ3 + Δ5 で門A である**(V3-M3-T00 の審査記録)。ここが赤くなったら、文言ではなく
  // 門の側を先に通すこと。全 `$defs` の凍結は `web/test/shell-navigation-boundary.test.ts` にある。
  // **【V3-M5-T02 / ADR-0055 による更新】** 逃げ道の参照 `custom_css` が門A を通って
  // 18キー目に加わった。**主張(「可視ロールを書くキーは無い」)は今日も真である** ——
  // `custom_css` はロールを1つも書けない(資産名と sha256 の2要素だけ)。**列挙を消さずに
  // 1行足して更新する**(件数の主張を消さない = ADR-0055 限定1 の作法)。
  //
  // **【V4-M3-T02 / `B-G1` / ADR-0070 限定1 による更新(19キー目)】**
  // **`audience`(画面ごとに見せる相手を書くキー)が門A の本審査を通って加わった** ——
  // **判定 = 限定採用**(`docs/plan/v4/records/v4-m0-gate-a-view-visibility.md` / `ADR-0070`)。
  // **本テスト名が言う「可視ロールを書くキーは無い」は、今日から偽である。**
  // **文言の是正は `V4-M3-T07`(Δ5 の再点検)が双方向で行う**(`ADR-0070` 限定12)——
  // **期待値だけを更新して文言を放置すると「緑のまま嘘が固定される」。**
  // **門は先に通してある**(実装時に初めて Δ3 が発火していない。04 §3-4 #10)。
  // **列挙を消して件数に丸めない**(`custom_css` と同じ作法)。
  // **【`V8-M20`。台帳 `J-G27`(判定 = 廃止)。手続きは `ADR-0301`】**
  // **画面の「見せる相手」のキーを列挙から落とした** —— **`schemas/manifest.schema.json` の
  // `$defs/view/properties` から撤去されたためである。** **旧値をここに残す**:
  //   旧: 列挙の2番目に `"audience"` が在った(`V4-M3-T02` が19キー目として足したもの)。
  // **これによって、本テスト名が言う「可視ロールを書くキーは無い」は再び真になった** ——
  // **ただし「役割の側から画面を名指しする」道は `app.roles[].rules` に在る**
  // (キーの在り処が `$defs/view` から `$defs/app` へ移っただけであり、
  // **「画面ごとの可視性が無くなった」という意味ではない**)。
  const viewProperties = Object.keys(manifestSchema().$defs.view.properties).sort();
  expect(viewProperties).toEqual(
    [
      "actions",
      // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` §4a 限定1 による更新(30キー目)】**
      // **`after_delete`(削除が成立したあとの行き先を書くキー)が門A の本審査
      // (`V10-M0` 群A)を通って加わった。判定 = 限定採用。**
      // **これは可視ロールを書くキーではない** —— 値は同一アプリの実在するビューID 1つで、
      // ロールを1つも書けない(`after_save` / `custom_css` / `menu_listed` と同じ性質)。
      // **列挙を消して件数に丸めない。**
      "after_delete",
      "columns",
      "custom_css",
      // **【V4-M16-T12 / `P-G17` の (C) 側 / ADR-0092 限定1 による更新(21キー目)】**
      // **`field_groups`(詳細画面の項目のまとまりを書くキー)が門A の本審査
      // (`V4-M14` 本審査② の単位9)を通って加わった。判定 = 限定採用。**
      // **これは可視ロールを書くキーではない** —— 書けるのは「どの項目がどのまとまりに
      // 属するか」だけで、ロールを1つも書けない(`custom_css` / `menu_listed` と同じ性質)。
      // **【訂正。`V10-M26-T02`(`CM-G33` / `ADR-0374` 限定2)。2026-08-24】**
      // **上のコメントは前半だけが偽である。** **`V10-M24-T03`(`ADR-0371` `CM-G24`)が
      // まとまりの値に2形目を入れたので、今日は名札(`id`)も書き足せる**(名札は省略でき、
      // 画面には1文字も出ない)。**後半「ロールを1つも書けない」は今日も真である。**
      // **既存行は書き換えない**(本リポジトリの作法)。
      // **列挙を消して件数に丸めない。**
      "field_groups",
      "fields",
      "filter",
      // **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` §4b 限定1 による更新(31キー目)】**
      // **`flow`(一続きの流れの中の段を書くキー)が門A の本審査(`V10-M0` 群B)を
      // 通って加わった。判定 = 限定採用。**
      // **これは可視ロールを書くキーではない** —— 値は流れの名前と位置と段の種類の3つで、
      // ロールを1つも書けない(`after_save` / `after_delete` / `custom_css` と同じ性質)。
      // **列挙を消して件数に丸めない。**
      "flow",
      "id",
      // **【V4-M10-T45 / `E-G12` / ADR-0084 限定1 による更新(20キー目)】**
      // **`menu_listed`(画面をメニューへ出すかを書くキー)が門A の本審査(再審査 B8)を
      // 通って加わった。** **これは可視ロールを書くキーではない** —— 値は真偽値1つで、
      // ロールを1つも書けない(`custom_css` と同じ性質)。**列挙を消して件数に丸めない。**
      "menu_listed",
      "name",
      "preset_column_align",
      "preset_column_width",
      "preset_field_columns",
      "preset_image_size",
      "preset_label_placement",
      // **【V4-M16-T13 / `P-G24` の (C) 側 / ADR-0093 限定1 による更新(22キー目)】**
      // **`preset_list_shape`(一覧の器を表にするかカードにするかを書くキー)が門A の
      // 本審査(`V4-M14` 本審査② の単位11)を通って加わった。判定 = 限定採用。**
      // **これは可視ロールを書くキーではない** —— 書けるのは `table` / `card` の2値だけで、
      // ロールを1つも書けない(`custom_css` / `menu_listed` / `field_groups` と同じ性質)。
      // **列挙を消して件数に丸めない。**
      "preset_list_shape",
      "preset_pager_position",
      "preset_text_preview",
      "related",
      "sort",
      "table",
      "type",
      // **【V4-M18-T03 / `P-G14` の (C) 側 / ADR-0095 限定1 による更新(23キー目)】**
      // **`modal`(この画面を重ねて出すかを書くキー)が門A の本審査(V4-M18 単位3)を
      // 通って加わった。判定 = 限定採用。** **これは可視ロールを書くキーではない** ——
      // 値は真偽値1つで、ロールを1つも書けない(`custom_css` / `menu_listed` /
      // `field_groups` / `preset_list_shape` と同じ性質)。**列挙を消して件数に丸めない。**
      "modal",
      // **【V4-M22-T01 / `E-G7` の (C) 側 / ADR-0112 限定1 による更新(24キー目)】**
      // **`search_fields`(検索の対象にする列を書くキー)が門A の本審査(V4-M22 単位A)を
      // 通って加わった。判定 = 限定採用。** **これは可視ロールを書くキーではない** ——
      // 値は実在フィールドIDの配列で、ロールを1つも書けない(`custom_css` / `menu_listed` /
      // `field_groups` / `preset_list_shape` / `modal` と同じ性質)。**列挙を消して件数に
      // 丸めない。**
      "search_fields",
      // **【V4-M22-T05 / ADR-0113 限定1 で 24 → 25 に更新した】** 門A の本審査(V4-M22 単位C。
      // **4回目の審査**。判定 = 限定採用)が25キー目 `page_size`(1ページに出す件数)を
      // 足した。**これは可視ロールを書くキーではない** —— 値は10/20/50/100の段階値1つで、
      // ロールを1つも書けない(`custom_css` / `menu_listed` / `field_groups` /
      // `preset_list_shape` / `modal` / `search_fields` と同じ性質)。**列挙を消して件数に
      // 丸めない。**
      "page_size",
      // **【V4-M19-T03 / `P-G32` の (C) 側 / ADR-0118 限定1 で 25 → 26 に更新した】** 26キー目
      // `preset_density`(画面の詰まり具合)が門A を通って加わった(V4-M19 単位C。2回目の
      // 審査。判定 = 限定採用)。**これは可視ロールを書くキーではない** —— 値は2値の enum で、
      // ロールを1つも書けない(`custom_css` / `menu_listed` と同じ性質)。**列挙を消して件数に
      // 丸めない。****本 ADR の増分ではない。**
      "preset_density",
      // **【V4-M20-T04 / `E-G34` / ADR-0102 限定1 で 26 → 27 に更新した】** 27キー目
      // `after_save`(保存が成立したあとに行く画面)が門A を通って加わった(V4-M20 単位D。
      // 2回目の審査。判定 = 限定採用)。**これは可視ロールを書くキーではない** —— 値は
      // ビューID 1つで、ロールを1つも書けない(`custom_css` / `menu_listed` と同じ性質)。
      // **見せ方のキーでもない** —— **意味は遷移である。****列挙を消して件数に丸めない。**
      "after_save",
      // **【V4-M23-T01 / `D-V4-89` / `E-G31` / ADR-0104 限定1 で 27 → 28 に更新した】**
      // 28キー目 `sum_field`(一覧が表す集合について `number` 列1本の合計を出す)が門A を
      // 通って加わった(V4-M23 単位A-2。**4回目の審査 = 3回目の再提出**。判定 = 限定採用)。
      // **これは可視ロールを書くキーではない** —— 値はフィールドID 1つで、ロールを1つも
      // 書けない(`custom_css` / `menu_listed` と同じ性質)。**見せ方のキーでもない** ——
      // **意味は読取の応答に数を1つ足すことである。****列挙を消して件数に丸めない。**
      "sum_field",
      // **【`V6-M2-T01` / `K-G2` / `ADR-0289` 限定1 で 28 → 29 に更新した】** 29キー目
      // `reference_pickers`(参照項目の選び方の、入力画面ごとの上書き)が門A を通って
      // 加わった(`V6-M0` 単位A。判定 = 限定採用)。**これは可視ロールを書くキーではない**
      // —— 値は「フィールドID → 有限3値」の対応で、ロールを1つも書けない(`custom_css` /
      // `menu_listed` と同じ性質)。**列挙を消して件数に丸めない。**
      "reference_pickers",
      // **【2026-08-14。`V8-M8`(台帳 `Q-G1`。門A 本審査 = `V8-M7`)で29キー目に増えた】**
      // `report`(集計表の中身)。**これは可視ロールを書くキーではない** —— 値は束ねるキーと
      // 集計と絞り込みだけで、ロールを1語も書けない(`custom_css` / `menu_listed` と同じ性質)。
      // **列挙を消して件数に丸めない。**
      "report",
    ].sort(),
  );
});

test("V3-M3-T06 (e): 顧客セルフサインアップの記述は M3 でも消えていない(D-G12a。状態が変わっただけ)", () => {
  // **書き換えは要らなかった** —— `CANNOT_DO` は V2-M1-T06 から「顧客セルフサインアップの
  // 別経路で本人が名乗って自己付与されます」と書いており、HTTP API については当時から真だった。
  // **V3-M3-T03 が web に導線を置いたことで、ブラウザの前の買い物客にとっても真になった**
  // (逆向きの緊張の解消。`docs/plan/v3/records/v3-m3.md` の T06-2)。
  // ここは V2-M1-T06 の歯止めを二重化するものではなく、**M3 がこの文を弱めないこと**を見る。
  // **【`V5-M17-T09`】逐語から「顧客」が外れた**(上のテストと同じ理由)。**弱めていない。**
  expect(CANNOT_DO).toContain("セルフサインアップの別経路で本人が名乗って自己付与されます");
  expect(CANNOT_DO).not.toContain("ブラウザからは登録できません");
});

// =============================================================================================
// **【`V8-M5-T05`。台帳 `I-G29`(門A・限定採用)。`ADR-0338` §3-3 の 1。裁定 `M5-4`】**
// **招待制で嘘になった1文の隣に、訂正が置かれていること**
// =============================================================================================

test("V8-M5-T05 (I-G29): 自己付与の記述の隣に、招待制では自己付与されないことの訂正が在る", () => {
  // **旧文は1バイトも消していない**(上の2本の検査が今日も緑であることがその証拠である)。
  // **足したのは訂正1つだけである。**
  //
  // **【なぜ嘘になったか】** **`V8-M1`(`ADR-0334`)がアプリに `signup: "invite"` の宣言を
  // 許し、`V8-M3`(`ADR-0337`)が招待の引き換えを配線した。****宣言されたアプリでは、
  // 名乗っただけでは自己付与されない** —— **有効な招待が要る。**
  // **例外は「そのアプリの登録者が0人のとき」だけである**(`D-V8-106`)。
  expect(CANNOT_DO).toContain("名乗っただけでは自己付与されません");
  expect(CANNOT_DO).toContain("登録者が0人");
  // **【訂正文に検査対象の綴りを書き写していないこと】**(`ADR-0338` §3-3 の限定)——
  // **旧文の逐語は本文に1回ちょうどしか現れない。**
  expect(
    CANNOT_DO.split("セルフサインアップの別経路で本人が名乗って自己付与されます").length - 1,
  ).toBe(1);
});

// --- V3-M4-T02: 言葉 → トークンの統制語彙(D-G8。ADR-0007 §8 の 2026-07-26 の行)-----
//
// **判定は「門外(Δ7)/ 将来送り」であり、送り先が本タスクである。** 表の置き場は
// **MCP の説明文層**(`src/mcp/vocabulary.ts` の定数)であって、マニフェストの語彙ではない
// (**統制語彙をマニフェストの語彙にする案は憲法1(メタサーキュラー)違反で却下されている**。
// V3-M0 問1 の結論を V3-M4-T00 が追認した)。
//
// **T00 が確定させた「表の形」4点を、ここで機械的に固定する**(審査記録 §4 S6)——
//
// 1. **表は「向き」ではなく「行き先の実値」を持つ。** ADR-0047 限定6 が `calc(` / `var(` /
//    `{{` / `$record.` を1つも許さないので、「1段上げる」をマニフェストに書けない。
// 2. **表の単位はスロット1個ではなく「軸1本 = スロットの組」である**(余白は6スロットで1軸)。
// 3. **段階を持たない軸で「もっと」を受け付けるなら、それが段階ではなく実値の差し替えである
//    ことを明記する。**
// 4. **`--focus-outline-style` / `--border-style` は `$defs/theme` の25スロットに無く、
//    テーマから動かせない。表に入れない。**
//
// **スロット名を書く場所が4箇所目になる**(ADR-0046 限定1 は3箇所の完全一致を要求している)。
// **だから一致検査は双方向でなければならない** —— 表が存在しないスロットを指していないこと
// (表 → スロット)と、**スロットが増えたときに表が取り残されないこと**(スロット → 表)。
// 後者は「表が触る集合」と「表が触らないと宣言した集合」の**和が25と完全一致する**形で固定する
// (片方向だけだと、26個目のスロットが増えても表は緑のまま古くなる)。

/** 表が触るスロット(軸の順・軸内の宣言順)。 */
function tableSlots(): string[] {
  return DESIGN_ADJECTIVE_AXES.flatMap((axis) => [...axis.slots]);
}

/** 表が触らないと宣言したスロット。 */
function untouchedSlots(): string[] {
  return DESIGN_ADJECTIVE_UNTOUCHED_SLOTS.map((entry) => entry.slot);
}

test("V3-M4-T02 (完了条件1): 対応表が有限で、凍結されていて、AI が要素を増やせない", () => {
  // **有限性の正体は「配列が凍結された定数であること」である。** AI が表を増やす経路は無い ——
  // 表は MCP の説明文に埋め込まれて配られるだけで、書き込み口が1つも無い。
  expect(Object.isFrozen(DESIGN_ADJECTIVE_AXES)).toBe(true);
  expect(Object.isFrozen(DESIGN_ADJECTIVE_PHRASES)).toBe(true);
  expect(Object.isFrozen(DESIGN_ADJECTIVE_UNTOUCHED_SLOTS)).toBe(true);
  for (const axis of DESIGN_ADJECTIVE_AXES) {
    expect(Object.isFrozen(axis)).toBe(true);
    expect(Object.isFrozen(axis.levels)).toBe(true);
    for (const level of axis.levels) {
      expect(Object.isFrozen(level)).toBe(true);
      expect(Object.isFrozen(level.values)).toBe(true);
    }
  }
  // **件数を字面で固定する。** 増やしたら赤くなり、ADR-0007 の門を通したかを問い直すことになる。
  expect(DESIGN_ADJECTIVE_AXES.length).toBe(7);
  expect(DESIGN_ADJECTIVE_PHRASES.length).toBe(22);
  // 説明文が宣言する件数と、実数が一致すること(「7軸19の言い方」が嘘にならない)。
  expect(DESIGN_ADJECTIVE_TABLE).toContain(
    `${DESIGN_ADJECTIVE_AXES.length}軸・${DESIGN_ADJECTIVE_PHRASES.length}通りの言い方`,
  );
});

test("V3-M4-T02 (完了条件1): 表の全量が字面に現れる(表そのものが列挙できる)", () => {
  // **「有限である」と書くだけでは、AI は表の中身を読めない。** 形容詞・軸・スロット名・
  // 行き先の実値のすべてが説明文の字面に出ていることを見る(**組み立てで作っているので、
  // 定義を足して書き忘れる余地が無い**ことをここで確かめる)。
  for (const phrase of DESIGN_ADJECTIVE_PHRASES) {
    expect(DESIGN_ADJECTIVE_TABLE).toContain(phrase.phrase);
  }
  for (const axis of DESIGN_ADJECTIVE_AXES) {
    expect(DESIGN_ADJECTIVE_TABLE).toContain(axis.label);
    for (const slot of axis.slots) {
      expect(DESIGN_ADJECTIVE_TABLE).toContain(slot);
    }
    for (const level of axis.levels) {
      expect(DESIGN_ADJECTIVE_TABLE).toContain(level.label);
      for (const value of Object.values(level.values)) {
        expect(DESIGN_ADJECTIVE_TABLE).toContain(value);
      }
    }
  }
});

test("V3-M4-T02 (完了条件6・双方向 その1): 表が指すスロットは $defs/theme に実在する", () => {
  const slots = new Set<string>(themeSlotNames());
  expect(slots.size).toBe(25);
  for (const slot of tableSlots()) {
    expect(slots.has(slot)).toBe(true);
  }
  for (const slot of untouchedSlots()) {
    expect(slots.has(slot)).toBe(true);
  }
});

test("V3-M4-T02 (完了条件6・双方向 その2): 触る13 + 触らない12 = $defs/theme の25 と完全一致する", () => {
  // **これが「スロットが増えたときに表が取り残されない」ための歯止めである。**
  // 26個目のスロットが `$defs/theme` に入った日、それを表に載せるか「載せない」と
  // 宣言するかを決めるまで、この検査は赤いままになる。
  const declared = [...tableSlots(), ...untouchedSlots()].sort();
  expect(declared).toEqual(themeSlotNames());
  expect(tableSlots().length).toBe(13);
  expect(untouchedSlots().length).toBe(12);
});

test("V3-M4-T02 (完了条件6): 触る集合と触らない集合は1件も交わらない", () => {
  const touched = new Set<string>(tableSlots());
  for (const slot of untouchedSlots()) {
    expect(touched.has(slot)).toBe(false);
  }
  // 同じスロットを2つの軸が持っていない(軸の単位が壊れていない)。
  expect(new Set(tableSlots()).size).toBe(tableSlots().length);
  // 触らないスロットには理由が書かれている(黙って落とさない)。
  for (const entry of DESIGN_ADJECTIVE_UNTOUCHED_SLOTS) {
    expect(entry.reason.length).toBeGreaterThan(0);
    expect(DESIGN_ADJECTIVE_TABLE).toContain(entry.slot);
  }
});

test("V3-M4-T02 (T00 の形4): --focus-outline-style / --border-style は表に1件も無い", () => {
  // **この2つは `web/src/styles.css` に実在するが `$defs/theme` の25スロットに無い** ——
  // **テーマからは動かせない。** 表に入れると「枠線の種別を変えて」を受け付ける嘘になる。
  const schemaSlots = new Set<string>(themeSlotNames());
  for (const slot of ["--focus-outline-style", "--border-style"]) {
    expect(schemaSlots.has(slot)).toBe(false); // 前提(実装の真)が変わったら赤くする
    expect(tableSlots()).not.toContain(slot);
    expect(untouchedSlots()).not.toContain(slot);
    expect(DESIGN_ADJECTIVE_TABLE).not.toContain(slot);
  }
});

test("V3-M4-T02 (T00 の形1): 表が持つのは実値で、式・計算・参照が1つも無い(ADR-0047 限定6)", () => {
  const forbidden = ["calc(", "var(", "{{", "$record."];
  for (const axis of DESIGN_ADJECTIVE_AXES) {
    for (const level of axis.levels) {
      for (const value of Object.values(level.values)) {
        for (const token of forbidden) {
          expect(value).not.toContain(token);
        }
        // 「1段上げる」のような向きの表現をマニフェストへ書けないので、値は必ずリテラルである。
        expect(value).not.toContain("+");
      }
    }
  }
  // 表の字面(AI が読む側)にも、向きをマニフェストに書けるかのような記述を残さない。
  for (const token of forbidden) {
    expect(DESIGN_ADJECTIVE_TABLE).not.toContain(token);
  }
});

test("V3-M4-T02 (T00 の形1): 表の実値はすべて $defs/theme の pattern を通る", () => {
  // **「行き先の実値」を名乗る以上、そのまま set_theme に書けなければ嘘である。**
  // スキーマの pattern(実装の真)で1件ずつ検査する。
  const properties = manifestSchema().$defs.theme.properties;
  let checked = 0;
  for (const axis of DESIGN_ADJECTIVE_AXES) {
    for (const level of axis.levels) {
      // 段が持つ値のキー集合は、その軸のスロット集合と完全一致する(部分的な段を作らない)。
      expect(Object.keys(level.values).sort()).toEqual([...axis.slots].sort());
      for (const [slot, value] of Object.entries(level.values)) {
        const pattern = properties[slot]?.pattern as string | undefined;
        expect(pattern).toBeDefined();
        expect(new RegExp(pattern as string).test(value as string)).toBe(true);
        checked += 1;
      }
    }
  }
  // 空回りしていないこと(段が0本になったら赤)。
  expect(checked).toBeGreaterThan(20);
});

test("V3-M4-T02 (T00 の形2): 表の単位は軸であり、余白の軸は6スロットの組である", () => {
  const space = DESIGN_ADJECTIVE_AXES.find((axis) => axis.id === "space");
  expect(space).toBeDefined();
  expect([...(space?.slots ?? [])]).toEqual([
    "--space-1",
    "--space-2",
    "--space-3",
    "--space-4",
    "--space-5",
    "--space-6",
  ]);
  // **1つの形容詞が6値を1組の別の6値へ差し替える。** 「スロット1個」ではない。
  for (const level of space?.levels ?? []) {
    expect(Object.keys(level.values).length).toBe(6);
  }
  expect(DESIGN_ADJECTIVE_TABLE).toContain("スロット1個ではなく軸1本");
});

test("V3-M4-T02 (完了条件4): 段階軸としてスロット側に実在するのは余白1本だけである", () => {
  // **実装の真**: `$defs/theme` の description が「余白の段階1 (最小)」「余白の段階6 (最大)」と
  // 自ら段階を名乗っているのは `--space-*` だけである。他の軸は単一スロットで段階を持たない。
  const properties = manifestSchema().$defs.theme.properties;
  const staged = Object.entries(properties)
    .filter(([, def]) => String((def as Any).description ?? "").includes("余白の段階"))
    .map(([slot]) => slot)
    .sort();
  expect(staged).toEqual([
    "--space-1",
    "--space-2",
    "--space-3",
    "--space-4",
    "--space-5",
    "--space-6",
  ]);
  // 記述側: 段階軸を名乗る軸はちょうど1本で、それが余白である。
  const stagedAxes = DESIGN_ADJECTIVE_AXES.filter((axis) => axis.slotStages);
  expect(stagedAxes.length).toBe(1);
  expect(stagedAxes[0]?.id).toBe("space");
  expect([...(stagedAxes[0]?.slots ?? [])].sort()).toEqual(staged);
  // **誇張しない** —— 「言葉で段階を動かせる」を一般化していないことを字面で固定する。
  expect(DESIGN_ADJECTIVE_TABLE).toContain("段階軸としてスロット側に実在するのは余白の1本だけ");
});

test("V3-M4-T02 (完了条件4): 段階を持たない6軸は「実値の差し替え」だと明記されている", () => {
  const unstaged = DESIGN_ADJECTIVE_AXES.filter((axis) => !axis.slotStages);
  expect(unstaged.length).toBe(6);
  for (const axis of unstaged) {
    // 各軸に「この軸に段階は無い」ことが書かれている(軸ごとに1件ずつ示す)。
    expect(DESIGN_ADJECTIVE_TABLE).toContain(`${axis.label}(段階なし`);
  }
  expect(DESIGN_ADJECTIVE_TABLE).toContain(
    "段階を1つ動かすのではなく、表が決めた別の実値へ差し替える",
  );
});

// 【`V5-M29-T05`】**テスト名を書き換えた。** 旧: 「V3-M4-T02 (完了条件3): RESOURCE_KINDS /
//   FIELD_TYPES / DIFF_OPS の要素数が 7 / 8 / 16 のまま」。**3つの要素数を測る `expect` が
//   消えたのに、名前だけが要素数を主張する状態を残さないため(記録 §4-7)。**
test("V3-M4-T02 (完了条件3): 統制語彙が使う diff op は既存の set_theme ただ1つである", () => {
  // **統制語彙は新しいリソース種・フィールド型・差分操作を1つも作らない。**
  // 着手前(V3-M4 のベースライン)の実数をここに固定する。増えたら赤くなる。
  // 【`V5-M29-T05` / `ADR-0250` 限定11】ここにあった「**統制語彙は新しいリソース種・フィールド型・
  //   差分操作を1つも作らない。** 着手前(V3-M4 のベースライン)の実数をここに固定する。
  //   増えたら赤くなる。」を `RESOURCE_KINDS` の本数で固定していた検査は
  //   `scripts/vocabulary-drift.test.ts` へ移した(名前の一覧は `scripts/vocabulary-snapshot.txt` の
  //   `RESOURCE_KINDS:` で始まる行)。**総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T05` / `ADR-0250` 限定11】同じ位置にあった `FIELD_TYPES` の本数を固定していた検査も
  //   `scripts/vocabulary-drift.test.ts` へ移した(一覧の `FIELD_TYPES:` で始まる行)。
  //   **総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 【`V5-M29-T05` / `ADR-0250` 限定11】同じ位置にあった `DIFF_OPS` の本数を固定していた検査も
  //   `scripts/vocabulary-drift.test.ts` へ移した(一覧の `DIFF_OPS:` で始まる行)。
  //   **総量ではなく名前と順序で見張る。**
  //   **どの決定がこの語彙を動かしたかは、ここでは分からなくなった**(`ADR-0250` §Decision 5 の (1))。
  // 表が使うのは既存の `set_theme` ただ1つである(新しい op を名乗っていない)。
  expect([...DIFF_OPS] as string[]).toContain("set_theme");
  expect(DESIGN_ADJECTIVE_TABLE).toContain("set_theme");
});

test("V3-M4-T02 (完了条件5): 統制語彙はマニフェストの語彙になっていない(憲法1)", () => {
  // **問1 の結論**: 統制語彙をマニフェストの語彙にする案は憲法1(メタサーキュラー)違反で却下。
  // **説明文定数として持つ案は反しない。** その線が守られていることを、正準スキーマの
  // **字面**に対して機械的に見る(1語でも漏れたら赤)。
  const manifestText = readFileSync(
    join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json"),
    "utf-8",
  );
  const diffText = readFileSync(
    join(import.meta.dir, "..", "..", "schemas", "diff.schema.json"),
    "utf-8",
  );
  for (const phrase of DESIGN_ADJECTIVE_PHRASES) {
    expect(manifestText).not.toContain(phrase.phrase);
    expect(diffText).not.toContain(phrase.phrase);
  }
  for (const axis of DESIGN_ADJECTIVE_AXES) {
    for (const level of axis.levels) {
      expect(manifestText).not.toContain(`"${level.id}"`);
      expect(diffText).not.toContain(`"${level.id}"`);
    }
  }
  // `$defs/theme` は25スロットのまま(形容詞・段・軸の置き場が1つも生えていない)。
  expect(themeSlotNames().length).toBe(25);
  expect(manifestSchema().$defs.theme.additionalProperties).toBe(false);
  // カーネルは「もっと」を1度も解釈しない ——(解釈するのは会話側 AI である)。
  expect(DESIGN_ADJECTIVE_TABLE).toContain("カーネルはこの表を1度も読みません");
});

test("V3-M4-T02 (完了条件2): 表に無い言い方は正直に断り、表にある近い言い方を提案する", () => {
  // `OUT_OF_SCOPE_BEHAVIOR` と同じ形(憲法6)。**断り方が説明文に無いと、AI は
  // 「かっこよく」を勝手に表の段へ読み替える。**
  expect(DESIGN_ADJECTIVE_TABLE).toContain("この表にありません");
  expect(DESIGN_ADJECTIVE_TABLE).toContain("表にある言い方を示して選んでもらう");
  // 表に無い言い方の実例が挙がっている(AI が照合できる形)。
  for (const example of ["かっこよく", "今風に", "明るい色に"]) {
    expect(DESIGN_ADJECTIVE_TABLE).toContain(example);
  }
  // 全ツールに届く側(`OUT_OF_SCOPE_BEHAVIOR`)にも、表の存在と断り方が載っている。
  expect(OUT_OF_SCOPE_BEHAVIOR).toContain("言葉と見た目の対応表");
  expect(OUT_OF_SCOPE_BEHAVIOR).toContain("表に無い言い方");
});

test("V3-M4-T02 (完了条件2・逆向きの歯止め): 「表に無くても近い段へ読み替えてよい」と書いていない", () => {
  // **逆向きの嘘**(審査記録 §4 S2 の Δ5 の注意) —— 表を足したあとに
  // 「表に無い言い方も何とかする」と振る舞えば、**表の有限性を主張する文言が嘘になる。**
  for (const lie of [
    "近い段へ読み替えてかまいません",
    "表に無くても適当に",
    "似た言葉なら同じ扱いにして",
  ]) {
    expect(DESIGN_ADJECTIVE_TABLE).not.toContain(lie);
    expect(OUT_OF_SCOPE_BEHAVIOR).not.toContain(lie);
  }
  // **勝手に丸めない**ことが明示されている(今の値がどの段とも一致しないときの振る舞い)。
  expect(DESIGN_ADJECTIVE_TABLE).toContain("勝手に近い段へ丸めない");
});

test("V3-M4-T02 (ADR-0047 限定3): 1軸だけ動かすときも25スロット全部を書き直す", () => {
  // **「微調整」という語と、実際に流れる差分の量が食い違う**(審査記録 §4 S3-8)。
  // **表が指すのが6スロットでも、`set_theme` は25スロットを要求する。** 隠さない。
  expect(manifestSchema().$defs.theme.required.length).toBe(25);
  expect(DESIGN_ADJECTIVE_TABLE).toContain("25スロット全部を書き直す");
  expect(DESIGN_ADJECTIVE_TABLE).toContain("部分更新の op はありません");
});

test("V3-M4-T02: 表は25のうち13スロットしか持たない —— 残る12の埋め方が書かれている", () => {
  expect(DESIGN_ADJECTIVE_TABLE).toContain("表が値を持つのは25スロットのうち13だけ");
  // 残る12は今のテーマから写す。テーマが未設定なら、この表だけでは set_theme を組み立てられない。
  expect(DESIGN_ADJECTIVE_TABLE).toContain(
    "`get_manifest` で今のテーマを読み、残る12スロットは写す",
  );
  expect(DESIGN_ADJECTIVE_TABLE).toContain("この表だけでは set_theme を組み立てられません");
});

test("V3-M4-T02 (段の参照が壊れていない): 形容詞の軸と行き先がすべて実在する", () => {
  const byId = new Map(DESIGN_ADJECTIVE_AXES.map((axis) => [axis.id, axis]));
  for (const phrase of DESIGN_ADJECTIVE_PHRASES) {
    const axis = byId.get(phrase.axis);
    expect(axis).toBeDefined();
    if (phrase.target.kind === "level") {
      expect(axis?.levels.map((level) => level.id)).toContain(phrase.target.level);
    } else {
      expect([1, -1]).toContain(phrase.target.delta);
    }
  }
  // 同じ形容詞が2度出てこない(表が一意に引ける)。
  const phrases = DESIGN_ADJECTIVE_PHRASES.map((entry) => entry.phrase);
  expect(new Set(phrases).size).toBe(phrases.length);
  // どの軸にも最低1つの形容詞が当たっている(誰も引けない軸を置かない)。
  for (const axis of DESIGN_ADJECTIVE_AXES) {
    expect(DESIGN_ADJECTIVE_PHRASES.some((entry) => entry.axis === axis.id)).toBe(true);
  }
});

test("V3-M4-T02: 各軸の段は2本以上あり、同じ値の組を持つ段が2つ無い", () => {
  for (const axis of DESIGN_ADJECTIVE_AXES) {
    expect(axis.levels.length).toBeGreaterThanOrEqual(2);
    const serialized = axis.levels.map((level) => JSON.stringify(level.values));
    expect(new Set(serialized).size).toBe(serialized.length);
    const ids = axis.levels.map((level) => level.id);
    expect(new Set(ids).size).toBe(ids.length);
  }
});

test("V3-M4-T02: 表が AI に届く(apply_diff の説明文の配送経路に載っている)", () => {
  // **説明文層に置いた表は、配られなければ存在しないのと同じである。**
  // `APPLY_DIFF_OP_EXAMPLES` は `src/mcp/tools/write.ts` から apply_diff の description に
  // 連結されており(`descriptions.test.ts` が固定している)、そこに丸ごと載ることを見る。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(DESIGN_ADJECTIVE_TABLE);
});

test("V3-M4-T02 (誇張しない): 本物の LLM で確かめたと書いていない", () => {
  // **§0-4 の1**: 本マイルストーンは本物の LLM を1度も呼ばない。**実証したのは表の性質だけ。**
  for (const lie of [
    "実際の AI で検証済み",
    "AI が正しく解釈することを確認",
    "LLM で実証",
    "正しく解釈できることを確かめました",
  ]) {
    expect(DESIGN_ADJECTIVE_TABLE).not.toContain(lie);
  }
  // 表が「守らせる強制力」を持たないことを、表自身が申告している(F-41 と同じ規律)。
  expect(DESIGN_ADJECTIVE_TABLE).toContain("この表はプロンプトであって強制力ではありません");
});

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った test「V3-M4-T02 (文書側)」 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

// ---------------------------------------------------------------------------
// V3-M4-T03: Δ5 文言点検の帰結(改訂 ADR-0054)
// ---------------------------------------------------------------------------
//
// **点検の結論**: 3定数のうち**現に偽になった文は0件**である。書き換えたのは1箇所
// (`CANNOT_DO` の「画面ごとの配色は今もできません」)で、理由は**偽になったから**ではなく
// **V3-M4-T01 のプレビュー(1つの画面に配色の違う枠が同時に並ぶ)によって誤読の余地が
// 増えたから**である(V3-M4-T00 の申し送り3 / V3-M4-T01 §7-2 の2)。
//
// **双方向にする**(片方向だけ固定すると逆向きの嘘に倒れる。ADR-0049 限定5 の規律):
// 実在するプレビューを隠さないことと、「画面ごとに配色を指定できる」へ倒れないことの両方を見る。

test("V3-M4-T03 (双方向): 画面ごとの配色の行が、実在するプレビューを隠さず、指定できるにも倒れていない", () => {
  // **実装→記述**: プレビューは実在する(`web/src/theme-candidates.ts` の候補を
  // `web/src/ThemePreviewPanel.tsx` が同時に描く)。その事実が記述から消えないこと。
  expect(CANNOT_DO).toContain("画面ごとの配色は今もできません");
  expect(CANNOT_DO).toContain("テーマ候補のプレビュー");
  expect(CANNOT_DO).toContain("適用前の一時的な描画");
  // **記述→実装**: 旧字面(プレビューに触れない単独の断定)が復活していないこと。
  expect(CANNOT_DO).not.toContain("画面ごとの配色は今もできません**(テーマはアプリ単位です)。");
  // **逆向きの嘘**(画面ごとに配色を指定できる)へ倒れていないこと。
  for (const lie of [
    "画面ごとに配色を指定できます",
    "画面ごとの配色も選べます",
    "画面ごとに違うテーマを保存できます",
  ]) {
    expect(CANNOT_DO, lie).not.toContain(lie);
  }
  // **越えてはならない線が文にも書かれていること**(機械検査は `web/test/intake-boundary.test.ts`)。
  expect(CANNOT_DO).toContain("AI が候補を増やすことはできません");
  expect(CANNOT_DO).toContain("URL を渡して見比べてもらうことはできず");
  // **錨**: 画面ごとの配色の置き場がマニフェストに1つも無いこと(`$defs/view` にテーマのキーが無い)は
  // 既存の検査が持っている(本ファイルの「`$defs/view.properties.theme` が undefined」)。二重化しない。
});

/** `web/src/styles.css` の `:root` の既定値(スロット名 → 実値)。 */
function rootDefaults(): Map<string, string> {
  const css = readSrc("web", "src", "styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.indexOf(":root {");
  const block = css.slice(start, css.indexOf("\n}", start));
  const out = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    out.set(match[1] as string, (match[2] as string).trim());
  }
  return out;
}

test("V3-M4-T03 (T02 の申し送り4): 各軸に、製品の既定値と完全一致する段がちょうど1つある", () => {
  // **V3-M4-T02 が置けなかった検査である** —— 同じ worktree で V3-M4-T01 が
  // `web/src/styles.css` を並行編集していたため(同記録 §7-3 の6)。**T01 が完了したので置く。**
  //
  // **「標準」という名前では照合しない。** 7軸のうち2軸(角丸・影)は、既定値と一致する段の
  // 名前が「標準」ではない(「角ばった」「なし」)。**名前で照合すると、その2軸を検査から
  // 落とすか、表の側の名前を実態に合わない「標準」へ寄せることになる。**
  const root = rootDefaults();
  const defaultLevel: Record<string, string[]> = {};
  for (const axis of DESIGN_ADJECTIVE_AXES) {
    for (const slot of axis.slots) {
      // 表が触るスロットは `:root` に実在する(当たり先のない段を書いていない)。
      expect(root.has(slot), `${axis.id}: ${slot} が :root に無い`).toBe(true);
    }
    defaultLevel[axis.id] = axis.levels
      .filter((level) => axis.slots.every((slot) => level.values[slot] === root.get(slot)))
      .map((level) => level.id);
  }
  // **既定と一致する段が、軸ごとにちょうど1つずつ在る。**
  // 0 になれば「標準に戻して」が既定へ戻らなくなり、2 以上なら段が重複している。
  expect(defaultLevel).toEqual({
    space: ["space-standard"],
    font_size: ["font-size-standard"],
    line_height: ["line-height-standard"],
    border_width: ["border-width-standard"],
    corner_radius: ["corner-radius-square"],
    shadow: ["shadow-none"],
    focus_outline_width: ["focus-outline-width-standard"],
  });
});

// ---------------------------------------------------------------------------
// V3-M7-T05: CSV / 外部データ取り込みの食い違いを双方向で塞ぐ(Δ5)
//
// **出所**: `docs/plan/v3/records/v3-m6-t05.md` §11-4 の申し送り(逐語「**直すときは双方向で
// 書くこと** —— 「回避策も無い」を消すだけだと「何でも取り込める」になる」)と
// [ADR-0059](../../docs/adr/0059-theme-import-declaration-revision.md) §限界5 が V3-M7 へ
// 明示的に渡したもの。**食い違いは実在した(真であった)** —— `CANNOT_DO` の総括が
// 「ツールの組み合わせによる回避策もありません」と述べる一方、`docs/mcp-quickstart.md` と
// `docs/manual.md` は「AI が読んで insert_sample_data / write_records で行に起こすことは
// できます」と述べていた。
//
// **本タスクは製品の挙動を1バイトも変えていない**(`insert_sample_data` / `write_records` は
// v1 / v2 から在る)。**変えたのは説明文だけであり、向きは「できないことをできると書く」の
// 逆側 = 「できることを黙っている」と「できないことを言いすぎている」の是正である。**
//
// **双方向の意味**(M3-T02 / V2-M1-T06 と同型):
//   (a) 実装 → 記述: 会話に貼られた中身を行に起こせるという真が、説明文に現れる。
//   (b) 記述 → 実装: 「取り込みができる」という逆向きの嘘が入らない。**製品が外部へ取りに
//       行く経路が今日1つも無いことを名指しで残す。**
//   (c) 文書 ⇄ CANNOT_DO: 利用者向け文書と AI 向け説明文が、同じ4点の限定を持つ。
// ---------------------------------------------------------------------------

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った 定数 `CSV_LIMITS` は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

test("V3-M7-T05 (a) 実装→記述: 会話に貼られた中身を行に起こせるという真が CANNOT_DO に在る", () => {
  // **実装の真**: `insert_sample_data` / `write_records` は公開ツールとして実在する。
  // 会話に貼られた表を AI が読んで行として書くことは、今日の語彙でできる。
  expect(CANNOT_DO).toContain("insert_sample_data / write_records");
  expect(CANNOT_DO).toContain("貼り付けた");
  // **できることを黙っていた側の是正である。** 消えたら赤くなる。
  expect(CANNOT_DO).toContain("混同されやすい真");
});

test("V3-M7-T05 (b) 記述→実装: 「取り込みができる」という逆向きの嘘が CANNOT_DO に入っていない", () => {
  // **「回避策も無い」を消すだけだと「何でも取り込める」になる**(§11-4 の逐語)。
  // 残すべき真の側:
  expect(CANNOT_DO).toContain("任意の外部データ取り込みはできません");
  expect(CANNOT_DO).toContain("ツールの組み合わせによる回避策もありません");
  expect(CANNOT_DO).toContain("それは「取り込み」ではありません");
  // 逆向きの嘘の側(**これが1つでも入ったら赤くなる**):
  for (const lie of [
    "CSV を取り込めます",
    "CSVを取り込めます",
    "外部データを読み込めます",
    "ファイルを読み込めます",
    "URL から取り込めます",
    "定期的に取り込めます",
    "自動で同期します",
  ]) {
    expect(CANNOT_DO, `CANNOT_DO が「${lie}」と述べている`).not.toContain(lie);
  }
});

test("V3-M7-T05 (b2): 例外の範囲が名指しされ、範囲の外が今日も無いことが残っている", () => {
  // 総括の側の書き分け。**「回避策が無い」ではなく「取り込みが無い」が正確である。**
  expect(CANNOT_DO).toContain("「回避策が1つも無い」ではなく「取り込みが無い」が正確です");
  // **範囲の外(製品が外部へ取りに行く経路)は owner にも AI にも無い** ——
  // 逃げ道(任意 CSS)が「AI には無いが owner には在る」のとは形が違う。混ぜない。
  expect(CANNOT_DO).toContain("owner にも AI にもありません");
});

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った test「V3-M7-T05 (c) 文書 ⇄ CANNOT_DO」 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

// --- V3-M8-T04(ADR-0061 限定13 / §2a-4 (7)): 運営ロールの行可視性が入ったことの双方向是正 ---
//
// **何が起きたか**: `V3-M8-T01`(ADR-0061)が `st_admin_readable` を宣言したテーブル ×
// `owner` ロール × 読取2経路にだけ、`isOwnerVisible` の owner 軸を越える例外を1つ作った。
// **その前から `CANNOT_DO` は「owner ロールも同じ post-filter を受ける」ことを1文字も
// 書いていなかった** —— 嘘ではないが不完全であり、読み手は「運営は見える」と誤解しうる
// (門A記録 §2 S5 問1 の申し送り)。**`V3-M8-T01b` はさらに HTTP バッチ経路に owner ガードを
// 入れたので、`VOCABULARY_SCOPE` のバッチ段落も不完全になった**(§2a-4 (7))。
//
// **双方向は M3-T02 / V2-M1-T06 / V3-M3-T06 と同型である**:
//   (a) 実装→記述: 例外が実在すること・その当たり先(`adminReadsAllRows`)が消えないこと。
//   (b) 記述→実装: **customer についての既存の正しい記述が1文も失われていないこと**
//       (是正が「顧客の制限」を消す形になっていないことの機械的な固定。ADR-0061 限定13)。
//   (c) 逆向き: **「運営はデータを管理できる」に倒れないこと** —— 書込は1バイトも開いておらず、
//       開いたのは `owner` だけ・宣言済みテーブルだけである(`D-M8-2` / 限定1〜3)。

test("V3-M8-T04 (a) 実装→記述: 所有の軸を越える例外の真 ⇔ CANNOT_DO が owner の post-filter とその例外を述べている", () => {
  // **【`V8-M20`。台帳 `J-G30`(判定 = 廃止)。手続きは `ADR-0301`。ユーザ決定 `D-V8-35`】**
  // **この検査は消していない** —— **問い(「所有の軸を越える例外が実在し、説明文がそれを
  // 双方向で述べているか」)は今日も意味を持つからである。** **錨だけを差し替えた。**
  //   旧テスト名: 「V3-M8-T04 (a) 実装→記述: adminReadsAllRows の真 ⇔ CANNOT_DO が owner の
  //                post-filter と宣言つきの例外を述べている」
  //   旧の錨: `adminReadsAllRows(table, role)`(撤去済み)+ `ADMIN_READABLE_FIELD`(撤去済み)
  //   新の錨: `roleReadCrossesOwnerScope({manifest, roles, table})`
  // **旧の期待値も残す**:
  //   旧: `expect(CANNOT_DO).toContain(ADMIN_READABLE_FIELD)`(予約規約フィールドの綴り)
  //   新: 綴りは無い。**代わりに「役割の規則で『この表を読める』と書く」を述べていることを見る。**
  //   旧: `expect(CANNOT_DO).toContain("宣言していないテーブルでは、管理でも他人の行は読めません")`
  //   新: `"規則を1本も書いていない表では、今日どおり管理(owner)でも他人の行は読めません"`
  //
  // **実装の真**: 例外は `roleReadCrossesOwnerScope` 1本が決める(`src/server/owner-scope.ts`)。
  // **`owner` を1文字も特別扱いしない** —— **規則を書いた役割なら誰でも越える**
  // (これが `D-V8-35` の代償そのものである)。
  const manifestWithRule = {
    app: {
      roles: [
        { id: "owner", rules: [{ target: "table", table: "orders", can: ["read"] }] },
        { id: "editor" },
      ],
    },
  };
  const manifestWithCustomerRule = {
    app: {
      roles: [{ id: "customer", rules: [{ target: "table", table: "orders", can: ["read"] }] }],
    },
  };
  const manifestWithoutRules = { app: { roles: [{ id: "owner" }] } };
  expect(
    roleReadCrossesOwnerScope({ manifest: manifestWithRule, roles: "owner", table: "orders" }),
  ).toBe(true);
  // **規則を書いていない役割は越えない**(allow-list)。
  expect(
    roleReadCrossesOwnerScope({ manifest: manifestWithRule, roles: "editor", table: "orders" }),
  ).toBe(false);
  // **規則を1本も書いていない表では、誰も越えない**(管轄外 = 既定は今日どおり)。
  expect(
    roleReadCrossesOwnerScope({ manifest: manifestWithoutRules, roles: "owner", table: "orders" }),
  ).toBe(false);
  // **`D-V8-35` の代償の実測** —— **運営でない役割に書いても、同じように越える。**
  expect(
    roleReadCrossesOwnerScope({
      manifest: manifestWithCustomerRule,
      roles: "customer" as Role,
      table: "orders",
    }),
  ).toBe(true);

  // **記述の側**: 撤去した綴りが1つも残っていないこと。
  expect(CANNOT_DO).not.toContain("st_admin_readable");
  // 門A記録 S5 問1 が申し送った不完全さ(owner も post-filter を受けることを書いていない)の解消。
  expect(CANNOT_DO).toContain("管理(owner)ロールも、この所有の切り方から自由ではありません");
  expect(CANNOT_DO).toContain("ロールを上げても他人の行は見えません");
  // 例外が読取2経路であることと、役割の規則に基づくこと。
  expect(CANNOT_DO).toContain(
    "役割の規則(app.roles[].rules)で「この役割はこの表を読める」と書くと",
  );
  expect(CANNOT_DO).toContain("その表の他人の行も一覧 GET と単件 GET で見えます");
  expect(CANNOT_DO).toContain(
    "規則を1本も書いていない表では、今日どおり管理(owner)でも他人の行は読めません",
  );
});

// --- `V8-M20` / ユーザ決定 `D-V8-35`: 代償(全員分が見える)が説明文に在ること ------------
//
// **`D-V8-35` の逐語**:
//
// > 予定どおり古い宣言を廃止し、代わりに「この役割はこの表を読める」と書いたら、その役割の人には
// > 全員分の行が見えるようにします。運営者は今までどおりデータを横断して見られます。**ただし
// > 代償があります —— 「この表を読める」と書いた役割は誰であっても全員分が見えるので、書き方を
// > 間違えると、本来自分の分だけ見えるはずだった人に全員分が見えます。今日はその危険が
// > 「運営者だけ」に閉じていました。**
//
// **説明文の側にこの代償が1文も無いと、AI は旧層と同じつもりで規則を書く。**
// **この検査はその1文を機械的に固定する**(消したら赤くなる)。
test("V8-M20 / D-V8-35: CANNOT_DO が「この表を読める」と書いた役割には全員分が見える、という代償を述べている", () => {
  expect(CANNOT_DO).toContain(
    "「この表を読める」と書いた役割は、運営かどうかに関わらず、誰であっても全員分の行が見えます",
  );
  expect(CANNOT_DO).toContain(
    "書き方を間違えると、本来自分の分だけが見えるはずだった人に、他の人の行が全部見えます",
  );
  // **「今日はその危険が運営者だけに閉じていた」= 危険の範囲が広がったことを書いていること。**
  expect(CANNOT_DO).toContain("この危険は、以前は運営だけに閉じていました");
  // **ユーザ目線の例が在ること**(内部記号を主語にしない。1件でも消えたら赤)。
  expect(CANNOT_DO).toContain("そのお客様に他のお客様の注文が全部見えます");
  // **AI 自身がこれを引き起こせることを書いていること**(憲法6。誇張の反対向き)。
  expect(CANNOT_DO).toContain("この規則は AI が差分操作 set_roles で書けます");
});

test("V3-M8-T04 (b) 記述→実装(双方向): customer についての既存の正しい記述が1文も失われていない", () => {
  // **ADR-0061 限定13 の逐語**: 「`CANNOT_DO` に「owner ロールも `st_owner` の post-filter を
  // 受ける(宣言したテーブルを除く)」を書き、**顧客の制限の既存記述を1文字も消さない**」。
  // **是正が「顧客の制限」を消す形になっていないことを、ここが機械的に固定する。**
  // 下の8件は V2-M1-T06 / V3-M3-T06 が置いた既存の正しい記述であり、**1件でも消えたら赤**。
  for (const kept of [
    // **【`V5-M17-T09` による更新】この逐語は `ADR-0158` の実装で偽になったので、
    // 「1文字も消さない」対象から外した**(`V4-M3-T07` が同じ表で2件について採ったのと
    // 同じ形。`ADR-0061` 限定13 が守るのは**顧客の制限の既存記述**であって、偽になった
    // 記述を保存しろという意味ではない):
    //   - 旧「顧客(customer)だけは違い、顧客セルフサインアップの別経路で本人が名乗って
    //     自己付与されます」
    //     → **非運営の種類はアプリが名付けられるので「顧客(customer)だけ」が偽になった。**
    //       **自己付与という事実そのものは下の行が今日も固定している。**
    "セルフサインアップの別経路で本人が名乗って自己付与されます",
    //   - 旧「顧客は自分の行(st_owner 規約のテーブル)と公開指定された行しか GET できず」
    //     → **主語が「顧客」に固定されていた点だけが偽になった**(宣言された種類も同じ扱い)。
    //       **制限そのものは1文字も弱めていない。**
    "の種類の利用者は自分の行(st_owner 規約のテーブル)と公開指定された行しか GET できず",
    "運営テーブルは 403 で遮断されます",
    "顧客には、上で 403 になる運営テーブルの画面が一覧に並びません",
    // **【V4-M3-T07 による更新】** この2件の逐語は V4-M3 の実装で偽になったので、
    // **「1文字も消さない」対象から外した**(`ADR-0061` 限定13 が守るのは**顧客の制限の
    // 既存記述**であり、偽になった記述を保存しろという意味ではない):
    //   - 旧「減るのは顧客のときだけで、閲覧 / 編集 / 管理では1画面も減りません」
    //     → **見せる相手を宣言した画面では閲覧 / 編集 / 管理でも減る**(当時の実測)。
    //       射程を分けた新しい文を下に置いた。
    //   - 旧「項目(フィールド)単位で隠す手段は今日も1つもありません」
    //     → **項目に見せる相手を宣言するキーが実在した**(`ADR-0071`)。
    // **【`V8-M20`。台帳 `J-G27` / `J-G28`】上の2つのキーはどちらも撤去され、
    // 代わりに面(役割 × 対象 × 動詞)が立った。****この表が守る「顧客の制限の既存記述」は
    // 1件も動いていない**(下の5件はどれも面と無関係である)。
    // **顧客の制限そのものの記述(上の3件と下の1件)は1文字も消していない。**
    "**規約の反映で減るのは顧客のときだけです**(閲覧 / 編集 / 管理では1画面も減りません)",
    "画面に出さないことは遮断ではありません",
    "AI が足した1フィールドで顧客に見える画面が変わることはあります",
  ]) {
    expect(CANNOT_DO, `customer の既存記述「${kept}」が失われている`).toContain(kept);
  }
  // **customer 側の実装も1ミリも動いていない**(ADR-0061 限定11)。記述の錨をここに置く。
  //
  // =====================================================================================
  // **【`V8-M27-T04`(2026-08-11)。台帳 `T-G5` / `D-V8-38`。錨を差し替えた。
  //   旧の期待値を逐語で残す】**
  //
  // **旧の期待値(逐語)**:
  //   expect(nonAdminTableAccess(tableWithFields([{ id: OWNER_FIELD, type: "text" }]))).toBe("scoped");
  //   expect(nonAdminTableAccess(tableWithFields([{ id: PUBLIC_FIELD, type: "boolean" }]))).toBe("public");
  //   expect(nonAdminTableAccess(tableWithFields([{ id: "title", type: "text" }]))).toBe("denied");
  //   expect(nonAdminTableAccess(tableWithFields([
  //     { id: "title", type: "text" }, { id: UNDELETABLE_FIELD, type: "boolean" },
  //   ]))).toBe("denied");
  //
  // **`nonAdminTableAccess` は撤去された** —— **「customer 側の実装は1ミリも動いていない」は
  // 今日は偽である。** **動いたのは判定の層であって、予約規約フィールドの述語ではない。**
  // **そこで錨を、消えていないほう(予約規約の述語)へ移した。**
  // =====================================================================================
  expect(personalOwnerField(tableWithFields([{ id: OWNER_FIELD, type: "text" }]))).toBeDefined();
  expect(publicField(tableWithFields([{ id: PUBLIC_FIELD, type: "boolean" }]))).toBeDefined();
  expect(personalOwnerField(tableWithFields([{ id: "title", type: "text" }]))).toBeUndefined();
  expect(publicField(tableWithFields([{ id: "title", type: "text" }]))).toBeUndefined();
  // **削除不可の宣言フィールドが在っても、所有・公開の述語は1つも動かない**
  // (旧の最後の1本が測っていた「他の予約規約フィールドは分類に効かない」の置き直し)。
  expect(
    personalOwnerField(
      tableWithFields([
        { id: "title", type: "text" },
        { id: UNDELETABLE_FIELD, type: "boolean" },
      ]),
    ),
  ).toBeUndefined();
});

test("V3-M8-T04 (c) 逆向きの歯止め: 「運営はデータを管理できる」に倒れていない(書込は1バイトも開いていない)", () => {
  // **`D-M8-2` により開いたのは読取だけである。** 「見える」を「管理できる」と言い換えない
  // (`v3-m8.md` §0-4a 9)。**3方向の閉じ(限定1 / 限定2 / 限定3)が記述に在ること。**
  expect(CANNOT_DO).toContain("開くのは読取の2経路だけで、書込は1ミリも開きません");
  expect(CANNOT_DO).toContain("存在しない扱い(404)で弾かれます");
  expect(CANNOT_DO).toContain("見えても直せません");
  // **【`V8-M20`。台帳 `J-G30`。ユーザ決定 `D-V8-35`】期待値を書き換えた。旧値を残す** ——
  //   旧: `expect(CANNOT_DO).toContain("開くのは管理(owner)だけです")`
  //   旧: `expect(CANNOT_DO).toContain("編集 / 閲覧 / 顧客と未認証には1件も開きません")`
  //   新: `"開くのは、その表に「読める」と書いた役割だけです"`
  // **この2行を書き換えたのは、`D-V8-35` が「主体を運営に閉じない」を選んだからである** ——
  // **旧の期待値をそのまま残すと、緑のまま嘘になる**(今日は運営以外にも開ける)。
  //   旧: `expect(CANNOT_DO).toContain("行に書いた true / false は判定に使わない")`
  //   新: `"規則に条件(when)を書いた場合は、行ごとに判定されます"`
  // **旧は「行の値は判定に使わない」= 宣言はテーブル単位、という事実だった。**
  // **面では条件(`when`)を書けば行ごとに判定されるので、旧の逐語は今日は偽である。**
  expect(CANNOT_DO).toContain("開くのは、その表に「読める」と書いた役割だけです");
  expect(CANNOT_DO).toContain("規則に条件(when)を書いた場合は、行ごとに判定されます");
  // **逆向きの嘘(これが1つでも入ったら赤)。**
  for (const lie of [
    "運営はデータを管理できます",
    "運営者が購入者のデータを管理できます",
    "運営はすべての行を編集できます",
    "管理ロールはすべての行を読めます",
    "回避策を外せました",
  ]) {
    expect(CANNOT_DO, `CANNOT_DO が「${lie}」と述べている`).not.toContain(lie);
  }
});

test("V3-M8-T04 (d) / V4-M4-T04 数の照合: 予約規約フィールドの実数(4本)と記述の本数・id が一致する", () => {
  // **実装の真**: `owner-scope.ts` の `export const *_FIELD` が予約規約フィールドの全量である。
  // **3 → 4 に更新した。根拠は `docs/adr/0073-row-state-delete-protection.md`**(`B-G8` の門A
  // 本審査 = 限定採用。`ADR-0061` 限定9 が要求した「門A の新規審査 + 同格の個別 ADR」を満たす)。
  // **【V4-M10-T04 / T05 / E-G49 / ADR-0077 による更新】** **4 → 5 に更新した。**
  // 根拠は `docs/adr/0077-direct-create-suppression.md`(`V4-M7` 単位2 の門A本審査 =
  // 限定採用。`ADR-0073` 限定2 / `ADR-0061` 限定9 が要求した「門A の新規審査 + 同格の
  // 個別 ADR」を満たす —— 門A の新規審査 =
  // `docs/plan/v4/records/v4-m7-gate-a-direct-create.md`)。
  // **6本目には改めて門A の新規審査 + 同格の個別 ADR が要る**(`ADR-0077` 限定2)。
  // **【`V8-M20`。台帳 `J-G30`(判定 = 廃止)。手続きは `ADR-0301`】5 → 4 に更新した。**
  // **旧値をここに残す**:
  //   旧: 期待する id 集合は `[ADMIN_READABLE_FIELD, NO_DIRECT_CREATE_FIELD, OWNER_FIELD,
  //        PUBLIC_FIELD, UNDELETABLE_FIELD]`(5本)。
  //   新: 運営可視の宣言を抜いた4本。
  // **`ADR-0301` 限定10 の履行**: **本数が減ったことを成果として書かない。**
  // **「6本目には門A が要る」という上の歯止めは1バイトも緩めていない** ——
  // **1本減ったからといって、次の1本が自動で通るのではない。**
  const source = readSrc("src", "server", "owner-scope.ts");
  const ids = [...source.matchAll(/^export const [A-Z_]+_FIELD = "(st_[a-z_]+)";$/gm)].map(
    (m) => m[1] as string,
  );
  expect(ids.sort()).toEqual(
    [NO_DIRECT_CREATE_FIELD, OWNER_FIELD, PUBLIC_FIELD, UNDELETABLE_FIELD].sort(),
  );
  expect(ids.length).toBe(4);
  // **記述の側**: 4本とも字面に在り、本数の申告が実数と一致すること。
  for (const id of ids) {
    expect(CANNOT_DO, `CANNOT_DO に予約規約フィールド ${id} が無い`).toContain(id);
  }
  expect(CANNOT_DO).toContain(`予約規約フィールドは今日${ids.length}本です`);
  // **「当たり先は st_owner / st_public の2本だけ」は画面一覧については今日も真である** ——
  // 残りの2本は `nonAdminTableAccess` に1件も効かない(上の (b) が実測)。
  expect(CANNOT_DO).toContain("画面一覧の出し分けに効くのは st_owner / st_public の2本だけです");
  expect(CANNOT_DO).toContain("顧客の画面一覧は1画面も動きません");
  // **4本目について、記述が「何ができなくなるか」と「何が守られないか」を対で言うこと**
  // (`ADR-0073` 限定6: MCP 経路を1バイトも守らないことを明記する)。
  expect(CANNOT_DO).toContain("削除(DELETE)だけができなくなります");
  expect(CANNOT_DO).toContain("宣言していない表・値が立っていない行は今日どおり消せます");
  expect(CANNOT_DO).toContain(
    "**MCP の delete_record はサーバの HTTP 経路を通らないので、この規約に1ミリも守られません。**",
  );
  // **5本目についても、記述が「何ができなくなるか」と「何が守られないか」を対で言うこと**
  // (`ADR-0077` 限定4 / 限定6 / 限定10)。**片方だけ書くと逆向きの嘘になる。**
  expect(CANNOT_DO).toContain("レコードを作れなくなります");
  expect(CANNOT_DO).toContain(
    "**ワークフローの create_record と run_function の島が返す作成操作は1ミリも止まりません**",
  );
  expect(CANNOT_DO).toContain("**ただし「どの自動処理か」は指定できません**");
});

test("V3-M8-T04 (e) 実装→記述: HTTP バッチ経路に owner ガードが在る ⇔ VOCABULARY_SCOPE がそれを述べる", () => {
  // **実装の真**: `V3-M8-T01b` が `POST /api/apps/:app_id/batch` のハンドラに、単件 POST /
  // PATCH と同じ判定関数を同じ順序で当てた。**ハンドラの本文を切り出して機械的に見る** ——
  // ガードが消えたら記述が嘘になるので、ここが赤になる。
  const appSource = readSrc("src", "server", "app.ts");
  const start = appSource.indexOf('app.post("/api/apps/:app_id/batch"');
  const end = appSource.indexOf('app.post("/api/apps/:app_id/files"', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const batchHandler = appSource.slice(start, end);
  // **【V3-M13-T10 / ADR-0067 限定 A5】当て先が2つになったので、見る字面を1段上げた。**
  // T01b はバッチハンドラの中に述語3本を直接並べていたが、**島が返した op も同じ判定を
  // 受ける必要が生じた**(限定 A5「判定を2箇所に書かない」)ため、**述語を当てる順序ごと
  // `owner-scope.ts` の `judgeOwnerScopedOp` 1本へ引き上げた。** **検査は弱めていない** ——
  // (1) ハンドラがその1本を呼んでいること と (2) その1本が述語3本を実際に当てていること の
  // 両方を見る。**ガードが消えれば、どちらかが必ず赤になる。**
  expect(batchHandler, "バッチハンドラに judgeOwnerScopedOp( が無い").toContain(
    "judgeOwnerScopedOp(",
  );
  const ownerScope = readSrc("src", "server", "owner-scope.ts");
  const start2 = ownerScope.indexOf("export function judgeOwnerScopedOp(");
  expect(start2).toBeGreaterThan(0);
  const judge = ownerScope.slice(start2);
  for (const symbol of ["personalOwnerField(", "isOwnerVisible(", "isAllowedOwnerUpdate("]) {
    expect(judge, `judgeOwnerScopedOp に ${symbol} が無い`).toContain(symbol);
  }
  // **島の op 経路も同じ1本を通る**(片方だけ直されて食い違う形を作っていない)。
  expect(readSrc("src", "kernel", "workflow-runner.ts")).toContain("judgeOwnerScopedOp(");
  // **宣言済みテーブルでも書込は開かない** —— バッチは `adminReadsAllRows` を1度も**呼ばない**。
  // (関数名そのものはハンドラのコメントに現れる —— 「渡さない」と明記した T01b の注記である。
  //  したがって照合するのは**呼び出しの字面**(開き括弧つき)であって、名前の出現ではない。)
  expect(batchHandler).not.toContain("adminReadsAllRows(");

  // **記述の側**(§2a-4 (7): 嘘になっていなくても不完全なら補う)。
  expect(VOCABULARY_SCOPE).toContain("個人スコープ(st_owner 規約)のガードが当たります");
  expect(VOCABULARY_SCOPE).toContain("create op の st_owner は呼び出した本人の id で必ず上書き");
  expect(VOCABULARY_SCOPE).toContain("運営可視を宣言したテーブルでも");
  expect(VOCABULARY_SCOPE).toContain("運営は見えても書けません");
});

test("V3-M8-T04 (f) 逆向き: MCP write_records にガードが無い ⇔ 説明文がその非対称を隠していない", () => {
  // **実装の真**: MCP は stdio・無認証で actor が居ないので、`write_records` は owner 規約を
  // 1箇所も見ない(ADR-0016 実装追記 (E) が受容した既知の非対称。`batch/owner 14` が固定)。
  // **「バッチにガードが当たります」だけを書くと、AI 自身が通る経路について逆向きの嘘になる。**
  // =====================================================================================
  // **【`V8-M31` 第6波・裁定 `M31-13`。ここで期待値を反転させた。旧を逐語で残す】**
  // =====================================================================================
  //
  // **旧の期待値(逐語。3行)**:
  //
  //       const writeTool = readSrc("src", "mcp", "tools", "write.ts");
  //       for (const symbol of ["personalOwnerField", "isOwnerVisible", "isAllowedOwnerUpdate"]) {
  //         expect(writeTool, `MCP write ツールに ${symbol} が現れている`).not.toContain(symbol);
  //       }
  //
  // **反転させた理由**: **裁定 `M31-13` が「既存の export を呼ぶだけで塞げる穴を残さない」と
  // 定め、`update_record` / `delete_record` / `insert_sample_data` / `write_records` の4本に
  // 個人スコープを配線した。** **旧コメントが指定した手続き(逐語:「**将来 MCP を塞ぐなら、
  // この検査を消すのではなく門A を通してから期待を反転させること**」)のうち、
  // **検査を消していないこと**と**期待を反転させたこと**は履行した。**
  // **門A については、`V8-M31` は門A本審査(`V8-M25`)を通った台帳の実装 MS であり、
  // 本波は既存 export の再利用に閉じている(新しい述語を1本も作っていない)。**
  const writeTool = readSrc("src", "mcp", "tools", "write.ts");
  for (const symbol of ["personalOwnerField", "isOwnerVisible", "isAllowedOwnerUpdate"]) {
    expect(writeTool, `MCP write ツールに ${symbol} が現れていない`).toContain(symbol);
  }
  // **`write_records` は HTTP のバッチと同じ1本(`judgeOwnerScopedOp`)を通る。**
  expect(writeTool, "MCP write ツールに judgeOwnerScopedOp( が無い").toContain(
    "judgeOwnerScopedOp(",
  );
  // =====================================================================================
  // **【説明文の側は反転させていない。今日から逐語が偽である。隠さない】**
  // =====================================================================================
  //
  // **下の1行は「その文字列が説明文に在ること」を測っており、今日も緑である。**
  // **しかし、その文字列が述べている内容(「MCP の write_records にはこのガードが
  // 掛かりません」)は、本波の配線によって**偽になった**。**
  //
  // **直していない理由**: **裁定 `M31-10`(`src/mcp/vocabulary.ts:1769` ほかの逐語が
  // 今日は偽であるが、本 MS では直さない)と同じ扱いにした** —— **説明文を1文字でも
  // 動かすと、`V8-M31` 第6波の出口が課している「ツールの説明文を1文字も足していない」の
  // 外側で、AI に渡る文章が変わる。**
  // **申し送りとして第6波の報告に1件立てた。**
  expect(VOCABULARY_SCOPE).toContain("MCP の write_records にはこのガードが掛かりません");
});

test("V3-M8-T04 (g) → V4-M3-T07: ADR-0061 の予約規約フィールドは、宣言キーが増えた後も schema に現れない", () => {
  // **【V4-M3-T07 による書き直し】**
  //
  // **旧テスト名**: 「V3-M8-T04 (g) 完了条件6: 「画面・項目単位の表示権限をマニフェストで
  // 定義できない」は今日も真である」。**その主張は今日から偽である** ——
  // **旧コメントが「偽になる条件」として名指しした事態(`ADR-0061` §3a-4 のビュー単位・
  // フィールド単位の可視性宣言)が、`V4-M0-T02` / `T03` の門A 本審査を通って実際に起きた。**
  //
  // **それでもこのテストは消さない。** **`ADR-0061` が採った案(c)の性質 ——「予約規約
  // フィールドの名前は `schemas/` に1バイトも現れない」—— は今日も真であり、
  // `ADR-0070` 限定6 / `ADR-0071` 限定2 がそれを引き継いだからである**(予約規約フィールドは
  // 3本のまま)。**見るものをその1点に絞り、偽になった主張は上の V4-M3-T07 のテストへ移した。**
  const schema = manifestSchema();
  // **【V4-M10-T24 / `E-G35`(再提出) / ADR-0080 限定1 による更新】** **`$defs/table` に
  // 4キー目(`representative_field`)が入った。** **予約規約フィールドの名前が `schemas/` に
  // 1文字も現れないという性質は今日も動いていない**(下の `not.toContain` が見る)。
  // **【`V6-M3-T01` / `K-G6` / `ADR-0290` 限定1 による更新】** **`$defs/table` に
  // 5キー目(`reference_search_fields`)が入った。** **予約規約フィールドの名前が
  // `schemas/` に1文字も現れないという性質は今日も動いていない**(下の `not.toContain`
  // が見る)。
  // **【`V7-M1-T01` / `Z-G2` による更新】** **`$defs/table` に6キー目(`access_control`)が
  // 入った。** **予約規約フィールド(`st_*`)の名前が `schemas/` に1文字も現れないという
  // 性質は今日も動いていない**(下の `not.toContain` が見る)——
  // **`access_control` は付与表・グループ表・メンバー表とその列を「宣言」で指すので、
  // 新しい `st_*` を1本も足していない**(`v7-m0.md` §5-2 (a) の 4)。
  expect(Object.keys(schema.$defs.table.properties).sort()).toEqual([
    "access_control",
    "fields",
    "id",
    "name",
    "reference_search_fields",
    "representative_field",
  ]);
  // **【V4-M3-T05 / `B-G2` / ADR-0071 限定1 による更新】** **`audience` が8キー目に加わった。**
  // **上のコメントが「偽になる条件」として名指しした事態(フィールド単位の可視性宣言)が、
  // 実際に起きた** —— `ADR-0061` §3a-4 の門A を `V4-M0-T03` が通し、判定は限定採用である。
  // **本テスト名の主張(「画面・項目単位の表示権限をマニフェストで定義できない」は今日も真)は、
  // 今日から偽である。** **文言の是正(`CANNOT_DO` の書き換えと、本テストの作り直し)は
  // `V4-M3-T07`(Δ5 の再点検)が行う**(`ADR-0070` 限定12 / `ADR-0071` §Consequences)——
  // **ここで期待値だけを更新して止めると「緑のまま嘘が固定される」。**
  // **【V4-M10-T01 / `E-G48` / ADR-0076 限定1 による更新】** **`writable_by` が9キー目に
  // 加わった。** **これは項目単位の**書込**制御であり、`audience`(読取)とは別のキーである**
  // (`ADR-0076` §1b: 読取の値域と書込の値域は一致しない)。**文言の是正(`CANNOT_DO` に
  // `writable_by` の段落を双方向で書き足す)は同じ差分で行った**(`ADR-0076` 限定10)——
  // **ここで期待値だけを更新して止めると「緑のまま嘘が固定される」。**
  // **【V4-M10-T46 / `E-G14` / ADR-0086 限定1 による更新】** **`unit` が10キー目に
  // 加わった。** **これは可視性でも書込制御でもなく「値の意味」である**(`options` /
  // `reference_table` に続く3本目。`v4-m10.md` §4d 申し送り5)。**文言の是正
  // (`web/src/fields/display.tsx` の Δ5 と `CANNOT_DO` の桁区切りの段落)は同じ差分で
  // 行った**(`ADR-0086` 限定12)—— **ここで期待値だけを更新して止めると
  // 「緑のまま嘘が固定される」。**
  // **【V4-M16-T10 / `P-G28` + `P-G22` / ADR-0090 限定1 による更新】** **`emphasis` が
  // 11キー目に加わった。** **これは可視性でも書込制御でも値の単位でもなく「値の意味に
  // 応じた強調」である**(門A = `V4-M14` 本審査② の単位3。判定 = 限定採用。記録 =
  // `docs/plan/v4/records/v4-m14-gate-a-value-emphasis.md`)。**文言の是正
  // (`web/src/fields/display.tsx` の Δ5 と `CANNOT_DO` / `VOCABULARY_SCOPE` /
  // `APPLY_DIFF_OP_EXAMPLES` の Δ5)は同じ差分で行った**(`ADR-0090` 限定9 / 限定10)——
  // **ここで期待値だけを更新して止めると「緑のまま嘘が固定される」。**
  // **【V4-M19-T07 / ADR-0119 限定1 で 11 → 12 に更新した】** `hide_when_empty` が12キー目に
  // 加わった。**これは可視性でも書込制御でも値の単位でも強調でもなく「値が無いとき行ごと
  // 出さない」宣言である**(V4-M19 単位E-a。2回目の審査。判定 = 限定採用)。**予約規約
  // フィールドの名前が `schemas/` に1文字も現れないという性質は今日も動いていない**
  // (下の `not.toContain` が見る)。**本 ADR の増分ではない。**
  // **【V6-M1-T01 / K-G1 / ADR-0288 限定1 で 12 → 13 に更新した】** `reference_picker` が
  // 13キー目に加わった。**これは可視性でも書込制御でも値の単位でも強調でも出し分けでもなく
  // 「他のテーブルから選ぶ項目をどう選ばせるか」の宣言である**(V6-M0 単位A。判定 = 限定採用)。
  // **予約規約フィールドの名前が `schemas/` に1文字も現れないという性質は今日も動いていない**
  // (下の `not.toContain` が見る)。**本 ADR の増分ではない。**
  // **【`V8-M20`。台帳 `J-G28`(判定 = 廃止)。手続きは `ADR-0301`】**
  // **項目の「見せる相手」と「書ける相手」の2キーを列挙から落とした** ——
  // **`schemas/manifest.schema.json` の `$defs/field/properties` から撤去されたためである。**
  // **旧値をここに残す**: 列挙の先頭に `"audience"`、末尾に `"writable_by"` が在った
  // (それぞれ `V4-M3-T05` が8キー目、`V4-M10-T01` が9キー目として足したもの)。
  // **したがって `$defs/field` は 14キー → 12キー になった。**
  // **代わりに立つのは「役割 × 対象(項目)× 読取 / 書込」であり、キーの在り処が
  // `$defs/field` から `$defs/app/properties/roles` へ移った** ——
  // **「項目単位の可視性が無くなった」という意味ではない。**
  expect(Object.keys(schema.$defs.field.properties).sort()).toEqual(
    [
      "emphasis",
      "hide_when_empty",
      "id",
      "name",
      "options",
      "reference_picker",
      // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定1 で 13 → 14 に更新した】**
      // `reference_search_fields` が14キー目に加わった。**これは可視性でも書込制御でも
      // 値の単位でも強調でも出し分けでも選び方でもなく「その参照項目で候補を探すとき、
      // 打った文字を何に照合するか」の宣言である**(`V6-M0` 単位B。判定 = 限定採用)。
      // **予約規約フィールドの名前が `schemas/` に1文字も現れないという性質は今日も
      // 動いていない**(下の `not.toContain` が見る)。**本 ADR の増分ではない。**
      "reference_search_fields",
      "reference_table",
      "required",
      "type",
      "unique",
      "unit",
    ].sort(),
  );
  // **宣言は「テーブルに boolean フィールドが在ること」だけで、その名前は schema に現れない。**
  // **【`V8-M20`。台帳 `J-G30`】** **錨を運営可視の宣言から、残っている予約規約フィールドへ
  // 差し替えた。旧値を残す** ——
  //   旧: `expect(schemaText).not.toContain(ADMIN_READABLE_FIELD)`
  //   旧: `expect(CANNOT_DO).toContain(ADMIN_READABLE_FIELD)`
  // **問い(予約規約フィールドの名前は `schemas/` に1文字も現れず、`CANNOT_DO` には現れる)は
  // 1バイトも変えていない。** **対象が5本から4本になっただけである。**
  const schemaText = readSrc("schemas", "manifest.schema.json");
  // **【測って書く。丸めない】** **`schemas/manifest.schema.json` を 2026-08-10 に数えた** ——
  // **`st_owner` は6件、`st_public` は2件現れる**(どちらも `unique` のスコープや
  // 未認証窓の `description` の中で、**説明として**名前を挙げているものである)。
  // **したがって「予約規約フィールドの名前は schema に1文字も現れない」は、この2本については
  // 着手前から成り立っていなかった。** **旧検査が見ていたのは運営可視の1本だけであり、
  // その1本は撤去された。** **成り立っている2本だけを、ここで固定する。**
  for (const id of [UNDELETABLE_FIELD, NO_DIRECT_CREATE_FIELD]) {
    expect(schemaText, `schemas/ に予約規約フィールド ${id} が現れている`).not.toContain(id);
  }
  // **`CANNOT_DO` は今日も4本を名指ししている**(記述→実装の錨)。
  for (const id of [OWNER_FIELD, PUBLIC_FIELD, UNDELETABLE_FIELD, NO_DIRECT_CREATE_FIELD]) {
    expect(CANNOT_DO, `CANNOT_DO に予約規約フィールド ${id} が無い`).toContain(id);
  }
});

// --- V3-M9-T04: 関数の入力が複数書けるようになった(D-G14 / ADR-0062。Δ5)-------------------
//
// **T01 が `$defs/function.properties.input` を「単体形または最大5要素の配列形」の2形にした。**
// **旧文(`vocabulary.ts` の (γ))は字面としては嘘になっていない** —— 増えたのは入力の**個数**で
// あって**種類**ではない(ADR-0062 §1c が「Δ5 は非発火」と判定したのはこの意味である)。
// **しかし「1つだけ」と読める不完全さが残るので書き足した。** ここが固定するのは**双方向**である:
//   実装→記述 = 配列形が実在する以上、記述がそれを述べていること((a)(d)(e))。
//   記述→実装 = 記述が実装より広くないこと(「何でも読める」に倒れていないこと。(b))。
// **`D-G15`(書込側 = 在庫の引き当て)は保留であり実装が1バイトも無い。** したがって
// (α)(β)(δ) は直していない —— 直すと嘘になる。**代わりに CAS の非対称を書き足した((d))。**

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った 補助関数 `countOccurrences` は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

test("V3-M9-T04 (a) 実装→記述: input が単体形+最大5要素の配列形の2形 ⇔ 記述が2形・上限5・宣言順・突き合わせは島 を述べる", () => {
  // **実装の真**(ADR-0062 §3 限定表3)。**記述だけが先に進んだら、ここが赤になる。**
  const input = manifestSchema().$defs.function.properties.input;
  expect(input.type).toEqual(["object", "array"]);
  expect(input.allOf.length).toBe(2);
  const arrayBranch = input.allOf.find((b: Any) => b.if.type === "array").then;
  expect(arrayBranch.minItems).toBe(1);
  expect(arrayBranch.maxItems).toBe(5);
  expect(arrayBranch.uniqueItems).toBe(true);
  expect(arrayBranch.items.$ref).toBe("#/$defs/function_input");
  // 単体形の枝は `$defs/function_input` をそのまま指す(後方互換。限定12)。
  expect(input.allOf.find((b: Any) => b.if.type === "object").then.$ref).toBe(
    "#/$defs/function_input",
  );
  // **実装→記述**: 2形であること・上限が5であること。**数を丸めた表現にしない。**
  expect(VOCABULARY_SCOPE).toContain(
    "**その参照は1つだけ書く形と、最大5つまで並べた配列の形の2つがあります**",
  );
  // **限定4(カーネルは突き合わせを1行も行わない)を記述の側でも述べる。**
  expect(VOCABULARY_SCOPE).toContain("各入力を解決した結果を宣言順に並べただけの配列です");
  expect(VOCABULARY_SCOPE).toContain(
    "突き合わせ(join)をカーネルは1行も行わず、それは島の JavaScript の仕事です",
  );
  // **参照の有無と無関係に渡せる**(1ホップの参照読み案では解けなかったケース。ADR-0062 §3d 案A)。
  expect(VOCABULARY_SCOPE).toContain("**参照で繋がっていない表も渡せます**");
  // **T01 §10 (6) が申告した限界**: 配列は名前の無い順序であり、並べ替えると島が黙って壊れる。
  expect(VOCABULARY_SCOPE).toContain("**配列には名前が無く、順序だけが意味を持ちます**");
  expect(VOCABULARY_SCOPE).toContain("要素を並べ替えると島のコードは黙って壊れ");
});

test("V3-M9-T04 (b) 記述→実装(逆向きの嘘の歯止め): 記述は「何でも読める」に倒れていない —— 種類は3種・禁止語0・1ホップも辿らない", () => {
  // **実装の真**: 緩んだのは個数だけである。`$defs/function_input` は1バイトも変わっていない。
  const schema = manifestSchema();
  // **【V4-M10-T44 / E-G72 / ADR-0083 限定1 による更新】** **4キー目(`via`)が入った。**
  // **`source` の enum は3値のまま・禁止7語は0のまま・`additionalProperties: false` も
  // 1バイトも変わっていない**(限定2)—— **緩んだのは「どの行か」の1点だけである。**
  const functionInput = schema.$defs.function_input;
  expect(Object.keys(functionInput.properties).sort()).toEqual(["source", "table", "via", "view"]);
  expect(functionInput.properties.source.enum).toEqual(["table", "view", "record"]);
  expect(functionInput.additionalProperties).toBe(false);
  // **クエリ言語の7語をどちらの定義にもキーとして持たない**(ADR-0024 限定3 の5語 + join / on)。
  for (const forbidden of ["where", "filter", "select", "count", "group_by", "join", "on"]) {
    expect(Object.keys(functionInput.properties)).not.toContain(forbidden);
    expect(Object.keys(schema.$defs.function.properties.input)).not.toContain(forbidden);
  }
  // **カーネルは参照を1ホップも辿らない** —— 入力の解決は reference フィールドを1度も読まない。
  const runner = readSrc("src", "kernel", "workflow-runner.ts");
  const resolveStart = runner.indexOf("function resolveFunctionInput");
  // 終端は次の宣言(島の出力検証)の doc コメントの手前。**入力解決の2関数だけを見る。**
  const resolveEnd = runner.indexOf("島の出力(行の配列を期待)", resolveStart);
  expect(resolveStart).toBeGreaterThan(0);
  expect(resolveEnd).toBeGreaterThan(resolveStart);
  const resolveBody = runner.slice(resolveStart, resolveEnd);
  /*
   * **【V4-M10-T44 / E-G72 / ADR-0083 による更新】**
   *
   * **旧検査は「`reference` という語が1度も現れない」を見ていた。** **`ADR-0083` が
   * `via` を足したとき、その説明コメントに「reference フィールド」という語が入ったので、
   * 旧検査は**コメントの字面**で赤くなる。**
   *
   * **見たいのは「参照を辿る実装が1行も無いこと」(限定7)であって、コメントの字面ではない。**
   * **そこでコメントを除いたコードだけを見る形へ引き直した。** **緩めていない** ——
   * **`via` の解決は既存の等値 filter を1つ当てるだけで、参照先の行を1度も読まない**
   * (`ADR-0083` 限定9)。**参照先を読む実装が入れば、この検査は今日どおり赤くなる。**
   */
  const codeOnly = resolveBody
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  expect(codeOnly).not.toContain("reference");
  // **記述の側**: 種類が増えていないこと・「どの行か」を絞る語彙が無いこと・1ホップも辿らないこと。
  expect(VOCABULARY_SCOPE).toContain("**緩んだのは個数だけで、入力の種類は1つも増えていません**");
  expect(VOCABULARY_SCOPE).toContain(
    "source は table / view / record の3種のままで、where / select / count / group_by / join を1つも足していません",
  );
  expect(VOCABULARY_SCOPE).toContain("**ただしカーネルは参照を1ホップも辿りません**");
  // **【V4-M10-T44 / ADR-0083 による更新】** **旧文は偽になったので、新しい逐語に差し替えた。**
  // **同時に「今日も書けないもの」を述べていることを固定する**(逆向きの嘘の歯止め)。
  expect(VOCABULARY_SCOPE).toContain("「どの行か」を発火ごとに絞る語彙は、今日1つだけあります");
  expect(VOCABULARY_SCOPE).toContain("**孫・多段・join・逆参照(親の側を絞る)は1つも書けません。**");
  // **実行予算は1ミリも動いていない**(限定6)。記述も「大きな表を複数渡せる」と言っていない。
  expect(VOCABULARY_SCOPE).toContain("判定は直列化後の総バイト数1本(和であって積ではない)");
  // **逆向きの嘘(これが1つでも入ったら赤)。**
  for (const lie of [
    "何でも読めます",
    "任意のテーブルを読めます",
    "参照先を読めるようになりました",
    "カーネルが突き合わせます",
    "join を書けます",
    "在庫を減らせます",
  ]) {
    expect(VOCABULARY_SCOPE, `VOCABULARY_SCOPE が「${lie}」と述べている`).not.toContain(lie);
    expect(CANNOT_DO, `CANNOT_DO が「${lie}」と述べている`).not.toContain(lie);
  }
});

test("V3-M9-T04 (c) 完了条件5: 集計語彙の否定は複数入力を足したあとも真のままである", () => {
  // **門A記録 §3 S2 の判定**: `D-G14` は入力側の話であり、**集計は依然として島の中である。**
  // **実装の真**: count / group_by / sum を表すキーは `$defs/function` のどこにも無い。
  const schema = manifestSchema();
  const functionDefText = JSON.stringify(schema.$defs.function.properties.output);
  for (const forbidden of ['"count"', '"group_by"', '"sum"']) {
    expect(functionDefText).not.toContain(forbidden);
  }
  // **記述の真**(`vocabulary.ts` の3箇所)。**既存の逐語固定検査(:407 / :412 / :423)は
  // 1バイトも緩めていない** —— ここは同じ逐語を重ねて置き、複数入力の追記で崩れないことを示す。
  // **【V4-M23-T04 / ADR-0104 で差し替えた。検査は消していない】** 旧2行は `count / group by /
  // sum` の全否定を固定していたが、**合計だけが門A を通ったので今日は嘘である。**
  // **同じ強さで「group by / 平均 / 最小 / 最大 は今日も無い」を固定する。**
  expect(VOCABULARY_SCOPE).toContain(
    "カーネルが持つ集計語彙は一覧の合計(list_view の sum_field)1つだけ",
  );
  expect(CANNOT_DO).toContain("group by / 平均 / 最小 / 最大 をカーネルに書くことはできません");
  expect(CANNOT_DO).toContain("集計ロジックは島のコードとして自分で書く必要があります");
});

test("V3-M9-T04 (d) 完了条件6: CAS が課される経路と課されない経路の非対称を記述が隠していない", () => {
  // **実装の真(課されない)**: ワークフローの `update_record` は版を渡さない = LWW。
  // **6引数目(expectedVersion)が足されたら、この字面が変わって赤になる。**
  const runner = readSrc("src", "kernel", "workflow-runner.ts");
  expect(runner).toContain("**版(expectedVersion)は渡さない = LWW を維持する**");
  expect(runner).toContain("updateRecord(db, manifest, action.table, target.value, values.value);");
  // **実装の真(課される)**: HTTP 単件は If-Match ヘッダ必須 / MCP 単件は if_match 必須。
  expect(readSrc("src", "server", "app.ts")).toContain('c.req.header("if-match")');
  expect(readSrc("src", "mcp", "tools", "write.ts")).toContain(
    'if (if_match === undefined || if_match === "")',
  );
  // **実装の真(任意)**: バッチの update op は `if_match` を書かなければ版を見ない。
  expect(readSrc("src", "kernel", "batch.ts")).toContain("if (op.if_match !== undefined");
  // **記述の側**: 3経路の違いを書き分けていること(1文に丸めない)。
  expect(VOCABULARY_SCOPE).toContain(
    "**版一致更新(CAS)が課される経路と課されない経路があるので、混ぜないでください**",
  );
  expect(VOCABULARY_SCOPE).toContain("MCP の update_record / delete_record は版");
  expect(VOCABULARY_SCOPE).toContain("バッチの update op の if_match は**任意**");
  expect(VOCABULARY_SCOPE).toContain(
    "**そしてワークフローのアクションの update_record は版を1つも渡しません(後勝ち = LWW)。**",
  );
  /*
   * **【V3-M13-T09 による期待値の更新】** **旧い2行は「`D-G15` は保留であり実装が1バイトも
   * 無い」ことを前提に置かれていた。** **2026-08-01 に `D-G15` は門A 本審査(4回目)で
   * 限定採用され(ADR-0067)、`run_function` の `write_ops` として実装された。**
   * **したがって「ワークフローには書けません」は今日から嘘であり、この期待値を残すことは
   * 嘘を固定することになる。** **実装の誤りではない。**
   *
   * **非対称そのものは1バイトも変わっていない**(上の3行の期待値は全部残っている)——
   * ワークフローの `update_record` は今日も LWW である。**変わったのは「現在値を踏まえた
   * 更新をどこにも書けない」という全称の否定だけであり、書ける場所(values ではなく島の
   * `write_ops`)を名指しさせる形に置き換える。**
   * **同時に逆向きの嘘へ倒れていないことも固定する** —— 島の update op は版一致必須である。
   */
  expect(VOCABULARY_SCOPE).toContain(
    "**したがって「今の値を読んで、その値から引く」形は、ワークフローのアクションの値(values)には書けません**",
  );
  expect(VOCABULARY_SCOPE).toContain(
    "他テーブルの行の**現在値**を values 側で参照する語彙は今日も1つも無く",
  );
  expect(VOCABULARY_SCOPE).toContain(
    "**その「計算する呼び出し側」をアプリの中に置ける唯一の形が、run_function の write_ops(島が返す更新操作の配列)です**",
  );
  expect(VOCABULARY_SCOPE).toContain(
    "**update には if_match(更新前に読んだ _updated_at)が必須です**",
  );
  // **書込側の実装が1バイトも動いていないことの錨**(ADR-0062 限定9)。
  expect(manifestSchema().$defs.workflow_action.properties.write_back.const).toBe("$record");
});

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った test「V3-M9-T04 (e) 散文の双方向」 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

// --- V3-M9-T04b: AI が「書き方」を学ぶ側の記述の是正(D-G14 / ADR-0062。`v3-m9.md` §2a-5)-------
//
// **T04 が直したのは要旨(`VOCABULARY_SCOPE`)だけであり、`APPLY_DIFF_OP_EXAMPLES`(= AI が
// `apply_diff` の書き方を学ぶ側)は配列形を1文字も述べていなかった**(T04 §8-1 の申し送り)。
// **要旨だけに上限を書いて書き方に書かないと、AI は上限を知らずに6要素を書く。**
// ここが固定するのは**3方向**である:
//   (f) 実装→記述  = 配列形が実在する以上、**書き方の側**がそれを述べていること。
//   (g) 記述→実装  = **書き方の側**が実装より広くないこと(ADR-0062 §3 限定表を超えないこと)。
//   (h) 記述↔記述  = **要旨と書き方が食い違わないこと**(T04b 完了条件1 の後段)。
// **(i)** は `docs/manual.md` §11.5 の追記が「CP-V2 の代償は解消した」に倒れていないことを固定する。

test("V3-M9-T04b (f) 実装→記述(書き方の側): APPLY_DIFF_OP_EXAMPLES が2形・上限5・重複不可・宣言順の配列を述べる", () => {
  // **実装の真**(ADR-0062 §3 限定表3 / 5)。**記述だけが先に進んだら、ここが赤になる。**
  const input = manifestSchema().$defs.function.properties.input;
  expect(input.type).toEqual(["object", "array"]);
  const arrayBranch = input.allOf.find((b: Any) => b.if.type === "array").then;
  expect(arrayBranch.minItems).toBe(1);
  expect(arrayBranch.maxItems).toBe(5);
  expect(arrayBranch.uniqueItems).toBe(true);
  // **書き方の側**が2形を述べる(「1つだけ」と読める状態を解消したことの錨)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**入力の宣言(input)には2つの形がある** —— 1つだけ書く**単体形**と、最大5つまで並べた**配列形**である",
  );
  // **上限5 と重複不可を書き方の側にも書く**(完了条件2。数を丸めない)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**配列の要素数は1以上5以下である**");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("6つ目を書くと差分全体が拒否され");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("同じ入力を2つ書くこと(重複)もできない");
  // **島が受け取る形**(限定4)。宣言の形が島へ渡らないことまで書く。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**配列形のときに島が受け取る input は、各要素を宣言順に解決した結果を並べただけの配列である**",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("input[0] / input[1] …");
  // **後方互換(限定12)**: 単体形の渡り方が変わっていないことも書き方の側に書く。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**単体形のときの渡り方は今日と1バイトも変わらない**");
  // **単体形の既存の説明を1バイトも消していない**(完了条件4 = 削除0行の錨)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**code は入力を1つ受け取る関数で、次の2つの形のどちらでもよい**",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("input.source は table(そのテーブルの全行を配列で渡す)");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("source=record は table も view も書けない");
});

test("V3-M9-T04b (g) 記述→実装(逆向きの嘘の歯止め・書き方の側): 上限5・突き合わせは島・クエリ5語0・1ホップも辿らない", () => {
  // **実装の真**: 緩んだのは個数だけ。`$defs/function_input` は1バイトも変わっていない(限定2)。
  const schema = manifestSchema();
  // **【V4-M10-T44 / E-G72 / ADR-0083 限定1 による更新】** **4キー目(`via`)が入った。**
  // **`source` の enum は3値のまま・禁止7語は0のまま・`additionalProperties: false` も
  // 1バイトも変わっていない**(限定2)—— **緩んだのは「どの行か」の1点だけである。**
  const functionInput = schema.$defs.function_input;
  expect(Object.keys(functionInput.properties).sort()).toEqual(["source", "table", "via", "view"]);
  expect(functionInput.properties.source.enum).toEqual(["table", "view", "record"]);
  for (const forbidden of ["where", "filter", "select", "count", "group_by", "join", "on"]) {
    expect(Object.keys(functionInput.properties)).not.toContain(forbidden);
  }
  // **完了条件2 の3点を書き方の側にも書いていること。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**どの行がどの行に対応するかの突き合わせ(join)をカーネルは1行も行わず、それは島の JavaScript の仕事である**",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**where / select / count / group_by を1つも足していない**",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("入力の種類は table / view / record の3種のままである");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**カーネルは参照を1ホップも辿らない**");
  // **【V4-M10-T44 / ADR-0083 による更新】** 上と同じ差し替えを書き方の側にも当てる。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("「どの行か」を発火ごとに絞る語彙は今日1つだけ在る");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**孫・多段・join・逆参照(親の側を絞る)は1つも書けず、突き合わせは等値1つだけで条件も値も書けない。**",
  );
  // **限定6(実行予算は1ミリも動いていない)** —— 「大きな表を複数渡せる」と書いていない。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**入力を増やしても実行の予算は1つも変わらない**");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("判定は直列化後の総バイト数1本(和であって積ではない)");
  // **逆向きの嘘(1つでも入ったら赤)。** T04 (b) が VOCABULARY_SCOPE / CANNOT_DO に当てたものを、
  // **書き方の側にも当てる**(「参照先を読める」「注文別クーポンが解ける」を名指しで足す)。
  for (const lie of [
    "何でも読めます",
    "任意のテーブルを読めます",
    "参照先を読めるようになりました",
    "参照先を読める",
    "カーネルが突き合わせます",
    "カーネルが join",
    "join を書けます",
    "注文別クーポンが解ける",
    "在庫を減らせます",
  ]) {
    expect(APPLY_DIFF_OP_EXAMPLES, `APPLY_DIFF_OP_EXAMPLES が「${lie}」と述べている`).not.toContain(
      lie,
    );
  }
});

test("V3-M9-T04b (h) 記述↔記述: 要旨(VOCABULARY_SCOPE)と書き方(APPLY_DIFF_OP_EXAMPLES)が食い違っていない", () => {
  // **完了条件1 の後段**: 片方だけを直すと「要旨は複数入力・書き方は単体形のみ」に戻る。
  // **両方に現れる語で照合する**(言い回し〔です/ます ↔ である〕の差は照合対象にしない)。
  for (const shared of [
    "最大5つまで並べた",
    "宣言順",
    "突き合わせ(join)をカーネルは1行も行わず、それは島の JavaScript の仕事",
    "カーネルは参照を1ホップも辿",
    "table / view / record の3種のまま",
    "where / select / count / group_by",
    "配列には名前が無く",
    "判定は直列化後の総バイト数1本(和であって積ではない)",
  ]) {
    expect(VOCABULARY_SCOPE, `要旨が「${shared}」を述べていない`).toContain(shared);
    expect(APPLY_DIFF_OP_EXAMPLES, `書き方が「${shared}」を述べていない`).toContain(shared);
  }
});

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った test「V3-M9-T04b (i) docs/manual.md §11.5」 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

/*
 * V3-M10-T02(`D-G16b`。ADR-0064 限定6)—— **双方向の歯止め + 新しい非対称の明記**。
 *
 * 限定6 が課したのは3点である:
 *
 * - **(a)** schedule 関連の記述を、実装後に嘘にならない形へ書き換える。
 * - **(b)** **「時刻の述語は時刻専用であり、一般の比較演算子ではない」ことを明記する**
 *   (ADR-0064 §2 の (a) が挙げた「新しい非対称」—— これを書かないと AI は
 *   「時刻が比較できるなら数値も比較できる」と推測する)。
 * - **(c)** **`when` が依然として等値1形であることを明記する。**
 *
 * **(d) の沈黙**(`VOCABULARY_SCOPE` / `CANNOT_DO` が `schedule` × `$record.` の制限を
 * 1文字も述べていないこと)を射程に入れるか否かの判定は **T05** の仕事である
 * (`v3-m10.md` §2a-5 / §2-0b 2)。**T02 はその判定を先取りしない。**
 */
test("V3-M10-T02 (a): schema が older_than を持つ ⇔ 説明文がその形と条件を述べている(ADR-0064 限定6)", () => {
  // 実装の真: `$defs/workflow_trigger.properties.older_than` が実在する。
  const trigger = manifestSchema().$defs.workflow_trigger as Any;
  expect(trigger.properties.older_than).toBeDefined();
  expect(Object.keys(trigger.properties.older_than.properties).sort()).toEqual(["days", "field"]);

  // 実装 → 記述: 形(`{field, days}`)・値域・書ける場所が述べられている。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("older_than");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("date 型のフィールド");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("1〜3650");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("table を書いた schedule でだけ書ける");
  // 境界とタイムゾーンを述べる(実装が `>=` / `ST_TIMEZONE` である以上、書かないと嘘になる)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("ちょうど N 日");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("ST_TIMEZONE");
});

test("V3-M10-T02 (b): 時刻の述語は時刻専用であり、一般の比較演算子ではないと明記されている", () => {
  // **ADR-0064 §2 の (a) が挙げた新しい非対称そのものである。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("時刻専用");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("一般の比較演算子ではない");
  // 「時刻が比較できるなら数値も比較できる」という推測を明示的に否定する。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "数値や文字列の大小をワークフローの条件に書く手段は1つも無い",
  );

  // 記述 → 実装: 実際に schema のどこにも比較演算子が生えていない。
  const schema = manifestSchema();
  const when = schema.$defs.workflow_action.properties.when as Any;
  for (const operator of ["lt", "gt", "lte", "gte"]) {
    expect(when.properties[operator]).toBeUndefined();
  }
  const older = (schema.$defs.workflow_trigger as Any).properties.older_than;
  expect(Object.keys(older.properties).sort()).toEqual(["days", "field"]);
});

test("V3-M10-T02 (c): when が依然として等値1形であることが明記されている", () => {
  // **ADR-0064 限定2(when を1バイトも触らない)を記述側でも固定する。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("when は等値の最小述語1形");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("older_than を足しても when は1バイトも変わっていない");
  // 既存の記述を1文字も消していない(ADR-0036 の限定の文言はそのまま残る)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "比較(lt/gt/lte/gte)・論理結合(and/or)・else・ネスト・条件式は1つも書けない",
  );
  // **AND は2層の合成である**ことを述べる(述語を結合可能にしたと読ませない)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("2つの条件を組み合わせたいときは");

  // 記述 → 実装: `when` の required / additionalProperties は今日も等値1形。
  const when = manifestSchema().$defs.workflow_action.properties.when as Any;
  expect([...when.required].sort()).toEqual(["equals", "field"]);
  expect(when.additionalProperties).toBe(false);
});

/*
 * V3-M10-T05(語彙記述の是正。Δ5。ADR-0063 限定8 / ADR-0064 限定6)
 * ---------------------------------------------------------------------------
 *
 * **T01 / T02 が直したのは `APPLY_DIFF_OP_EXAMPLES` の (11)(12) だけである**(実測:
 * 着手時点で `VOCABULARY_SCOPE` は 8,997 字・`CANNOT_DO` は 6,573 字で、T01 / T02 の
 * 実装後も同じ字数のまま = 1バイトも触られていなかった)。**T05 は残る2定数を直した。**
 *
 * **§0-4b (1) の「着手時点で既に在る沈黙」を射程に入れると判定した**
 * (`v3-m10-t05.md` §2 に判定と理由)。**この沈黙は V3-M10 が作った乖離ではない** ——
 * 着手時点(`52695da`)で既に `VOCABULARY_SCOPE` / `CANNOT_DO` は `schedule` × `$record.`
 * の制限を1文字も述べていなかった。**しかし ADR-0063 §2 の (a) が「行選択を入れると
 * `$record.` が書ける場合と書けない場合に分岐するので、沈黙は今日より重くなる」と
 * 書いており、分岐する規則は例を1つ見ても推測できない。** したがって埋めた。
 *
 * **双方向で置く**(片方向だけだと逆向きの嘘に倒れる。V2-M3-T05 以来の規律):
 * **実装→記述**(schema / カーネルの真を読んで、記述がそれを述べていること)と
 * **記述→実装**(記述が広く言いすぎていないこと = 比較演算子が本当に0件であること)。
 */

test("V3-M10-T05 (a) 実装→記述: VOCABULARY_SCOPE が schedule の2形・上限・分岐・older_than を述べている", () => {
  const schema = manifestSchema();
  const trigger = schema.$defs.workflow_trigger as Any;
  // **実装の真1**: `schedule` 分岐から `"table": false` が消えている(ADR-0063)。
  const scheduleBranch = (trigger.allOf as Any[]).find(
    (branch) => branch.if.properties.type.const === "schedule",
  ) as Any;
  expect(scheduleBranch.then.properties?.table).toBeUndefined();
  // **実装の真2**: `older_than` が実在し、`{field, days}` の平坦な1形である(ADR-0064)。
  expect(Object.keys(trigger.properties.older_than.properties).sort()).toEqual(["days", "field"]);
  // **実装の真3**: 1回の発火の行数上限は 1000 で、**非 export** である(ADR-0063 限定5)。
  const scheduler = readSrc("src", "kernel", "workflow-scheduler.ts");
  expect(scheduler).toContain("const SCHEDULE_ROW_LIMIT = 1000;");
  expect(scheduler).not.toContain("export const SCHEDULE_ROW_LIMIT");

  // **記述の側**: 2形あること・分岐すること・上限・older_than・時刻専用であること。
  expect(VOCABULARY_SCOPE).toContain("**決まった時刻の発火(schedule)には2つの形があります**");
  expect(VOCABULARY_SCOPE).toContain("table を書くとその表の行を1件ずつ処理します");
  expect(VOCABULARY_SCOPE).toContain("1回の発火で 1000 行までで");
  expect(VOCABULARY_SCOPE).toContain(
    "table を書いた schedule では各行がトリガー元レコードになるので $record.<フィールドID> と when が書けます",
  );
  expect(VOCABULARY_SCOPE).toContain("table を書かない schedule ではどちらも書けず");
  expect(VOCABULARY_SCOPE).toContain("older_than");
  expect(VOCABULARY_SCOPE).toContain("1〜3650");
  expect(VOCABULARY_SCOPE).toContain("ST_TIMEZONE");
  // **発火の時刻と頻度は1ミリも変わっていない**(ADR-0063 限定2 / ADR-0064 限定3)。
  expect(VOCABULARY_SCOPE).toContain("**発火の時刻と頻度は1ミリも変わっていません**");
});

test("V3-M10-T05 (b) 記述→実装: 記述は「比較ができる」に倒れていない —— 比較演算子は schema に0件", () => {
  const schema = manifestSchema();
  // **実装の真**: `when` は等値1形のまま。比較演算子も論理結合も1つも生えていない。
  const when = schema.$defs.workflow_action.properties.when as Any;
  for (const forbidden of ["lt", "gt", "lte", "gte", "and", "or", "not", "else"]) {
    expect(Object.keys(when.properties)).not.toContain(forbidden);
  }
  expect([...when.required].sort()).toEqual(["equals", "field"]);
  expect(when.additionalProperties).toBe(false);
  // **実装の真**: `older_than` も `{field, days}` の2キーだけで、演算子キーを持たない。
  const older = (schema.$defs.workflow_trigger as Any).properties.older_than as Any;
  expect(older.additionalProperties).toBe(false);
  for (const forbidden of ["lt", "gt", "lte", "gte", "operator", "op", "hours", "newer_than"]) {
    expect(Object.keys(older.properties)).not.toContain(forbidden);
  }
  // **実装の真**: `$defs/schedule_at` は2キーのまま(cron / 曜日 / 間隔は0件)。
  expect(Object.keys(schema.$defs.schedule_at.properties).sort()).toEqual(["hour", "minute"]);

  // **記述の側**: 「時刻専用であって一般の比較演算子ではない」を3定数のうち2つで述べる。
  expect(VOCABULARY_SCOPE).toContain(
    "**これは時刻専用の1形であって、一般の比較演算子ではありません**",
  );
  expect(VOCABULARY_SCOPE).toContain(
    "数値や文字列の大小をワークフローの条件に書く手段は今日も1つもありません",
  );
  expect(CANNOT_DO).toContain(
    "**数値や文字列の大小をワークフローの条件に書く手段は1つもありません**",
  );
  expect(CANNOT_DO).toContain(
    "**これは時刻専用の1形であって、比較演算子が入ったわけではありません。**",
  );
});

test("V3-M10-T05 (c) CANNOT_DO: ユーザの言い回しで「大小の比較は無い / 経過時間だけは別」が両方書かれている", () => {
  // **ADR-0064 §2 の (a) が挙げた「新しい非対称」そのものである** ——
  // これを書かないと AI は「時刻が比較できるなら数値も比較できる」と推測する。
  // **【V5-M14 / G-G15 による逐語の更新】** **例示が業種に偏らない言い方へ差し替わった**
  // (`docs/plan/v5/records/v5-m14.md` §4-1)。**固定している内容(大小の比較を書く手段が
  // 無いこと)は1文字も弱めていない** —— 変わったのは例示の語だけである。
  expect(CANNOT_DO).toContain("「金額が1000円以上の行だけ処理して」");
  expect(CANNOT_DO).toContain("「残数が10を下回った行だけ印を付けて」");
  // **「できない」に全部倒していない**(older_than は実在する)。
  expect(CANNOT_DO).toContain("trigger.older_than");
  expect(CANNOT_DO).toContain("date 型の項目が N 日以上前");
  // **「できる」に全部倒していない**(即座ではない・上限がある・table 無しでは書けない)。
  expect(CANNOT_DO).toContain(
    "「3日ちょうど」ではなく「3日経ったあとの最初の発火時刻」に処理されます",
  );
  expect(CANNOT_DO).toContain(
    "**1回の発火で処理できるのは 1000 行までで、超えるとその発火は1行も処理せずに打ち切られます**",
  );
  expect(CANNOT_DO).toContain(
    "**trigger に表を書かない schedule では、$record.<フィールドID> も when も1つも書けません**",
  );
  // **AND は2層の合成である**(述語を結合可能にしたと読ませない)。
  expect(CANNOT_DO).toContain("and / or を書く場所はどこにもありません");
});

test("V3-M10-T05 (d) 逆向きの嘘の歯止め: 3定数とも「schedule で何でもできる」に倒れていない", () => {
  const lies = [
    "schedule でも $record. が使えます",
    "schedule に条件が書けるようになりました",
    "比較演算子が書けます",
    "cron 式が書けます",
    "曜日を指定できます",
    "行ごとに処理済みを覚えます",
    "打ち切られた行は次回に回されます",
  ];
  for (const lie of lies) {
    expect(VOCABULARY_SCOPE, `VOCABULARY_SCOPE が「${lie}」と述べている`).not.toContain(lie);
    expect(CANNOT_DO, `CANNOT_DO が「${lie}」と述べている`).not.toContain(lie);
    expect(APPLY_DIFF_OP_EXAMPLES, `APPLY_DIFF_OP_EXAMPLES が「${lie}」と述べている`).not.toContain(
      lie,
    );
  }
  /*
   * **【V3-M13-T09 による期待値の更新】** この2行は「`D-G15` は3回目も保留であり実装が
   * 1バイトも無い」ことを前提に置かれていた。**4回目(2026-08-01)の門A 本審査で限定採用
   * され(ADR-0067)、`run_function` の `write_ops` として実装された。**
   * **この test の主眼(`schedule` について逆向きの嘘へ倒れていないこと)は1バイトも
   * 変えていない** —— 上の `lies` 7件は今日も全件不在である。
   * **「打ち切れる」と「在庫が戻る」を混ぜない**という `v3-m10.md` §0-4 (2) の規律も維持する ——
   * `schedule` の発火**全体**は今日も原子的ではなく(`ADR-0066` 限定7 / `ADR-0067` 限定 C1)、
   * 原子性が成立するのは**1つの run_function が返す op 配列の内側だけ**である。
   */
  expect(VOCABULARY_SCOPE).toContain(
    "**したがって「今の値を読んで、その値から引く」形は、ワークフローのアクションの値(values)には書けません**",
  );
  expect(VOCABULARY_SCOPE).toContain(
    "他テーブルの行の**現在値**を values 側で参照する語彙は今日も1つも無く",
  );
  // **`schedule` の発火全体が原子的になったとは1文字も書いていない**(限定 C1)。
  expect(VOCABULARY_SCOPE).not.toContain("schedule の発火は全部巻き戻ります");
  expect(VOCABULARY_SCOPE).toContain("**決まった時刻の発火(schedule)は巻き戻りません**");
});

test("V3-M10-T05 (e) 「絞りは2箇所」の数え上げを補った(不完全になったら補う)", () => {
  // **【V4-M10-T44 / E-G72 / ADR-0083 による更新】** **旧主節「絞る語彙も今日はありません」は
  // 偽になったので、新しい逐語に差し替えた。** **older_than についての補い(下)は今日も真である。**
  expect(VOCABULARY_SCOPE).toContain("「どの行か」を発火ごとに絞る語彙は、今日1つだけあります");
  // **上と同じ差し替えを書き方の側にも当てる**(片方だけ直すと逆向きの嘘になる)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("「どの行か」を発火ごとに絞る語彙は今日1つだけ在る");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**孫・多段・join・逆参照(親の側を絞る)は1つも書けず、突き合わせは等値1つだけで条件も値も書けない。**",
  );
  // **補った側**: older_than は「入力のどの行か」ではなく「発火がどの行を対象にするか」である。
  expect(VOCABULARY_SCOPE).toContain(
    "**schedule の older_than は「入力のどの行か」ではなく「発火がどの行を対象にするか」を絞るもので、",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**schedule の trigger.older_than は「入力のどの行か」ではなく「発火がどの行を対象にするか」を",
  );
  // **記述→実装**: 関数の入力の語彙は1バイトも変わっていない(3キー・3種)。
  // **【V4-M10-T44 / E-G72 / ADR-0083 限定1 による更新】** **4キー目(`via`)が入った。**
  // **`source` の enum は3値のまま・禁止7語は0のまま・`additionalProperties: false` も
  // 1バイトも変わっていない**(限定2)—— **緩んだのは「どの行か」の1点だけである。**
  const functionInput = manifestSchema().$defs.function_input as Any;
  expect(Object.keys(functionInput.properties).sort()).toEqual(["source", "table", "via", "view"]);
  expect(functionInput.properties.source.enum).toEqual(["table", "view", "record"]);
});

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った test「V3-M10-T05 (f) docs/manual.md」 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

// ---------------------------------------------------------------------------
// V4-M22-T03: Δ5 —— 検索の口で偽になる/誤解を招く散文を、同じ差分で直す
// (`ADR-0112` 限定3・限定5・限定6・限定7・限定9・限定12 / `ADR-0086` 限定4)
// ---------------------------------------------------------------------------

test("V4-M22-T03 (Δ5): VOCABULARY_SCOPE の update_view の列挙が search_fields を含む", () => {
  // **列挙を件数に丸めない**(既存の作法)。**旧文を1バイトも消していない。**
  expect(VOCABULARY_SCOPE).toContain("search_fields");
  // **【V4-M22-T05 / T07 による更新。理由を書く】** 本検査は着手時に「**18**キーだけ」を
  // 逐語で見ていた。**同じ V4-M22 の T05 が19キー目 `page_size` を足したので、件数の主張は
  // 下の `V4-M22-T07` の検査が持つ**(2箇所で同じ数を主張して片方だけ古くなる形を作らない)。
  // **「17キーだけ」に戻っていないことは、ここが今日も見ている。**
  expect(VOCABULARY_SCOPE).not.toContain("の17キーだけ");
});

test("V4-M22-T03 (Δ5): AI 向けの説明文が、書ける型と隠した項目についての限界と contains 固定を述べている", () => {
  // **`ADR-0112` 限定5**(text / long_text の2型だけ)。
  expect(VOCABULARY_SCOPE).toContain("text / long_text");
  // **【`V8-M20`。台帳 `J-G28`(判定 = 廃止)。手続きは `ADR-0301`】**
  //   旧テスト名: 「…書ける型と audience の禁止と contains 固定を述べている」
  //   旧: `expect(VOCABULARY_SCOPE).toContain("audience")`(`ADR-0112` 限定6 の錨)
  //   新: **禁止そのものが消えたので、代わりに「今日は書けてしまう」と、その帰結を述べて
  //        いることを見る。**
  // **2026-08-10 に `src/kernel/referential-integrity.ts` を読んで確かめた** ——
  // **`search_fields` の検査が見るのは実在と型の2つだけであり、限定6 の禁止は
  // 撤去された宣言のキーを見ているので今日1件も発火しない。**
  // **【禁止の履行】「禁止が消えた」で終わらせない** —— **限定6 が塞いでいた漏れ
  // (絞り込みの当たり外れから値が推測される)は今日も残っており、説明文はそれを書く。**
  expect(VOCABULARY_SCOPE).toContain(
    "**役割の規則(rules)が名指ししている項目でも、検索の対象として宣言できます**",
  );
  expect(VOCABULARY_SCOPE).toContain(
    "**絞り込みの当たり外れから、見えないはずの値が推測される余地が残ります**",
  );
  // **`ADR-0112` 限定7**(照合は部分一致の OR で固定。演算子を1つも書けない)。
  expect(VOCABULARY_SCOPE).toContain("部分一致");
  // **`ADR-0112` 限定12**(既定は「口を出さない」)。
  expect(VOCABULARY_SCOPE).toContain("書かなかった画面には検索の入力欄が出ません");
});

test("V4-M22-T03 (ADR-0086 限定4): related の子一覧に当たらないことを、黙らずに明記している", () => {
  // **「書けるが効かない」を黙って作らない。** `related` は `detail_view` の中の定義であり、
  // **`search_fields` を書く場所がそもそも無い** —— **その事実を AI 向けの説明文が述べる。**
  // **`ADR-0093` 限定7 / `ADR-0113` 限定8 と同じ形である。**
  expect(VOCABULARY_SCOPE).toContain("関連レコード一覧(related)に検索の入力欄は出ません");
});

test("V4-M22-T03 (Δ5): 表示層の方針文を消さず、いつ・どの ADR が射程を引き直したかを併記している", () => {
  const renderer = readSrc("web", "src", "views", "ListViewRenderer.tsx");
  // **旧文を1バイトも消していない**(v0 から生きている方針文である)。
  expect(renderer).toContain("**並べ替え・絞り込みをフロントで実装しない。**");
  // **いつ・どの ADR が射程を引き直したかを併記する。**
  expect(renderer).toContain("V4-M22-T02");
  expect(renderer).toContain("ADR-0112");
  // **並べ替えの側は1ミリも引き直していない**(引き直したのは絞り込みの一部だけである)。
  expect(renderer).toContain("並べ替えの側は1ミリも引き直していない");
});

// ---------------------------------------------------------------------------
// V4-M22-T07: Δ5 —— 一覧の件数で偽になる散文と既存検査を、同じ差分で直す
// (`ADR-0113` 限定8・限定11 / 台帳 `:887` の (d) の履行)
// ---------------------------------------------------------------------------

// **【V4-M19-T03 / ADR-0118 限定1 で 19 → 20 に更新した】** `preset_density`
// (画面の詰まり具合)が門A を通って加わったので、`src/mcp/vocabulary.ts` の散文は
// 「の20キーだけ」になった。**本 ADR の増分ではない** —— 期待値だけを実数に合わせる
// (散文は既に直してある)。
test("V4-M22-T07 (Δ5): VOCABULARY_SCOPE の update_view の列挙が19キーになり、page_size を含む", () => {
  // **【V4-M20-T04 / ADR-0102 限定1 で 20 → 21 に更新した】** 21キー目 `after_save`
  // (保存が成立したあとに行く画面)が門A を通って `view_changes` に加わった
  // (V4-M20 単位D。判定 = 限定採用)。**テスト名(19キー)は制定時の記述であり、
  // 1バイトも書き換えていない。****固定の向き(説明文とスキーマを一致させる)を
  // 1ミリも弱めていない** —— 旧い件数が残っていたら赤くなる側も足す。
  // **【V4-M23-T01 / ADR-0104 限定1 で 21 → 22 に更新した】** 22キー目 `sum_field`
  // (合計を出す列)が門A を通って `view_changes` に加わった(V4-M23 単位A-2。
  // 4回目の審査 = 3回目の再提出。判定 = 限定採用)。**テスト名(19キー)は制定時の
  // 記述であり、1バイトも書き換えていない。**
  expect(VOCABULARY_SCOPE).toContain("page_size");
  expect(VOCABULARY_SCOPE).toContain("sum_field");
  // **【V5-M21-T03 / `L-G4` / ADR-0172 限定1 で 22 → 23 に更新した】** `actions` が
  // 加わった。**テスト名(19キー)は制定時の記述であり、1バイトも書き換えていない。**
  expect(VOCABULARY_SCOPE).toContain("actions");
  // **【`V6-M2-T04` / `K-G3` / `K-G21a` / `ADR-0289` 限定1 で 23 → 24 に更新した】**
  // 24キー目 `reference_pickers` が `UPDATE_VIEW_ACCEPTED_KEYS` に加わった。
  // **件数は `.length` 由来なので、描画側は要素を足すだけで追随する。**
  expect(VOCABULARY_SCOPE).toContain("reference_pickers");
  // **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` §4a 限定2 で 24 → 25 に更新した】**
  // 25キー目 `after_delete`(削除が成立したあとの行き先)が `UPDATE_VIEW_ACCEPTED_KEYS` に
  // 加わった。**件数は `.length` 由来なので、描画側は要素を足すだけで追随する。**
  // **テスト名(19キー)は制定時の記述であり、1バイトも書き換えていない。**
  // **【正直に書く】この25 は `$defs/view_changes` の26 と一致しない** ——
  // **`UPDATE_VIEW_ACCEPTED_KEYS` に `report`(`V8-M8` が足した)が着手前から欠けている。**
  // **本タスクはその欠落を埋めていない**(`ADR-0359` の射程外である)。
  expect(VOCABULARY_SCOPE).toContain("after_delete");
  // **【2026-08-20。`V10-M4-T01` / `NV-G9` / `ADR-0359` §4b 限定1 で 25 → 26 に更新した】**
  // 26キー目 `flow`(一続きの流れの中の段)が `UPDATE_VIEW_ACCEPTED_KEYS` に加わった。
  // **件数は `.length` 由来なので、描画側は要素を足すだけで追随する。**
  // **テスト名(19キー)は制定時の記述であり、1バイトも書き換えていない。**
  // **【正直に書く】この26 は `$defs/view_changes` の27 と一致しない** ——
  // **`UPDATE_VIEW_ACCEPTED_KEYS` に `report`(`V8-M8` が足した)が着手前から欠けている。**
  // **本タスクもその欠落を埋めていない。**
  expect(VOCABULARY_SCOPE).toContain("flow");
  expect(VOCABULARY_SCOPE).toContain("の26キーだけ");
  expect(VOCABULARY_SCOPE).not.toContain("の19キーだけ");
  expect(VOCABULARY_SCOPE).not.toContain("の20キーだけ");
  expect(VOCABULARY_SCOPE).not.toContain("の21キーだけ");
  expect(VOCABULARY_SCOPE).not.toContain("の24キーだけ");
  // **旧行の逐語**: `expect(VOCABULARY_SCOPE).toContain("の25キーだけ");`
  expect(VOCABULARY_SCOPE).not.toContain("の25キーだけ");
});

test("V4-M22-T07 (Δ5): AI 向けの説明文が、4つの段階値と既定 50 とページ位置の不在を述べている", () => {
  // **`ADR-0113` 限定3**(値は段階値の enum だけ)。
  expect(VOCABULARY_SCOPE).toContain("10 / 20 / 50 / 100");
  // **限定10**(既定は 50)。
  expect(VOCABULARY_SCOPE).toContain("書かなかった画面は 50 件");
  // **限定4**(ページ位置は書けない)。
  expect(VOCABULARY_SCOPE).toContain("今何ページ目かは書けません");
});

test("V4-M22-T07 (ADR-0113 限定8): related の子一覧の件数が変わらないことを、黙らずに明記している", () => {
  // **「書けるが効かない」を黙って作らない**(`ADR-0093` 限定7 / `ADR-0112` と同じ形)。
  expect(VOCABULARY_SCOPE).toContain("関連レコード一覧(related)の件数は変わりません");
});

test("V4-M22-T07 (限定11): CANNOT_DO の「1ページの件数は選べない」が、今日の事実に直っている", () => {
  // **旧文は逐語「**1ページの件数**」を「選べません」の側に並べていた。** **今日から偽である。**
  // **だが「件数が自由に選べる」に倒すと逆向きの嘘になる** —— **選べるのは4つの段階値だけで、
  // 自由な数は今日も書けない。****双方向に書く**(`V4-M16-T11` / `V4-M16-T13` と同じ作法)。
  expect(CANNOT_DO).toContain("1ページの件数は 10 / 20 / 50 / 100 の4つからだけ選べ");
  expect(CANNOT_DO).toContain("自由な数は今日も書けません");
});

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った test「V4-M22-T07 (限定11)」 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った test「V4-M22-T07 (Δ5) 旧断定が文書から消えている」 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

// ---------------------------------------------------------------------------
// V4-M41a(ユーザ決定 `D-V4-129`): AI 向けの説明が実物と食い違っている箇所を直す
// ---------------------------------------------------------------------------
//
// **本ブロックは既存の検査を1本も消していない。** 足しただけである。

test("V4-M41a (a): 受信で届いた本文から予約規約フィールドが黙って落ちることが、VOCABULARY_SCOPE に書いてある", () => {
  // **`V4-M27`(`st_public`)と `V4-M36`(残る3本)が受信 payload から無条件に取り除く実装を
  // 入れたのに、AI 向け説明文には1文字も書かれていなかった**(`records/v4-m27.md` §9 の 2 /
  // `records/v4-m36.md` §8 の 4)。**嘘は書かれていないが、何も書かれていなかった。**
  // **実装の真は `src/server/owner-scope.ts` の `INBOUND_STRIPPED_RESERVED_FIELDS`。**
  // **【`V8-M20`。台帳 `J-G30`(判定 = 廃止)。手続きは `ADR-0301`】4本 → 3本 に更新した。**
  // **旧値をここに残す**: 期待していたのは
  // `[PUBLIC_FIELD, ADMIN_READABLE_FIELD, UNDELETABLE_FIELD, NO_DIRECT_CREATE_FIELD]` の4本。
  // **問い(落ちる本数と id が実装と一致するか)は1バイトも変えていない。**
  expect(VOCABULARY_SCOPE).toContain("書込の直前に黙って取り除かれます");
  for (const field of [PUBLIC_FIELD, UNDELETABLE_FIELD, NO_DIRECT_CREATE_FIELD]) {
    expect(VOCABULARY_SCOPE, field).toContain(field);
  }
  // **拒否ではないこと(=エラーにならない)を書いていること。**
  expect(VOCABULARY_SCOPE).toContain("拒否ではありません");
});

test("V4-M41a (a): 同じ事実が CANNOT_DO の予約規約フィールドの段落にも書いてある", () => {
  // **`CANNOT_DO` は予約規約フィールドを名指しで説明している唯一の段落であり、
  // 受信経路の非対称(`write_records` / 受信 capability は守られない)も既にここに在る。**
  // **「受信では黙って落ちる」を書く場所として、ここを外すと AI は片方しか読まない。**
  // **【`V8-M20`。台帳 `J-G30`】期待値を書き換えた。旧値を残す** ——
  //   旧: `expect(CANNOT_DO).toContain("受信口から届いた本文にこれら4本を書いても")`
  //   新: 3本。
  expect(CANNOT_DO).toContain("受信口から届いた本文にこれら3本を書いても");
  expect(CANNOT_DO).toContain("黙って取り除かれます");
});

test("V4-M41a (d) #7: 「狭い画面では潰れます」が、一覧の表と項目の段組で分けて書かれている", () => {
  // **`records/v4-m29.md` §1-1 の #7**: 前半(画面幅に追随しない)は真だが、
  // **後半は曖昧になった** —— `V4-M15` が一覧の表を横スクロールの器(`TableFrame` =
  // `overflow-x-auto`)で包んだので、**列は潰れずに横へ送れる。**
  // **段組(`.detail-fields` / `.form-fields` の `minmax(0, 1fr)`)は器を持たないので今日も縮む。**
  expect(CANNOT_DO).toContain("画面幅に追随しない"); // 既存の検査(:2167)が見ている逐語を壊さない
  expect(CANNOT_DO).toContain("一覧の表は横スクロールの器に入っている");
  expect(CANNOT_DO).toContain("項目の段組は器を持たない");
  // **旧文(2つを1つに丸めた断定)が復活したら赤くする。**
  expect(CANNOT_DO).not.toContain("固定値で、狭い画面では潰れます");
});

test("V4-M41a (d) #8: 「レスポンシブはこの語彙に1つもない」が、画面の側の事実と分けて書かれている", () => {
  // **`records/v4-m29.md` §1-1 の #8**: 括弧が「あなたが差分で指定する手段」に限定しているので
  // **今日も真**だが、**リード文だけを読むと「画面が幅に追随しない」と誤読されうる。**
  // **実物**: `web/src/tailwind.css:70`-`:71` が断点を2本(`sm` = 40rem / `lg` = 64rem)持ち、
  // `web/src/styles.css:913` / `:919` が `.shell` の余白をその2本で変えている。
  expect(CANNOT_DO).toContain("レスポンシブ"); // 既存の検査(:2165)が見ている逐語を壊さない
  expect(CANNOT_DO).toContain("画面が画面幅に1ミリも追随しない");
  expect(CANNOT_DO).toContain("断点");
  // **【本タスクが自分の誤りを検査で塞ぐ】** 最初に書いた文は逐語「変わるのは外枠の余白だけで、
  // アプリの中身の並びは1つも変わりません」だったが、**実測で偽だった** —— **`web/src/` の
  // 10ファイル・49箇所が `sm:` / `lg:` を使っており、一覧のページャ・まとめ操作の並び・
  // 入力欄の幅・詳細の項目名の位置は画面幅で実際に変わる**
  // (`ListViewRenderer.tsx:1411` / `FormRenderer.tsx:294` / `DetailViewRenderer.tsx:849`)。
  // **その断定が復活したら赤くする。**
  expect(CANNOT_DO).not.toContain("アプリの中身の並びは1つも変わりません");
  expect(CANNOT_DO).toContain("入力欄の幅・詳細の項目名の位置は");
  // **同時に「レスポンシブになった」に倒れていないこと** —— **プリセット(段組数・列幅)は
  // 今日も追随しない。****#7 の段落と矛盾させない。**
  expect(CANNOT_DO).toContain("そこは今日も画面幅に追随しません");
});

test("V4-M41a (e): 実行履歴の error 欄が「成功なら空」と断定していない", () => {
  // **`records/v4-m38-gate-a.md` §1-1 の実測**: **`status='success'` かつ `error` が非空の行は
  // 29件**(全件が `when` によるスキップ通知)。**旧文「(成功したときは空になります)」は
  // 今日すでに嘘である。**
  // **【区別を丸めない】`ADR-0131` 限定8 は破れていない** —— 限定8 の第4列は
  // 「**0件の実行の直後**に履歴が1行増え `status` が `success` / `error` が `null` である検査1本」
  // であり、射程は 0件の実行に限られる。**破れているのは「成功なら必ず空」という一般化の方である。**
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).not.toContain("成功したときは空になります");
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain(
    "status が success の行でも error が空でないことがあります",
  );
  // **逆向きの嘘(「error はいつも埋まる」)に倒れていないこと。**
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("失敗の理由だけではありません");
  // **0件の実行についての限定8 の射程を、説明文の側でも消していないこと。**
  expect(WORKFLOW_HISTORY_TABLE_TEMPLATE).toContain("何も処理するものが無かった実行");
});

// **【`V9-M11-T02` / 台帳 `X-G28`】ここに在った test「V4-M41a (c) ADR-0090 / ADR-0092」 は `tools/docs/vocabulary-docs.test.ts` へ切り出した**(`docs/` を fs で読むため。公開単位は公開単位の外を読まない)。

// ---------------------------------------------------------------------------
// V5-M21-T05 (`L-G1` / `L-G2` / `L-G4`。ADR-0171 無効化条文6・7 / ADR-0172 無効化条文2。Δ5)
// ---------------------------------------------------------------------------

/**
 * **AI に渡す説明文が、今日の実物と食い違っていないこと。**
 *
 * **`ADR-0171` / `ADR-0172` はどちらも `Δ5`(説明文を書き換えないと嘘になる)を
 * 門A への引き上げ根拠に挙げている。** **したがって説明文の是正は増分の一部であり、
 * 後回しにできない**(`V4-M3-T07` が「期待値だけを更新して文言を放置すると緑のまま
 * 嘘が固定される」と書いたのと同じ理由)。
 */
test("V5-M21-T05 (Δ5): 説明文が「一覧に actions は書けない」と言っていない(ADR-0171 が解いた)", () => {
  expect(VOCABULARY_SCOPE).not.toContain(
    "**一覧(list_view)と入力フォーム(form)に actions は書けません。**",
  );
  // **一覧に置けることと、置けるのが遷移の形だけであることの両方を述べている。**
  /*
   * **【`V5-M22-T05` / `L-G5` / `ADR-0173` で書き換えた】** 着手前の1行は逐語
   * `expect(VOCABULARY_SCOPE).toContain("一覧に書けるのは (i) の形だけです");` であった。
   * **今日は偽である** —— **`ADR-0173`(門A / 判定 = 限定採用)が3形目(行き先の宣言)を
   * 一覧に開いた。** **`ADR-0171` の主張(一覧に `set` を書けない)は1ミリも変わっていない**
   * (直下の別テストがそれを固定している)。**旧文を逐語でここに残してある。**
   */
  expect(VOCABULARY_SCOPE).toContain("一覧(list_view)の行にも操作の起点(actions)を書けます");
  /*
   * **【`V5-M25-T07` / `L-G3` で書き換えた。旧文を隠さない】** 着手前の1行は逐語
   * `expect(VOCABULARY_SCOPE).toContain("一覧に書けるのは (i) の形と (iii) の形の2つです");`
   * であった。**今日は偽である** —— **`V5-M25-T03` が `ADR-0175` の規則を実装したので
   * `ADR-0171` 限定10 の順序拘束が解け、`set` 形が開いた。****4形目(`run`)も
   * `ADR-0174` が開いた。**
   */
  expect(VOCABULARY_SCOPE).toContain(
    "一覧に書けるのは (i) 遷移(form + prefill)/ (ii) 値の書換(set)/ (iii) 行き先の宣言(view)/ (iv) 自動処理の起動(run)の4つです。",
  );
  // **入力フォームの分は今日も真である**(`ADR-0171` 限定3)。
  expect(VOCABULARY_SCOPE).toContain("入力フォーム(form)に actions は書けません");
});

/*
 * **【`V5-M25-T07` / `L-G3` で反転した。旧テスト名と旧の期待を隠さない】**
 * **旧テスト名(逐語)**: 「**V5-M21-T05 (Δ5): 説明文が「一覧では set 形を書けない」ことを
 * 明記している(書けるが効かないを作らない)**」/ 旧の期待:
 * `expect(VOCABULARY_SCOPE).toContain("一覧では set は書けません");`
 * **今日は偽である** —— **順序拘束が解け、一覧にも `set` を書けるようになった。**
 * **「書けるが効かない」を作らないという趣旨(`ADR-0086` 限定4)は1ミリも弱めていない** ——
 * **書けるようになったと同時に、表示層(`ListViewRenderer`)が実際に書き換える**
 * (`web/test/list-view-set-action.test.tsx`)。
 */
test("V5-M25-T07 (Δ5): 説明文が「一覧にも set を書ける」ことを明記している(書けるが効かないを作らない)", () => {
  expect(VOCABULARY_SCOPE).not.toContain("一覧では set は書けません");
  expect(VOCABULARY_SCOPE).toContain("一覧の set も詳細画面の set と同じで");
});

test("V5-M21-T05 (Δ5): 説明文が「押した行を引き継ぐ」ことを述べている(L-G2)", () => {
  expect(VOCABULARY_SCOPE).toContain("押した行");
});

test("V5-M21-T05 (Δ5): 説明文が「actions は update_view で書けません」と言っていない(ADR-0172 が解いた)", () => {
  expect(VOCABULARY_SCOPE).not.toContain(
    "**actions は update_view で書けません**(add_view でだけ書けます)が、",
  );
  expect(VOCABULARY_SCOPE).toContain("actions は update_view でも書けます");
  // **全置換であることを明記している**(`ADR-0172` 限定2)。
  expect(VOCABULARY_SCOPE).toContain("書いた配列でそっくり置き換わります");
});

// ---------------------------------------------------------------------------
// V5-M22-T05 (`L-G5` / `L-G6` / `L-G7`。ADR-0173 無効化条文4。Δ5)
// ---------------------------------------------------------------------------

/**
 * **`ADR-0173` は `Δ5` を門A への引き上げ根拠に挙げている**(`S2` の逐語:
 * 「`src/mcp/vocabulary.ts:387` 逐語『**3つ目の形はありません**…』を書き換えないと
 * 嘘になる」)。**したがって説明文の是正は増分の一部であり、後回しにできない。**
 *
 * **【禁止】「どこへでも飛べる」と読める文にしない**(`ADR-0173` 限定3)。
 * **【禁止】「詳細画面からも飛べる」と読める文にしない**(`L-G7` = 却下)。
 */
test("V5-M22-T05 (Δ5): 説明文が「3つ目の形はありません」と言っていない(ADR-0173 が解いた)", () => {
  // **`ADR-0173` §Decision 6 の4 が「全部」を無効化と名指しした唯一の条文である。**
  expect(VOCABULARY_SCOPE).not.toContain("**3つ目の形はありません**");
  expect(VOCABULARY_SCOPE).not.toContain("3つ目の形はありません");
});

test("V5-M22-T05 (Δ5): 説明文が3形目(行き先の宣言)を述べ、かつ一覧だけであることを明記している", () => {
  expect(VOCABULARY_SCOPE).toContain("行き先");
  // **一覧にだけ書けること**(`L-G7` = 却下による非対称)。
  expect(VOCABULARY_SCOPE).toContain("詳細画面(detail_view)には書けません");
  /*
   * **【`V5-M25-T01` / `L-G8` / `ADR-0174` による追随。旧を隠さない】**
   * **旧(逐語)**: `expect(VOCABULARY_SCOPE).toContain("4つ目の形はありません");`
   * **今日は偽である** —— **`ADR-0174` が4形目(自動処理の起動 = `run`)を足した。**
   * **置き換えとなる新しい不変条件: 5つ目の形はありません。**
   */
  expect(VOCABULARY_SCOPE).toContain("5つ目の形はありません");
});

test("V5-M22-T05 (Δ5): 説明文が行き先の値域を狭く述べている(外部 URL も別アプリも form も指せない)", () => {
  expect(VOCABULARY_SCOPE).toContain("外部の URL");
  expect(VOCABULARY_SCOPE).toContain("別のアプリ");
  // **`form` を指せないこと**(限定3)。
  expect(VOCABULARY_SCOPE).toContain("入力フォーム(form)は行き先にできません");
});

test("V5-M22-T05 (Δ5): 説明文が「宣言があれば宣言・無ければ今日どおり」を1本の規則として述べている", () => {
  expect(VOCABULARY_SCOPE).toContain("書かなかった画面の行き先は今日と1バイトも変わりません");
  // **行き先が詳細なら押した行を開き、一覧なら何も引き継がない**(§Decision 3)。
  expect(VOCABULARY_SCOPE).toContain("詳細なら押した行を開きます");
});

test("V5-M21-T05: ソースの禁止コメント「一覧の行ごとに出し分けられると書かない」が今日の実物と揃っている", () => {
  const source = readSrc("src", "mcp", "vocabulary.ts");
  /*
   * **`ADR-0171` 無効化条文7 が「全部」無効化した禁止である。**
   * **旧文は1バイトも消していない**(このリポジトリの作法)—— **消さない代わりに、
   * 「着手前ここには…が在った」という改訂注の中にだけ残っていることを確かめる。**
   * **生きた禁止として立っていないことを、直前の文字列で機械的に見る。**
   */
  expect(source).toContain(
    "// 「**【禁止】「一覧の行ごとに出し分けられる」と書かない**(ADR-0101 §限界1)。」が",
  );
  expect(source).toContain("**着手前ここには");
  // **代わりに置いた禁止**(`ADR-0171` §限界2 / §限界5)。
  expect(source).toContain("**【禁止】「一覧から何でも呼べるようになった」と書かない**");
  expect(source).toContain("**【禁止】「一覧の set 形が書ける」と書かない**");
});

// --- V5-M15 / `G-G11`(門外・実施する): 受信口の説明文を実物に合わせて狭める ---------------
//
// **上位**: `docs/plan/v5/04-generalization-baseline.md` §4-3 の `G-G11`(逐語「**受信口の申請
// ツールの説明文から、決済に固有の前提を外す**」)/ `docs/plan/v5/records/v5-m12.md` §3-3
// (判定 = **外(`Δ7`)・`(記録)`・実施する**)/ `v5-progress-handover.md` §2-1 の **`D-V5-85`**
// (逐語「**AI 向け説明文が実際より広く読める件は `G-G11`(門外・実施する)の射程内なので、
// そちらで文言を狭める。**」)。
//
// **2方向で測る**(片方だけだと逆向きの嘘に倒れる。`V2-M5-T04` の双方向の歯止めと同型):
//
//  1. **広く読める側を消す** —— 特定の業種の道具であるかのような枕(「決済 Webhook 等」)を外す。
//  2. **狭い側を書き足す** —— **今日受けられない形**(本文にタイムスタンプ等を連結してから
//     署名する形式)を名指しで書く。**書かないと、AI は受けられない送り手を前提にした機能を
//     組んでしまう。**
//
// **測っていないもの**: **差し替え後の文が AI にどう読まれるかを1度も確かめていない**
// (`v5-m14.md` §9 の 1 と同じ限界)。測ったのは字面だけである。

test("V5-M15 / G-G11 (1): 受信の説明文から業種に固有の枕が消えている(2箇所 + 申請ツール)", () => {
  // **消える側**: 「決済 Webhook 等」という枕。**実装は決済に固有ではない**(署名付きの
  // 通知を1行にする経路であって、送り手の業種を1つも問わない)。
  expect(VOCABULARY_SCOPE).not.toContain("決済 Webhook 等");
  expect(CANNOT_DO).not.toContain("決済 Webhook 等");
  expect(OUT_OF_SCOPE_BEHAVIOR).not.toContain("決済 Webhook 等");

  const writeTools = readSrc("src", "mcp", "tools", "write.ts");
  expect(writeTools).not.toContain("決済 Webhook 等の外部受信口");
  expect(writeTools).not.toContain("決済 PSP からの Webhook を受けて注文行を作る");
});

test("V5-M15 / G-G11 (2): 受信の説明文が『今日受けられない署名の形』を名指ししている", () => {
  // **書き足す側**: `ADR-0160` 限定3 / 限定5 が今日も生きていることを、AI が読む文に載せる。
  // **これを書かないと、説明文は実物より広く読める**(`D-V5-85`)。
  const cannotReceive = "本文に連結してから署名する";
  expect(VOCABULARY_SCOPE).toContain(cannotReceive);
  expect(CANNOT_DO).toContain(cannotReceive);
  expect(readSrc("src", "mcp", "tools", "write.ts")).toContain(cannotReceive);

  // アルゴリズムが1種だけで選べないことも書いてある(限定3)。
  expect(VOCABULARY_SCOPE).toContain("HMAC-SHA256 の1種だけ");
  expect(readSrc("src", "mcp", "tools", "write.ts")).toContain("HMAC-SHA256 の1種だけ");

  // **既にある真を1つも消していない**(V2-M5-T04 の双方向の歯止め)。
  expect(VOCABULARY_SCOPE).toContain("受信口(inbound capability)");
  expect(VOCABULARY_SCOPE).toContain("署名付き Webhook");
  expect(VOCABULARY_SCOPE).toContain(
    "AI は request_inbound_endpoint で受信口を申請することしかできません",
  );
});

test("V5-M15 / G-G11 (3): 差し替え後の文に業種依存語が1つも無い(共有の代理検査で測る)", async () => {
  // **代理検査は `scripts/industry-words.ts` から引く**(`v5-m14.md` §10 の 5。
  // 面1 と面5 が共有しているモジュールで、**語を1つも足していない・1つも減らしていない**)。
  const { FACE5_INDUSTRY_WORDS, findIndustryWords } = await import(
    "../../scripts/industry-words.ts"
  );
  const replaced = [
    "外部サービスからの通知を受け取る口です",
    "署名が載るヘッダの名前は3つ、値の書き表し方は3つで、owner が受信口ごとに1つずつ宣言します",
    "署名アルゴリズムは HMAC-SHA256 の1種だけで、選べません",
    "本文に連結してから署名する送り手からの通知は、今日1つも受け取れません",
    "別のサービスで起きた出来事の通知を受けて、その1件を表に1行足す",
  ];
  for (const sentence of replaced) {
    // **差し替え後の逐語が実在すること**(文を書き換えたのに検査だけ残る形を避ける)。
    const inVocabulary = VOCABULARY_SCOPE.includes(sentence) || CANNOT_DO.includes(sentence);
    const inWriteTools = readSrc("src", "mcp", "tools", "write.ts").includes(sentence);
    expect(inVocabulary || inWriteTools, sentence).toBe(true);
    // **その文に業種依存語が1つも無いこと。**
    expect(findIndustryWords(sentence, FACE5_INDUSTRY_WORDS), sentence).toEqual([]);
  }
});

// --- V5-M28-T04: 操作起点の `audience` が書込の壁になった(`A-G1` / `ADR-0249`。Δ5)-------
//
// **`V5-M28-T00` §6-1 (B) の指摘**: `src/mcp/vocabulary.ts:502-503` の逐語
// (「権限ではありません」「サーバの応答は1バイトも変わりません」)を `toContain` で
// 固定している検査は**着手前 0件**だった —— **嘘になった文言を放置しても緑のままだった。**
// 以下の2本がその穴を塞ぐ。
//
// **【なぜ `$comment` の固定検査をここに置いたか】**
// `ADR-0249` 限定9 が `src/kernel/` への変更を禁じており、既存の schema-annotation 系の
// 検査は `src/kernel/` に在る。`web/test/view-action-audience.test.tsx` は限定11 が
// 「1バイトも書き換えない」と定めた対象である。**本ファイルは (a) `src/kernel/` の外にあり、
// (b) 既に `manifestSchema()` で正準スキーマを直読みする作法を持ち(`V2-M3-T05` 以来)、
// (c) 同じ `Δ5` の2本(説明文 / `$comment`)が隣に並ぶ** —— したがってここに置いた。

test("A-G1 (Δ5): AI 向けの説明文が「壁が立つ表への書込が断られること」と「止まらない経路」を両方述べている", () => {
  // **【`V8-M20`。台帳 `J-G29`(判定 = 廃止)。手続きは `ADR-0301`】**
  // **ボタンの「見せる相手」のキーは撤去され、壁の主体が「規則で許した役割」になった。**
  // **この検査は消していない** —— **問い(壁が立つことと、止まらない経路を同じ段落で
  // 述べているか)は今日も意味を持つ。** **旧値を全部残す**:
  //   旧: `"挙げていない相手はサーバに 403 で断られます"`
  //   新: `"そのボタンを読める役割でない相手はサーバに 403 で断られます"`
  //   旧: `"挙がった相手の和集合が通ります"` → 新: `"読める役割の和集合が通ります"`
  //   旧テスト名/期待: `"止まらない経路が5本あります"` と、その5本目 `"行を消すとき"`
  //   新: `"止まらない経路が4本あります"` +「壁が立つのは作成と更新だけ」という別の1文。
  // **5本目が減ったのは事実が変わったからではない** —— **旧層でも面でも `DELETE` には
  // 1バイトも掛からない。****書き方を「止まらない経路の列挙」から「壁が立つ範囲の明示」へ
  // 変えたので、同じ事実を別の文が持っている**(下の (d-2) がそれを見る)。
  // **2026-08-10 に `isRoleActionWriteAllowed` と `src/server/app.ts` の3箇所を読んで確かめた。**
  // (a) **壁が立つこと・断られること。**
  expect(VOCABULARY_SCOPE).toContain("その起点が書く先のテーブルに壁が立ちます");
  expect(VOCABULARY_SCOPE).toContain(
    "ブラウザからログインして使う人が、そのテーブルに行を作る要求・行を直す要求を送ると、",
  );
  expect(VOCABULARY_SCOPE).toContain("そのボタンを読める役割でない相手はサーバに 403 で断られます");
  // (b) **名乗り(`?view=`)の有無に依存しない。**
  expect(VOCABULARY_SCOPE).toContain("名乗りの有無で結果は1つも変わりません");
  // (c) **合成は和集合1本**(`ADR-0249` §Decision 5)。
  expect(VOCABULARY_SCOPE).toContain("読める役割の和集合が通ります");
  // (d) **止まらない経路4本。1本ずつ数える(丸めない)。**
  expect(VOCABULARY_SCOPE).toContain("止まらない経路が4本あります");
  for (const path of [
    "外から届く通知(受信口)",
    "アプリを育てる側の口",
    "自動処理が書くとき",
    "コードの島が書くとき",
  ]) {
    expect(VOCABULARY_SCOPE, path).toContain(path);
  }
  // (d-2) **`DELETE` に掛からないことが、別の1文で今日も述べられていること**
  //       (旧の5本目「行を消すとき」が持っていた事実。**落としていない。**)
  expect(VOCABULARY_SCOPE).toContain("壁が立つのは行を作るときと直すときだけです");
  expect(VOCABULARY_SCOPE).toContain(
    "**行を消すとき(DELETE)と読むときには1バイトも掛かりません。**",
  );
  // (e) **6本目: 別画面へ移るだけのボタンには壁が立たない。**
  expect(VOCABULARY_SCOPE).toContain("別画面へ移るだけのボタン(view の形)には壁が立ちません");
  // (f) **穴(`v5-m28.md` §4-5 の 6): `anonymous` だけを書くと誰も作れない・警告は0件。**
  expect(VOCABULARY_SCOPE).toContain("誰も行を作れなくなります");
  expect(VOCABULARY_SCOPE).toContain("差分を適用した時点で警告は1件も出ません");
  // (g) **嘘になった旧逐語が復活していない**(`ADR-0249` §Decision 7 の 9)。
  expect(VOCABULARY_SCOPE).not.toContain("サーバの応答は1バイトも変わりません");
  expect(VOCABULARY_SCOPE).not.toContain(
    "これは画面に出すか出さないかだけを決める先回りの案内であって、権限ではありません",
  );
});

// **【`V8-M20`。台帳 `J-G29`(判定 = 廃止)。手続きは `ADR-0301`】検査を1本消した。**
//
//   消したテスト名(逐語):
//   「A-G1: $defs/view_action.properties.audience の $comment が旧文を1バイトも消していない
//    (追記で引き直した)」
//
// **消した理由**: **この検査が見ていたのは `$defs/view_action.properties.audience` の
// `$comment` と `description` そのものであり、そのキーが撤去された今日、参照先が存在しない。**
// **「その語彙が無くなったので意味を失った検査」であって、赤いから消したのではない。**
// **旧文が消されていないことの固定は、撤去した側の `$comment_retired_view_action_audience`
// (`schemas/manifest.schema.json`)が引き継いでいる**(`ADR-0301` 限定8 の作法)。
//
// **【この撤去で測らなくなったこと。隠さない】** **撤去した `$comment` の中身が
// 「旧文を1バイトも消していないか」を機械で見る検査は、今日1本も無い。**

// ---------------------------------------------------------------------------
// `V6-M6-T01`(`K-G21a`): 参照項目の選び方・探せる項目が、MCP の説明文に**列挙で**現れる
// ---------------------------------------------------------------------------
//
// **なぜこの群が要るのか(実測。丸めない)。**
// `V6-M1` 〜 `V6-M5` が語彙を8本増やしたあいだ、MCP の説明文は1文字も追随していなかった。
// **その状態を赤くする検査が1本も無かった**ことは、`v6-m1.md` §5-1 が「今日それを赤くする
// 検査 = **無い**。**これは穴である**」と最初に書き、`v6-m2.md` 〜 `v6-m5.md` が4回続けて
// 「残っている」と申し送っている。**ここがその穴を塞ぐ。**
//
// **測るのは3つ**: (a) 散文の列挙が `schemas/diff.schema.json` と**順序ごと**一致すること /
// (b) 3キーの意味が**件数に丸めず**述べられていること / (c) 述べてはならないことが
// 1文字も無いこと(器の名前・「新しく作る」の案内)。
//
// **測っていないもの(先に書く)**: 説明文の**正しさ**は測っていない —— 測れるのは
// 「名前と件数が正と一致すること」と「あらかじめ決めた字面の有無」までである
// (`scripts/skill-vocabulary-drift.test.ts` の doc コメントが述べている限界と同型)。

test("V6-M6-T01: change_table / change_field の列挙が diff.schema.json と順序ごと一致する", () => {
  // **正はスキーマである。** 定数の側だけを書き換えても、ここが両方向で赤くなる。
  expect([...CHANGE_TABLE_ACCEPTED_KEYS] as string[]).toEqual(
    Object.keys(diffSchema().$defs.table_changes.properties),
  );
  expect([...CHANGE_FIELD_ACCEPTED_KEYS] as string[]).toEqual(
    Object.keys(diffSchema().$defs.field_changes.properties),
  );
  // **散文が定数を素通りしていないこと** —— 列挙も件数も定数から出ていることを、
  // 実際に描画された文字列の上で確かめる(**件数に丸めない**)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    `change_table は ${CHANGE_TABLE_ACCEPTED_KEYS.join(" / ")} の${CHANGE_TABLE_ACCEPTED_KEYS.length}つだけ`,
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    `change_field は ${CHANGE_FIELD_ACCEPTED_KEYS.join(" / ")} の${CHANGE_FIELD_ACCEPTED_KEYS.length}個だけで、`,
  );
  // **旧文(3つだけ / 11個だけ)が1文字も残っていないこと**(双方向)。
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain(
    "change_table は id / name / representative_field の3つだけ",
  );
});

test("V6-M6-T01: 5キー目 / 14キー目が生えたら説明文の側が赤くなる(スキーマを1バイトも変えずに確かめる)", () => {
  // **歯があることの実測。** 定数に1本足した世界を作って、突き合わせが破れることを見る。
  const withOneMore: string[] = [...CHANGE_TABLE_ACCEPTED_KEYS, "for_each"];
  expect(withOneMore).not.toEqual(Object.keys(diffSchema().$defs.table_changes.properties));
  const reordered: string[] = [...CHANGE_FIELD_ACCEPTED_KEYS].reverse();
  expect(reordered).not.toEqual(Object.keys(diffSchema().$defs.field_changes.properties));
});

test("V6-M6-T01: 説明文が reference_picker の3値を列挙で述べている(件数に丸めない)", () => {
  const picker = manifestSchema().$defs.field.properties.reference_picker;
  expect(picker.enum).toEqual(["list", "type_filter", "search"]);
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**reference_picker は「この参照項目を画面でどう選ばせるか」の宣言である**",
  );
  // **3値を1つ残らず名指ししていること**(「3値のどれか」だけでは列挙になっていない)。
  for (const value of picker.enum as string[]) {
    expect(APPLY_DIFF_OP_EXAMPLES).toContain(value);
  }
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("4値目を書くと差分全体が拒否される");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("reference 型のフィールドにだけ書ける");
  // **「3値のうち2値は今日効かない」は今日から偽である**(`V6-M4` / `V6-M5` が描画を入れた)。
  // **その事実を述べていること**を固定する —— **古い断りを残さないため。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**3値とも今日は実際に画面へ当たる**");
  expect(APPLY_DIFF_OP_EXAMPLES).not.toContain("type_filter と search の描画は今日1バイトも");
  // **`D-V6-8` / `D-V6-19`**: 探す面から新しい相手を作れないこと・案内も出ないこと。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**別の面を開いて探す形(search)でも、その面から新しい相手を作ることはできない**",
  );
  // **`ADR-0288` 限定2**: 器の割り当てはプラットフォームが持ち、マニフェストに現れない。
  // **述べていることを固定する**(「書けない」を書かないと、AI は書けると読む)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**どの器(小窓など)で描くか、候補の上限件数、打つたびの取り直しの間隔は1つも書けない**",
  );
  // **器の名前が「選び方の値」として説明文に紛れていないこと。**
  // **「小窓」は除く** —— **書けないものの例として本文が名指ししており、
  // それは `schemas/manifest.schema.json` の同キーの `description` の逐語と同じ形である。**
  for (const container of ["ポップオーバー", "ダイアログ", "モーダル", "トースト"]) {
    expect(`${container}:${String(APPLY_DIFF_OP_EXAMPLES.includes(container))}`).toBe(
      `${container}:false`,
    );
  }
});

test("V6-M6-T01: 説明文が reference_search_fields を2箇所とも述べている(テーブル側と項目側)", () => {
  expect(manifestSchema().$defs.table.properties.reference_search_fields).toBeDefined();
  expect(manifestSchema().$defs.field.properties.reference_search_fields).toBeDefined();
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**reference_search_fields は「この参照の候補を探すとき、打った文字を照合する列」の宣言である**",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**同じ1語のキーを2箇所に書ける**");
  // **値域の限定を件数で述べていること**(1本以上8本以下・重複不可)。
  const table = manifestSchema().$defs.table.properties.reference_search_fields;
  expect(`${table.minItems}/${table.maxItems}/${String(table.uniqueItems)}`).toBe("1/8/true");
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("1本以上8本以下、同じ列は2度書けない");
  // **【`V8-M20`。台帳 `J-G28`(判定 = 廃止)】期待値を書き換えた。旧値を残す** ——
  //   旧: `expect(APPLY_DIFF_OP_EXAMPLES).toContain("実在する text / long_text だけで、audience")`
  //   新: 型の限定だけを見る文へ。**見せる相手を宣言するキーが撤去され、拒否の条件が
  //       型1つに戻ったためである**(2026-08-10 に `referential-integrity.ts` で確認)。
  // **【禁止の履行】「禁止が消えた」で終わらせない** —— **残る漏れを述べていることも見る。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**書けるのは実在する text / long_text だけで、それ以外の型を書くと差分全体が拒否される。**",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**探す面の当たり外れから、その項目の値が推測される余地が残る。**",
  );
  // **優先順位を1本だけ述べていること**(2本目の規則を作らない)。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**優先順位は「項目 > テーブル > 代表の項目1本」の1本だけで、",
  );
  // **`D-V6-20`**: 画面は入らない。
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("**画面ごとに変えることはできない**");
});

test("V6-M6-T01: VOCABULARY_SCOPE が reference_pickers(画面ごとの上書き)を述べている", () => {
  // **`V6-M2-T04` は名前を1語足しただけで、意味を1文字も書いていなかった。**
  expect(UPDATE_VIEW_ACCEPTED_KEYS).toContain("reference_pickers");
  expect(VOCABULARY_SCOPE).toContain(
    "**reference_pickers は入力画面(form)ごとの、参照項目の選び方の上書きです**",
  );
  expect(VOCABULARY_SCOPE).toContain("**書けるのは form だけです**");
  expect(VOCABULARY_SCOPE).toContain("**優先順位は「画面 > 項目 > 既定」の1本だけです**");
  expect(VOCABULARY_SCOPE).toContain("**2本目の規則はありません。**");
  // **3値を1つ残らず名指ししていること。**
  for (const value of manifestSchema().$defs.field.properties.reference_picker.enum as string[]) {
    expect(VOCABULARY_SCOPE).toContain(value);
  }
});

test("V6-M6-T01: 3つの宣言の説明が apply_diff に届いている(貼り先を測る)", () => {
  // **`V6-M12` が作った構造を壊していないことの実測** —— **語彙境界の全文は
  // `apply_diff` 1本にだけ載り、残る22ツールには入口の一文と誘導だけが載る。**
  // **本タスクが足した散文が22ツールへ漏れていないこと**を、実際に貼る関数で測る。
  const shared = describeTool("");
  const full = describeTool("", { withFullVocabulary: true });
  expect(shared).not.toContain("reference_pickers は入力画面");
  expect(full).toContain(
    "**reference_pickers は入力画面(form)ごとの、参照項目の選び方の上書きです**",
  );
  // `APPLY_DIFF_OP_EXAMPLES` は `apply_diff` のツール固有説明として貼られる
  // (`src/mcp/tools/write.ts`)。**共通部には1文字も入らない。**
  expect(shared).not.toContain("reference_picker は「この参照項目を画面でどう選ばせるか」");
});

// --- `V7-M6-T04`(`Z-G29`。Δ5 の是正)-----------------------------------------------------
//
// **v7 が挙動を変えたことで偽になった `VOCABULARY_SCOPE` / `CANNOT_DO` の文を、
// 双方向(できるようになったこと + 守らない5経路)で書き直したことを機械で固定する。**
//
// **本節が守る限定(`docs/plan/v7/records/v7-m0.md` §6-3 の `Z-G29` の `S5`)**:
//   (1) **偽になった2文を直す。既存の顧客の制限の記述を1文字も消さない。**
//   (2) **双方向に書く**(できるようになったことと、守らない5経路を**同時に**)。
//   (3) **`Z-G34` が偽にする1文も直す。**
//   (4) **`Z-G19` の運営専用の口を書く**(「運営でも見えない行がある」と「見つける口がある」を同時に)。
//   (5) **語彙の本数の主張を1つも足さない。**
//   (6) **検証に `expect()` 総数を使わない**(`ADR-0007` §6 規律2)。
//
// **【本節が測っていないもの。先に書く(憲法6)】**
//   - **説明文が実物と一致していることを、サーバを起動して測ってはいない。**
//     ここが見るのは字面と、`src/server/owner-scope.ts` / `schemas/manifest.schema.json`
//     から引いた値との一致だけである。
//   - **同じ事実は要件ドキュメント(`src/kernel/requirements-doc.ts`)にも書かれている。**
//     **両者が食い違っていないことを突き合わせる検査は、本節には1本も無い**
//     (要件ドキュメント側は宣言だけを出し、守る経路・守らない経路を1文字も出さないので、
//     対になる文がそもそも存在しない)。

test("V7-M6-T04 (a) 旧文を1バイトも消していない(既存の顧客の制限の記述が全部残っている)", () => {
  // **`Z-G29` 限定(1) の逐語**: 「**既存の顧客の制限の記述を1文字も消さない。**」
  // **是正が「消して書き直す」形になっていないことを、ここが機械的に固定する。**
  // **1件でも消えたら赤。**
  for (const kept of [
    // (1) が名指しした2文。
    "の種類の利用者は自分の行(st_owner 規約のテーブル)と公開指定された行しか GET できず",
    "運営テーブルは 403 で遮断されます",
    "**管理(owner)ロールも、この所有の切り方から自由ではありません**",
    "個人所有(st_owner 規約)のテーブルでは、ロールを上げても他人の行は見えません",
    // (3) が名指しした1文(`Z-G34` が偽にしたもの)。
    "**宣言していない表・値が立っていない行は今日どおり消せます。**",
  ]) {
    expect(CANNOT_DO, `CANNOT_DO から旧文が消えた: ${kept}`).toContain(kept);
  }
  // **`V7-M4` が追加で見つけた1ホップの2文も、1バイトも消していない。**
  expect(VOCABULARY_SCOPE).toContain("**辿れるのは1ホップだけです**");
  expect(VOCABULARY_SCOPE).toContain("**孫・多段・join・逆参照(親の側を絞る)は1つも書けません。**");
  // **`V7-M1-T03` が書いた「今日は効かない」の2文も、1バイトも消していない。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**ただし今日この宣言を書いても、行の見え方・書き換え方は1つも変わりません**",
  );
  expect(APPLY_DIFF_OP_EXAMPLES).toContain("(判定の実装はまだありません)");
});

test("V7-M6-T04 (b) 双方向: できるようになったことと、判定を1つも通らない5経路を同時に述べている", () => {
  // **`Z-G29` 限定(2)**: **片方だけ書くと逆向きの嘘になる。**
  // **できるようになったこと**(主張の上限は `01` §9)。
  for (const written of [
    "**ただし、直前の2文が述べているのは access_control を宣言していない表のことです**",
    "**宣言していない表と enabled: false の表は、今日と1バイトも変わりません。**",
    "**権限名は最大8個まで宣言でき、名前ごとに「読む」「書く」「消す」を決められます**",
    "**owner / editor / viewer / anonymous は権限名に使えません**",
    "**付与の相手はユーザでもグループでもかまいません**",
    "**ただしグループは、アプリが普通の表として作るものであって、プラットフォームが持つ機能ではありません**",
    "**規約から外れた作り方をすれば効きません。グループの入れ子は書けません。**",
    "**行を作った人には、宣言した権限名が自動で入ります**",
    "**逆に、利用者の表に自分の行が無い人は、その表に行を1件も作れません**",
    "**親に付けた付与を子・孫へ引き継げます**",
    "**辿るのは5段までで、上限に当たった要求は黙って打ち切らずに 400 で拒みます**",
    "**削除(DELETE)にも「消す」の権限が効きます**",
    "**行が見えない相手には、その行の画像・添付ファイルも配信されません。**",
  ]) {
    expect(CANNOT_DO, `できるようになったことの記述が消えた: ${written}`).toContain(written);
  }
  // **守らない5経路。1つでも消えたら赤。**
  expect(CANNOT_DO).toContain(
    "**あなた(MCP)・受信口・ワークフロー・コードの島・get_manifest の5経路は、" +
      "この付与の判定を1つも通りません。**",
  );
  expect(CANNOT_DO).toContain(
    "**あなたが write_records / update_record / delete_record / list_records で触る行に、" +
      "この権限は1ミリも効きません。**",
  );
  expect(CANNOT_DO).toContain("**get_manifest は今日も未ログインで全定義を返します**");
  expect(CANNOT_DO).toContain("**取り消した共有が復活し、API はそれを1文字も告げません。**");
  expect(CANNOT_DO).toContain(
    "**利用者の表とグループの表そのものへの書込は1ミリも絞っていません**",
  );
  // **要件ドキュメントとの非対称を1行で述べていること**(`V7-M6-T03` との突合)。
  expect(CANNOT_DO).toContain(
    "**付与の行の中身は1文字も出ず、守る経路・守らない経路のことも1文字も出ません。**",
  );
});

test("V7-M6-T04 (c) 運営専用の口: 「運営でも見えない行がある」と「見つける口がある」を同時に述べている", () => {
  // **`Z-G29` 限定(4)**: **片方だけ書くと、閉じた行の取り残しに運営が気づけないか、
  // 逆に「運営は結局見える」と読まれる。**
  expect(CANNOT_DO).toContain("**付与が1件も無い行は、管理(owner)からも見えません**");
  expect(CANNOT_DO).toContain(
    "**そのかわり、誰にも開けなくなった行を運営が見つける口が1本あります**",
  );
  expect(CANNOT_DO).toContain(
    "並ぶのは、付与が1件も無く、引き継ぎのどの段にも付与が無い行だけです",
  );
  // **誇張していないこと**(この口は回復を意味しない)。
  expect(CANNOT_DO).toContain("**これは「運営が回復できる」ことを1ミリも意味しません**");
  // **`st_owner` の段にも、閉め出しの軸が2つになったことが書いてある。**
  expect(CANNOT_DO).toContain("**なお、ロールを上げても越えられない軸は、今日2つあります**");
});

test("V7-M6-T04 (d) DELETE: 効くようになったことと、今日も掛からない壁を同時に述べている", () => {
  // **`Z-G29` 限定(3) / `01` §9 の 16**: **「`DELETE` が守られるようになった」とだけ書かない。**
  expect(CANNOT_DO).toContain(
    "**ただし「今日どおり消せます」は、access_control を宣言していない表のことです**",
  );
  expect(CANNOT_DO).toContain("そもそも付与が1件も無い行は(管理(owner)であっても)404 になります");
  // **【`V8-M20`。台帳 `J-G28` / `J-G29`(どちらも判定 = 廃止)。手続きは `ADR-0301`】**
  // **期待値を書き換えた。旧値を残す** ——
  //   旧: `"**項目ごとの書込宣言(writable_by)と画面の操作起点の壁は、DELETE に1ミリも掛かりません。**"`
  //   新: `"**役割の規則のうち、項目に書いた規則とボタンの壁は、DELETE に1ミリも掛かりません**"`
  // **問い(`DELETE` に掛からない層を名指しで書いているか)は1バイトも変えていない。**
  // **2026-08-10 に実物で確かめた** —— **`judgeRoleFieldWrite` は `DELETE` の経路から
  // 1度も呼ばれず、`isRoleActionWriteAllowed` の書込の種類は作成・更新の2つだけである。**
  expect(CANNOT_DO).toContain(
    "**役割の規則のうち、項目に書いた規則とボタンの壁は、DELETE に1ミリも掛かりません**",
  );
  // **MCP は今日も守られないこと**(旧文と同じ向きの事実を、付与の側についても書いた)。
  expect(CANNOT_DO).toContain(
    "**この表でも、MCP の delete_record は今日どおりサーバの HTTP 経路を通らないので、" +
      "付与の判定にも1ミリも守られません。**",
  );
});

test("V7-M6-T04 (e) 1ホップの4条文を丸ごと否定せず、射程を書き分けている", () => {
  // **`V7-M4` が追加で見つけたもの** —— **`inherit_from` は多段を辿るが、
  // 表示・入力の辿りは今日も1ホップだけである。** **両方を書く。**
  expect(VOCABULARY_SCOPE).toContain(
    "**表示・入力の辿りが1ホップだけであることは今日も変わりません**",
  );
  expect(VOCABULARY_SCOPE).toContain("**辿った先の行を1件も返しません。**");
  expect(VOCABULARY_SCOPE).toContain(
    "**ここでの「多段は書けない」は、島に渡す行の絞り方についてです**",
  );
  expect(VOCABULARY_SCOPE).toContain("**島の入力を1行も増やしません。**");
  // **書き方の側(`APPLY_DIFF_OP_EXAMPLES`)にも同じ書き分けが在ること** ——
  // **片方だけ直すと逆向きの嘘になる。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**多段を辿る宣言は access_control の inherit_from ただ1つで、",
  );
  // **`change_table` の「今日は効かない」の是正も、書き方の側に在ること。**
  expect(APPLY_DIFF_OP_EXAMPLES).toContain(
    "**判定はすでに動いていて、宣言した表では付与に応じて" +
      "行の見え方・書き換え方・消し方が変わります。**",
  );
});

test("V7-M6-T04 (f) 実装→記述: 5段 / 8個 / 予約4語が、実装とスキーマの値と一致している", () => {
  // **字面を焼き込まない** —— **実装の定数とスキーマから引いて突き合わせる。**
  // **改名・変更したら、説明文を直すまで赤くなる。**
  expect(MAX_RECORD_ACCESS_INHERIT_DEPTH).toBe(5);
  expect(CANNOT_DO).toContain(`辿るのは${MAX_RECORD_ACCESS_INHERIT_DEPTH}段まで`);
  expect(VOCABULARY_SCOPE).toContain(`親を最大${MAX_RECORD_ACCESS_INHERIT_DEPTH}段まで辿る`);

  const accessControl = manifestSchema().$defs.table.properties.access_control;
  expect(CANNOT_DO).toContain(`権限名は最大${accessControl.properties.permissions.maxItems}個まで`);
  expect(CANNOT_DO).toContain(
    `辿る参照項目を最大${accessControl.properties.inherit_from.maxItems}本まで`,
  );
  // **権限名に使えない4語**(スキーマの `not.enum` が真)。
  const reserved = accessControl.properties.permissions.items.properties.id.not.enum as string[];
  expect(CANNOT_DO).toContain(`${reserved.join(" / ")} は権限名に使えません`);
  // **3つの動詞**(`read` / `write` / `delete`)が1つ残らず日本語で書かれていること。
  for (const verb of ["read", "write", "delete"]) {
    expect(accessControl.properties.permissions.items.required).toContain(verb);
  }
  expect(CANNOT_DO).toContain("名前ごとに「読む」「書く」「消す」を決められます");
});

test("V7-M6-T04 (g) 総括の禁止: 書いてはならない言い回しが1つも入っていない", () => {
  // **`docs/plan/v7/01-record-access-grant-baseline.md` §9 の 1 / 6 / 7。**
  // **文言そのものを禁止しておかないと、将来の編集で静かに入ってくる**
  // (`M3-T02` が「権限・アクセス制御は無い」について採ったのと同じ形)。
  for (const forbidden of [
    "権限管理ができるようになった",
    "全部の経路で権限が効く",
    "安全になった",
    "情報漏洩を防げる",
    "権限昇格",
    "語彙ゼロ増",
  ]) {
    for (const [name, text] of [
      ["CANNOT_DO", CANNOT_DO],
      ["VOCABULARY_SCOPE", VOCABULARY_SCOPE],
      ["APPLY_DIFF_OP_EXAMPLES", APPLY_DIFF_OP_EXAMPLES],
    ] as const) {
      expect(text, `${name} に禁止の言い回しが入った: ${forbidden}`).not.toContain(forbidden);
    }
  }
  // **`MCP / ローカル操作そのものに権限制御は無く` は今日も真である** ——
  // **v7 はこの文を1バイトも動かしていない**(付与の判定は MCP に1ミリも掛からない)。
  expect(CANNOT_DO).toContain("MCP / ローカル操作そのものに権限制御は無く");
});

test("V7-M6-T04 (h) 足した散文は apply_diff にだけ届き、残る22ツールには1文字も漏れていない", () => {
  // **`V6-M12` が作った構造を壊していないことの実測**(`V6-M6-T01` と同じ形)。
  const shared = describeTool("");
  const full = describeTool("", { withFullVocabulary: true });
  expect(shared).not.toContain("**権限名は最大8個まで宣言でき");
  expect(full).toContain("**権限名は最大8個まで宣言でき");
  // **見出し(`【…】`)を1つも増やしていない** —— **増やすと `instructions` 側
  // (`CANNOT_DO_INDEX`)が黙って伸びる。**
  expect((CANNOT_DO.match(/【[^】]+】/g) ?? []).length).toBe(2);
  expect(CANNOT_DO_INDEX).not.toContain("access_control");
});

// --- `V8-M22`(波及)/ 台帳 `J-G35`(門A・限定採用): 説明文を今日の実物に合わせる -----------
//
// **この5本は「今日は偽である / 今日は不足している」ことを先に赤で示すために書いた。**
// **書いた時点では5本とも落ちる**(実施記録に落ちた出力を残してある)。
//
// **測っているのは字面だけである** —— **散文が読んで分かるかどうかも、AI が実際にそう振る舞う
// かどうかも1ミリも測っていない**(`scripts/skill-vocabulary-drift.test.ts` の doc が先に
// 書いた限界と同型)。**「説明文を全部直した」ことの証明ではない。**

test("V8-M22 (J-G35)(a): 説明文は「規則は受信口・自動処理・島に1バイトも掛からない」で終わっていない", () => {
  // **旧文は1バイトも消していない**(`ADR-0301` 限定8 系の作法)。**直後に訂正が続くことを固定する。**
  // **旧文の逐語**: 「**あなた(MCP)・受信口・自動処理・コードの島には1バイトも掛かりません。**」
  // **今日は偽である** —— **`V8-M21` が受信口・登録起動の自動処理・コードの島の3経路に
  // 面の判定(`judgeRoleAccess`)を配線した**(`src/kernel/workflow-runner.ts` /
  // `src/server/inbound-route.ts`。2026-08-10 に実物を読んだ)。
  const old = "**あなた(MCP)・受信口・自動処理・コードの島には1バイトも掛かりません。**";
  expect(VOCABULARY_SCOPE).toContain(old);
  const at = VOCABULARY_SCOPE.indexOf(old);
  expect(VOCABULARY_SCOPE.slice(at + old.length)).toContain(
    "訂正します。直前の1文のうち「受信口・自動処理・コードの島には1バイトも掛かりません」は今日は偽です",
  );
});

test("V8-M22 (J-G35)(b): 説明文は、今日も規則を1つも通らない2本を名指ししている", () => {
  // **双方向に書く** —— **効くようになった3経路だけを書くと逆向きの嘘になる。**
  expect(VOCABULARY_SCOPE).toContain("決まった時刻に動く処理(schedule)");
  expect(VOCABULARY_SCOPE).toContain("登録で動けば規則が効き、時刻で動けば効きません");
});

test("V8-M22 (J-G35)(c): 説明文は、役割の規則と行ごとの付与が OR で重なることを述べている", () => {
  // **実装の真は `src/server/owner-scope.ts` の `combineRoleAndGrantAccess`** ——
  // **両方が管轄内なら `role.allowed || grant.allowed` である**(`V8-M19` / `d414c47`)。
  // **着手前、この事実は `VOCABULARY_SCOPE` にも `CANNOT_DO` にも1文字も無かった**
  // (`v8-m19.md` §11-3 の申し送り)。
  for (const text of [VOCABULARY_SCOPE, CANNOT_DO]) {
    expect(text).toContain("どちらか一方が許せば通ります");
  }
  expect(CANNOT_DO).toContain("片方だけを読んで「閉じた」と判断しないでください");
});

test("V8-M22 (J-G35)(d): 説明文は条件の葉2形の綴りを述べている(equals / equals_current_user)", () => {
  // **着手前、`equals_current_user` は `VOCABULARY_SCOPE` にも `CANNOT_DO` にも
  // **0件**であった**(散文行989行に対して0件。`v8-m18.md` §… の申し送り)。
  // **綴りが無いと、AI は「担当が自分」を書けない** —— **センチネル文字列は値域に1つも無い。**
  expect(VOCABULARY_SCOPE).toContain("equals_current_user");
  expect(VOCABULARY_SCOPE).toContain('"equals"');
});

test("V8-M22 (J-G35)(e): CANNOT_DO の (え) は今日の実物に合わせて訂正されている", () => {
  // **旧文は1バイトも消していない。** **旧文の逐語**:
  // 「**利用者の表とグループの表そのものへの書込は1ミリも絞っていません**」。
  // **今日は偽である** —— **`V8-M19`(`d414c47` / 台帳 `J-G33` / `U-2`)が、
  // メンバー表・グループ表への HTTP の書込4経路を管理(owner)だけに絞った**
  // (`src/server/owner-scope.ts` の `judgeGrantWrite` の `membership_locked`)。
  const old = "**利用者の表とグループの表そのものへの書込は1ミリも絞っていません**";
  expect(CANNOT_DO).toContain(old);
  const at = CANNOT_DO.indexOf(old);
  const after = CANNOT_DO.slice(at + old.length);
  expect(after).toContain("参加者の表は、アプリの運営者だけが書き換えられます");
  // **塞いでいない側も同じ段落に書く**(片方だけ書くと逆向きの嘘になる)。
  expect(after).toContain("読取は1ミリも絞っていません");
});

// --- V10-M34-T01(台帳 `CM-G45` / `ADR-0379` §Decision 2)-------------------------------
//
// **本段は「波及」である** —— **`src/mcp/vocabulary.ts` を直す唯一の担い手**(限定1)。
// **直す対象は §Decision 2 の (1)〜(4) ちょうどで、5つ目を作らない**(限定2)。
// **旧行を1バイトも消さず、訂正を後ろに足す**(限定5。このリポジトリの作法)。
//
// **【禁止】この検査が緑であることを「今日の正になった」の根拠にしない**(限定5)——
// **旧文を残す作法の下では `scripts/skill-vocabulary-drift.test.ts` の `verbatim` は
// 赤くならない。** **緑は「壊していない」ことしか示さない。**

/** `(1)` の訂正の逐語(`actor-guard.ts:71` / `index.ts:114` / `http-entry.ts:129` と同じ形)。 */
const TOOL_COUNT_26_FIX = "(直前の「25本」は今日は26本です)。";

test("V10-M34-T01 (1): `src/mcp/vocabulary.ts` の「25本」4行すべてに 26本 の訂正が足されている", () => {
  const source = readSrc("src", "mcp", "vocabulary.ts");
  // **旧行は1バイトも消していない**(4行とも残っている)。
  expect(source.split("(直前の「24本」は今日は25本です)。").length - 1).toBe(4);
  // **訂正は4行とも足した**(`:1076` / `:1474` / `:2155` / `:2424` の直後)。
  expect(source.split(TOOL_COUNT_26_FIX).length - 1).toBe(4);
});

test("V10-M34-T01 (1): 残る4ファイル(cp-5-scenario / error-self-correction / http-transport / server)にも 26本 の訂正が在る", () => {
  // **前段(`V10-M30-T02`)が済ませた3本(actor-guard / http-entry / index)は触っていない。**
  for (const file of [
    "cp-5-scenario.test.ts",
    "error-self-correction.test.ts",
    "http-transport.ts",
    "server.ts",
  ]) {
    const source = readSrc("src", "mcp", file);
    // 旧文が残っていること(消していない陽性対照)。
    expect(source, `${file}: 旧文「25本」が消えている`).toContain("25本");
    // 訂正が足されていること。
    expect(source, `${file}: 26本 の訂正が無い`).toContain("26本");
  }
});

test("V10-M34-T01 (2): CANNOT_DO は、書く欄が出るのがアプリごとの設定であり、既定は出さないことを述べている", () => {
  expect(CANNOT_DO).toContain(
    "書く欄が画面に出るのは、そのアプリで書く欄を出す設定にしたときだけで、既定は出しません",
  );
  expect(CANNOT_DO).toContain("配る版では、設定を出す側に倒しても書く欄は1つも出ません");
  // **口は閉じていない**(`D-V10-38`)。 **【禁止】「設定を切ると書けなくなる」と書かない。**
  expect(CANNOT_DO).toContain("欄が画面に出ていなくても、書き込みは今日どおり通ります");
  expect(CANNOT_DO).toContain("設定を切っても書けなくなるわけではありません");
  expect(CANNOT_DO).not.toContain("設定を切ると書けなくなります");
});

test("V10-M34-T01 (3): CANNOT_DO は、読み取りの口が今日2本あることと、規則の無いアプリでは本人以外も読めることを述べている", () => {
  // **旧文は1バイトも消していない。**
  expect(CANNOT_DO).toContain(
    "(読み取りは1ミリも開いていないので、書いた本人も自分のコメントを1件も読み返せません)。",
  );
  // (i) **読み取りの口は今日2本ある**(HTTP 1本 + MCP の道具1本)。
  expect(CANNOT_DO).toContain(
    "**読み取りの口は今日2本あります**(GET /api/apps/:app_id/comments と、この MCP の道具 list_comments)。",
  );
  // (ii) **「本人も読み返せない」も、規則を1本も書いていないアプリでは偽である。**
  expect(CANNOT_DO).toContain(
    "「書いた本人も読み返せない」も、役割の規則を1本も書いていないアプリでは偽です",
  );
  expect(CANNOT_DO).toContain("そのアプリでは未ログインのまま、コメントが全件読めます");
  // (iii) **この偽は本審査が作ったものではない**(限定4)。
  expect(CANNOT_DO).toContain(
    "この偽は本審査が作ったものではありません —— 元の文を書いた後に、読む口を足した別のタスクが偽にしました。",
  );
});

test("V10-M34-T01 (2)(3): 2つの訂正は (a)〜(f) 一続きの末尾(旧文 `:2343` 相当)より後ろに在る", () => {
  // **置き場を `:2339` の直後にすると、`plugins/` の引用ブロックが
  // `CANNOT_DO` の部分文字列でなくなり `scripts/skill-vocabulary-drift.test.ts` が赤くなる。**
  // **順序を数で当てる**(逐語で位置を固定しない)。
  const tailOfRun =
    "(読み取りは1ミリも開いていないので、書いた本人も自分のコメントを1件も読み返せません)。";
  const at = CANNOT_DO.indexOf(tailOfRun);
  expect(at).toBeGreaterThan(-1);
  const end = at + tailOfRun.length;
  for (const added of [
    "書く欄が画面に出るのは、そのアプリで書く欄を出す設定にしたときだけで、既定は出しません",
    "**読み取りの口は今日2本あります**",
    "この偽は本審査が作ったものではありません",
  ]) {
    expect(CANNOT_DO.indexOf(added), `末尾より前に置かれている: ${added}`).toBeGreaterThan(end - 1);
  }
});

test("V10-M34-T01 (限定3): `ADR-0367` 限定6 の1文は1バイトも消えていない", () => {
  // **足すのは条件だけである**(`ADR-0379` §Decision 3 / `CM-G45` 限定3)。
  expect(CANNOT_DO).toContain(
    "**未ログインの書き込みには、送ってくる相手を特定する手がかりも、回数の制限も1つもありません** —— ",
  );
  expect(CANNOT_DO).toContain(
    "**何度でも書けますし、誰が書いたのかを後から知る手立ても1つもありません**",
  );
});

test("V10-M34-T01 (4a): 説明書の引用ブロックは、CANNOT_DO に足した2つの訂正を逐語で持っている", () => {
  // **`plugins/` の引用は1行の中に連結して書かれている**(改行を挟むと部分文字列でなくなる)。
  // **【禁止】`plugins/` に内部記号を1文字も書かない**(`scripts/public-docs-internal-symbols.test.ts`)。
  const doc = readSrc("plugins", "smailtalk", "skills", "view-shape", "reference", "cannot-do.md");
  for (const added of [
    "**書く欄が画面に出るのは、そのアプリで書く欄を出す設定にしたときだけで、既定は出しません**",
    "(設定を切っても書けなくなるわけではありません。止まるのは画面の表示だけです)。",
    "**読み取りの口は今日2本あります**(GET /api/apps/:app_id/comments と、この MCP の道具 list_comments)。",
    "(この偽は本審査が作ったものではありません —— 元の文を書いた後に、読む口を足した別のタスクが偽にしました。)",
  ]) {
    expect(doc, `説明書に届いていない逐語: ${added}`).toContain(added);
  }
});

test("V10-M34-T01 (4c): 入口の凍結値は 52 / 26 のまま動いていない(限定8)", () => {
  // **26 にしたのは前段(`V10-M30-T02`)である。** **【禁止】本段が「限定8 を履行した」と書かない。**
  const source = readSrc("src", "server", "entry-point-inventory.test.ts");
  expect(source.split("toHaveLength(52)").length - 1).toBe(1);
  expect(source.split("toHaveLength(26)").length - 1).toBe(1);
});
