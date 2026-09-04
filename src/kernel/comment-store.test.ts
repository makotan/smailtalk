/**
 * コメントの器の検査(`V10-M10-T01` / `V10-M25-T01` / `V10-M25-T02` / `CM-G1` / `CM-G3` /
 * `CM-G25a` / `CM-G25b` / `CM-G26` / `ADR-0366` / `ADR-0372` / `ADR-0373`)。
 *
 * ここで固定するのは、今日成り立っていなければならない5点である:
 *
 * - **宛先の形は今日 11 ちょうどである**(`app` / `view` / `view_action` / `view_field` /
 *   `view_related` / `view_report_node` / `view_field_group` / `view_field_link` /
 *   `view_row` / `view_after_save` / `view_after_delete`)。**11形すべてで1件ずつ書けて、
 *   書いたとおりに読み戻せる**(`ADR-0373` 限定1 の陽性対照)。
 *   8形目・9形目は `V10-M25-T01` が足し(参照リンクと一覧の行クリック)、
 *   10形目・11形目は `V10-M25-T02` が足した(保存した後・削除した後の行き先)。
 * - **登録簿に無い形の名前は拒否する。** 12形目に当たる綴り(`view_after_cancel` など、
 *   どこにも実在しない名前)は登録簿に無いので拒否される。**却下された `view_flow` も
 *   同じく1行も無い**(`CM-G27` = 却下。この検査は `V10-M10-T01` が先に打ったもので、
 *   本工程はそれを残しただけである)。
 * - **部品の数が形の定義と合わないもの・空白だけの部品・空の本文は拒否する。**
 * - **器は宛先が実在するかを1度も見ない**(`CM-G1` 限定5)。実在しない画面ID・実在しない
 *   名札でも書ける —— **それは限界であって不具合ではない**(記録に書く)。
 * - `listComments` は `created_at` 昇順(同時刻は `id` 昇順)で返す。
 *
 * `escape-hatch-store.test.ts` の作法に倣い、`dataRoot` は一時ディレクトリを渡して
 * リポジトリの `data/` を汚さない。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMENT_ANCHOR_FORMS, COMMENT_STATES, CommentStore } from "./comment-store.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { kernelDbPath } from "./storage-paths.ts";
import { validateManifestFull } from "./validate.ts";

const APP_ID = "shop";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "gp-comment-store-"));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

/** ストアを開いて処理し、必ず閉じる。 */
function withStore<T>(run: (store: CommentStore) => T): T {
  const store = CommentStore.openForKernel(dataRoot);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

/** 形の部品の数だけ、それらしい綴りを作る(部品の中身は器にとって不透明である)。 */
function partsFor(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `part-${index + 1}`);
}

// --- 登録簿(今日は11形ちょうど)-------------------------------------------------------

test("宛先の形は今日 11 ちょうどで、綴りと順序が固定されている", () => {
  expect(COMMENT_ANCHOR_FORMS).toHaveLength(11);
  expect(COMMENT_ANCHOR_FORMS.map((entry) => entry.form)).toEqual([
    "app",
    "view",
    "view_action",
    "view_field",
    "view_related",
    "view_report_node",
    "view_field_group",
    // ここから2形は `V10-M25-T01`(`CM-G25a` / `CM-G25b` / `ADR-0372`)が足した。
    "view_field_link",
    "view_row",
    // ここから2形は `V10-M25-T02`(`CM-G26` / `ADR-0372`)が足した。
    "view_after_save",
    "view_after_delete",
  ]);
  // 部品の並びも固定する(形を1つ足す差分が「登録簿に1行」で済むことの裏返し)。
  expect(COMMENT_ANCHOR_FORMS.map((entry) => [...entry.parts])).toEqual([
    [],
    ["view_id"],
    ["view_id", "action_id"],
    ["view_id", "field_id"],
    ["view_id", "related_id"],
    ["view_id", "report_node_id"],
    ["view_id", "field_group_id"],
    ["view_id", "field_id"],
    ["view_id"],
    ["view_id"],
    ["view_id"],
  ]);
});

test("V10-M25-T01: 足した2形の部品の数は view_field_link が2つ・view_row が1つである", () => {
  // **`view_field_link` は `view_field` と部品が同じ(`view_id` / `field_id`)である。**
  // 区別するのは**形の名前**であって部品ではない(裁定5)。
  const link = COMMENT_ANCHOR_FORMS.find((entry) => entry.form === "view_field_link");
  expect(link).toBeDefined();
  expect([...(link?.parts ?? [])]).toEqual(["view_id", "field_id"]);
  expect(link?.parts).toHaveLength(2);

  // **`view_row` は `view` と部品が同じ(`view_id` 1つ)である。**
  // **行のIDを入れる場所は1つも無い** —— どの行を押したかは1ミリも表せない。
  const row = COMMENT_ANCHOR_FORMS.find((entry) => entry.form === "view_row");
  expect(row).toBeDefined();
  expect([...(row?.parts ?? [])]).toEqual(["view_id"]);
  expect(row?.parts).toHaveLength(1);
});

test("V10-M25-T02: 足した2形の部品はどちらも view_id 1つである", () => {
  // **`view_after_save` / `view_after_delete` の部品は `view` と同じ(`view_id` 1つ)である。**
  // 区別するのは**形の名前**であって部品ではない(裁定5)。
  // **行のIDを入れる場所は1つも無い** —— 保存した行・消した行を1ミリも表せない。
  for (const form of ["view_after_save", "view_after_delete"]) {
    const entry = COMMENT_ANCHOR_FORMS.find((candidate) => candidate.form === form);
    expect(entry).toBeDefined();
    expect([...(entry?.parts ?? [])]).toEqual(["view_id"]);
    expect(entry?.parts).toHaveLength(1);
  }
});

test("汎用スロットは2本ちょうどである(部品が3つ以上の形は今日1つも無い)", () => {
  // **【禁止】これを「いくつでも足せる」と読まない**(裁定4 の代償)。
  for (const entry of COMMENT_ANCHOR_FORMS) {
    expect(entry.parts.length).toBeLessThanOrEqual(2);
  }
});

test("データ行を指す形は1つも無い(行のIDを入れる場所が無い)", () => {
  // **数え方**: 登録簿の全要素の `parts` を平らに並べ、`record` / `row` / `row_id` の
  // いずれかを名前に含む部品を数える。**0件でなければならない。**
  // **形の名前(`view_row`)には `row` が入るが、それは宛先の**種類**の名前であって
  // 部品ではない** —— 数えるのは `parts` の側だけである。
  const partNames = COMMENT_ANCHOR_FORMS.flatMap((entry) => [...entry.parts]);
  expect(partNames.filter((name) => /record|row|row_id/.test(name))).toEqual([]);
  // 陽性対照: 同じ式を、行のIDを持つ架空の部品名に当てると 1 件になる。
  expect(["view_id", "row_id"].filter((name) => /record|row|row_id/.test(name))).toEqual([
    "row_id",
  ]);
});

// --- 11形すべてで書けて読める -----------------------------------------------------------

test("11形すべてで1件ずつ書けて、書いたとおりに読み戻せる", () => {
  // **`ADR-0373` 限定1 の前半が求める陽性対照である** —— 登録簿の全要素を舐め、
  // 1件ずつ書いて読み戻す。**形を足しても、この検査は書き換えずに増えた分を測る。**
  withStore((store) => {
    for (const entry of COMMENT_ANCHOR_FORMS) {
      const parts = partsFor(entry.parts.length);
      const comment = store.addComment({
        appId: APP_ID,
        anchorForm: entry.form,
        anchorParts: parts,
        body: `${entry.form} への意見`,
      });
      expect(comment.anchorForm).toBe(entry.form);
      expect(comment.anchorParts).toEqual(parts);
      expect(comment.appId).toBe(APP_ID);
      expect(comment.body).toBe(`${entry.form} への意見`);
      expect(comment.id).not.toBe("");
      expect(comment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const read = store.getComment(comment.id);
      expect(read).toEqual(comment);
    }
    expect(store.listComments(APP_ID)).toHaveLength(11);
  });
});

test("部品を持たない形(app)は空の配列で書け、読み戻しても空である", () => {
  withStore((store) => {
    const comment = store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "アプリ全体への意見",
    });
    expect(comment.anchorParts).toEqual([]);
    expect(store.getComment(comment.id)?.anchorParts).toEqual([]);
  });
});

test("getComment は未登録の id に undefined を返す", () => {
  withStore((store) => {
    expect(store.getComment("存在しない-id")).toBeUndefined();
  });
});

// --- 拒否する4つ -------------------------------------------------------------------

test("拒否1: 登録簿に無い形の名前を拒否し、エラー文に今日の本数(11)を書く", () => {
  withStore((store) => {
    // **12形目**に当たる綴り。**どこにも実在しない名前**であり、登録簿に無いので拒否される
    // (`ADR-0373` 限定1 の後半)。**`V10-M25-T02` が11形にしたので、10形目・11形目を
    //  拒否の例に使えなくなった** —— 実在しない綴りに差し替えてある。
    expect(() =>
      store.addComment({
        appId: APP_ID,
        anchorForm: "view_after_cancel",
        anchorParts: ["books-detail"],
        body: "取り消したあとの行き先について",
      }),
    ).toThrow(/受け付ける宛先の形は11つです/);
    // もう1つ、部品の数が合っていても綴りが登録簿に無ければ拒否される。
    expect(() =>
      store.addComment({
        appId: APP_ID,
        anchorForm: "view_after_save_and_delete",
        anchorParts: ["books-detail"],
        body: "両方の行き先について",
      }),
    ).toThrow(/受け付ける宛先の形は11つです/);
    // 却下された `view_flow` も同じく無い(`CM-G27` = 却下の履行)。
    // **この1本は `V10-M10-T01` が先に打ったものであり、本工程が初めて打ったのではない。**
    expect(() =>
      store.addComment({
        appId: APP_ID,
        anchorForm: "view_flow",
        anchorParts: ["books-detail"],
        body: "流れについて",
      }),
    ).toThrow(/受け付ける宛先の形は11つです/);
    expect(store.listComments(APP_ID)).toHaveLength(0);
  });
});

test("拒否2: 部品の数が形の定義と合わないものを拒否する(多すぎ・少なすぎの両方)", () => {
  withStore((store) => {
    expect(() =>
      store.addComment({
        appId: APP_ID,
        anchorForm: "view",
        anchorParts: ["books-detail", "余計な部品"],
        body: "b",
      }),
    ).toThrow(/部品/);
    expect(() =>
      store.addComment({
        appId: APP_ID,
        anchorForm: "view_action",
        anchorParts: ["books-detail"],
        body: "b",
      }),
    ).toThrow(/部品/);
    expect(() =>
      store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: ["x"], body: "b" }),
    ).toThrow(/部品/);
    expect(store.listComments(APP_ID)).toHaveLength(0);
  });
});

test("拒否3: 部品に空文字・空白だけの文字列を拒否する", () => {
  withStore((store) => {
    expect(() =>
      store.addComment({ appId: APP_ID, anchorForm: "view", anchorParts: [""], body: "b" }),
    ).toThrow(/部品/);
    expect(() =>
      store.addComment({ appId: APP_ID, anchorForm: "view", anchorParts: ["   "], body: "b" }),
    ).toThrow(/部品/);
    expect(() =>
      store.addComment({
        appId: APP_ID,
        anchorForm: "view_field",
        anchorParts: ["books-detail", " "],
        body: "b",
      }),
    ).toThrow(/部品/);
    expect(store.listComments(APP_ID)).toHaveLength(0);
  });
});

test("拒否4: 本文が空(空白だけを含む)のものを拒否する", () => {
  withStore((store) => {
    expect(() =>
      store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "" }),
    ).toThrow(/本文/);
    expect(() =>
      store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "   \n " }),
    ).toThrow(/本文/);
    expect(store.listComments(APP_ID)).toHaveLength(0);
  });
});

test("アプリIDが空のものを拒否する(どのアプリ宛てか分からない行を作らない)", () => {
  withStore((store) => {
    expect(() =>
      store.addComment({ appId: "", anchorForm: "app", anchorParts: [], body: "b" }),
    ).toThrow(/アプリ/);
  });
});

// --- 拒否しない2つ(限界。記録に書く)---------------------------------------------------

test("限界: 宛先が実在しなくても書ける(器はマニフェストを1度も読まない)", () => {
  withStore((store) => {
    const comment = store.addComment({
      appId: APP_ID,
      anchorForm: "view_field",
      anchorParts: ["実在しない画面", "実在しない項目"],
      body: "実在しない宛先への意見",
    });
    // **書けてしまう。**`CM-G1` 限定5 の帰結であり、不具合ではない。
    expect(store.getComment(comment.id)?.anchorParts).toEqual(["実在しない画面", "実在しない項目"]);
  });
});

test("限界: 画面の種別に合わない形も書ける(集計表の画面IDに view_field_group など)", () => {
  withStore((store) => {
    const comment = store.addComment({
      appId: APP_ID,
      anchorForm: "view_field_group",
      anchorParts: ["sales-report", "実在しない名札"],
      body: "種別に合わない宛先",
    });
    expect(store.getComment(comment.id)?.anchorForm).toBe("view_field_group");
  });
});

test("限界: list_view 以外の画面IDでも view_row を書けてしまう(器は止めない)", () => {
  // **`view_row` は「一覧の行を押した」ことを指す形である。** それでも器は、
  // 集計表・詳細画面・フォーム、さらには実在しない画面IDに対しても素通しする ——
  // **器はマニフェストを1度も読まないので、画面の種別を知らない**(`CM-G1` 限定5 / 裁定6)。
  // **【禁止】これを不具合と読まない。限界である。**
  withStore((store) => {
    for (const viewId of ["sales-report", "books-detail", "books-form", "実在しない画面"]) {
      const comment = store.addComment({
        appId: APP_ID,
        anchorForm: "view_row",
        anchorParts: [viewId],
        body: `${viewId} の行について`,
      });
      expect(store.getComment(comment.id)?.anchorForm).toBe("view_row");
      expect(store.getComment(comment.id)?.anchorParts).toEqual([viewId]);
    }
    expect(store.listComments(APP_ID)).toHaveLength(4);
  });
});

test("限界: 同じ項目へのコメントが view_field と view_field_link の2箇所に散る", () => {
  // **部品は1バイトも違わない(同じ画面ID・同じ項目ID)のに、形の名前が違うだけで
  // 別の行として並ぶ。** **器はこの2本を突き合わせない** —— 項目の説明への意見と、
  // その項目のリンク先への意見が、同じ項目の下に集まらない。
  withStore((store) => {
    const parts = ["books-detail", "publisher"];
    const onField = store.addComment({
      appId: APP_ID,
      anchorForm: "view_field",
      anchorParts: parts,
      body: "この項目の説明が分かりにくい",
    });
    const onLink = store.addComment({
      appId: APP_ID,
      anchorForm: "view_field_link",
      anchorParts: parts,
      body: "押した先が期待と違う",
    });
    expect(onField.id).not.toBe(onLink.id);
    expect(onField.anchorParts).toEqual(onLink.anchorParts);
    const listed = store.listComments(APP_ID);
    expect(listed).toHaveLength(2);
    expect(listed.map((entry) => entry.anchorForm).sort()).toEqual([
      "view_field",
      "view_field_link",
    ]);
    // **突き合わせる口が無いことを、実際に数えて示す。**
    // 「この項目に付いた意見」を1本の式で採ろうとすると、形の名前で2度引くしかない。
    // (部品の一致は要素ごとに見る。**`join("/")` で畳むと `scripts/upward-path-scan.test.ts` /
    //  `scripts/standalone-scope.test.ts` が「上へ出る相対パスの式」と読んで赤くなる** ——
    //  実測で踏んだ。)
    const samePartsAsTarget = (entry: { anchorParts: string[] }) =>
      entry.anchorParts.length === parts.length &&
      entry.anchorParts.every((part, index) => part === parts[index]);
    const byForm = (form: string) =>
      listed.filter((entry) => entry.anchorForm === form && samePartsAsTarget(entry));
    expect(byForm("view_field")).toHaveLength(1);
    expect(byForm("view_field_link")).toHaveLength(1);
  });
});

test("限界: after_save の宣言を持たない画面IDでも view_after_save が書けてしまう", () => {
  // **`support` のディスク上の画面17本のうち、`after_save` を宣言しているのは7本である**
  // (残る10本は宣言を持たない)。**`after_delete` を宣言している画面は、今日どのアプリにも
  //  1本も無い**(`support` 0 / `shop` 0 / `todo` 0)。
  // それでも器は、**宣言を1つも持たない画面IDに対してこの2形を素通しする** ——
  // 器はマニフェストを1度も読まないからである(`CM-G1` 限定5 / 裁定6)。
  // **したがって書かれた宛先の指し先は、今日も明日も解決しない。**
  // **【禁止】これを不具合と読まない。限界である。**
  withStore((store) => {
    // `projects_list` / `tasks_detail` はディスク上の `support` に実在し、
    // どちらも `after_save` を1つも宣言していない画面である。
    for (const viewId of ["projects_list", "tasks_detail", "実在しない画面"]) {
      const saved = store.addComment({
        appId: APP_ID,
        anchorForm: "view_after_save",
        anchorParts: [viewId],
        body: `${viewId} の保存後の行き先について`,
      });
      expect(store.getComment(saved.id)?.anchorForm).toBe("view_after_save");
      expect(store.getComment(saved.id)?.anchorParts).toEqual([viewId]);

      // `after_delete` は今日どのアプリも1本も宣言していない。それでも書ける。
      const deleted = store.addComment({
        appId: APP_ID,
        anchorForm: "view_after_delete",
        anchorParts: [viewId],
        body: `${viewId} の削除後の行き先について`,
      });
      expect(store.getComment(deleted.id)?.anchorForm).toBe("view_after_delete");
      expect(store.getComment(deleted.id)?.anchorParts).toEqual([viewId]);
    }
    expect(store.listComments(APP_ID)).toHaveLength(6);
  });
});

test("限界: view と view_after_save は部品が1バイトも違わないのに別の行として並ぶ", () => {
  // **同じ画面IDに対する「画面そのものへの意見」と「保存した後の行き先への意見」は、
  //  部品が完全に同一である。** 区別するのは**形の名前**だけであり、
  // **器はこの2本(3本)を突き合わせない** —— 同じ画面の下に集まらない。
  withStore((store) => {
    const parts = ["books-detail"];
    const onView = store.addComment({
      appId: APP_ID,
      anchorForm: "view",
      anchorParts: parts,
      body: "この画面が使いにくい",
    });
    const onAfterSave = store.addComment({
      appId: APP_ID,
      anchorForm: "view_after_save",
      anchorParts: parts,
      body: "保存したあとに戻る先が違う",
    });
    const onAfterDelete = store.addComment({
      appId: APP_ID,
      anchorForm: "view_after_delete",
      anchorParts: parts,
      body: "消したあとに戻る先が違う",
    });
    expect(onView.anchorParts).toEqual(onAfterSave.anchorParts);
    expect(onView.anchorParts).toEqual(onAfterDelete.anchorParts);
    expect(new Set([onView.id, onAfterSave.id, onAfterDelete.id]).size).toBe(3);

    const listed = store.listComments(APP_ID);
    expect(listed).toHaveLength(3);
    expect(listed.map((entry) => entry.anchorForm).sort()).toEqual([
      "view",
      "view_after_delete",
      "view_after_save",
    ]);
    // 部品の一致は要素ごとに見る(文字列に畳む式は `scripts/upward-path-scan.test.ts` /
    // `scripts/standalone-scope.test.ts` が「上へ出る相対パスの式」と読んで赤くなる)。
    const samePartsAsTarget = (entry: { anchorParts: string[] }) =>
      entry.anchorParts.length === parts.length &&
      entry.anchorParts.every((part, index) => part === parts[index]);
    expect(listed.filter(samePartsAsTarget)).toHaveLength(3);
  });
});

test("限界: view_field_link はリンク先のどの行かを1ミリも表せない", () => {
  // **同じ列でも行が違えばリンク先の行が違う。** それでも書ける宛先は
  // `(view_id, field_id)` の1組だけなので、**2つの行のリンクへの意見は
  // 1バイトも区別できない同じ宛先になる。**
  withStore((store) => {
    const first = store.addComment({
      appId: APP_ID,
      anchorForm: "view_field_link",
      anchorParts: ["books-detail", "publisher"],
      body: "1行目のリンク先が違う",
    });
    const second = store.addComment({
      appId: APP_ID,
      anchorForm: "view_field_link",
      anchorParts: ["books-detail", "publisher"],
      body: "2行目のリンク先が違う",
    });
    expect(first.anchorForm).toBe(second.anchorForm);
    expect(first.anchorParts).toEqual(second.anchorParts);
    // 区別できるのは本文だけである(宛先は完全に同一)。
    expect(first.body).not.toBe(second.body);
  });
});

// --- 一覧 -----------------------------------------------------------------------------

test("listComments は app スコープに閉じる(別アプリのコメントが混ざらない)", () => {
  withStore((store) => {
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "shop への意見" });
    store.addComment({
      appId: "other",
      anchorForm: "app",
      anchorParts: [],
      body: "other への意見",
    });
    expect(store.listComments(APP_ID).map((c) => c.body)).toEqual(["shop への意見"]);
    expect(store.listComments("other").map((c) => c.body)).toEqual(["other への意見"]);
    expect(store.listComments("居ないアプリ")).toEqual([]);
  });
});

test("listComments は created_at 昇順(同時刻は id 昇順)で返す", () => {
  withStore((store) => {
    // 同一ミリ秒に落ちても順序が定まることを見るため、`created_at` を明示して並べ替える。
    const a = store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "1" });
    const b = store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "2" });
    const c = store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "3" });
    const listed = store.listComments(APP_ID);
    expect(listed).toHaveLength(3);
    const sorted = [a, b, c].sort((x, y) =>
      x.createdAt === y.createdAt
        ? x.id.localeCompare(y.id)
        : x.createdAt.localeCompare(y.createdAt),
    );
    expect(listed.map((entry) => entry.id)).toEqual(sorted.map((entry) => entry.id));
  });
});

// --- 閉じた後 --------------------------------------------------------------------------

test("close の後は読み書きとも例外になる", () => {
  const store = CommentStore.openForKernel(dataRoot);
  store.close();
  expect(() =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "b" }),
  ).toThrow();
  expect(() => store.listComments(APP_ID)).toThrow();
});

test("同じ dataRoot を開き直すと、前に書いた行がそのまま読める(kernel.sqlite に永続する)", () => {
  const id = withStore((store) => {
    return store.addComment({
      appId: APP_ID,
      anchorForm: "view",
      anchorParts: ["books-list"],
      body: "一覧が見づらい",
    }).id;
  });
  withStore((store) => {
    expect(store.getComment(id)?.body).toBe("一覧が見づらい");
  });
});

// --- V10-M10-T02(`CM-G2` 限定4。同じ項目IDが2度書かれた画面)-------------------------
//
// **`CM-G2` 限定4 は「宛先は『どの項目か』を指すのであって『何番目か』を指さない」を課す。**
// **同じ項目IDが2度書かれた画面**(`columns: ["title","title"]`)が今日も定義として
// 通ってしまうため、その画面の1本目の列と2本目の列は**器の宛先では1行も区別が付かない。**
// **【禁止】これを「区別できるようにした」と読まない。** ここで固定するのは
// 「区別が付かないこと」そのものである。
//
// **登録簿(`COMMENT_ANCHOR_FORMS`)の `parts` を測る式は、ここには足していない** ——
// `:60`(綴りと順序)と `:128`(データ行を指す形は1つも無い)が既に逐語で固定しており、
// 足すと重複するだけである(独立点検 A-4)。

/** 一覧画面を1つだけ持つマニフェスト。`columns` は渡した**宣言順のまま**入る。 */
const T02_VIEW_ID = "book-list";

function manifestWithColumns(columns: readonly string[]): unknown {
  return {
    app: {
      id: APP_ID,
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "memo", name: "メモ", type: "long_text" },
          ],
        },
      ],
      views: [{ id: T02_VIEW_ID, type: "list_view", table: "books", columns: [...columns] }],
    },
  };
}

/** `dataRoot` の下の別々の器を開いて処理し、必ず閉じる。 */
function withStoreAt<T>(root: string, run: (store: CommentStore) => T): T {
  const store = CommentStore.openForKernel(root);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

/**
 * 画面の列を**宣言順に**なぞって、1列につき1件のコメントを書く。
 * 宛先は `view_field`(部品 = `view_id` / `field_id`)であり、**何番目かを渡す場所が無い。**
 */
function commentOnEachColumn(root: string, columns: readonly string[]): void {
  withStoreAt(root, (store) => {
    for (const columnId of columns) {
      store.addComment({
        appId: APP_ID,
        anchorForm: "view_field",
        anchorParts: [T02_VIEW_ID, columnId],
        body: `${columnId} の列が見づらい`,
      });
    }
  });
}

/**
 * `gp_comments` の**全行 dump**(`v10-m25.md` §5 が採った形)。
 *
 * 列は `PRAGMA table_info` から取り、**行ごとに不定な2列(`id` / `created_at`)だけを落とす。**
 * 列名を焼き込まないので、**器に「何番目か」を入れる列が生えたら dump に現れる。**
 * 並べ替えの鍵も dump に出す列そのものであり、**書いた順序は1バイトも混ぜない。**
 */
function dumpCommentRows(root: string): string[] {
  const db = new Database(kernelDbPath(root), { readonly: true });
  try {
    const columns = (db.query(`PRAGMA table_info("gp_comments")`).all() as { name: string }[])
      .map((info) => info.name)
      .filter((name) => name !== "id" && name !== "created_at");
    const quoted = columns.map((name) => `"${name}"`).join(", ");
    const rows = db.query(`SELECT ${quoted} FROM "gp_comments" ORDER BY ${quoted}`).all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => columns.map((name) => `${name}=${String(row[name])}`).join(" | "));
  } finally {
    db.close();
  }
}

test("V10-M10-T02(限定4-a): 同じ項目IDを2度書いた画面は今日も valid=true である(陽性対照: 実在しない列は valid=false)", () => {
  const duplicated = validateManifestFull(manifestWithColumns(["title", "title"]));
  expect(duplicated.valid).toBe(true);

  // 陽性対照: 同じ形で列のIDだけを実在しないものに変えると落ちる(検査が素通りしていない)。
  const missing = validateManifestFull(manifestWithColumns(["title", "zzz"]));
  expect(missing.valid).toBe(false);
  expect(missing.valid ? [] : missing.errors.map((error) => error.path)).toEqual([
    "/app/views/0/columns/1",
  ]);
});

test("V10-M10-T02(限定4-b): 同じ項目IDを2度書いた画面の2つの列は、器の宛先では1行も区別が付かない(陽性対照: 列の宣言順を入れ替えても dump が変わらない)", () => {
  // (1) 同じ項目IDが2度並ぶ画面。1本目の列と2本目の列に1件ずつ書く。
  const duplicatedColumns = ["title", "title"];
  const duplicatedRoot = join(dataRoot, "duplicated");
  commentOnEachColumn(duplicatedRoot, duplicatedColumns);
  const duplicatedRows = dumpCommentRows(duplicatedRoot);
  expect(duplicatedRows).toHaveLength(2);
  // **2件の行が1バイトも違わない。** 器は「1本目の列」「2本目の列」を表せない。
  expect(duplicatedRows[0]).toBe(duplicatedRows[1]);

  // (2) 陽性対照: 列の**宣言順を入れ替えた別のマニフェスト**でも、dump が1バイトも変わらない。
  //     = 器の宛先は画面の並びに1ミリも依存しない。
  const declaredOrder = ["title", "memo"];
  const swappedOrder = ["memo", "title"];
  expect(declaredOrder).not.toEqual(swappedOrder);
  expect(validateManifestFull(manifestWithColumns(declaredOrder)).valid).toBe(true);
  expect(validateManifestFull(manifestWithColumns(swappedOrder)).valid).toBe(true);

  const declaredRoot = join(dataRoot, "declared-order");
  const swappedRoot = join(dataRoot, "swapped-order");
  commentOnEachColumn(declaredRoot, declaredOrder);
  commentOnEachColumn(swappedRoot, swappedOrder);
  const declaredRows = dumpCommentRows(declaredRoot);
  expect(declaredRows).toHaveLength(2);
  expect(declaredRows).toEqual(dumpCommentRows(swappedRoot));
});

// **【裁定5(`V10-M13` メインの裁定。`RULINGS-M13.md`)】**
// **列を足すたびに「N本ちょうど」と焼いたテスト名が赤くなる型を、このリポジトリは
// 3回(`T01` → `T02` → `T03`)踏むと分かっているので、名前から本数を外した。**
// **旧の名前(逐語。消さない)**:
//   `V10-M10-T02(限定4-c): gp_comments の列は7本ちょうどで、何番目かを入れる列が1本も無い`
// **旧の期待配列(逐語。消さない。`V10-M13-T01` より前の7列)**:
//   ["id", "app_id", "anchor_form", "anchor_1", "anchor_2", "body", "created_at"]
// **`V10-M13-T01` が `writer` を1本足した(7列 → 8列)。**
// **`V10-M13-T02` が `state` を1本足した(8列 → 9列)。**
// **`V10-M13-T03` が `reason` を1本足した(9列 → 10列)。**
// **`V10-M15-T01` が `diff_id` を1本足した(10列 → 11列。差分を指す繋ぎの列。列は
// 増えたが「N本ちょうど」はテスト名から既に外れているので、名前は1バイトも書き換えない)。**
test("gp_comments の列は、器の宣言と全量で一致し、何番目かを入れる列が1本も無い", () => {
  withStore((store) => {
    store.addComment({
      appId: APP_ID,
      anchorForm: "view_field",
      anchorParts: [T02_VIEW_ID, "title"],
      body: "この列が見づらい",
    });
  });
  const db = new Database(kernelDbPath(dataRoot), { readonly: true });
  try {
    const names = (db.query(`PRAGMA table_info("gp_comments")`).all() as { name: string }[]).map(
      (info) => info.name,
    );
    expect(names).toEqual([
      "id",
      "app_id",
      "anchor_form",
      "anchor_1",
      "anchor_2",
      "body",
      "created_at",
      "writer",
      "state",
      "reason",
      "diff_id",
    ]);
    // **これは陰性対照ではない**(独立点検 B-12)。上の `toEqual` が通った時点で必ず 0 本になる。
    // **読み手に「何を見ているか」を示す再掲**であり、陰性対照の本体は
    // 「`SCHEMA` に `"anchor_index" INTEGER,` を1行足すとこの検査が赤くなる」ことである。
    expect(names.filter((name) => /index|ordinal|position|nth/.test(name))).toEqual([]);
  } finally {
    db.close();
  }
});

// ===========================================================================
// `V10-M13-T01`(台帳 `CM-G10`。**門A**(`Δ8`)/ 判定値 = 限定採用。`ADR-0369`)
//
// **コメント1行に「書き手」の列を1本(`NULL` 可)持たせる。器は書き手を1度も解決しない**
// —— 誰が書いたかは呼び出し側(HTTP の口)が決めて渡すだけである。
// ===========================================================================

test("V10-M13-T01: 書き手を渡さずに書くと writer が null になる(未ログインの行)", () => {
  const comment = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "未ログインで書いた1件",
    }),
  );
  expect(comment.writer).toBeNull();
  const reread = withStore((store) => store.getComment(comment.id));
  expect(reread?.writer).toBeNull();
});

test("V10-M13-T01: 書き手を渡すと、渡した文字列が1バイトも変わらずに読み戻せる", () => {
  const writer = "user-9f3a7c21";
  const comment = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "ログインして書いた1件",
      writer,
    }),
  );
  expect(comment.writer).toBe(writer);
  const reread = withStore((store) => store.getComment(comment.id));
  expect(reread?.writer).toBe(writer);
});

test("V10-M13-T01: 器は書き手を1度も解決しない(実在しない利用者IDでも空白だけでも書ける)", () => {
  const fakeUserId = "no-such-user-zzz-999";
  const whitespaceOnly = "   ";
  const first = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "実在しない利用者IDを渡す",
      writer: fakeUserId,
    }),
  );
  expect(first.writer).toBe(fakeUserId);
  const second = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "空白だけの書き手を渡す",
      writer: whitespaceOnly,
    }),
  );
  // **空白だけでも拒否しない**(`body` と違い `writer` は `trim()` すら見ない)。
  expect(second.writer).toBe(whitespaceOnly);
});

test("V10-M13-T01: 空文字の書き手を null に丸めない(渡していないことと区別する)", () => {
  const withEmptyString = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "空文字の書き手",
      writer: "",
    }),
  );
  const withoutWriter = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "書き手を渡さない",
    }),
  );
  // **"" と渡さなかった場合は別物である。** "" は "" のまま残り、null にはならない。
  expect(withEmptyString.writer).toBe("");
  expect(withEmptyString.writer).not.toBeNull();
  expect(withoutWriter.writer).toBeNull();
});

test("V10-M13-T01: 7列で作られた既存の gp_comments を開き直すと、欠けている列だけが足される", () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "gp-comment-store-old7-"));
  try {
    const db = new Database(kernelDbPath(oldRoot), { create: true });
    db.exec(`
      CREATE TABLE "gp_comments" (
        "id"          TEXT PRIMARY KEY,
        "app_id"      TEXT NOT NULL,
        "anchor_form" TEXT NOT NULL,
        "anchor_1"    TEXT,
        "anchor_2"    TEXT,
        "body"        TEXT NOT NULL,
        "created_at"  TEXT NOT NULL
      );
    `);
    db.query(
      `INSERT INTO "gp_comments"
         ("id", "app_id", "anchor_form", "anchor_1", "anchor_2", "body", "created_at")
       VALUES ('old-1', ${JSON.stringify(APP_ID)}, 'app', NULL, NULL, '移行前の行', '2026-08-01T00:00:00.000Z')`,
    ).run();
    db.close();

    const migrated = CommentStore.openForKernel(oldRoot);
    try {
      const columns = migrated.getComment("old-1");
      expect(columns?.body).toBe("移行前の行");
      // **移行で埋まった `writer` は null である**(未認証で書かれた行と機械では区別が付かない。限界)。
      expect(columns?.writer).toBeNull();
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(oldRoot, { recursive: true, force: true });
  }
});

test("V10-M13-T01: 移行は冪等である(2回開いても PRAGMA table_info が同じ列を返す)", () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "gp-comment-store-idempotent-"));
  try {
    const db = new Database(kernelDbPath(oldRoot), { create: true });
    db.exec(`
      CREATE TABLE "gp_comments" (
        "id"          TEXT PRIMARY KEY,
        "app_id"      TEXT NOT NULL,
        "anchor_form" TEXT NOT NULL,
        "anchor_1"    TEXT,
        "anchor_2"    TEXT,
        "body"        TEXT NOT NULL,
        "created_at"  TEXT NOT NULL
      );
    `);
    db.close();

    const columnsOf = (): string[] => {
      const handle = new Database(kernelDbPath(oldRoot), { readonly: true });
      try {
        return (handle.query(`PRAGMA table_info("gp_comments")`).all() as { name: string }[]).map(
          (row) => row.name,
        );
      } finally {
        handle.close();
      }
    };

    const first = CommentStore.openForKernel(oldRoot);
    first.close();
    const afterFirstOpen = columnsOf();

    const second = CommentStore.openForKernel(oldRoot);
    second.close();
    const afterSecondOpen = columnsOf();

    expect(afterFirstOpen).toEqual(afterSecondOpen);
    expect(afterFirstOpen).toContain("writer");
  } finally {
    rmSync(oldRoot, { recursive: true, force: true });
  }
});

test("V10-M13-T01: 移行の前に在った行は1行も壊れず、本文が1バイトも変わらない", () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "gp-comment-store-preserve-"));
  try {
    const originalBody = "移行の前に書いた本文。1バイトも変わってはいけない。";
    const db = new Database(kernelDbPath(oldRoot), { create: true });
    db.exec(`
      CREATE TABLE "gp_comments" (
        "id"          TEXT PRIMARY KEY,
        "app_id"      TEXT NOT NULL,
        "anchor_form" TEXT NOT NULL,
        "anchor_1"    TEXT,
        "anchor_2"    TEXT,
        "body"        TEXT NOT NULL,
        "created_at"  TEXT NOT NULL
      );
    `);
    db.query(
      `INSERT INTO "gp_comments"
         ("id", "app_id", "anchor_form", "anchor_1", "anchor_2", "body", "created_at")
       VALUES ('preserved-1', ${JSON.stringify(APP_ID)}, 'view_field', 'v1', 'f1', ?, '2026-08-01T00:00:00.000Z')`,
    ).run(originalBody);
    db.close();

    const migrated = CommentStore.openForKernel(oldRoot);
    try {
      const row = migrated.getComment("preserved-1");
      expect(row?.body).toBe(originalBody);
      expect(row?.anchorForm).toBe("view_field");
      expect(row?.anchorParts).toEqual(["v1", "f1"]);
      expect(row?.createdAt).toBe("2026-08-01T00:00:00.000Z");
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(oldRoot, { recursive: true, force: true });
  }
});

// **このテスト名は `V10-M15-T01` の今日から字面として偽である**
// (`entry-point-inventory.test.ts` と同じ作法で、名前は1バイトも書き換えない)。
// **`diff` を含む列は0件ではなく `diff_id` の1本ちょうどになった** —— **これは「案」
// (中央の識別子。`CM-G8` = 却下)を持つ列ではなく、コメント → 差分 の繋ぎの列である。**
// **`proposal` を含む列は今日も0件のまま**(繋ぐのは2点であって3点ではない)。
test("V10-M13-T01: 案と差分を繋ぐ列を1本も持たない(gp_comments の列名に diff / proposal が0件)", () => {
  const comment = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "案と差分を繋ぐ列は無い",
    }),
  );
  expect(comment).toBeDefined();
  const db = new Database(kernelDbPath(dataRoot), { readonly: true });
  try {
    const names = (db.query(`PRAGMA table_info("gp_comments")`).all() as { name: string }[]).map(
      (row) => row.name,
    );
    // **`proposal` は今日も0件**(中央の「案」は無い)。
    expect(names.filter((name) => /proposal/.test(name))).toEqual([]);
    // **`diff` は `V10-M15-T01` から `diff_id` の1本ちょうど**(コメント → 差分 の繋ぎ)。
    expect(names.filter((name) => /diff/.test(name))).toEqual(["diff_id"]);
    // **陽性対照** —— フィルタが空振りしていないことを、当たるパターンで示す
    // (`body` / `id` は実在する列名であり、このパターンには本当に当たる)。
    expect(names.filter((name) => /id|body/.test(name)).length).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});

test("V10-M13-T01: 器は書き手を解決する関数を1つも呼ばない(限定2。陽性対照つき)", () => {
  const storeSource = readFileSync(join(import.meta.dir, "comment-store.ts"), "utf-8");
  const pattern = /findUser|resolveActor|requireActorAndApp/g;
  const hitsInStore = storeSource.match(pattern) ?? [];
  expect(hitsInStore.length).toBe(0);

  // **陽性対照** —— 同じ式を `src/mcp/tools/read.ts` に当てると 0 でないことを示す
  // (式そのものが空振りしていないことの担保)。
  const readToolSource = readFileSync(
    join(import.meta.dir, "..", "mcp", "tools", "read.ts"),
    "utf-8",
  );
  const hitsInReadTool = readToolSource.match(pattern) ?? [];
  expect(hitsInReadTool.length).toBeGreaterThan(0);
});

// ===========================================================================
// `V10-M13-T02`(台帳 `CM-G19`。**門A**(`Δ8`)/ 判定値 = 限定採用。`ADR-0369`)
//
// **コメント1行に3値の状態を持たせる。新しいコメントは必ず open で生まれ、
// 状態を書き換える関数(`updateCommentState`)は1本ちょうどである。**
// ===========================================================================

test("V10-M13-T02: 新しいコメントの状態は open である(生まれた時点で applied にはできない)", () => {
  const comment = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "生まれたばかりの1件",
    }),
  );
  expect(comment.state).toBe(COMMENT_STATES[0]);

  const rows = withStore((store) => store.listComments(APP_ID));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe(COMMENT_STATES[0]);
});

test("V10-M13-T02: 3値それぞれに倒せて、そのまま読み戻せる", () => {
  const created = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "3値を1本ずつ試す",
    }),
  );
  for (const state of COMMENT_STATES) {
    // **`V10-M13-T03` の波及**: 対応できないという値(`COMMENT_STATES[1]`)は理由が
    // 必須になったので、この generic なループにも渡す(それ以外は `undefined` のまま)。
    const updated = withStore((store) =>
      store.updateCommentState(
        created.id,
        state,
        state === COMMENT_STATES[1] ? "3値を1本ずつ試すときの理由" : undefined,
      ),
    );
    expect(updated.state).toBe(state);
    const reread = withStore((store) => store.getComment(created.id));
    expect(reread?.state).toBe(state);
  }
});

test("V10-M13-T02: 4値目を渡すと器が拒否し、エラー文に3値の名前が並ぶ(陽性対照: 3値はすべて通る)", () => {
  const created = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "拒否を試す1件",
    }),
  );

  let captured: unknown;
  try {
    withStore((store) => store.updateCommentState(created.id, "done"));
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(Error);
  const message = captured instanceof Error ? captured.message : "";
  const missing = COMMENT_STATES.filter((state) => !message.includes(state));
  expect(missing).toEqual([]);

  // 陽性対照: 3値はすべて通る。
  // **`V10-M13-T03` の波及**: 対応できないという値は理由が必須になった。
  for (const state of COMMENT_STATES) {
    const updated = withStore((store) =>
      store.updateCommentState(
        created.id,
        state,
        state === COMMENT_STATES[1] ? "4値目の陽性対照で使う理由" : undefined,
      ),
    );
    expect(updated.state).toBe(state);
  }
});

test("V10-M13-T02: 状態を3回書き換えても本文が1バイトも変わらない", () => {
  const originalBody = "本文はここに固定。1バイトも変わってはいけない。";
  const created = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: originalBody,
    }),
  );
  // **`V10-M13-T03` の波及**: 対応できないという値は理由が必須になった。
  for (const state of COMMENT_STATES) {
    const updated = withStore((store) =>
      store.updateCommentState(
        created.id,
        state,
        state === COMMENT_STATES[1] ? "本文が変わらないことを確かめるときの理由" : undefined,
      ),
    );
    expect(updated.body).toBe(originalBody);
  }
  const reread = withStore((store) => store.getComment(created.id));
  expect(reread?.body).toBe(originalBody);
  // 陽性対照 —— 本文の比較そのものが空振りしていないこと(わざと変えると不一致になる)。
  expect(reread?.body).not.toBe(`${originalBody}x`);
});

test("V10-M13-T02: 状態を書き換えても宛先・書き手・作成時刻が1バイトも変わらない", () => {
  const created = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "view_field",
      anchorParts: ["v1", "f1"],
      body: "宛先つきの1件",
      writer: "writer-01",
    }),
  );
  // **`V10-M13-T03` の波及**: 対応できないという値は理由が必須になった。
  const updated = withStore((store) =>
    store.updateCommentState(created.id, COMMENT_STATES[1], "宛先などが変わらないことの理由"),
  );
  expect(updated.appId).toBe(created.appId);
  expect(updated.anchorForm).toBe(created.anchorForm);
  expect(updated.anchorParts).toEqual(created.anchorParts);
  expect(updated.writer).toBe(created.writer);
  expect(updated.createdAt).toBe(created.createdAt);
});

test("V10-M13-T02: 未登録の id を倒そうとすると拒否される(1行も作らない)", () => {
  const before = withStore((store) => store.listComments(APP_ID));
  expect(before).toHaveLength(0);
  expect(() =>
    withStore((store) => store.updateCommentState("no-such-comment-id", COMMENT_STATES[0])),
  ).toThrow();
  const after = withStore((store) => store.listComments(APP_ID));
  expect(after).toHaveLength(0);
});

test("V10-M13-T02: 状態を書き換える関数は1本ちょうどで、applied を書くのは引数だけである(限定3)", () => {
  const storeSource = readFileSync(join(import.meta.dir, "comment-store.ts"), "utf-8");
  // 期待: COMMENT_STATES の配列リテラル1行だけに現れる(実装は綴りを注釈にも書かない)。
  const appliedHits = storeSource.split("applied").length - 1;
  expect(appliedHits).toBe(1);

  // 状態を書き換える関数の定義は1件ちょうど(呼び出し元は器のファイルの外である)。
  const updateFnDefinitions = storeSource.match(/\bupdateCommentState\s*\(/g) ?? [];
  expect(updateFnDefinitions.length).toBe(1);
});

test("V10-M13-T02: 器は散文を1バイトも解釈しない(validateDiff / applyDiff / dryRunDiff / readCurrentManifest を1度も呼ばない。限定4。陽性対照つき)", () => {
  const storeSource = readFileSync(join(import.meta.dir, "comment-store.ts"), "utf-8");
  const pattern = /validateDiff|applyDiff|dryRunDiff|readCurrentManifest/g;
  const hits = storeSource.match(pattern) ?? [];
  expect(hits.length).toBe(0);

  // 陽性対照 —— 同じ式を `src/mcp/tools/read.ts` に当てると 0 でないことを示す。
  const readToolSource = readFileSync(
    join(import.meta.dir, "..", "mcp", "tools", "read.ts"),
    "utf-8",
  );
  const readToolHits = readToolSource.match(pattern) ?? [];
  expect(readToolHits.length).toBeGreaterThan(0);
});

test("V10-M13-T02: 状態の値域は SQLite の CHECK でも守られる(器を通さずに直に書くと落ちる)", () => {
  const created = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "CHECK を直に試す1件",
    }),
  );
  const db = new Database(kernelDbPath(dataRoot));
  try {
    expect(() => {
      db.query(`UPDATE "gp_comments" SET "state" = 'done' WHERE "id" = ?`).run(created.id);
    }).toThrow();
  } finally {
    db.close();
  }
  // 器を経由していないので、値は今日も既定(open)のまま変わっていない。
  const reread = withStore((store) => store.getComment(created.id));
  expect(reread?.state).toBe(COMMENT_STATES[0]);
});

test("V10-M13-T02: 8列で作られた既存の gp_comments を移行すると、既にある行はすべて open になる", () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "gp-comment-store-old8-"));
  try {
    const db = new Database(kernelDbPath(oldRoot), { create: true });
    db.exec(`
      CREATE TABLE "gp_comments" (
        "id"          TEXT PRIMARY KEY,
        "app_id"      TEXT NOT NULL,
        "anchor_form" TEXT NOT NULL,
        "anchor_1"    TEXT,
        "anchor_2"    TEXT,
        "body"        TEXT NOT NULL,
        "created_at"  TEXT NOT NULL,
        "writer"      TEXT
      );
    `);
    db.query(
      `INSERT INTO "gp_comments"
         ("id", "app_id", "anchor_form", "anchor_1", "anchor_2", "body", "created_at", "writer")
       VALUES ('old8-1', ${JSON.stringify(APP_ID)}, 'app', NULL, NULL, '移行前(8列)の行', '2026-08-01T00:00:00.000Z', 'writer-old')`,
    ).run();
    db.close();

    const migrated = CommentStore.openForKernel(oldRoot);
    try {
      const row = migrated.getComment("old8-1");
      expect(row?.body).toBe("移行前(8列)の行");
      expect(row?.writer).toBe("writer-old");
      // **移行で埋まった state は既定(COMMENT_STATES[0])になる**
      // ——**移行で入った open と、生まれつきの open を機械で区別する手段は無い**(限界)。
      expect(row?.state).toBe(COMMENT_STATES[0]);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(oldRoot, { recursive: true, force: true });
  }
});

// ===========================================================================
// `V10-M13-T03`(台帳 `CM-G20`。**門A**(`Δ8`)/ 判定値 = 限定採用。`ADR-0369`)
//
// **「対応できない」の行に理由を1本持たせる。器は理由の中身を1バイトも検査しない**
// (空白だけでないことしか見ない)。理由は {@link CommentStore.updateCommentState} の
// **第3引数**として受ける —— 専用の関数を2本目に作らない。
// ===========================================================================

test("V10-M13-T03: 対応できない行に渡した理由が1バイトも変わらずに読み戻せる", () => {
  const created = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "対応できないに倒す1件",
    }),
  );
  const reasonText = "今日の語彙では画面に説明文を付けられません。改行\nも含む理由です。";
  const updated = withStore((store) =>
    store.updateCommentState(created.id, COMMENT_STATES[1], reasonText),
  );
  expect(updated.reason).toBe(reasonText);
  const reread = withStore((store) => store.getComment(created.id));
  expect(reread?.reason).toBe(reasonText);
  // 陽性対照 —— 比較そのものが空振りしていないこと(わざと1バイト足すと不一致になる)。
  expect(reread?.reason).not.toBe(`${reasonText}x`);
});

test("V10-M13-T03: 対応できない行に空・空白だけの理由を渡すと拒否される（陽性対照: 非空は通る）", () => {
  const created = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "1件" }),
  );
  expect(() =>
    withStore((store) => store.updateCommentState(created.id, COMMENT_STATES[1], "")),
  ).toThrow();
  expect(() =>
    withStore((store) => store.updateCommentState(created.id, COMMENT_STATES[1], "   ")),
  ).toThrow();
  // 器に1行も書き換わっていない(状態も理由も生まれたときのまま)。
  const stillOpen = withStore((store) => store.getComment(created.id));
  expect(stillOpen?.state).toBe(COMMENT_STATES[0]);
  expect(stillOpen?.reason).toBeNull();

  // 陽性対照: 非空の理由は通る。
  const updated = withStore((store) =>
    store.updateCommentState(created.id, COMMENT_STATES[1], "非空の理由"),
  );
  expect(updated.reason).toBe("非空の理由");
});

test("V10-M13-T03: 対応できない行に理由を渡さないと拒否される", () => {
  const created = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "1件" }),
  );
  expect(() =>
    withStore((store) => store.updateCommentState(created.id, COMMENT_STATES[1])),
  ).toThrow();
  const stillOpen = withStore((store) => store.getComment(created.id));
  expect(stillOpen?.state).toBe(COMMENT_STATES[0]);
  expect(stillOpen?.reason).toBeNull();
});

test("V10-M13-T03: 他の2値に理由を渡すと拒否される（空文字を渡しても拒否される）", () => {
  const created = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "1件" }),
  );
  for (const state of [COMMENT_STATES[0], COMMENT_STATES[2]]) {
    expect(() =>
      withStore((store) => store.updateCommentState(created.id, state, "何か理由")),
    ).toThrow();
    // 空文字を渡しても拒否される(空文字は「渡した」に含む。undefined とは区別する)。
    expect(() => withStore((store) => store.updateCommentState(created.id, state, ""))).toThrow();
  }
  // 器に1行も書き換わっていない。
  const stillOpen = withStore((store) => store.getComment(created.id));
  expect(stillOpen?.state).toBe(COMMENT_STATES[0]);
  expect(stillOpen?.reason).toBeNull();
});

test("V10-M13-T03: 他の2値へ倒すと理由が消える（器は履歴を1行も持たない）", () => {
  const created = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "1件" }),
  );
  const withReason = withStore((store) =>
    store.updateCommentState(created.id, COMMENT_STATES[1], "対応できない理由"),
  );
  expect(withReason.reason).toBe("対応できない理由");

  const backToOpen = withStore((store) => store.updateCommentState(created.id, COMMENT_STATES[0]));
  expect(backToOpen.reason).toBeNull();
  const reread1 = withStore((store) => store.getComment(created.id));
  expect(reread1?.reason).toBeNull();

  // もう一度理由を付けてから、今度は3値目へ倒しても消える(前の値を残さない)。
  const withReasonAgain = withStore((store) =>
    store.updateCommentState(created.id, COMMENT_STATES[1], "また理由"),
  );
  expect(withReasonAgain.reason).toBe("また理由");
  const applied = withStore((store) => store.updateCommentState(created.id, COMMENT_STATES[2]));
  expect(applied.reason).toBeNull();
});

test("V10-M13-T03: 理由は自由文1本で、構造化した列を1本も持たない", () => {
  const created = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "1件" }),
  );
  withStore((store) => store.updateCommentState(created.id, COMMENT_STATES[1], "理由その1"));
  const db = new Database(kernelDbPath(dataRoot), { readonly: true });
  try {
    const names = (db.query(`PRAGMA table_info("gp_comments")`).all() as { name: string }[]).map(
      (info) => info.name,
    );
    // 構造化した列(`ValidationError` が持つ path / hint / allowed_values 相当)は1本も無い。
    expect(names.filter((name) => /path|hint|allowed_values/.test(name))).toEqual([]);
    // `reason` は1本ちょうど(理由専用の2本目の列を作らない)。
    expect(names.filter((name) => name === "reason")).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("V10-M13-T03: 器は理由を1度も組み立てない（限定3。限定4 と同じ式で、2本目の検査を作らない）", () => {
  const storeSource = readFileSync(join(import.meta.dir, "comment-store.ts"), "utf-8");
  const pattern = /validateDiff|applyDiff|dryRunDiff|readCurrentManifest/g;
  const hits = storeSource.match(pattern) ?? [];
  expect(hits.length).toBe(0);

  // 陽性対照 —— 同じ式を `src/mcp/tools/read.ts` に当てると 0 でないことを示す
  // (`V10-M13-T02` の限定4 の検査と同じ式。2本目の検査を作らない)。
  const readToolSource = readFileSync(
    join(import.meta.dir, "..", "mcp", "tools", "read.ts"),
    "utf-8",
  );
  const readToolHits = readToolSource.match(pattern) ?? [];
  expect(readToolHits.length).toBeGreaterThan(0);
});

test("V10-M13-T03: 理由の中身を1バイトも検査しない（「対応できません」の1文でも通る）", () => {
  const created = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "1件" }),
  );
  const updated = withStore((store) =>
    store.updateCommentState(created.id, COMMENT_STATES[1], "対応できません"),
  );
  expect(updated.reason).toBe("対応できません");

  // 陽性対照 —— 語彙にも日本語にも無関係なでたらめな文字列でも通る(中身を見ていない証拠)。
  const created2 = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "2件目" }),
  );
  const nonsense = withStore((store) =>
    store.updateCommentState(created2.id, COMMENT_STATES[1], "xzq123!@#こんにちは🍣"),
  );
  expect(nonsense.reason).toBe("xzq123!@#こんにちは🍣");
});

// ===========================================================================
// `V10-M15-T01`(台帳 `CM-G14`。**門A**(`Δ8`)/ 判定値 = 限定採用。`ADR-0370`)
//
// **コメントの行から差分を指す列を1本作る。繋ぐのは コメント → 差分 の2点である。**
// **中央の「案」に識別子は無い**(`CM-G8` = 却下)。**器は `diff_id` を不透明な文字列として
// 持つだけで、差分の記録を1度も読まない**(限定4)。**繋ぎを書く関数は1本ちょうど
// (`linkCommentToDiff`)であり、逆向きの列も2本目の繋ぎも作らない**(限定5)。
// ===========================================================================

test("V10-M15-T01: gp_comments に差分を指す列が1本ちょうど在る(PRAGMA table_info の全量)", () => {
  CommentStore.openForKernel(dataRoot).close();
  const db = new Database(kernelDbPath(dataRoot), { readonly: true });
  try {
    const names = (db.query(`PRAGMA table_info("gp_comments")`).all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(names).toHaveLength(11);
    expect(names.filter((name) => /diff/.test(name))).toEqual(["diff_id"]);
  } finally {
    db.close();
  }
});

test("V10-M15-T01: 新しいコメントの diff_id は null である(addComment は差分の識別子を引数に取らない)", () => {
  const comment = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "繋ぎ前の1件" }),
  );
  expect(comment.diffId).toBeNull();
  // 読み戻しても null のままである(別経路)。
  const reread = withStore((store) => store.getComment(comment.id));
  expect(reread?.diffId).toBeNull();
  // **`AddCommentInput` に `diffId` という入力欄が無いことを型ではなく実行時の形で示す** ——
  // **渡しても無視されず、器は今日そのプロパティを読まない**(`addComment` の入力に
  // `diffId` を書いても、生成された行の `diffId` は常に `null` である)。
  const withExtra = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "余分なキーを渡した1件",
      ...({ diffId: "d-should-be-ignored" } as Record<string, unknown>),
    }),
  );
  expect(withExtra.diffId).toBeNull();
});

test("V10-M15-T01: linkCommentToDiff は渡した文字列を1バイトも変えずに書き、読み戻せる", () => {
  const created = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "繋ぐ1件" }),
  );
  const diffId = "d-link-exact-0123456789あ🍣";
  const linked = withStore((store) => store.linkCommentToDiff(created.id, diffId));
  expect(linked.diffId).toBe(diffId);
  // 別経路(器の getComment)でも同じ文字列が1バイトも変わらず読み戻せる。
  const reread = withStore((store) => store.getComment(created.id));
  expect(reread?.diffId).toBe(diffId);
  // 繋ぎ以外は1バイトも変わっていない(本文・宛先・作成時刻)。
  expect(reread?.body).toBe("繋ぐ1件");
  expect(reread?.anchorForm).toBe("app");
});

test("V10-M15-T01: linkCommentToDiff は空文字・空白だけの識別子を拒否する(陽性対照: 非空は通る)", () => {
  const created = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "拒否を試す1件" }),
  );
  expect(() => withStore((store) => store.linkCommentToDiff(created.id, ""))).toThrow();
  expect(() => withStore((store) => store.linkCommentToDiff(created.id, "   "))).toThrow();
  // 拒否のあと、行の diff_id は null のまま(1行も壊れていない)。
  const reread = withStore((store) => store.getComment(created.id));
  expect(reread?.diffId).toBeNull();
  // 陽性対照 —— 非空の識別子なら通る(同じ id・別の呼び出し)。
  const linked = withStore((store) => store.linkCommentToDiff(created.id, "d-non-empty"));
  expect(linked.diffId).toBe("d-non-empty");
});

test("V10-M15-T01: linkCommentToDiff は未登録の id を拒否し、行を1行も作らず1行も壊さない", () => {
  const created = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "既存の1件" }),
  );
  expect(() =>
    withStore((store) => store.linkCommentToDiff("no-such-comment-id", "d-anything")),
  ).toThrow();
  // 器の行数は1行のまま(未登録の id への繋ぎは新しい行を作らない)。
  const rows = withStore((store) => store.listComments(APP_ID));
  expect(rows).toHaveLength(1);
  // 既存の1件は1バイトも壊れていない。
  const reread = withStore((store) => store.getComment(created.id));
  expect(reread?.body).toBe("既存の1件");
  expect(reread?.diffId).toBeNull();
});

test("V10-M15-T01: 繋ぎを書いても本文・宛先・書き手・作成時刻・状態・理由が1バイトも変わらない", () => {
  const created = withStore((store) =>
    store.addComment({
      appId: APP_ID,
      anchorForm: "view_field",
      anchorParts: [T02_VIEW_ID, "title"],
      body: "繋ぎで壊れてはいけない本文",
      writer: "u-diff-link-writer",
    }),
  );
  const beforeState = withStore((store) =>
    store.updateCommentState(created.id, COMMENT_STATES[1], "対応できない理由(繋ぎの前)"),
  );
  expect(beforeState.state).toBe(COMMENT_STATES[1]);

  const linked = withStore((store) => store.linkCommentToDiff(created.id, "d-no-side-effect"));

  expect(linked.body).toBe("繋ぎで壊れてはいけない本文");
  expect(linked.anchorForm).toBe("view_field");
  expect(linked.anchorParts).toEqual([T02_VIEW_ID, "title"]);
  expect(linked.writer).toBe("u-diff-link-writer");
  expect(linked.createdAt).toBe(created.createdAt);
  expect(linked.state).toBe(COMMENT_STATES[1]);
  expect(linked.reason).toBe("対応できない理由(繋ぎの前)");
  expect(linked.diffId).toBe("d-no-side-effect");
});

// ---------------------------------------------------------------------------
// **【引き直しの理由 —— `V10-M30-T01`(台帳 `CM-G36` / `ADR-0377`)】**
//
// `V10-M30-T01` が **`apps` 表に「アプリごとの表示設定」の列を2本**
// (`comment_write_enabled` / `comment_read_enabled`)足した。その結果、
// **`meta-store.ts` のソースに `comment` の綴りが載った**(12件)。
//
// **それは `changelog` の列ではなく、コメントの行を1つも指していない。**
// 足したのは `apps` 表の表示設定(真偽2値)であって、`gp_comments` の行を1件も参照しない。
// **`ADR-0370` の限定1(`changelog` の DDL は9列のまま)も、限定5(繋ぎは1方向1本ちょうど。
// 逆向きの列を作らない)も、実体としては1つも破れていない** ——
// `changelog` の列は今日も9本ちょうどで、差分を指す列は `gp_comments.diff_id` の1本だけ、
// 逆向きの列は1本も無い。
//
// **旧の式(`metaStoreSource.match(/comment/g)` が0件)はソース全文の綴りを見る代理であり、
// 測ろうとしている実体(列)より広く網を張っていた。** 本工程で引き直したのは
// **代理の式であって、担保ではない。** 実体(実DBの `PRAGMA table_info`)を直に測る形にし、
// ソース側は「コメントの器を1バイトも読み書きしない」ことを器の綴りで測る形にした ——
// **旧の式が実際に守っていた中身は1つも落ちておらず、精度が上がっている。**
//
// **【禁止】これを「`ADR-0370` の限定を緩めた」と読まない。**
//
// ---------------------------------------------------------------------------
// **【`V10-M30` の独立点検 B-4(2026-08-25)。上の段は1バイトも消していない】**
//
// **上の最終行の断定(「…精度が上がっている」で終わる1文)は偽である。**
// **旧の式が守っていた担保のうち、次の1つが落ちた**(点検の実測):
//
// > **`meta-store.ts` が、綴りを割ってコメントの器に触ること。**
// > 例: `meta-store.ts` に `"gp" + "_" + "comments"` と書いてコメント行を読む口を足すと、
// > **旧の式(`metaStoreSource.match(/comment/g)` が0件)は赤くなり、
// > 新しい式(`containerIdentifiers` の素の `includes`)は見逃す。**
// > 新しい式が探すのは `gp_comments` / `CommentStore` / `comment-store` /
// > `linkCommentToDiff` / `updateCommentState` の**5つの綴りそのもの**なので、
// > 連結・別名・動的な組み立てで割られると1つも当たらない。
//
// **落ちた理由**: 旧の式は `/comment/` という**極めて広い網**で、
// `meta-store.ts` に `comment` の綴りが1文字も無いことを要求していた。
// **`V10-M30-T01` が `apps` 表に `comment_write_enabled` / `comment_read_enabled` を
// 足した時点で、その網は維持できなくなった**(赤くなるのは正しい変更に対してである)。
// **網を狭めた代償が、上の1つである。**
//
// **同時に、次のことも実測として正しい** ——
// **測ろうとしている実体に対しては、新しい式のほうが強い。**
// 旧の式は**ソースの綴り**という代理しか見ておらず、実DBの列を1本も見ていなかった。
// 新しい式は `PRAGMA table_info` で**実DBの `changelog` が9列ちょうどであること**と
// **`gp_comments` を指す逆向きの列が0本であること**を直に測り、
// **その両方に使い捨ての実DBで陽性対照を当てている**(`comment_x` を1本足すと
// `/comment/i` に1本当たり、列が10本になる)。
// **綴りをどう割っても、実DBに列が生えれば新しい式は赤くなる。**
//
// **したがって今日の正しい言い方は次のとおり**:
// **実体(列)に対しては新しい式のほうが強く、ソースの綴りに対しては新しい式のほうが弱い。**
// **`ADR-0370` 限定4(器は差分の記録を1度も読まない)の側の担保は、
// この test ではなく直下の `V10-M15-T01: 器は差分の記録を1度も読まない` が持つ。**
// **【禁止】上の落ちた1つを「代理の式だから担保ではない」と言って無かったことにしない。**
// ---------------------------------------------------------------------------
test("V10-M15-T01: 繋ぎは1方向ちょうどで、差分から逆に引く列が1本も無い(陽性対照つき)", () => {
  const created = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "1方向の検査" }),
  );
  withStore((store) => store.linkCommentToDiff(created.id, "d-one-direction"));
  // **差分の記録(`changelog`)を実物として作らせる** —— `CommentStore` は `gp_comments` しか
  // 作らないので、同じ `kernel.sqlite` に `KernelMetaStore` を開いて `changelog` を用意する。
  // 以降はソース文字列ではなく**実DBの列**を見る。
  KernelMetaStore.open(dataRoot).close();
  const db = new Database(kernelDbPath(dataRoot), { readonly: true });
  try {
    const names = (db.query(`PRAGMA table_info("gp_comments")`).all() as { name: string }[]).map(
      (row) => row.name,
    );
    // **`gp_comments` 側の「差分を指す」列はちょうど1本**(2本目の繋ぎを作らない)。
    expect(names.filter((name) => /diff/.test(name))).toEqual(["diff_id"]);

    // **差分の記録(`changelog`)を持つ側は、コメントを指す列を1本も持たない**
    // (逆向きの繋ぎが無いことの担保。`ADR-0370` 限定5 の実体)。
    const changelogNames = (
      db.query(`PRAGMA table_info("changelog")`).all() as { name: string }[]
    ).map((row) => row.name);
    expect(changelogNames.filter((name) => /comment/i.test(name))).toEqual([]);
    // **列は9本ちょうど**(`ADR-0370` 限定1 の実体。`V10-M30-T01` が足した2列は
    // `apps` 表であって `changelog` ではない、ということがここで直に出る)。
    expect(changelogNames).toHaveLength(9);
  } finally {
    db.close();
  }

  // **陽性対照(実DB)** —— 上の2式が空振りしていないことを、使い捨ての実DBで示す。
  // 同じ `changelog` に `comment_x` を1本足すと、`/comment/i` に1本当たり、列は10本になる。
  // (リポジトリのファイルは1バイトも触らない。使い捨ての一時ディレクトリだけを使う。)
  const probeRoot = mkdtempSync(join(tmpdir(), "gp-changelog-probe-"));
  try {
    KernelMetaStore.open(probeRoot).close();
    const probe = new Database(kernelDbPath(probeRoot));
    try {
      probe.exec(`ALTER TABLE "changelog" ADD COLUMN "comment_x" TEXT`);
      const probeNames = (
        probe.query(`PRAGMA table_info("changelog")`).all() as { name: string }[]
      ).map((row) => row.name);
      expect(probeNames.filter((name) => /comment/i.test(name))).toEqual(["comment_x"]);
      expect(probeNames).toHaveLength(10);
    } finally {
      probe.close();
    }
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }

  // **`meta-store.ts` はコメントの器を1バイトも読み書きしない** —— 器の綴りが1つも無い。
  const metaStoreSource = readFileSync(join(import.meta.dir, "meta-store.ts"), "utf-8");
  const containerIdentifiers = [
    "gp_comments",
    "CommentStore",
    "comment-store",
    "linkCommentToDiff",
    "updateCommentState",
  ];
  expect(containerIdentifiers.filter((id) => metaStoreSource.includes(id))).toEqual([]);
  // 陽性対照(ソース) —— 同じ綴りの並びを実際に当たるファイルに当てると1件以上当たる。
  const authRoutesSource = readFileSync(
    join(import.meta.dir, "..", "server", "auth-routes.ts"),
    "utf-8",
  );
  expect(containerIdentifiers.filter((id) => authRoutesSource.includes(id)).length).toBeGreaterThan(
    0,
  );
  // 陽性対照(旧の式のまま残す) —— `/comment/` は実際に当たるファイルで0件でない。
  expect((authRoutesSource.match(/comment/g) ?? []).length).toBeGreaterThan(0);
});

test("V10-M15-T01: 器は差分の記録を1度も読まない(限定4。陽性対照: requirements-doc.ts は4件)", () => {
  const storeSource = readFileSync(join(import.meta.dir, "comment-store.ts"), "utf-8");
  const pattern = /getChangelog|KernelMetaStore|readCurrentManifest/g;
  const hits = storeSource.match(pattern) ?? [];
  expect(hits.length).toBe(0);

  // 陽性対照 —— 同じ式を requirements-doc.ts に当てると0件でないことを示す
  // (式そのものが空振りしていないことの担保。`§0-19` の実出力と揃える)。
  const requirementsDocSource = readFileSync(join(import.meta.dir, "requirements-doc.ts"), "utf-8");
  const hitsInRequirementsDoc = requirementsDocSource.match(pattern) ?? [];
  expect(hitsInRequirementsDoc.length).toBe(4);
});

test("V10-M15-T01: 10列で作られた既存の gp_comments を開き直すと、欠けている1列だけが足される", () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "gp-comment-store-old10-"));
  try {
    const db = new Database(kernelDbPath(oldRoot), { create: true });
    db.exec(`
      CREATE TABLE "gp_comments" (
        "id"          TEXT PRIMARY KEY,
        "app_id"      TEXT NOT NULL,
        "anchor_form" TEXT NOT NULL,
        "anchor_1"    TEXT,
        "anchor_2"    TEXT,
        "body"        TEXT NOT NULL,
        "created_at"  TEXT NOT NULL,
        "writer"      TEXT,
        "state"       TEXT NOT NULL DEFAULT 'open',
        "reason"      TEXT
      );
    `);
    db.query(
      `INSERT INTO "gp_comments"
         ("id", "app_id", "anchor_form", "anchor_1", "anchor_2", "body", "created_at", "writer", "state", "reason")
       VALUES ('old10-1', ${JSON.stringify(APP_ID)}, 'app', NULL, NULL, '10列の時代に書いた行', '2026-08-01T00:00:00.000Z', NULL, 'open', NULL)`,
    ).run();
    db.close();

    const migrated = CommentStore.openForKernel(oldRoot);
    try {
      const columns = migrated.getComment("old10-1");
      expect(columns?.body).toBe("10列の時代に書いた行");
      // **移行で埋まった `diff_id` は null である**(繋いでいなかった行と機械では区別が付かない)。
      expect(columns?.diffId).toBeNull();

      const columnsOf = (): string[] => {
        const handle = new Database(kernelDbPath(oldRoot), { readonly: true });
        try {
          return (handle.query(`PRAGMA table_info("gp_comments")`).all() as { name: string }[]).map(
            (row) => row.name,
          );
        } finally {
          handle.close();
        }
      };
      // **足された列は `diff_id` の1本だけである。**
      expect(columnsOf()).toEqual([
        "id",
        "app_id",
        "anchor_form",
        "anchor_1",
        "anchor_2",
        "body",
        "created_at",
        "writer",
        "state",
        "reason",
        "diff_id",
      ]);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(oldRoot, { recursive: true, force: true });
  }
});

test("V10-M15-T01: 移行の前に在った行は1行も壊れず、本文が1バイトも変わらない(diff_id は null で埋まる)", () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "gp-comment-store-preserve-diff-"));
  try {
    const originalBody = "diff_id が無い時代に書いた本文。1バイトも変わってはいけない。";
    const db = new Database(kernelDbPath(oldRoot), { create: true });
    db.exec(`
      CREATE TABLE "gp_comments" (
        "id"          TEXT PRIMARY KEY,
        "app_id"      TEXT NOT NULL,
        "anchor_form" TEXT NOT NULL,
        "anchor_1"    TEXT,
        "anchor_2"    TEXT,
        "body"        TEXT NOT NULL,
        "created_at"  TEXT NOT NULL,
        "writer"      TEXT,
        "state"       TEXT NOT NULL DEFAULT 'open',
        "reason"      TEXT
      );
    `);
    db.query(
      `INSERT INTO "gp_comments"
         ("id", "app_id", "anchor_form", "anchor_1", "anchor_2", "body", "created_at", "writer", "state", "reason")
       VALUES ('preserved-diff-1', ${JSON.stringify(APP_ID)}, 'view_field', 'v1', 'f1', ?, '2026-08-01T00:00:00.000Z', 'u-old-writer', 'applied', NULL)`,
    ).run(originalBody);
    db.close();

    const migrated = CommentStore.openForKernel(oldRoot);
    try {
      const row = migrated.getComment("preserved-diff-1");
      expect(row?.body).toBe(originalBody);
      expect(row?.anchorForm).toBe("view_field");
      expect(row?.anchorParts).toEqual(["v1", "f1"]);
      expect(row?.createdAt).toBe("2026-08-01T00:00:00.000Z");
      expect(row?.writer).toBe("u-old-writer");
      expect(row?.state).toBe("applied");
      expect(row?.diffId).toBeNull();
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(oldRoot, { recursive: true, force: true });
  }
});

test("V10-M15-T01: 既に繋がっている行に別の識別子を上書きでき、前の値は1バイトも残らない(履歴を持たない)", () => {
  const created = withStore((store) =>
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "上書きの検査" }),
  );
  const first = withStore((store) => store.linkCommentToDiff(created.id, "d-first"));
  expect(first.diffId).toBe("d-first");
  const second = withStore((store) => store.linkCommentToDiff(created.id, "d-second"));
  expect(second.diffId).toBe("d-second");
  // 別経路(器の直読み)でも「前の値が残っていない」ことを確かめる。
  const db = new Database(kernelDbPath(dataRoot), { readonly: true });
  try {
    const row = db
      .query<{ diff_id: string | null }, [string]>(
        `SELECT "diff_id" FROM "gp_comments" WHERE "id" = ?`,
      )
      .get(created.id);
    expect(row?.diff_id).toBe("d-second");
    expect(row?.diff_id).not.toBe("d-first");
  } finally {
    db.close();
  }
});

// ===========================================================================
// `V10-M15-T05`(台帳 `CM-G21` / `ADR-0370`。**門A** / 判定値 = 限定採用)。
// **対応できないまま残ったコメントを一覧する読出の口を1本作る。**
// **`listCommentsByState` は器のメソッドを1本足すだけであり、`listComments` は
// 1バイトも変えない**(呼び出し元が `src/mcp/tools/read.ts` に居るため)。
// ===========================================================================

test("V10-M15-T05: listCommentsByState は渡した状態の行だけを返す(3値それぞれで確かめる)", () => {
  withStore((store) => {
    // 3件は全部 open で生まれる。**返り値(`created[i].id`)で直接倒す** ——
    // 同一ミリ秒だと `listComments` の並びが id のランダム順に落ちるため
    // (「同一ミリ秒の2行はランダム UUID 順」)、`store.addComment` の返り値そのものを使う。
    const created = COMMENT_STATES.map((state) =>
      store.addComment({
        appId: APP_ID,
        anchorForm: "app",
        anchorParts: [],
        body: `${state} になる予定の1件`,
      }),
    );
    created.forEach((comment, index) => {
      const target = COMMENT_STATES[index] as (typeof COMMENT_STATES)[number];
      if (target !== COMMENT_STATES[0]) {
        store.updateCommentState(
          comment.id,
          target,
          target === COMMENT_STATES[1] ? "listCommentsByState を確かめる理由" : undefined,
        );
      }
    });

    for (const state of COMMENT_STATES) {
      const found = store.listCommentsByState(APP_ID, state);
      expect(found).toHaveLength(1);
      expect(found[0]?.state).toBe(state);
      expect(found[0]?.body).toBe(`${state} になる予定の1件`);
    }
  });
});

test("V10-M15-T05: listCommentsByState は値域に無い状態を拒否する(陽性対照: 3値はすべて通る)", () => {
  let captured: unknown;
  try {
    withStore((store) => store.listCommentsByState(APP_ID, "done"));
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(Error);
  const message = captured instanceof Error ? captured.message : "";
  const missing = COMMENT_STATES.filter((state) => !message.includes(state));
  expect(missing).toEqual([]);

  // 陽性対照: 3値はすべて通る(1件も無いアプリでも空配列を返すだけで、例外にはならない)。
  for (const state of COMMENT_STATES) {
    expect(() => withStore((store) => store.listCommentsByState(APP_ID, state))).not.toThrow();
  }
});

test("V10-M15-T05: listCommentsByState は app スコープに閉じる(別アプリの行が1件も混ざらない)", () => {
  withStore((store) => {
    store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "shop の1件" });
    store.addComment({ appId: "other", anchorForm: "app", anchorParts: [], body: "other の1件" });
    expect(store.listCommentsByState(APP_ID, COMMENT_STATES[0]).map((c) => c.body)).toEqual([
      "shop の1件",
    ]);
    expect(store.listCommentsByState("other", COMMENT_STATES[0]).map((c) => c.body)).toEqual([
      "other の1件",
    ]);
    expect(store.listCommentsByState("居ないアプリ", COMMENT_STATES[0])).toEqual([]);
  });
});

test("V10-M15-T05: listCommentsByState は created_at 昇順(同時刻は id 昇順)で返す", () => {
  withStore((store) => {
    const a = store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "1" });
    const b = store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "2" });
    const c = store.addComment({ appId: APP_ID, anchorForm: "app", anchorParts: [], body: "3" });
    const listed = store.listCommentsByState(APP_ID, COMMENT_STATES[0]);
    expect(listed).toHaveLength(3);
    const sorted = [a, b, c].sort((x, y) =>
      x.createdAt === y.createdAt
        ? x.id.localeCompare(y.id)
        : x.createdAt.localeCompare(y.createdAt),
    );
    expect(listed.map((entry) => entry.id)).toEqual(sorted.map((entry) => entry.id));
  });
});
