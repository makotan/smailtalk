/**
 * **`V8-M10-T02`(台帳 `Q-G16a` / `Q-G21d`)—— 母集団の判定を1箇所に集めたことの白箱検査。**
 *
 * 仕様は `docs/plan/v8/records/v8-m10.md` §1 の `T02`(元の条文 + 独立点検による差し替え
 * `2'` / `2''`)である。**本ファイルはリファクタの検査であり、レコード一覧の応答を
 * 1バイトも変えていないことは別に実 HTTP(`replay.sh` の84本)で測っている。**
 *
 * ## この1本(`judgeRecordPopulation`)が返すもの —— **3つだけ**
 *
 * 1. **可視行の集合**(`{ kind: "visible", scope, rows }`)
 * 2. **絞りは要らない**(`{ kind: "unfiltered" }`)—— **分岐5(非スコープ)。**
 *    **レコード一覧は今日どおり `readRecordCountAndSum` の SQL 1文で件数と合計を採り続ける**
 *    (`ADR-0104` 限定6 と `list-view-sum-boundary.test.ts` の (D) 3本を壊さない)。
 *    **集計表の経路は、この答えを受けて全行を母集団にする。**
 * 3. **上限に当たった**(`{ kind: "limit_exceeded", limit }`)
 *
 * ## **この1本に集約しないもの(逐語。`v8-m10.md` §1 `T02` の `2'` の列挙そのもの)**
 *
 * > **射影(`dropHidden` / `projectForAnonymous`)・表示名の解決(`resolveOwnerDisplays`)・
 * > ページ切り・件数の採り方は集約しない**(今日の場所に残す)。
 *
 * **すなわち、次の5つは `src/server/app.ts` の今日の場所に残っている**(下の (B-3) が
 * 実物で固定する)—— **後から「1本に集めきれていない」と読まれないために逐語で書く**:
 *
 * | 集約しないもの | 今日の場所 |
 * |---|---|
 * | 射影(見せない項目を落とす) | `app.ts` の `dropHidden`(中身は `projectForRoleFields` 1本) |
 * | 射影(匿名に予約規約フィールドを見せない) | `app.ts` の `.map(projectForAnonymous)` |
 * | 表示名の解決 | `app.ts` の `resolveOwnerDisplays(manifest.app.id, page, actor.id)` |
 * | ページ切り | `app.ts` の `slicePage(visible, limit, offset)` |
 * | 件数と合計の採り方 | `app.ts` の `total: visible.length` / `sumVisible` / `readRecordCountAndSum` |
 *
 * ## **群化(`Q-G21d`)について**
 *
 * **この1本は群を1つも知らない** —— **入力は行、出力は行である。**
 * **したがって「群を作ってから絞る」形は構造的に書けない**(下の (C) が固定する)。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, Table } from "../kernel/index.ts";
import {
  type CombinedRecordAccessResolution,
  judgeRecordPopulation,
  judgeRoleAccess,
  OWNER_FIELD,
  recordPopulationScope,
} from "./owner-scope.ts";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

const APP_PATH = join(PRODUCT_ROOT, "src", "server", "app.ts");
const APP_SOURCE = readFileSync(APP_PATH, "utf-8");

/** 登録行の正規表現(`access-control-paths.test.ts` と同じ形)。 */
const ROUTE_PATTERN = /\bapp\.(get|post|patch|delete|put|all|options|head)\(\s*"([^"]+)"/g;

/** レコード一覧のハンドラ本文だけを切り出す(次の登録行の直前まで)。 */
function listRouteBody(): string {
  const found: { key: string; index: number }[] = [];
  ROUTE_PATTERN.lastIndex = 0;
  let match = ROUTE_PATTERN.exec(APP_SOURCE);
  while (match !== null) {
    found.push({ key: `${match[1]?.toUpperCase()} ${match[2]}`, index: match.index });
    match = ROUTE_PATTERN.exec(APP_SOURCE);
  }
  const at = found.findIndex(
    (registration) => registration.key === "GET /api/apps/:app_id/tables/:table_id/records",
  );
  expect(at).toBeGreaterThanOrEqual(0);
  return APP_SOURCE.slice(found[at]?.index ?? 0, found[at + 1]?.index ?? APP_SOURCE.length);
}

/** 注釈行を除いた製品コードだけ(`list-view-sum-boundary.test.ts` の (D) と同じ作法)。 */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// (A) 5分岐すべてが1本を通る —— 単体で真理値表を固定する
// ---------------------------------------------------------------------------

const PLAIN_TABLE: Table = {
  id: "t_plain",
  name: "ふつうの表",
  fields: [{ id: "tag", name: "区分", type: "text" }],
};

const OWNER_TABLE: Table = {
  id: "t_owner",
  name: "個人の表",
  fields: [
    { id: "tag", name: "区分", type: "text" },
    { id: OWNER_FIELD, name: "持ち主", type: "text" },
  ],
};

const PUBLIC_TABLE: Table = {
  id: "t_public",
  name: "公開の表",
  fields: [
    { id: "tag", name: "区分", type: "text" },
    { id: "st_public", name: "公開", type: "boolean" },
  ],
};

/** 役割を1つも宣言していないマニフェスト(面は「管轄外」に倒れる)。 */
function manifestWith(tables: Table[], roles?: unknown): Manifest {
  return {
    app: { id: "m10", name: "母集団の台", ...(roles === undefined ? {} : { roles }) },
    tables,
    views: [],
  } as unknown as Manifest;
}

/** 面の答え(表単位)を実物の関数から採る —— 手で組み立てた偽物を渡さない。 */
function tableReadOf(manifest: Manifest, tableId: string, roles: string[] | null) {
  return judgeRoleAccess({
    manifest,
    roles: roles === null ? null : (roles as unknown as never),
    target: { target: "table", table: tableId },
    verb: "read",
  });
}

/** 「担当が自分」の条件つき読取だけを持つ役割の宣言。 */
const CONDITIONAL_ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "table", table: "t_plain", can: ["read", "write", "delete"] },
    ],
  },
  {
    id: "editor",
    name: "編集者",
    rules: [
      {
        target: "table",
        table: "t_plain",
        can: ["read"],
        when: { field: "tag", equals_current_user: false, equals: "A" },
      },
    ],
  },
];

test("(A-1) 5分岐すべてが1本の分類を通る(匿名公開 / 個人スコープ / 行アクセス権 / 条件読取 / 非スコープ)", () => {
  const plain = manifestWith([PLAIN_TABLE]);
  const owned = manifestWith([OWNER_TABLE]);
  const shown = manifestWith([PUBLIC_TABLE]);
  const sources = { grantTable: "g", memberTable: undefined, groupTable: undefined } as never;

  expect({
    anonymous: recordPopulationScope({
      manifest: shown,
      table: PUBLIC_TABLE,
      anonymousPublic: true,
      accessSources: undefined,
      tableRead: tableReadOf(shown, "t_public", null),
    }),
    owner: recordPopulationScope({
      manifest: owned,
      table: OWNER_TABLE,
      anonymousPublic: false,
      accessSources: undefined,
      tableRead: tableReadOf(owned, "t_owner", null),
    }),
    grant: recordPopulationScope({
      manifest: plain,
      table: PLAIN_TABLE,
      anonymousPublic: false,
      accessSources: sources,
      tableRead: tableReadOf(plain, "t_plain", null),
    }),
    conditional: recordPopulationScope({
      manifest: plain,
      table: PLAIN_TABLE,
      anonymousPublic: false,
      accessSources: undefined,
      tableRead: { allowed: true, governed: true, blockedBy: null, conditional: true },
    }),
    unscoped: recordPopulationScope({
      manifest: plain,
      table: PLAIN_TABLE,
      anonymousPublic: false,
      accessSources: undefined,
      tableRead: tableReadOf(plain, "t_plain", null),
    }),
  }).toEqual({
    anonymous: "anonymous_public",
    owner: "owner_scoped",
    grant: "record_access",
    conditional: "role_conditional",
    unscoped: "unfiltered",
  });
});

test("(A-2) 分岐1(匿名公開): `st_public` が厳密に true の行だけが母集団になる", () => {
  const manifest = manifestWith([PUBLIC_TABLE]);
  const rows = [
    { _id: "1", st_public: true, tag: "A" },
    { _id: "2", st_public: false, tag: "A" },
    { _id: "3", tag: "A" },
  ];
  const population = judgeRecordPopulation({
    manifest,
    table: PUBLIC_TABLE,
    tableId: "t_public",
    rows,
    anonymousPublic: true,
    actorId: null,
    roles: null,
    accessSources: undefined,
    tableRead: tableReadOf(manifest, "t_public", null),
    judge: undefined,
  });
  expect(population.kind).toBe("visible");
  expect(population.kind === "visible" ? population.rows.map((row) => row._id) : []).toEqual(["1"]);
});

test("(A-3) 分岐2(個人スコープ): 自分の行と共有行だけが母集団になる", () => {
  const manifest = manifestWith([OWNER_TABLE]);
  const rows = [
    { _id: "1", [OWNER_FIELD]: "u1" },
    { _id: "2", [OWNER_FIELD]: "u2" },
    { _id: "3", [OWNER_FIELD]: null },
  ];
  const population = judgeRecordPopulation({
    manifest,
    table: OWNER_TABLE,
    tableId: "t_owner",
    rows,
    anonymousPublic: false,
    actorId: "u1",
    roles: null,
    accessSources: undefined,
    tableRead: tableReadOf(manifest, "t_owner", null),
    judge: undefined,
  });
  expect(population.kind === "visible" ? population.rows.map((row) => row._id) : []).toEqual([
    "1",
    "3",
  ]);
});

test("(A-4) 分岐3(行アクセス権): 判定が `read` を許した行だけが母集団になる", () => {
  const manifest = manifestWith([PLAIN_TABLE]);
  const rows = [{ _id: "1" }, { _id: "2" }, { _id: "3" }];
  const judge = (row: Record<string, unknown>): CombinedRecordAccessResolution => ({
    kind: "verdict",
    verdict: { read: row._id !== "2", write: false, delete: false } as never,
    blockedBy: { read: [], write: [], delete: [] },
  });
  const population = judgeRecordPopulation({
    manifest,
    table: PLAIN_TABLE,
    tableId: "t_plain",
    rows,
    anonymousPublic: false,
    actorId: "u1",
    roles: null,
    accessSources: { grantTable: "g" } as never,
    tableRead: tableReadOf(manifest, "t_plain", null),
    judge,
  });
  expect(population.kind === "visible" ? population.rows.map((row) => row._id) : []).toEqual([
    "1",
    "3",
  ]);
});

test("(A-5) 分岐3: 1行でも上限に当たったら「上限に当たった」を返す(行を黙って落とさない)", () => {
  const manifest = manifestWith([PLAIN_TABLE]);
  const rows = [{ _id: "1" }, { _id: "2" }];
  const judge = (row: Record<string, unknown>): CombinedRecordAccessResolution =>
    row._id === "2"
      ? { kind: "limit_exceeded", limit: "rows" }
      : {
          kind: "verdict",
          verdict: { read: true, write: false, delete: false } as never,
          blockedBy: { read: [], write: [], delete: [] },
        };
  const population = judgeRecordPopulation({
    manifest,
    table: PLAIN_TABLE,
    tableId: "t_plain",
    rows,
    anonymousPublic: false,
    actorId: "u1",
    roles: null,
    accessSources: { grantTable: "g" } as never,
    tableRead: tableReadOf(manifest, "t_plain", null),
    judge,
  });
  expect(population).toEqual({ kind: "limit_exceeded", limit: "rows" });
});

test("(A-6) 分岐4(役割つき条件読取): 条件に合う行だけが母集団になる", () => {
  const manifest = manifestWith([PLAIN_TABLE], CONDITIONAL_ROLES);
  const rows = [
    { _id: "1", tag: "A" },
    { _id: "2", tag: "B" },
  ];
  const tableRead = judgeRoleAccess({
    manifest,
    roles: "editor" as never,
    target: { target: "table", table: "t_plain" },
    verb: "read",
  });
  expect(tableRead.conditional).toBe(true);
  const population = judgeRecordPopulation({
    manifest,
    table: PLAIN_TABLE,
    tableId: "t_plain",
    rows,
    anonymousPublic: false,
    actorId: "u1",
    roles: "editor" as never,
    accessSources: undefined,
    tableRead,
    judge: undefined,
  });
  expect(population.kind === "visible" ? population.rows.map((row) => row._id) : []).toEqual(["1"]);
});

test("(A-7) 分岐5(非スコープ): 「絞りは要らない」を返す(行を1件も読み直さない)", () => {
  const manifest = manifestWith([PLAIN_TABLE]);
  const population = judgeRecordPopulation({
    manifest,
    table: PLAIN_TABLE,
    tableId: "t_plain",
    rows: [{ _id: "1" }, { _id: "2" }],
    anonymousPublic: false,
    actorId: "u1",
    roles: null,
    accessSources: undefined,
    tableRead: tableReadOf(manifest, "t_plain", null),
    judge: undefined,
  });
  expect(population).toEqual({ kind: "unfiltered" });
});

// ---------------------------------------------------------------------------
// (B) レコード一覧の経路が、その1本だけを通る
// ---------------------------------------------------------------------------

test("(B-1) レコード一覧のハンドラは母集団の判定を1度だけ呼ぶ(5分岐ぶんの呼び出しを書かない)", () => {
  expect(occurrences(codeOnly(listRouteBody()), "judgeRecordPopulation(")).toBe(1);
});

test("(B-2) レコード一覧のハンドラに可視性の条件式が1つも無い(判定は `owner-scope.ts` の側)", () => {
  // **`ADR-0061` 限定4 の作法。** **旧はこのハンドラの中に5分岐が直に書かれていた** ——
  // **逐語で残す**(消さずに引き直す):
  //   `if (anonymousPublic) {`
  //   `if (ownerField !== undefined) {`
  //   `if (accessSources !== undefined) {`
  //   `if (roleTableRead.conditional) {`
  //   `.filter((row) => isPublicRow(row))`
  //   `isOwnerVisible(row[OWNER_FIELD], actor.id)`
  // **今日、この6つの綴りはハンドラの中に1件も無い。**
  const body = codeOnly(listRouteBody());
  expect({
    anonymousBranch: occurrences(body, "if (anonymousPublic) {"),
    ownerBranch: occurrences(body, "if (ownerField !== undefined) {"),
    grantBranch: occurrences(body, "if (accessSources !== undefined) {"),
    conditionalBranch: occurrences(body, "if (roleTableRead.conditional) {"),
    publicRow: occurrences(body, "isPublicRow("),
    ownerVisible: occurrences(body, "isOwnerVisible("),
  }).toEqual({
    anonymousBranch: 0,
    ownerBranch: 0,
    grantBranch: 0,
    conditionalBranch: 0,
    publicRow: 0,
    ownerVisible: 0,
  });
});

test("(B-3) 集約しないもの5つは、今日の場所(`app.ts` のレコード一覧)に残っている", () => {
  // **本ファイル冒頭の表の逐語である。** **1つでも `owner-scope.ts` へ移したら赤くなる。**
  const body = listRouteBody();
  expect({
    dropHidden: body.includes("const dropHidden = (row: Record<string, unknown>)"),
    anonymousProjection: body.includes(".map(projectForAnonymous)"),
    ownerDisplay: body.includes("resolveOwnerDisplays(manifest.app.id, page, actor.id)"),
    page: body.includes("slicePage(visible, limit, offset)"),
    total: body.includes("total: visible.length"),
    sql: body.includes("readRecordCountAndSum(source, manifest, tableId, {"),
  }).toEqual({
    dropHidden: true,
    anonymousProjection: true,
    ownerDisplay: true,
    page: true,
    total: true,
    sql: true,
  });
});

// ---------------------------------------------------------------------------
// (C) 可視性は群化の**前**に掛かる(`Q-G21d`)
// ---------------------------------------------------------------------------

test("(C-1) 母集団の判定は群を1つも知らない(入力は行・出力は行)", () => {
  // **群を作ってから絞る形を構造的に書けないことの根拠である。**
  // **`owner-scope.ts` に集計表の語(`group_by` / `aggregations`)が1件も無い。**
  // **【誇張しない】`groups` の綴りは10件あるが、それは行アクセス権の**グループ表**
  // (`AccessControlTableRole` の `"groups"`)であって、集計の群ではない** ——
  // **だから `groups` は数えない。**
  const source = codeOnly(
    readFileSync(join(PRODUCT_ROOT, "src", "server", "owner-scope.ts"), "utf-8"),
  );
  expect({
    groupBy: occurrences(source, "group_by"),
    aggregations: occurrences(source, "aggregations"),
  }).toEqual({ groupBy: 0, aggregations: 0 });
  // **返り値に群は1つも無い** —— **`rows`(行の配列)しか持たない。**
  const population = judgeRecordPopulation({
    manifest: manifestWith([PLAIN_TABLE]),
    table: PLAIN_TABLE,
    tableId: "t_plain",
    rows: [{ _id: "1" }],
    anonymousPublic: true,
    actorId: null,
    roles: null,
    accessSources: undefined,
    tableRead: tableReadOf(manifestWith([PLAIN_TABLE]), "t_plain", null),
    judge: undefined,
  });
  expect(Object.keys(population).sort()).toEqual(["kind", "rows", "scope"]);
});
