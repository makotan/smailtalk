/**
 * **実行専用の起動プロファイルの否定形の検査**(`V5-M3-T02` / `R-G1` のサーバ側。
 * 契約は `docs/plan/v5/records/v5-m0.md` §2-1 / §6-3)。
 *
 * ## この検査が主張すること / **主張しないこと**
 *
 * **主張するのは「実行専用プロファイルでは編集系5ルートが1本も登録されない」までである。**
 *
 * - **【禁止】「編集できない」と読まないこと**(`01` §8-1 の禁止1)。**環境変数1つ
 *   (`ST_SERVER_PROFILE`)を外せば、同じ実行ファイルが編集系5ルートを登録する。**
 *   **`Dockerfile` を書き換えれば配布物にも入る。**
 * - **【禁止】「v5 が未認証のルートを塞いだ」と読まないこと。** **`GET /undo/preview` /
 *   `GET /changelog` / `GET /requirements` は今日も `full` プロファイルでは未認証で通る。**
 *   **本タスクはその3本を1バイトも塞いでいない** —— **`runner` プロファイルで登録しない
 *   だけである。**
 *
 * ## 4群ある
 *
 * | # | 何を見るか | なぜ要るか |
 * |---|---|---|
 * | **(a)** | 編集系5ルートの登録が `change-routes.ts` に在り、`app.ts` に1本も無い | `T01` の切り出しそのもの |
 * | **(b)** | **`full` プロファイルには落とす12エントリが実在する** | **目印が死んでいないこと。** 名前が変わると (c) は何も検査せずに緑になる |
 * | **(c)** | **`runner` プロファイルに1つも無い** | **本丸** |
 * | **(d)** | **`full` から消えたのは、ちょうどその12エントリだけである** | **全量。** 実行系を巻き添えで落としても、落とすべきものを落とし忘れても赤くなる |
 *
 * ## **落とすのは12エントリである**(`V5-M3b` / `D-V5-96`。2026-08-06)
 *
 * **`V5-M3` の時点では7エントリだった**(編集系5ルート + 関門2本)。
 * **`D-V5-96` が5本を足した** —— **逃げ道CSSの発行・失効・一覧・申請一覧の4本と
 * `GET /api/apps`(アプリの一覧)。** **残る運営者の口は12本である**(`KEPT_OWNER_ROUTES`)。
 *
 * ## この検査が言えないこと(**丸めない**)
 *
 * - **コンテナイメージの中身を1バイトも見ていない**(`V5-M7` の担当)。
 * - **逃げ道CSSの「配信」の口(`GET /api/apps/:app_id/views/:view_id/custom.css`)は
 *   落としていない。** **落とすと既に発行済みの CSS が配布物で1バイトも読めなくなる**
 *   (判断と理由は `docs/plan/v5/records/v5-m3b.md` §2)。
 * - **`ALL /api/apps/:app_id/escape-hatch-assets` と `ALL …/escape-hatch-assets/*` の
 *   2つの middleware は `runner` にも残っている。** **`D-V5-96` が数えた12エントリに
 *   入っていないためである。** **その結果、Origin ヘッダ付きの越境 POST は 404 ではなく
 *   403 になる**(実測は `v5-m3b.md` §6)。
 * - **実データを持つアプリでの肯定形は本ファイルに無い** —— **`src/server/change-api.test.ts`
 *   の `V5-M3-T02` の describe が持つ**(既存アプリのフィクスチャがそちらに在るため)。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerApp, resolveServerProfile, SERVER_PROFILE_ENV } from "./app.ts";

/**
 * **編集系5ルート**(`v5-m0.md` §6-3 が名指しした5本。当時 `src/server/app.ts:2581` /
 * `:2613` / `:2638` / `:2653` / `:2674` → **2026-08-06 の着手前は `:3467` / `:3499` /
 * `:3524` / `:3539` / `:3560`**)。
 */
const EDIT_ROUTES: readonly string[] = [
  "POST /api/apps/:app_id/diffs",
  "POST /api/apps/:app_id/undo",
  "GET /api/apps/:app_id/undo/preview",
  "GET /api/apps/:app_id/changelog",
  "GET /api/apps/:app_id/requirements",
];

/**
 * **編集系の2つの middleware 登録**(`app.use`。Hono は `method: "ALL"` として持つ)。
 * **ルートだけ外して middleware を残すと、未認証の `POST /diffs` が 404 ではなく 401 に
 * なる** —— 「その口はこの配布物に無い」ではなく「その口はあるが認証が要る」になる。
 */
const EDIT_MIDDLEWARE: readonly string[] = [
  "ALL /api/apps/:app_id/diffs",
  "ALL /api/apps/:app_id/undo",
];

/**
 * **読み物3本の関門**(`V17-M4-T02`。台帳 `AC-G20` = 門外 / 限定採用)。
 *
 * **`GET /undo/preview` / `GET /changelog` / `GET /requirements` にも `app.use` が掛かった** ——
 * **`app.ts` が `GET /manifest` に掛けているものと同じ1本である。**
 *
 * **【なぜ `EDIT_MIDDLEWARE` に足さないのか】** —— **上の定数の名前と doc は「編集系の2つ」を
 * 指しており、読み物の関門を混ぜると名前が嘘になる**(期待値は赤くならないまま、名前だけが
 * 事実と食い違う)。 **本数の効き方は同じである** —— **`DROPPED_ENTRIES` が 12 → 15 になる。**
 *
 * **【禁止】この 12 → 15 を「`runner` を緩めた」とも「厳しくした」とも読まないこと。**
 * **`runner` に登録される口は1本も増減していない**(3本はもともと `runner` に無い)。
 * **動いたのは「`full` に在って `runner` に無いもの」の数え方だけである** ——
 * **`runner` の登録の全量が着手の前後で1エントリも動いていないことは、下の
 * `(d) 【V17-M4-T02】` が撃つ。**
 */
const READ_MIDDLEWARE: readonly string[] = [
  "ALL /api/apps/:app_id/undo/preview",
  "ALL /api/apps/:app_id/changelog",
  "ALL /api/apps/:app_id/requirements",
];

/**
 * **`D-V5-96`(2026-08-06)で `runner` から追加で落ちることになった5エントリ**
 * (`docs/plan/v5/records/v5-distribution-handover.md` §2-2)。
 *
 * **`V5-M3` はこの5本を「どちらとも言えない17本」として全部残していた。**
 * **`D-V5-96` が 12本を残し 5本を落とすと決めた** —— **逃げ道CSSの発行・失効・一覧・申請一覧の
 * 4本と、`GET /api/apps`(アプリの一覧)である。**
 *
 * **`GET /api/apps` は `:app_id` を持たない唯一のエントリであり、`app.ts` が直接登録している**
 * (`app.ts` の `// 1. アプリ一覧` の直下)。**残る4本は `auth-routes.ts` の
 * `registerAuthRoutes` の中にある。** **登録の場所が違う。**
 */
const OWNER_DROPPED_ROUTES: readonly string[] = [
  "GET /api/apps",
  "GET /api/apps/:app_id/escape-hatch-assets",
  "POST /api/apps/:app_id/escape-hatch-assets",
  "GET /api/apps/:app_id/escape-hatch-assets/requests",
  "DELETE /api/apps/:app_id/escape-hatch-assets/:asset_id",
];

/**
 * **`runner` が落とす全量。**
 *
 * **【`V17-M4-T02` による改訂。旧の逐語(1バイトも書き換えていない)】**:
 *   `/** **`runner` が落とす全量(7 + 5 = 12エントリ)。** *\/`
 * **今日は 5 + 2 + 3 + 5 = **15エントリ** である**(読み物3本の関門が足された)。
 */
const DROPPED_ENTRIES: readonly string[] = [
  ...EDIT_ROUTES,
  ...EDIT_MIDDLEWARE,
  ...READ_MIDDLEWARE,
  ...OWNER_DROPPED_ROUTES,
];

/**
 * **`D-V5-96` が「配布物に残す」と決めた運営者の口12本。**
 *
 * **【正直に書く。`D-V5-96` の逐語】** **外部との連携と AI の能力は「申請」までであり、
 * 申請を許可する口は AI 側にあって配布物に入らない** —— **配った先で申請しても、許可する
 * 手段が無い。** **この非対称を承知のうえで残す選択がなされた。**
 *
 * **【禁止】「配布物では運営者が何も変えられない」と読まないこと** —— **12本が残る。**
 */
const KEPT_OWNER_ROUTES: readonly string[] = [
  // 利用者の管理(3本)
  "GET /api/apps/:app_id/auth/users",
  "PATCH /api/apps/:app_id/auth/users/:user_id",
  "GET /api/apps/:app_id/auth/activity",
  // 外部との連携(4本)
  "GET /api/apps/:app_id/connections",
  "POST /api/apps/:app_id/connections",
  "GET /api/apps/:app_id/connections/requests",
  "DELETE /api/apps/:app_id/connections/:connection_id",
  // AI の能力(5本)
  "GET /api/apps/:app_id/ai-capabilities",
  "POST /api/apps/:app_id/ai-capabilities",
  "GET /api/apps/:app_id/ai-capabilities/requests",
  "PATCH /api/apps/:app_id/ai-capabilities/:capability_id/limit",
  "DELETE /api/apps/:app_id/ai-capabilities/:capability_id",
];

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gp-runner-profile-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type HonoRoute = { method: string; path: string };

/** 起動プロファイルを1つ組み立て、登録されたルートを `"METHOD /path"` の集合で返す。 */
function registeredRoutes(profile: "full" | "runner"): string[] {
  const app = createServerApp({ dataRoot: tempRoot(), profile });
  const routes = (app as unknown as { routes: HonoRoute[] }).routes;
  return routes.map((route) => `${route.method} ${route.path}`);
}

const APP_TS = readFileSync(join(import.meta.dir, "app.ts"), "utf-8");
const CHANGE_ROUTES_TS = readFileSync(join(import.meta.dir, "change-routes.ts"), "utf-8");

describe("V5-M3-T01 編集系ルートの切り出し", () => {
  test("(a) 編集系5ルートの登録は change-routes.ts に在り、app.ts に1本も無い", () => {
    const registrations: Array<{ entry: string; needle: string }> = [
      { entry: "POST /api/apps/:app_id/diffs", needle: 'app.post("/api/apps/:app_id/diffs"' },
      { entry: "POST /api/apps/:app_id/undo", needle: 'app.post("/api/apps/:app_id/undo"' },
      {
        entry: "GET /api/apps/:app_id/undo/preview",
        needle: 'app.get("/api/apps/:app_id/undo/preview"',
      },
      { entry: "GET /api/apps/:app_id/changelog", needle: 'app.get("/api/apps/:app_id/changelog"' },
      {
        entry: "GET /api/apps/:app_id/requirements",
        needle: 'app.get("/api/apps/:app_id/requirements"',
      },
    ];
    const missingFromChangeRoutes = registrations
      .filter((r) => !CHANGE_ROUTES_TS.includes(r.needle))
      .map((r) => r.entry);
    const leftInAppTs = registrations.filter((r) => APP_TS.includes(r.needle)).map((r) => r.entry);
    expect({ missingFromChangeRoutes, leftInAppTs }).toEqual({
      missingFromChangeRoutes: [],
      leftInAppTs: [],
    });
  });

  test("(a) 編集系の middleware 登録も change-routes.ts に移っている", () => {
    for (const needle of [
      'app.use("/api/apps/:app_id/diffs"',
      'app.use("/api/apps/:app_id/undo"',
    ]) {
      expect(CHANGE_ROUTES_TS).toContain(needle);
      expect(APP_TS).not.toContain(needle);
    }
  });
});

describe("V5-M3-T02 実行専用の起動プロファイル", () => {
  test("(b) full プロファイルには落とす12エントリが実在する(目印が死んでいない)", () => {
    const full = registeredRoutes("full");
    const missing = DROPPED_ENTRIES.filter((e) => !full.includes(e));
    expect(missing).toEqual([]);
  });

  test("(c) 【本丸】runner プロファイルには落とす12エントリが1つも登録されない", () => {
    const runner = registeredRoutes("runner");
    const leaked = DROPPED_ENTRIES.filter((e) => runner.includes(e));
    expect(leaked).toEqual([]);
  });

  test("(d) full から消えたのは、ちょうどその12エントリだけである(全量)", () => {
    const full = registeredRoutes("full");
    const runner = registeredRoutes("runner");
    const dropped = full.filter((entry) => !runner.includes(entry)).sort();
    const added = runner.filter((entry) => !full.includes(entry)).sort();
    expect({ dropped, added }).toEqual({
      dropped: [...DROPPED_ENTRIES].sort(),
      added: [],
    });
    // **【`V17-M4-T02`】旧の逐語**: `expect(dropped.length).toBe(12);`
    // **読み物3本の関門(`READ_MIDDLEWARE`)が `full` に足されたぶんだけ増えた。**
    expect(dropped.length).toBe(15);
  });

  test("(d) 【D-V5-96】残す12本は runner にも今日どおり登録されている", () => {
    const runner = registeredRoutes("runner");
    const missing = KEPT_OWNER_ROUTES.filter((entry) => !runner.includes(entry));
    expect(missing).toEqual([]);
    expect(KEPT_OWNER_ROUTES.length).toBe(12);
  });

  // **【`V17-M4-T02`。台帳 `AC-G20`】** **`full` から落ちる数が 12 → 15 になったが、
  // `runner` に登録される口は1本も増減していない** —— **その全量を数で固定する。**
  //
  // **着手前(`089637ab`)に同じ式を打った値**: **`full` = 77 / `runner` = **65**。**
  // **着手後**: **`full` = 80 / `runner` = **65**。**
  // **`runner` 側の並びは着手の前後で1エントリも違わなかった**(実出力は記録
  // `docs/plan/v17/records/v17-m4.md` §2 に貼ってある)。
  // **【2026-09-08。`V17-M6-T04`。台帳 `AC-G24` = 門外(`Δ7`)/ 限定採用。
  //   テスト名は1バイトも書き換えていない】**
  //
  // **旧の期待値2つを逐語で残す**:
  //   `expect(runner.length).toBe(65);`
  //   `expect(registeredRoutes("full").length).toBe(65 + 15);`
  //
  // **【`V17-M4-T02` が固定した 65 を、本段が動かす。名指しで書く】** ——
  // **`V17-M4-T02` の記録は「**`runner` 側の並びは着手の前後で1エントリも違わなかった**」と
  // 書いている**(上のコメントの逐語)。 **`V17-M6-T04` はその 65 を **67** にする。**
  // **【禁止】これを「増えていない」と書かない。**
  //
  // **【なぜ 66 ではなく 67 なのか。計画の予測と1つずれた】** —— **計画 §3-4b の (7) は
  // 「`runner` **65 → 66** / `full` **65+15 → 66+15**」と予測していた。**
  // **実測は **67** である** —— **この検査が数えているのは Hono の `app.routes` であり、
  // **`app.use` による関門の登録も1エントリとして数える**。**
  // **付与の出どころを返す口は、関門を第2引数に混ぜず `app.use` で別に置いた**
  // (理由は `app.ts` の登録の直前に書いた。混ぜると整形器が行を折り、入口の全量表から
  // 口が見えなくなる)—— **したがって増えるのは口1本ぶんの `GET` と、関門1本ぶんの
  // 登録の**2エントリ**である。**
  // **`src/server/entry-point-inventory.test.ts` の側は `app.get(` の綴りだけを数えるので、
  // あちらは **52 → 53**(1本)である** —— **数え方が違うので数も違う。**
  //
  // **`runner` から落ちる数(`DROPPED_ENTRIES` = 15本)は1本も動いていない** ——
  // **この口は `runner` にも登録する**(配って動かす版の運営者も同じ問いを持つ)。
  test("(d) 【V17-M4-T02】runner の登録の全量は着手前と同じ 65エントリである", () => {
    const runner = registeredRoutes("runner");
    expect(runner.length).toBe(67);
    // **陽性対照** —— **`full` 側は3本だけ増えている**(読み物3本の関門)。
    expect(registeredRoutes("full").length).toBe(67 + 15);
  });

  test("(d) runner プロファイルにも実行系の代表が今日どおり登録されている", () => {
    const runner = registeredRoutes("runner");
    for (const entry of [
      "GET /api/apps/:app_id/manifest",
      "GET /api/apps/:app_id/tables/:table_id/records",
      "POST /api/apps/:app_id/tables/:table_id/records",
      "POST /api/apps/:app_id/batch",
      // **`v5-m0.md` §6-3 が「1本増えた」と申し送った手動起動の入口。実行系である。**
      "POST /api/apps/:app_id/views/:view_id/actions/run",
      "GET /api/apps/:app_id/views/:view_id/custom.css",
      "POST /api/apps/:app_id/auth/password/login",
      "POST /inbound/:endpoint_id",
    ]) {
      expect(runner).toContain(entry);
    }
  });

  // **`V10-M15-T05`(台帳 `CM-G21` / `ADR-0370`。限定5「両プロファイルに必ず登録する。
  // 片側だけの登録をしない」の機械的な履行)。** **`DROPPED_ENTRIES` にも `KEPT_OWNER_ROUTES`
  // にも1行も足していない** —— **両プロファイルに載る口はどちらの台帳にも載らないので、
  // 「登録する」の履行は配列への追記ではなく、差集合が空のままであることである。**
  test("V10-M15-T05: 一覧の口は full と runner の両方に登録されている(dropped にも added にも1件も出ない)", () => {
    const full = registeredRoutes("full");
    const runner = registeredRoutes("runner");
    const NEW_ENTRY = "GET /api/apps/:app_id/comments";
    expect(full).toContain(NEW_ENTRY);
    expect(runner).toContain(NEW_ENTRY);
    // **陽性対照** —— 同じ式を `POST /api/apps/:app_id/diffs`(runner から落ちる口)へ
    // 当てると、片方(runner)には無い。
    expect(full).toContain("POST /api/apps/:app_id/diffs");
    expect(runner).not.toContain("POST /api/apps/:app_id/diffs");
  });

  test("(c) runner プロファイルでは編集系の口が「エンドポイントがありません」の 404 になる", async () => {
    const app = createServerApp({ dataRoot: tempRoot(), profile: "runner" });
    for (const [method, path] of [
      ["POST", "/api/apps/demo/diffs"],
      ["POST", "/api/apps/demo/undo"],
      ["GET", "/api/apps/demo/undo/preview"],
      ["GET", "/api/apps/demo/changelog"],
      ["GET", "/api/apps/demo/requirements"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { errors: Array<{ message: string }> };
      expect(body.errors[0]?.message).toContain("に対応するエンドポイントはありません");
    }
  });

  test("(b) full プロファイルでは同じ口が「エンドポイントがありません」にはならない", async () => {
    const app = createServerApp({ dataRoot: tempRoot(), profile: "full" });
    for (const [method, path] of [
      ["POST", "/api/apps/demo/diffs"],
      ["POST", "/api/apps/demo/undo"],
      ["GET", "/api/apps/demo/undo/preview"],
      ["GET", "/api/apps/demo/changelog"],
      ["GET", "/api/apps/demo/requirements"],
    ] as const) {
      const res = await app.request(path, { method });
      const body = (await res.json()) as { errors: Array<{ message: string }> };
      expect(body.errors[0]?.message).not.toContain("に対応するエンドポイントはありません");
    }
  });

  test("(c) 【本丸・D-V5-96】runner では新しく落とす5本が 404 になり、本文も「エンドポイントがありません」である", async () => {
    const app = createServerApp({ dataRoot: tempRoot(), profile: "runner" });
    for (const [method, path] of [
      ["GET", "/api/apps"],
      ["GET", "/api/apps/demo/escape-hatch-assets"],
      ["POST", "/api/apps/demo/escape-hatch-assets"],
      ["GET", "/api/apps/demo/escape-hatch-assets/requests"],
      ["DELETE", "/api/apps/demo/escape-hatch-assets/asset-1"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      const body = (await res.json()) as { errors: Array<{ message: string }> };
      // **`V5-M3` の変異2 が「ステータスだけ見ていたら緑だった」ことを実測している。**
      // **本文まで見る** —— 「アプリ "demo" は存在しません。」でも 404 になるためである。
      expect(body.errors[0]?.message, `${method} ${path}`).toContain(
        "に対応するエンドポイントはありません",
      );
    }
  });

  test("(b) full では新しく落とす5本が「エンドポイントがありません」にはならない(目印が死んでいない)", async () => {
    const app = createServerApp({ dataRoot: tempRoot(), profile: "full" });
    // **`GET /api/apps` は full では 200 を返す**(アプリ0件の一覧)。
    const listed = await app.request("/api/apps");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ apps: [] });
    // **逃げ道CSSの4本は full では 401(未認証)であって 404 ではない。**
    for (const [method, path] of [
      ["GET", "/api/apps/demo/escape-hatch-assets"],
      ["POST", "/api/apps/demo/escape-hatch-assets"],
      ["GET", "/api/apps/demo/escape-hatch-assets/requests"],
      ["DELETE", "/api/apps/demo/escape-hatch-assets/asset-1"],
    ] as const) {
      const res = await app.request(path, { method });
      const body = (await res.json()) as { errors: Array<{ message: string }> };
      expect(body.errors[0]?.message, `${method} ${path}`).not.toContain(
        "に対応するエンドポイントはありません",
      );
    }
  });

  /**
   * **逃げ道CSSの「配信」の口は落としていない**(`GET /api/apps/:app_id/views/:view_id/custom.css`)。
   *
   * **落とすと、既に発行済みの CSS が配布物で1バイトも読めなくなる。**
   * **`D-V5-96` が名指しした4本は発行・失効・一覧・申請一覧であり、配信は1本も入っていない。**
   */
  test("(d) 逃げ道CSSの配信の口は runner にも残っている(発行と配信は別である)", () => {
    const runner = registeredRoutes("runner");
    expect(runner).toContain("GET /api/apps/:app_id/views/:view_id/custom.css");
  });

  /**
   * **【落としきれていないものを、隠さずに固定する】**
   *
   * **`D-V5-96` が数えた12エントリに、逃げ道CSSの2つの middleware
   * (`ALL /api/apps/:app_id/escape-hatch-assets` / `ALL …/escape-hatch-assets/*`)は
   * 入っていない。** **したがって `runner` にも残っている。**
   *
   * **その結果、Origin ヘッダの付いた越境の `POST` / `DELETE` は 404 ではなく 403 になる**
   * —— **「その口はこの配布物に無い」ではなく「越境だから断る」が返る。**
   * **`V5-M3` の変異2 が実測したのと同じ形の漏れであり、本タスクは塞いでいない。**
   */
  test("【正直に固定する】越境の Origin を付けると、落としたはずの口が 404 ではなく 403 を返す", async () => {
    const app = createServerApp({ dataRoot: tempRoot(), profile: "runner" });
    const res = await app.request("/api/apps/demo/escape-hatch-assets", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: Array<{ message: string }> };
    expect(body.errors[0]?.message).not.toContain("に対応するエンドポイントはありません");
    // **Origin を付けない同じ要求は 404 である**(上の本丸の検査が見ている)。
    const plain = await app.request("/api/apps/demo/escape-hatch-assets", { method: "POST" });
    expect(plain.status).toBe(404);
  });
});

describe("V5-M3-T02 プロファイルの与え方", () => {
  test("既定は full(環境変数を与えなければ今日どおり)", () => {
    expect(resolveServerProfile(undefined)).toBe("full");
    expect(resolveServerProfile("")).toBe("full");
    expect(resolveServerProfile("full")).toBe("full");
    expect(resolveServerProfile("runner")).toBe("runner");
  });

  test("語彙外の値は黙って既定へ落とさず、受理集合を添えて止める(憲法6)", () => {
    expect(() => resolveServerProfile("prod")).toThrow(/full/);
    expect(() => resolveServerProfile("RUNNER")).toThrow(/runner/);
  });

  test(`環境変数 ${SERVER_PROFILE_ENV}=runner で編集系ルートが登録されない`, () => {
    const before = process.env[SERVER_PROFILE_ENV];
    try {
      process.env[SERVER_PROFILE_ENV] = "runner";
      const app = createServerApp({ dataRoot: tempRoot() });
      const routes = (app as unknown as { routes: HonoRoute[] }).routes.map(
        (route) => `${route.method} ${route.path}`,
      );
      expect([...EDIT_ROUTES, ...EDIT_MIDDLEWARE].filter((e) => routes.includes(e))).toEqual([]);
    } finally {
      if (before === undefined) {
        delete process.env[SERVER_PROFILE_ENV];
      } else {
        process.env[SERVER_PROFILE_ENV] = before;
      }
    }
  });

  test("options.profile は環境変数より優先する", () => {
    const before = process.env[SERVER_PROFILE_ENV];
    try {
      process.env[SERVER_PROFILE_ENV] = "runner";
      const app = createServerApp({ dataRoot: tempRoot(), profile: "full" });
      const routes = (app as unknown as { routes: HonoRoute[] }).routes.map(
        (route) => `${route.method} ${route.path}`,
      );
      expect(routes).toContain("POST /api/apps/:app_id/diffs");
    } finally {
      if (before === undefined) {
        delete process.env[SERVER_PROFILE_ENV];
      } else {
        process.env[SERVER_PROFILE_ENV] = before;
      }
    }
  });
});
