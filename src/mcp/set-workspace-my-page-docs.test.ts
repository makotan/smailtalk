/**
 * **`set_workspace` の新しい意味とマイページ(`workspace.my_page`)が、AI と人の読み物に届いていること**
 * (`V22-M3-T03`。`ADR-0488` §Decision 2 / 授権 `ADR-0489` 行22・行40 / `ADR-0491` 行53〜55)。
 *
 * `V22-M3-T02` で `set_workspace` は「`app.workspace` を丸ごと差し替え、`{}` で宣言ごと消える」から
 * 「直下のキーごとに置き換え、書かなかったキーは残し、`null` でそのキーを消し、空の `{}` は断る」に変わった。
 * **読み物が旧い意味のままだと、AI はメニューの位置だけを変えるつもりでマイページの宣言を書き落とすか、
 * `{}` を送って断られる。**
 *
 * **このファイルは新しい検査である**(既存の検査の期待値を1つも動かさない)。 見るのは次の6か所の字面:
 *   1. 語彙の全量(`VOCABULARY_SCOPE`。MCP の resources/read で読む)
 *   2. `apply_diff` のツール説明
 *   3. 説明書 view-shape の `SKILL.md`
 *   4. 説明書 diff-shape の `SKILL.md` と `reference/op-required-keys.md`
 *   5. 公開用の `MANUAL.md`
 *
 * **旧い文は消さない**(このリポジトリの訂正の作法)。 旧文が残っていることも見る(消して緑にしない)。
 *
 * **この検査がしないこと**: 文が読めるか・正しいかは見ない。 見るのは決めた綴りが在るかだけである。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server.ts";
import { VOCABULARY_SCOPE } from "./vocabulary.ts";

const UNIT_ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(UNIT_ROOT, path), "utf-8");

/** 新しい意味の4点(どの読み物にも要る綴り)。 */
const PARTIAL_UPDATE_WORDS = ["直下のキーごとに置き換え", "書かなかったキーは残", "null"] as const;

/** マイページの宣言の形(語彙の全量・view-shape・MANUAL に要る綴り)。 */
const MY_PAGE_WORDS = [
  "my_page",
  "open_after_login",
  "exclude",
  "include",
  "owner_field",
  "views",
  "detail_view",
] as const;

let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-set-workspace-docs-"));
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

test("語彙の全量: set_workspace の新しい意味を言い、旧い文(丸ごと差し替え)は訂正として残す", () => {
  for (const word of PARTIAL_UPDATE_WORDS) {
    expect(VOCABULARY_SCOPE).toContain(word);
  }
  expect(VOCABULARY_SCOPE).toContain("空の {} は断られます");
  // 旧文は消していない(訂正の作法)。
  expect(VOCABULARY_SCOPE).toContain("マニフェストの app.workspace を丸ごと差し替え");
});

test("語彙の全量: my_page の形と、載る表・載らない形・連鎖を言う", () => {
  for (const word of MY_PAGE_WORDS) {
    expect(VOCABULARY_SCOPE).toContain(word);
  }
  expect(VOCABULARY_SCOPE).toContain("my_page: {} は既定どおり置きます");
  expect(VOCABULARY_SCOPE).toContain("運営者にも他人の行は出ません");
  expect(VOCABULARY_SCOPE).toContain("同じ差分で set_workspace も直してください");
});

test("apply_diff のツール説明: 19種目の説明の直後に新しい意味の訂正がある", async () => {
  const server = createMcpServer({ dataRoot, previewBaseUrl: "http://localhost:5173", actor: "a" });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const listed = await client.listTools();
    const description = listed.tools.find((one) => one.name === "apply_diff")?.description ?? "";
    const old = description.indexOf("丸ごと差し替える。{} で宣言を消す");
    const correction = description.indexOf(
      "直前の「丸ごと差し替える。{} で宣言を消す」は今日は偽です",
    );
    expect(old).toBeGreaterThanOrEqual(0);
    expect(correction).toBeGreaterThan(old);
    for (const word of PARTIAL_UPDATE_WORDS) {
      expect(description).toContain(word);
    }
    expect(description).toContain("空の {} は断られます");
    expect(description).toContain("my_page");
  } finally {
    await client.close();
    await server.close();
  }
});

test("説明書 view-shape: 5b の旧い2行の直後に訂正があり、マイページの節がある", () => {
  const text = read("plugins/smailtalk/skills/view-shape/SKILL.md");
  const old = text.indexOf("**`{}` を渡すと宣言ごと消える**");
  const correction = text.indexOf("**【訂正】直前の2行は今日は偽である。**");
  expect(old).toBeGreaterThanOrEqual(0);
  expect(correction).toBeGreaterThan(old);
  for (const word of PARTIAL_UPDATE_WORDS) {
    expect(text).toContain(word);
  }
  expect(text).toContain("空の `{}` は断られる");
  expect(text).toContain("## 5c. マイページ(`workspace.my_page`)");
  for (const word of MY_PAGE_WORDS) {
    expect(text).toContain(word);
  }
});

test("説明書 diff-shape: 19種目の説明と op の表に訂正がある", () => {
  const skill = read("plugins/smailtalk/skills/diff-shape/SKILL.md");
  expect(skill).toContain("丸ごと差し替える。`{}` で宣言を消す)が加わった");
  expect(skill).toContain(
    "**【訂正】直前の「丸ごと差し替える。`{}` で宣言を消す」は今日は偽である**",
  );
  const keys = read("plugins/smailtalk/skills/diff-shape/reference/op-required-keys.md");
  expect(keys).toContain(
    "**【訂正】上の表の19行目の「丸ごと差し替える」「`{}` で宣言を消す」は今日は偽である**",
  );
  for (const text of [skill, keys]) {
    for (const word of PARTIAL_UPDATE_WORDS) {
      expect(text).toContain(word);
    }
  }
});

test("MANUAL: 差分操作の表の下に set_workspace の訂正があり、マイページの書き方がある", () => {
  const text = read("MANUAL.md");
  const row = text.indexOf("| `set_workspace` |");
  const correction = text.indexOf(
    "**(訂正)上の表の `set_workspace` の行の「丸ごと」「空の `{}` で宣言を消し」は今日は偽である。**",
  );
  expect(row).toBeGreaterThanOrEqual(0);
  expect(correction).toBeGreaterThan(row);
  for (const word of PARTIAL_UPDATE_WORDS) {
    expect(text).toContain(word);
  }
  expect(text).toContain("### マイページ(`workspace.my_page`)");
  for (const word of MY_PAGE_WORDS) {
    expect(text).toContain(word);
  }
});

// ---------------------------------------------------------------------------
// マイページを壊す差分の列挙の訂正(2026-09-28)。
// 3か所(語彙の全量・説明書 view-shape・MANUAL)の列挙は5つ(remove_table / remove_field / remove_view /
// change_field / set_roles)だけを挙げていた。 適用時の断りの案内は add_field(st_owner を足す)と
// change_table(表の ID を変える)も挙げている。 旧文は消さず、**列挙の直後に**訂正を足す。
// 見るのは (1) 旧文が逐語で残る (2) 旧文の直後(間に空白と箇条の印だけ)に訂正が在る
// (3) 訂正が add_field・st_owner・change_table・set_workspace を言う (4) 内部の記号と【】を書いていない。
// ---------------------------------------------------------------------------

/** 3か所に共通の、訂正の書き出しの綴り(逐語)。 */
const CASCADE_CORRECTION_MARK = "訂正(2026-09-28。直前の";

/** 訂正に要る綴り。 */
const CASCADE_CORRECTION_WORDS = [
  "add_field",
  "st_owner",
  "change_table",
  "set_workspace",
] as const;

/** 公開・配布される読み物に書いてはならない内部の記号。 */
const INTERNAL_SYMBOLS: readonly RegExp[] = [
  /ADR-/,
  /H-V2[0-9]-/,
  /D-V2[0-9]/,
  /V2[0-9]-M[0-9]/,
  /MP-G[0-9]/,
  /EN-G[0-9]/,
];

/** 旧文の直後に訂正が在るか。 間に許すのは空白・改行・箇条の印(`-`)・太字の印(`*`)だけ。 */
function correctionRightAfter(
  text: string,
  oldSentence: string,
): { readonly oldFound: boolean; readonly adjacent: boolean; readonly slice: string } {
  const oldAt = text.indexOf(oldSentence);
  if (oldAt < 0) return { oldFound: false, adjacent: false, slice: "" };
  const after = oldAt + oldSentence.length;
  const markAt = text.indexOf(CASCADE_CORRECTION_MARK, after);
  if (markAt < 0) return { oldFound: true, adjacent: false, slice: "" };
  // 直後でない訂正(同じ日付の別の訂正が後ろに在る)の中身は返さない。 返すと (4) が別の訂正を見て緑になる。
  const adjacent = /^[\s\-*]*$/.test(text.slice(after, markAt));
  // 中身は訂正の行(改行まで。語彙の全量は改行を持たないので 400 文字まで)だけを見る。
  const slice = adjacent ? (text.slice(markAt, markAt + 400).split("\n")[0] ?? "") : "";
  return { oldFound: true, adjacent, slice };
}

const CASCADE_SITES: readonly {
  readonly label: string;
  readonly text: () => string;
  readonly oldSentence: string;
}[] = [
  {
    label: "語彙の全量(VOCABULARY_SCOPE)",
    text: () => VOCABULARY_SCOPE,
    oldSentence:
      "**my_page が指している表・列・画面を remove_table / remove_field / remove_view / change_field / set_roles で消す・壊すときは、" +
      "同じ差分で set_workspace も直してください**(直さないと差分全体が拒否されます)。",
  },
  {
    label: "説明書 view-shape の SKILL.md",
    text: () => read("plugins/smailtalk/skills/view-shape/SKILL.md"),
    oldSentence:
      "- **`my_page` が指している表・列・画面を `remove_table` / `remove_field` / `remove_view` / `change_field` / `set_roles` で消す・壊すときは、同じ差分の中で `set_workspace` も直す。** 直さないと差分全体が拒否される。",
  },
  {
    label: "MANUAL.md",
    text: () => read("MANUAL.md"),
    oldSentence:
      "- `my_page` が指している表・列・画面を消す・壊す差分(`remove_table` / `remove_field` / `remove_view` / `change_field` / `set_roles`)は、同じ差分で `set_workspace` も直さないと差分全体が断られる。",
  },
];

for (const site of CASCADE_SITES) {
  test(`マイページを壊す差分の列挙(${site.label}): 旧文を消さず、その直後に add_field と change_table を足す訂正が在る`, () => {
    const found = correctionRightAfter(site.text(), site.oldSentence);
    expect({ 旧文: found.oldFound, 直後: found.adjacent }).toEqual({ 旧文: true, 直後: true });
    for (const word of CASCADE_CORRECTION_WORDS) {
      expect(found.slice).toContain(word);
    }
  });

  test(`マイページを壊す差分の列挙(${site.label}): 訂正は内部の記号と【】を書いていない`, () => {
    const found = correctionRightAfter(site.text(), site.oldSentence);
    expect(found.slice.length).toBeGreaterThan(0);
    expect({
      記号: INTERNAL_SYMBOLS.filter((pattern) => pattern.test(found.slice)).map(String),
      見出しの括弧: found.slice.includes("【"),
    }).toEqual({ 記号: [], 見出しの括弧: false });
  });
}

test("【陽性対照】直後の判定は、旧文と訂正の間に別の文が挟まると当たらない", () => {
  const old = "旧い列挙。";
  expect(correctionRightAfter(`${old}\n- ${CASCADE_CORRECTION_MARK}行)`, old).adjacent).toBe(true);
  expect(
    correctionRightAfter(`${old}\n- 別の文。\n- ${CASCADE_CORRECTION_MARK}行)`, old).adjacent,
  ).toBe(false);
  expect(correctionRightAfter("訂正の無い文。", old).oldFound).toBe(false);
});
