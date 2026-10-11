/**
 * **宣言で有効にする変更履歴の語彙と、適用時の拒否 —— `table.history`・`detail_view.history`**
 * (`V23-M8-T01`。門A = `ADR-0504`(`SC-G23`)を補う `ADR-0544`。決定 `D-V23-205`、
 * 計画 §27-3 の T01 と §27-6 軽7。授権 `ADR-0545`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **測るもの**:
 * 1. **設計図の形** —— `$defs/table` の7本目と `table_changes` の6本目に `history`(真偽値)。
 *    `$defs/view` の35本目と `view_changes` の31本目に `history`(真偽値)。 `list_view`・`form`・`report_view`
 *    の分岐は `false` で閉じる。 **新しい `$defs` は作らない。** 差分側は manifest 側の定義を `$ref` する。
 * 2. **受け入れ** —— 表と詳細画面に書いた定義が通る。 `list_view`・`form`・`report_view` に書くと断る。
 * 3. **適用時の拒否2形**(`D-V23-205`) —— 詳細画面の `history: true` なのに表が宣言していない /
 *    後から来る差分で、`history: true` の詳細画面が残っている表の `history` を外す。
 *    **文面は「先に画面の history を外す」を伝える。** 断られたとき定義は1バイトも動かない。
 * 4. **差分の経路** —— 同じ差分で表と画面を同時に足す・外す(順序を問わない)。 `update_view` だけで足す。
 *    `change_table` で足す・外す。 値は適用後の定義に残る。
 * 5. **陰性対照** —— `history` を書かない定義の検査結果は今日どおり(通り、適用後の定義に `history` が現れない)。
 *
 * **測らないもの(誇張しない)**: 記録の書込(`T03`)。 追記だけ(`T04`)。 閲覧権(`T05`)。 undo(`T06`)。
 * 画面(`T07`)。 MCP の道具と要件ドキュメントの文(`T08`)。 生成器(`T10`)。
 * `remove_table` で宣言ごと消えると前の履歴が読めなくなることは説明書の文で伝える(検査は `T04`)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import type { Manifest } from "./types.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

const DEFS = "$defs";
const M = (manifestSchema as unknown as Any)[DEFS] as Any;
const D = (diffSchema as unknown as Any)[DEFS] as Any;

const APP_ID = "rh-vocab";
/** 拒否の文面(ヒント)が伝える「先に画面の history を外す」の目印。 */
const HINT_MARK = "の history を外して";

type Options = {
  /** 案件の表(`tables/0`)の `history`。 `undefined` なら書かない。 */
  tableHistory?: unknown;
  /** 詳細画面(`views/1`)の `history`。 `undefined` なら書かない。 */
  detailHistory?: unknown;
  /** 一覧・入力・集計表に書く `history`(`{ list: true }` の形。書かなければ書かない)。 */
  others?: { list?: unknown; form?: unknown; report?: unknown };
};

function manifestWith(options: Options = {}): Manifest {
  const others = options.others ?? {};
  const put = (value: unknown) => (value === undefined ? {} : { history: value });
  return {
    app: {
      id: APP_ID,
      name: "変更履歴の語彙",
      tables: [
        {
          id: "cases",
          name: "案件",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "state", name: "状態", type: "select", options: ["open", "closed"] },
          ],
          ...put(options.tableHistory),
        },
        { id: "notes", name: "メモ", fields: [{ id: "body", name: "本文", type: "text" }] },
      ],
      views: [
        {
          id: "case-list",
          type: "list_view",
          table: "cases",
          columns: ["title", "state"],
          ...put(others.list),
        },
        {
          id: "case-detail",
          type: "detail_view",
          table: "cases",
          fields: ["title", "state"],
          ...put(options.detailHistory),
        },
        {
          id: "case-form",
          type: "form",
          table: "cases",
          fields: ["title", "state"],
          ...put(others.form),
        },
        {
          id: "case-report",
          type: "report_view",
          table: "cases",
          report: { group_by: [{ field: "state" }], aggregates: [{ type: "count" }] },
          ...put(others.report),
        },
      ],
    },
  } as unknown as Manifest;
}

function errorsOf(result: { valid: boolean; errors?: ValidationError[] }): ValidationError[] {
  return result.valid ? [] : (result.errors ?? []);
}

/** 罠の汎用文(英語の既定文・`anyOf` の言い訳)と内部記号を1つも含まないこと。 */
function expectPlainJapanese(errors: ValidationError[]): void {
  const text = JSON.stringify(errors);
  expect(text).not.toContain("must ");
  expect(text).not.toContain("anyOf");
  expect(text).not.toContain("詳細不明");
  expect(text).not.toMatch(/ADR-|D-V\d|V\d+-M\d|SC-G|H-V\d/);
}

/** `path` ちょうどの誤りを1つ取り出す(無ければ全体を見せて落ちる)。 */
function hitAt(result: { valid: boolean; errors?: ValidationError[] }, path: string) {
  expect(result.valid).toBe(false);
  const hit = errorsOf(result).find((error) => error.path === path);
  expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
  expectPlainJapanese(hit === undefined ? [] : [hit]);
  return hit as ValidationError;
}

function propertiesOf(def: unknown): Any {
  return ((def as Any)?.properties ?? {}) as Any;
}

// ---------------------------------------------------------------------------------------
// (S) 設計図の形
// ---------------------------------------------------------------------------------------

describe("(S) 設計図の形", () => {
  test("(S-1) $defs/table の7本目が history(真偽値)", () => {
    const keys = Object.keys(propertiesOf(M.table));
    expect(keys).toHaveLength(7);
    expect(keys[6]).toBe("history");
    expect((propertiesOf(M.table).history as Any)?.type).toBe("boolean");
    expect((M.table as Any).required).not.toContain("history");
  });

  test("(S-2) table_changes の6本目が history で、manifest 側の定義を $ref する", () => {
    const keys = Object.keys(propertiesOf(D.table_changes));
    expect(keys).toHaveLength(6);
    expect(keys[5]).toBe("history");
    expect((propertiesOf(D.table_changes).history as Any)?.$ref).toBe(
      "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/table/properties/history",
    );
  });

  test("(S-3) $defs/view の35本目が history(真偽値)", () => {
    const keys = Object.keys(propertiesOf(M.view));
    expect(keys).toHaveLength(35);
    expect(keys[34]).toBe("history");
    expect((propertiesOf(M.view).history as Any)?.type).toBe("boolean");
  });

  test("(S-4) view_changes の31本目が history で、manifest 側の定義を $ref する", () => {
    const keys = Object.keys(propertiesOf(D.view_changes));
    expect(keys).toHaveLength(31);
    expect(keys[30]).toBe("history");
    expect((propertiesOf(D.view_changes).history as Any)?.$ref).toBe(
      "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/view/properties/history",
    );
  });

  test("(S-5) list_view・form・report_view の分岐は history を false で閉じ、detail_view の分岐は閉じない", () => {
    const branches = ((M.view as Any).allOf ?? []) as Any[];
    const closed: Record<string, unknown> = {};
    for (const branch of branches) {
      const type = (propertiesOf((branch as Any).if).type as Any | undefined)?.const;
      if (typeof type !== "string") continue;
      closed[type] = propertiesOf((branch as Any).then).history;
    }
    expect(closed).toEqual({
      list_view: false,
      form: false,
      detail_view: undefined,
      report_view: false,
    });
  });

  test("(S-6) $defs の名前は増えていない(manifest 31・diff 5)", () => {
    expect(Object.keys(M).length).toBe(31);
    expect(Object.keys(D).length).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------
// (A) 受け入れ
// ---------------------------------------------------------------------------------------

describe("(A) 受け入れ", () => {
  test("(A-1) 表と詳細画面の両方に history: true を書いた定義は通る", () => {
    const result = validateManifestFull(manifestWith({ tableHistory: true, detailHistory: true }));
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("(A-2) 表だけに書いた定義は通る(画面に出さなくても記録は残せる)。false も書ける", () => {
    for (const options of [
      { tableHistory: true },
      { tableHistory: false },
      { tableHistory: true, detailHistory: false },
    ]) {
      const result = validateManifestFull(manifestWith(options));
      expect(errorsOf(result), JSON.stringify(options)).toEqual([]);
    }
  });

  test.each([
    ["一覧", { list: true }, 0],
    ["入力フォーム", { form: true }, 2],
    ["集計表", { report: true }, 3],
  ])(
    "(A-3) %s に history を書くと断られる(その画面を指し、history の名を出す)",
    (_label, others, index) => {
      const result = validateManifestFull(manifestWith({ tableHistory: true, others }));
      expect(result.valid).toBe(false);
      const hits = errorsOf(result).filter(
        (error) =>
          (error.path === `/app/views/${index}` || error.path === `/app/views/${index}/history`) &&
          error.message.includes('"history"'),
      );
      expect(hits.length, JSON.stringify(errorsOf(result))).toBe(1);
      expectPlainJapanese(hits);
      // 詳細画面だけが書ける —— 同じ定義で詳細画面には誤りが出ない(表が宣言しているので)。
      expect(errorsOf(result).some((error) => error.path.startsWith("/app/views/1"))).toBe(false);
    },
  );

  test("(A-4) 真偽値でない値は断られる", () => {
    for (const options of [{ tableHistory: "yes" }, { tableHistory: true, detailHistory: 1 }]) {
      const result = validateManifestFull(manifestWith(options));
      expect(result.valid, JSON.stringify(options)).toBe(false);
      expect(
        errorsOf(result).some((error) => error.path.endsWith("/history")),
        JSON.stringify(errorsOf(result)),
      ).toBe(true);
    }
  });

  test("(A-5) 差分の設計図: change_table と update_view の changes に history を書ける", () => {
    const result = validateDiff({
      diff_id: "rh-a5",
      intent: "案件の変更履歴を残して詳細画面に出す",
      operations: [
        { op: "change_table", table: "cases", changes: { history: true } },
        { op: "update_view", view: "case-detail", changes: { history: true } },
      ],
    });
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// (R) 適用時の拒否(定義全体を見る形)
// ---------------------------------------------------------------------------------------

describe("(R) 適用時の拒否", () => {
  test("(R-1) 詳細画面に history: true を書いたのに表が宣言していないと断る(表に書いていない・false)", () => {
    for (const tableHistory of [undefined, false]) {
      const hit = hitAt(
        validateManifestFull(manifestWith({ tableHistory, detailHistory: true })),
        "/app/views/1/history",
      );
      expect(hit.message).toContain('"case-detail"');
      expect(hit.message).toContain('"cases"');
      expect(hit.hint ?? "").toContain(HINT_MARK);
    }
  });
});

// ---------------------------------------------------------------------------------------
// (N) 陰性対照: history を書かない定義
// ---------------------------------------------------------------------------------------

describe("(N) 陰性対照", () => {
  test("(N-1) history を書かない定義は今日どおり通る", () => {
    const result = validateManifestFull(manifestWith());
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("(N-2) history を書かない定義の誤りは、history の誤りを1つも含まない(今日の誤りのまま)", () => {
    const broken = manifestWith() as unknown as { app: { views: Any[] } };
    (broken.app.views[1] as Any).fields = ["no_such_field"];
    const errors = errorsOf(validateManifestFull(broken as unknown as Manifest));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((error) => error.path.includes("history"))).toBe(false);
    expect(JSON.stringify(errors)).not.toContain("history");
  });
});

// ---------------------------------------------------------------------------------------
// (G) 差分の経路
// ---------------------------------------------------------------------------------------

function diffOf(operations: unknown[], diffId: string): unknown {
  return { diff_id: diffId, intent: "変更履歴の宣言", operations };
}

async function freshApp(initial: Manifest): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-record-history-vocab-"));
  const store = KernelMetaStore.open(dataRoot);
  createApp(store, "変更履歴の語彙", { app_id: APP_ID });
  store.close();
  const applied = applyManifest(dataRoot, APP_ID, initial);
  if (!applied.valid) {
    throw new Error(`テスト前提の初期マニフェスト投入に失敗しました: ${JSON.stringify(applied)}`);
  }
  return dataRoot;
}

type Current = {
  app: { tables: { id: string; history?: unknown }[]; views: { id: string; history?: unknown }[] };
};

describe("(G) 差分の経路", () => {
  let dataRoot: string | undefined;

  afterEach(async () => {
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
      dataRoot = undefined;
    }
  });

  function current(): Current {
    return readCurrentManifest(dataRoot as string, APP_ID) as unknown as Current;
  }
  function tableHistory(): unknown {
    return current().app.tables.find((table) => table.id === "cases")?.history;
  }
  function viewHistory(id = "case-detail"): unknown {
    return current().app.views.find((view) => view.id === id)?.history;
  }

  function applied(operations: unknown[], diffId: string): void {
    const result = applyDiff(dataRoot as string, APP_ID, diffOf(operations, diffId));
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  }

  /** 断られ、定義が動かず、詳細画面の history の位置に「先に画面の history を外す」の文面が出ること。 */
  function refusedAtView(operations: unknown[], diffId: string): void {
    const before = JSON.stringify(current());
    const result = applyDiff(dataRoot as string, APP_ID, diffOf(operations, diffId));
    expect(result.valid).toBe(false);
    expect(JSON.stringify(current())).toBe(before);
    const hits = errorsOf(result).filter((error) => error.path === "/app/views/1/history");
    expect(hits.length, JSON.stringify(errorsOf(result))).toBeGreaterThan(0);
    expectPlainJapanese(hits);
    expect(hits.some((error) => (error.hint ?? "").includes(HINT_MARK))).toBe(true);
  }

  describe("宣言の無いアプリから", () => {
    beforeEach(async () => {
      dataRoot = await freshApp(manifestWith());
    });

    test("(G-1) change_table で表に足すと、値が適用後の定義に残る", () => {
      applied([{ op: "change_table", table: "cases", changes: { history: true } }], "rh-g1");
      expect(tableHistory()).toBe(true);
      expect(viewHistory()).toBeUndefined();
    });

    test("(G-2) 同じ差分で表と画面を同時に足せる(画面を先に書いても通る)", () => {
      applied(
        [
          { op: "update_view", view: "case-detail", changes: { history: true } },
          { op: "change_table", table: "cases", changes: { history: true } },
        ],
        "rh-g2",
      );
      expect(tableHistory()).toBe(true);
      expect(viewHistory()).toBe(true);
    });

    test("(G-3) 表が宣言していないのに update_view だけで画面に足すと断られる", () => {
      refusedAtView(
        [{ op: "update_view", view: "case-detail", changes: { history: true } }],
        "rh-g3",
      );
    });

    test("(G-4) add_table と add_view で、表と詳細画面を同じ差分で足せる", () => {
      applied(
        [
          {
            op: "add_table",
            table: {
              id: "tickets",
              name: "問合せ",
              fields: [{ id: "subject", name: "件名", type: "text" }],
              history: true,
            },
          },
          {
            op: "add_view",
            view: {
              id: "ticket-detail",
              type: "detail_view",
              table: "tickets",
              fields: ["subject"],
              history: true,
            },
          },
        ],
        "rh-g4",
      );
      expect(current().app.tables.find((table) => table.id === "tickets")?.history).toBe(true);
      expect(viewHistory("ticket-detail")).toBe(true);
    });

    test("(G-5) update_view で一覧に history を書くと断られる(詳細画面だけ)", () => {
      const before = JSON.stringify(current());
      const result = applyDiff(
        dataRoot as string,
        APP_ID,
        diffOf(
          [
            { op: "change_table", table: "cases", changes: { history: true } },
            { op: "update_view", view: "case-list", changes: { history: true } },
          ],
          "rh-g5",
        ),
      );
      expect(result.valid).toBe(false);
      expect(JSON.stringify(current())).toBe(before);
    });
  });

  describe("表だけが宣言したアプリから", () => {
    beforeEach(async () => {
      dataRoot = await freshApp(manifestWith({ tableHistory: true }));
    });

    test("(G-6) update_view だけで詳細画面に足せる", () => {
      applied([{ op: "update_view", view: "case-detail", changes: { history: true } }], "rh-g6");
      expect(viewHistory()).toBe(true);
      expect(tableHistory()).toBe(true);
    });

    test("(G-7) 画面が無ければ change_table で表の history を外せる(false が残る)", () => {
      applied([{ op: "change_table", table: "cases", changes: { history: false } }], "rh-g7");
      expect(tableHistory()).toBe(false);
    });
  });

  describe("表と詳細画面が宣言したアプリから", () => {
    beforeEach(async () => {
      dataRoot = await freshApp(manifestWith({ tableHistory: true, detailHistory: true }));
    });

    test("(G-8) 詳細画面が history: true のまま表の history を外す差分は断られる", () => {
      refusedAtView([{ op: "change_table", table: "cases", changes: { history: false } }], "rh-g8");
    });

    test("(G-9) 同じ差分で画面と表から同時に外せる(画面を先に書いた順)", () => {
      applied(
        [
          { op: "update_view", view: "case-detail", changes: { history: false } },
          { op: "change_table", table: "cases", changes: { history: false } },
        ],
        "rh-g9a",
      );
      expect(viewHistory()).toBe(false);
      expect(tableHistory()).toBe(false);
    });

    test("(G-10) 表を先に書いた順でも、同じ差分で画面からも外せば通る", () => {
      applied(
        [
          { op: "change_table", table: "cases", changes: { history: false } },
          { op: "update_view", view: "case-detail", changes: { history: false } },
        ],
        "rh-g10",
      );
      expect(viewHistory()).toBe(false);
      expect(tableHistory()).toBe(false);
    });

    test("(G-11) 画面の history だけを外す差分は通り、表の宣言は残る", () => {
      applied([{ op: "update_view", view: "case-detail", changes: { history: false } }], "rh-g11");
      expect(viewHistory()).toBe(false);
      expect(tableHistory()).toBe(true);
    });
  });

  describe("陰性対照: history を書かない差分", () => {
    beforeEach(async () => {
      dataRoot = await freshApp(manifestWith());
    });

    test("(G-12) history を書かない差分を当てても、適用後の定義に history は1つも現れない", () => {
      applied(
        [
          { op: "update_view", view: "case-detail", changes: { name: "案件の詳細" } },
          { op: "change_table", table: "cases", changes: { name: "案件一覧" } },
        ],
        "rh-g12",
      );
      expect(JSON.stringify(current())).not.toContain('"history"');
    });
  });
});

// ---------------------------------------------------------------------------------------
// (I) ID の付け替え(`V23-M8-T13` の独立点検の中1。決定 `D-V23-232`)
//
// 履歴を取っている表(`history: true`)では、表の ID を変える `change_table` と、項目の ID を変える
// `change_field` を適用時に断る(付け替えると、それより前の履歴が黙って読めなくなるため)。 画面に出る名前は
// 今どおり変えられる。 同じ差分で先に表の `history` を外した後の付け替えは通す(同じ op で外すのも通す)。
// 宣言の無い表の付け替えは今日のまま(陰性対照)。
// ---------------------------------------------------------------------------------------

/** 拒否の文面が伝える「先に表の history を外す」の目印。 */
const RENAME_HINT_MARK = "先に表の history を外して";

describe("(I) 履歴を取っている表の ID の付け替え", () => {
  let dataRoot: string | undefined;

  afterEach(async () => {
    if (dataRoot !== undefined) {
      await rm(dataRoot, { recursive: true, force: true });
      dataRoot = undefined;
    }
  });

  type RenameCurrent = {
    app: { tables: { id: string; history?: unknown; fields?: { id: string }[] }[] };
  };
  function current(): RenameCurrent {
    return readCurrentManifest(dataRoot as string, APP_ID) as unknown as RenameCurrent;
  }

  function applied(operations: unknown[], diffId: string): void {
    const result = applyDiff(dataRoot as string, APP_ID, diffOf(operations, diffId));
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  }

  /** 断られ、定義が1バイトも動かず、`path` に「先に表の history を外す」の文面が出ること。 */
  function refusedAt(operations: unknown[], diffId: string, path: string): ValidationError {
    const before = JSON.stringify(current());
    const result = applyDiff(dataRoot as string, APP_ID, diffOf(operations, diffId));
    expect(result.valid).toBe(false);
    expect(JSON.stringify(current())).toBe(before);
    const hit = hitAt(result, path);
    expect(`${hit.message}${hit.hint ?? ""}`).toContain(RENAME_HINT_MARK);
    return hit;
  }

  describe("表が history: true のアプリで", () => {
    beforeEach(async () => {
      dataRoot = await freshApp(manifestWith({ tableHistory: true }));
    });

    test("(I-1) change_table で表の ID を変える差分は断られる(文面に表の ID と「先に表の history を外して」)", () => {
      const hit = refusedAt(
        [{ op: "change_table", table: "cases", changes: { id: "matters" } }],
        "rh-i1",
        "/operations/0/changes/id",
      );
      expect(hit.message).toContain('"cases"');
      expect(hit.message).toContain('"matters"');
    });

    test("(I-2) change_field で項目の ID を変える差分は断られる(文面に項目の ID と「先に表の history を外して」)", () => {
      const hit = refusedAt(
        [{ op: "change_field", table: "cases", field: "title", changes: { id: "headline" } }],
        "rh-i2",
        "/operations/0/changes/id",
      );
      expect(hit.message).toContain('"title"');
      expect(hit.message).toContain('"headline"');
    });

    test("(I-3) 名前(name)は今どおり変えられる。同じ ID を書いた付け替えも通る", () => {
      applied(
        [
          { op: "change_table", table: "cases", changes: { name: "事案", id: "cases" } },
          {
            op: "change_field",
            table: "cases",
            field: "title",
            changes: { name: "見出し", id: "title" },
          },
        ],
        "rh-i3",
      );
      const table = current().app.tables.find((candidate) => candidate.id === "cases");
      expect(table?.history).toBe(true);
      expect((table?.fields ?? []).map((field) => field.id)).toContain("title");
    });

    test("(I-4) 同じ差分で先に表の history を外した後の付け替えは通る(表と項目)", () => {
      applied(
        [
          { op: "change_table", table: "cases", changes: { history: false } },
          { op: "change_field", table: "cases", field: "title", changes: { id: "headline" } },
          { op: "change_table", table: "cases", changes: { id: "matters" } },
        ],
        "rh-i4",
      );
      const table = current().app.tables.find((candidate) => candidate.id === "matters");
      expect(table?.history).toBe(false);
      expect((table?.fields ?? []).map((field) => field.id)).toContain("headline");
    });

    test("(I-5) 同じ op で history: false と ID を書いた change_table も通る(history を先に運ぶ)", () => {
      applied(
        [{ op: "change_table", table: "cases", changes: { history: false, id: "matters" } }],
        "rh-i5",
      );
      expect(current().app.tables.find((candidate) => candidate.id === "matters")?.history).toBe(
        false,
      );
    });

    test("(I-6) 付け替えの後に history を戻す順は、付け替えの時点で外れているので通る", () => {
      applied(
        [
          { op: "change_table", table: "cases", changes: { history: false } },
          { op: "change_table", table: "cases", changes: { id: "matters" } },
          { op: "change_table", table: "matters", changes: { history: true } },
        ],
        "rh-i6",
      );
      expect(current().app.tables.find((candidate) => candidate.id === "matters")?.history).toBe(
        true,
      );
    });

    test("(I-7) 付け替えの後で history を外す順(付け替えの時点で宣言がある)は断られる", () => {
      refusedAt(
        [
          { op: "change_field", table: "cases", field: "title", changes: { id: "headline" } },
          { op: "change_table", table: "cases", changes: { history: false } },
        ],
        "rh-i7",
        "/operations/0/changes/id",
      );
    });

    test("(I-8) 宣言の無い別の表の付け替えは通る(断るのは history: true の表だけ)", () => {
      applied(
        [
          { op: "change_field", table: "notes", field: "body", changes: { id: "text" } },
          { op: "change_table", table: "notes", changes: { id: "memos" } },
        ],
        "rh-i8",
      );
      const memos = current().app.tables.find((candidate) => candidate.id === "memos");
      expect((memos?.fields ?? []).map((field) => field.id)).toEqual(["text"]);
    });
  });

  describe("陰性対照: 宣言の無いアプリ・false の表", () => {
    test.each([
      ["宣言の無い表", undefined],
      ["history: false の表", false],
    ])("(I-9) %s の表と項目の付け替えは今日のまま通る", async (_label, tableHistory) => {
      dataRoot = await freshApp(manifestWith({ tableHistory }));
      applied(
        [
          { op: "change_field", table: "cases", field: "title", changes: { id: "headline" } },
          { op: "change_table", table: "cases", changes: { id: "matters" } },
        ],
        "rh-i9",
      );
      const table = current().app.tables.find((candidate) => candidate.id === "matters");
      expect((table?.fields ?? []).map((field) => field.id)).toContain("headline");
    });
  });
});
