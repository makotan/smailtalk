/**
 * **`RB-G5` の見張り**(`V14-M2-T06`。**門外・限定採用であり個別 ADR を持たない** ——
 * その限定6点は `ADR-0402` §Decision 8「越えてはならない線」に写されている)。
 *
 * ## **【この検査が見ないもの。最初に書く】**
 *
 * **この検査は「合成規則が生えていないこと」しか見ない。判定が正しいことも、画面が
 * 正しく隠すことも1文字も見ていない。**
 *
 * **逐語の出所は `ADR-0402` §Decision 8 の結び** ——
 * 「**加えて、`RB-G5` の見張りが見ないものを書いておく** —— **その検査は
 * 『合成規則が生えていないこと』しか見ない。** **判定が正しいことも、画面が正しく
 * 隠すことも1文字も見ていない。**」
 *
 * **判定の正しさは `web/test/row-action-verb.test.ts`(写像)と
 * `src/server/record-row-access-response.test.ts`(サーバの応答)が撃つ。**
 * **画面が隠すことは `web/test/row-grant-detail-buttons.test.tsx` /
 * `web/test/row-grant-list-buttons.test.tsx` が撃つ。** **本ファイルはそのどちらでもない。**
 *
 * ## 5本が守る線(`ADR-0402` §Decision 8 との対応)
 *
 * | # | 見るもの | 線 |
 * |---|---|---|
 * | `guard-1` | `web/src/` に面と点を重ねる合成の綴りが0件 | 線1 |
 * | `guard-2` | 形 → 動詞の写像を定義する製品ファイルがちょうど1本 | 線2 |
 * | `guard-3` | `canUseAction` の本体が1バイトも変わっていない | 線3 |
 * | `guard-4` | 詳細と一覧の**両方**が写像の1本を読んでいる | 線2(片側だけに当てない) |
 * | `guard-5` | 画面側の写しのキー集合がサーバの正と一致する | 限定2 の画面側 |
 *
 * ## **【弱さを隠さない】どういう変更なら、この5本を素通りするか**
 *
 * - `guard-1` … **`rowGrant` などの別名で行の判定と面の判定を重ねれば素通りする。**
 *   **綴り1語しか見ていない**(`ADR-0402` §Decision 8 の 1 が名指しした綴りである)。
 * - `guard-2` … **`rowActionVerb` という名前を使わずに、別名の写像を2本目として
 *   書けば素通りする。** **定義の名前1つしか見ていない。**
 * - `guard-3` … **`canUseAction` の外側(呼び出し元・`judgeRoleAccess` の中身・
 *   その上の doc)を書き換えても素通りする。** **切り出した本体の1文字も見ていない外は
 *   自由である。**
 * - `guard-4` … **`import` 文が在ることしか見ない。** **読んだうえで結果を捨てても
 *   素通りする**(実際に `filter` に効いていることは別の検査が撃つ)。
 * - `guard-5` … **キーの**名前の集合**しか見ない。** **両方を同時に同じ向きへ
 *   書き換えれば素通りする**(4キーちょうどであることはサーバ側の
 *   `src/server/record-row-access-response.test.ts` が撃つ)。**型も既定値も見ていない。**
 *
 * ## 製品コードを1バイトも足していない
 *
 * **本タスクが足したのはこのファイル1本だけである。** **`web/src/` に
 * アクセス権管理の宣言(`ADR-0402` 限定10 が2本に固定した綴り)を1文字も増やしていない。**
 */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** `apps/smailtalk/web`。**`import.meta.dir` から数える** —— `process.cwd()` で解くと打つ場所で変わる。 */
const WEB_ROOT = dirname(import.meta.dir);
/** `apps/smailtalk`。`src` / `web` はこの下に在る。 */
const PRODUCT_ROOT = dirname(WEB_ROOT);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    out.push(full);
  }
  return out;
}

/**
 * **`web/src` の下だけを歩く。**
 *
 * **【自己参照に注意】** **`web/test/` を混ぜてはならない** —— **本ファイル自身が
 * `guard-1` の探す綴りを doc に書いているので、混ぜた瞬間に自分の綴りで赤くなる。**
 * **このリポジトリで実際に起きている型である**(`evidence-self-referential-grep`)。
 */
function webSrcFiles(): { path: string; text: string }[] {
  return walk(join(WEB_ROOT, "src")).map((path) => ({
    path: path.slice(PRODUCT_ROOT.length + 1),
    text: readFileSync(path, "utf-8"),
  }));
}

function readProduct(...parts: string[]): string {
  return readFileSync(join(PRODUCT_ROOT, ...parts), "utf-8");
}

// ---------------------------------------------------------------------------
// guard-1 —— 面と点を重ねる合成が `web/src/` に1件も無い(線1)
// ---------------------------------------------------------------------------

/**
 * **`ADR-0402` §Decision 8 の 1 が名指しした綴り**(`ADR-0308` 限定3 の逐語
 * 「合成の式を `app.ts` にも `web/src/` にも1行も書かない」の対象)。
 *
 * **今日この綴りが在るのは `src/server/` と `web/test/` だけである。**
 */
const COMPOSITION_SPELLING = "combineRoleAndGrantAccess";

test("(RB-G5/guard-1) web/src/ に面と点を重ねる合成(combineRoleAndGrantAccess 相当)が1件も無い", () => {
  // **件数ではなくファイル名の全量を `toEqual` で撃つ** —— **赤になったときに
  // 「どこに生えたか」がテストの出力に出る**(数だけだと読み手に分からない)。
  const offenders = webSrcFiles()
    .filter((file) => file.text.includes(COMPOSITION_SPELLING))
    .map((file) => file.path)
    .sort();
  expect(offenders).toEqual([]);
});

// ---------------------------------------------------------------------------
// guard-2 —— 形 → 動詞の写像はちょうど1本(線2)
// ---------------------------------------------------------------------------

test("(RB-G5/guard-2) 形 → 動詞の写像を持つ製品ファイルは web/src/views/row-action-verb.ts ちょうど1本である", () => {
  const definers = webSrcFiles()
    .filter((file) => file.text.includes("export function rowActionVerb"))
    .map((file) => file.path)
    .sort();
  // **「1本である」を `toHaveLength(1)` で書かない** —— **どの1本かまで固定する。**
  expect(definers).toEqual(["web/src/views/row-action-verb.ts"]);
});

// ---------------------------------------------------------------------------
// guard-3 —— `canUseAction` の本体が1バイトも変わっていない(線3)
// ---------------------------------------------------------------------------

const AUTHZ_PATH_PARTS = ["web", "src", "auth", "authz.tsx"] as const;

/**
 * **`canUseAction` の本体だけを切り出す。**
 *
 * **`export function canUseAction(` から、最初に現れる列0の `}`(= `"\n}\n"`)まで。**
 * **関数の途中に列0の `}` は1つも無い**(閉じ括弧はいずれも字下げされている)ので、
 * **先に当たることはない。** **切り出しの実測: 17行 / 469 バイト**
 * (**計画 `01-v14-m2-tasks.md` §6 は「本体18行」と書いているが、この切り出し方では
 * 17行である。1行ぶん食い違っている。実測の側を採った**)。
 */
function canUseActionBody(): string {
  const source = readProduct(...AUTHZ_PATH_PARTS);
  const start = source.indexOf("export function canUseAction(");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

/**
 * **`V14-M2-T06` が凍結した基準。**
 *
 * **先例は `web/test/shell-navigation-boundary.test.ts:1883`-`:1884`**
 * (`src/server/owner-scope.ts` の `bytes` / `sha256` 凍結)。**同じ書き方に倣っている。**
 *
 * **【手続き】この値を書き換えるときは、先に赤を見ること。** **`V14-M2-T06` では
 * 実際に見た** —— **本体を1バイト変えて3本とも赤にし、元へ戻して `shasum` が
 * 一致することを確かめてから焼いた。**
 */
const CAN_USE_ACTION_BASELINE = {
  bytes: 469,
  sha256: "d669974cce19fa38c43a851e2ff3868d9250e941cadbd686d82af8876c7f30f5",
} as const;

test("(RB-G5/guard-3) canUseAction の本体が1バイトも変わっていない", () => {
  const body = canUseActionBody();
  expect(Buffer.byteLength(body, "utf-8")).toBe(CAN_USE_ACTION_BASELINE.bytes);
  expect(createHash("sha256").update(body, "utf-8").digest("hex")).toBe(
    CAN_USE_ACTION_BASELINE.sha256,
  );
});

test("(RB-G5/guard-3) canUseAction が判定を1本しか呼ばず、行の判定を1文字も綴っていない", () => {
  // **`sha256` だけだと、落ちたときに何が変わったのか読み手に分からない** ——
  // 1バイトの差でも同じ赤になる。**「何が変わったか」が出る式を隣に置く。**
  const body = canUseActionBody();
  // 線3 の逐語「`judgeRoleAccess` を1本呼ぶだけの形を保つ」。
  expect(body.match(/judgeRoleAccess/g) ?? []).toHaveLength(1);
  // **小文字の `access`** —— **行の判定(`RowAccess` / `rowAccess` / `access`)を
  // ここへ持ち込んでいないこと。** **`judgeRoleAccess` は大文字 `A` なので当たらない。**
  expect(body.match(/access/g) ?? []).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// guard-4 —— 詳細と一覧の**両方**が写像の1本を読んでいる(線2)
// ---------------------------------------------------------------------------

test("(RB-G5/guard-4) 詳細と一覧の両方が row-action-verb.ts を読んでいる", () => {
  // **片方だけに当てていないことを撃つ** —— **`ADR-0402` 限定15 の精神**
  // (詳細と一覧で別々の道を作らない)。
  const importers = ["DetailViewRenderer.tsx", "ListViewRenderer.tsx"].filter((name) =>
    readProduct("web", "src", "views", name).includes('from "./row-action-verb.ts"'),
  );
  expect(importers).toEqual(["DetailViewRenderer.tsx", "ListViewRenderer.tsx"]);
});

// ---------------------------------------------------------------------------
// guard-5 —— 画面側の写しのキー集合が、サーバの正と一致する(限定2 の画面側)
// ---------------------------------------------------------------------------

/**
 * `export type <名前> = { … };` の中の `readonly <キー>:` を全部拾う。
 *
 * **型も既定値も見ていない** —— **キーの名前の集合だけである。**
 */
function typeKeys(source: string, typeName: string): string[] {
  const start = source.indexOf(`export type ${typeName} = {`);
  expect(start, typeName).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n};", start);
  expect(end, typeName).toBeGreaterThan(start);
  const block = source.slice(start, end);
  return [...block.matchAll(/^\s*readonly ([A-Za-z_][A-Za-z0-9_]*)/gm)]
    .map((match) => match[1] as string)
    .sort();
}

test("(RB-G5/guard-5) web/src/api.ts の RowAccess のキー集合が、src/server/owner-scope.ts の RecordRowAccess と一致する", () => {
  // **点検が見つけた穴** —— **限定2(4つちょうど)を撃つ
  // `src/server/record-row-access-response.test.ts` の `(A-2)` は**サーバ側だけ**を
  // 見ており、画面側の写しが3キーに減っても今日は誰も赤くならなかった。**
  const client = typeKeys(readProduct("web", "src", "api.ts"), "RowAccess");
  const server = typeKeys(readProduct("src", "server", "owner-scope.ts"), "RecordRowAccess");
  // **どちらが正かを式で書いておく** —— **正はサーバである**(画面側は写し)。
  expect(client).toEqual(server);
  // **空同士で一致しても緑になる**ので、実際に鍵が在ることも撃つ。
  expect(server.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// guard-6 —— 「閲覧のみ」の注記の条件が1バイトも変わっていない
//            (`V14-M6-T03` / 単位 `RB-G8`。計画 `04-v14-m6-tasks.md` §3 の 5 / §6 `R-14`)
// ---------------------------------------------------------------------------

const DETAIL_RENDERER_PATH_PARTS = ["web", "src", "views", "DetailViewRenderer.tsx"] as const;

/**
 * **`web/src/views/DetailViewRenderer.tsx` の「閲覧のみ」の注記の**条件の行**を切り出す。**
 *
 * **行番号で切り出さない** —— **`V14-M6-T03` は編集ボタンの手前(= この行より**下**)に
 * 注記(コメント)を足したので、この行は今回はたまたま動かなかった(着手前も今日も `:1307`)。
 * **しかし上に1行でも入れば動く。** **`ADR-0402` の先例引用が実際にずれている**
 * (計画 §6 `R-13`。逐語「当時 `:748` → 今日 `:820`」)。**行番号に寄りかからない。**
 * **代わりに `{!canWriteRecord && isWriteAudienceRole(` を含む行そのものを探す。**
 *
 * **切り出しの実測: 1行 / 65 バイト。** **綴りの一致は製品側にちょうど1箇所である**
 * (本ファイルは `web/test/` に在るので、{@link webSrcFiles} と違って自分自身を数えない)。
 */
function readOnlyNoteConditionLine(): string {
  const source = readProduct(...DETAIL_RENDERER_PATH_PARTS);
  const marker = "{!canWriteRecord && isWriteAudienceRole(";
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  // **2箇所目が生えていたら赤くする** —— **「どちらを凍結したのか」が曖昧になるからである。**
  expect(source.indexOf(marker, at + 1)).toBe(-1);
  const start = source.lastIndexOf("\n", at) + 1;
  const end = source.indexOf("\n", at);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * **`V14-M6-T03` が凍結した基準。**
 *
 * **先例は同ファイルの `guard-3`**(`canUseAction` の本体を `bytes` / `sha256` で凍結)。
 * **同じ書き方に倣っている。**
 *
 * **【手続き】この値を書き換えるときは、先に赤を見ること。** **`V14-M6-T03` では
 * 実際に見た** —— **条件の行を1バイト変えて2本とも赤にし、元へ戻して `bytes` と
 * `sha256` が一致することを確かめてから焼いた。**
 *
 * **【この検査が見ないもの。誇張しない】**
 * **見ているのは条件の1行だけである。** **注記の本文(「閲覧のみ(書き込み権限が
 * ありません)。」)も `data-testid` も `isWriteAudienceRole` の中身も1文字も見ていない。**
 * **注記が正しい相手に出ることは `web/test/role-visibility.test.tsx` が撃つ。**
 */
const READ_ONLY_NOTE_CONDITION_BASELINE = {
  bytes: 65,
  sha256: "267c5ae27bc52d62cf4f422a6b33c09a09be2ffc5824eee5535f611b3d66cddf",
} as const;

test("(RB-G8/guard-6) 「閲覧のみ」の注記の条件が V14-M6-T03 で1バイトも変わっていない", () => {
  const line = readOnlyNoteConditionLine();
  expect(Buffer.byteLength(line, "utf-8")).toBe(READ_ONLY_NOTE_CONDITION_BASELINE.bytes);
  expect(createHash("sha256").update(line, "utf-8").digest("hex")).toBe(
    READ_ONLY_NOTE_CONDITION_BASELINE.sha256,
  );
});

test("(RB-G8/guard-6) 注記の条件に行ごとの判定が1文字も持ち込まれていない", () => {
  // **`sha256` だけだと、落ちたときに何が変わったのか読み手に分からない**(`guard-3` と同じ理由)。
  // **`rowAccessAllows` を注記の条件へ足す**のが、この段が引き受けた代償を黙って
  // 直してしまう典型の手であり、そのときに何が起きたかが出る式を隣に置く。
  const line = readOnlyNoteConditionLine();
  expect(line.match(/rowAccessAllows/g) ?? []).toHaveLength(0);
  expect(line.match(/access/g) ?? []).toHaveLength(0);
  expect(line.match(/canWriteRecord/g) ?? []).toHaveLength(1);
});
