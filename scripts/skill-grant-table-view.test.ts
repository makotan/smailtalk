/**
 * **`V17-M6-T03`(`AC-G24` の骨格側)**: **付与を記録する表には一覧画面を1本必ず宣言する。**
 *
 * ## **本ファイルが撃つもの(計画 `docs/plan/v17/07-v17-m6-plan.md` §2b の 3 の4項)**
 *
 *  1. **骨格(共有型)の画面の内訳を固定する** —— **既存の4枚(`work_list` / `work_form` /
 *     `work_detail` / `work_grant_form`)が今日も1枚も欠けておらず、そのうえで
 *     **付与表 `work_grants` を対象にした `list_view` が1枚**在る。**
 *  2. **骨格から起こしたアプリで、非運営(`staff`)が自分に効いている付与の行を
 *     一覧の口から1件以上読める**(**着手前は画面が無い**)。
 *  3. **説明書に「付与を記録する表には一覧画面を1本必ず宣言する」が逐語で在る**(**着手前 赤**)。
 *  4. **足した `list_view` の `menu_listed` と役割の規則が `staff` に届いている**(**着手前 赤**)。
 *
 * ## **【計画の項1 の書き方に従えなかった。名指しで書く】**
 *
 * **計画 §2b の 3 の項1 は「`work_grants` を対象にした `list_view` が**0枚**である
 * (着手前 緑。実測を固定する)」と書いている。** **これは同じ計画の完了条件14
 * (「骨格に `work_grants` を対象にした `list_view` が **1枚**」)と、
 * 完了条件16(「`T03b` の commit が `plugins/` の1ファイルだけ」)と**同時には成り立たない**
 * —— **0枚で固定すると実装した日に赤くなり、直すには実装の commit で本ファイルも
 * 触ることになるからである。**
 *
 * **したがって項1 は「今日の枚数 = 1枚」を撃つ形にした。** **着手前の実測値(0枚)は
 * 下の `SKELETON_GRANT_LIST_VIEWS_BEFORE` に逐語で残してある**(1バイトも消していない)。
 * **その結果、項1 は着手前 **赤** である**(計画の予告は「緑」だった)。
 *
 * ## **【この検査が測っていないもの。誇張しない】**
 *
 * - **足した一覧が「自分に効いている付与だけ」を見せるかどうかを測っていない。**
 *   **付与表 `work_grants` は `access_control` を宣言しない普通の表なので、
 *   表の規則で読める人には**全員分**の付与行が見える。** **項2 はそれを実測して固定する**
 *   (`(2-d)`)—— **良いことだと書かない。**
 * - **画面の規則(`target: "view"`)をサーバが関門にしているかどうかを測っていない。**
 *   **一覧の中身は `GET .../tables/<表>/records` が返し、その口は画面の規則を1つも見ない。**
 *   **項4 が測るのは「規則と `menu_listed` がアプリの定義として届いているか」だけである。**
 * - **説明書の文が正しいかどうかを1文字も測っていない**(測るのは逐語の実在だけである)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, KernelMetaStore } from "../src/kernel/index.ts";
import { createServerApp } from "../src/server/app.ts";
import { seedSession, TEST_ORIGIN } from "../src/server/test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(HERE, "../plugins/smailtalk/skills/app-build/SKILL.md");

/** **説明書に在ることを撃つ逐語**(起票の完了条件の言葉。1文字も変えない)。 */
const REQUIRED_SENTENCE = "付与を記録する表には一覧画面を1本必ず宣言する";

/**
 * **着手前の実測**(`docs/plan/v17/records/v17-m6.md` §0-7-3。2026-09-08)——
 * **骨格(共有型)が宣言する画面は4枚で、付与表 `work_grants` を対象にしたものは
 * `form` 1枚だけ、`list_view` は **0枚** だった。** **この数は消さずに残す。**
 */
const SKELETON_GRANT_LIST_VIEWS_BEFORE = 0;

/** **骨格が着手前から持っている4枚**(`id` / `type` / `table`。1枚も書き換えさせない)。 */
const SKELETON_VIEWS_BEFORE = [
  { id: "work_list", type: "list_view", table: "work" },
  { id: "work_form", type: "form", table: "work" },
  { id: "work_detail", type: "detail_view", table: "work" },
  { id: "work_grant_form", type: "form", table: "work_grants" },
] as const;

const APP_ID = "grant-table-view";

type AnyOp = { op: string; [key: string]: unknown };
type ViewOp = { op: "add_view"; view: Record<string, unknown> };
type RoleRule = Record<string, unknown>;
type RoleDecl = { id: string; rules?: RoleRule[] };

const skillText = (): string => readFileSync(SKILL_PATH, "utf-8");

/** **§4(共有型の骨格)の本文だけを切り出す。** */
function sharedSkeletonSection(): string {
  const text = skillText();
  const start = text.indexOf("## 4. 骨格(共有型)");
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf("\n## 5. ", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

/**
 * **1つのコードブロックに、最上位のオブジェクトが複数並んでいる**(JSON 配列ではない)。
 * **文字列とエスケープを見ながら波括弧の深さで切り出す。**
 */
function splitTopLevelObjects(block: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i] as string;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        found.push(block.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return found;
}

/** **§4 の JSON ブロックから、差分の操作を書かれている順に全部拾う。** */
function skeletonOperations(): AnyOp[] {
  const section = sharedSkeletonSection();
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  expect(blocks.length).toBeGreaterThan(0);
  const ops: AnyOp[] = [];
  for (const block of blocks) {
    for (const chunk of splitTopLevelObjects(block)) {
      const parsed = JSON.parse(chunk) as Record<string, unknown>;
      if (typeof parsed.op === "string") {
        ops.push(parsed as AnyOp);
      }
    }
  }
  return ops;
}

const viewOps = (): ViewOp[] => skeletonOperations().filter((o) => o.op === "add_view") as ViewOp[];

function grantListViews(): Record<string, unknown>[] {
  return viewOps()
    .map((o) => o.view)
    .filter((v) => v.table === "work_grants" && v.type === "list_view");
}

function skeletonRoles(): RoleDecl[] {
  const setRoles = skeletonOperations().find((o) => o.op === "set_roles");
  expect(setRoles).toBeDefined();
  return (setRoles as unknown as { roles: RoleDecl[] }).roles;
}

// =====================================================================================
// **項1 / 項3 / 項4**(**説明書と骨格の文字だけを見る。サーバを起こさない**)
// =====================================================================================

describe("V17-M6-T03(AC-G24 の骨格): 説明書と骨格", () => {
  test("(1) 骨格の画面は着手前の4枚を1枚も欠かさず、付与表を対象にした一覧画面が1枚在る", () => {
    const views = viewOps().map((o) => o.view);
    for (const expected of SKELETON_VIEWS_BEFORE) {
      const found = views.find((v) => v.id === expected.id);
      expect(found).toBeDefined();
      expect((found as Record<string, unknown>).type).toBe(expected.type);
      expect((found as Record<string, unknown>).table).toBe(expected.table);
    }
    // **着手前は 0枚だった**(`SKELETON_GRANT_LIST_VIEWS_BEFORE`)。**今日は 1枚である。**
    expect(SKELETON_GRANT_LIST_VIEWS_BEFORE).toBe(0);
    expect(grantListViews()).toHaveLength(1);
  });

  test("(3) 説明書に「付与を記録する表には一覧画面を1本必ず宣言する」が逐語で在る", () => {
    expect(skillText()).toContain(REQUIRED_SENTENCE);
  });

  test("(4) 足した一覧画面は menu_listed が真で、運営と担当者の役割の規則に届いている", () => {
    const view = grantListViews()[0] as Record<string, unknown>;
    expect(view.menu_listed).toBe(true);
    const viewId = view.id as string;

    const hasViewRead = (roleId: string): boolean => {
      const role = skeletonRoles().find((r) => r.id === roleId);
      return (role?.rules ?? []).some(
        (rule) =>
          rule.target === "view" &&
          rule.view === viewId &&
          Array.isArray(rule.can) &&
          (rule.can as string[]).includes("read"),
      );
    };

    expect(hasViewRead("owner")).toBe(true);
    expect(hasViewRead("staff")).toBe(true);
    // **`customer` には足さない**(計画 §3-3 の (2)。**射程を越えない**)。
    expect(hasViewRead("customer")).toBe(false);
  });
});

// =====================================================================================
// **項2**(**骨格をそのまま本物のサーバへ入れて、非運営が一覧の口から読めるかを撃つ**)
// =====================================================================================

describe("V17-M6-T03(AC-G24 の骨格): 骨格から起こしたアプリ", () => {
  let dataRoot = "";
  let app: ReturnType<typeof createServerApp>;
  let boss: ReturnType<typeof seedSession>;
  let staff: ReturnType<typeof seedSession>;
  let staffMemberId = "";
  let otherMemberId = "";

  const path = (rest: string): string => `/api/apps/${APP_ID}${rest}`;

  async function post(rest: string, cookie: string, body: unknown): Promise<Response> {
    return await app.request(path(rest), {
      method: "POST",
      headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function get(rest: string, cookie: string): Promise<Response> {
    return await app.request(path(rest), { method: "GET", headers: { cookie } });
  }

  async function createRow(
    table: string,
    cookie: string,
    fields: Record<string, unknown>,
  ): Promise<string> {
    const response = await post(`/tables/${table}/records`, cookie, fields);
    expect(response.status).toBe(201);
    return ((await response.json()) as { record: { _id: string } }).record._id;
  }

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-grant-table-view-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "骨格(共有型)", { app_id: APP_ID });
    } finally {
      store.close();
    }
    app = createServerApp({ dataRoot });
    boss = seedSession(dataRoot, APP_ID, { role: "owner", username: "boss" });

    // **骨格を1文字も書き換えずに、そのまま差分として入れる。**
    const applied = await post("/diffs", boss.cookie, {
      diff_id: "skeleton-from-skill",
      intent: "説明書の骨格(共有型)をそのまま入れて、非運営が付与の行を読めるかを測る",
      operations: skeletonOperations(),
    });
    expect(applied.status).toBe(201);

    staff = seedSession(dataRoot, APP_ID, { role: "staff", username: "staff" });

    staffMemberId = await createRow("members", boss.cookie, {
      name: "担当者",
      account: staff.userId,
    });
    otherMemberId = await createRow("members", boss.cookie, {
      name: "別の担当者",
      account: "someone-else",
    });
    await createRow("members", boss.cookie, { name: "運営", account: boss.userId });
  });

  afterEach(async () => {
    if (dataRoot !== "") {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  /**
   * **一覧の口は、画面の宣言があってもなくても同じ `GET .../tables/<表>/records` である**
   * (`web/src/api.ts` の `buildListQuery` が画面の `page_size` / 列 / 並べ替えを
   * 読取パラメータへ翻訳して投げる)。 **したがって「画面から読める」を撃つには、
   * **まず画面の宣言をアプリから取り出し、その宣言のとおりに口を叩く**必要がある。**
   * **着手前は画面が1枚も無いので、ここで止まる。**
   */
  async function grantListViewOf(cookie: string): Promise<Record<string, unknown>> {
    const response = await get("/manifest", cookie);
    expect(response.status).toBe(200);
    const manifest = (await response.json()) as { app: { views: Record<string, unknown>[] } };
    const view = manifest.app.views.find(
      (v) => v.table === "work_grants" && v.type === "list_view",
    );
    expect(view).toBeDefined();
    return view as Record<string, unknown>;
  }

  test("(2) 非運営(担当者)が、自分に効いている付与の行を画面(一覧)から1件以上読める", async () => {
    const workId = await createRow("work", boss.cookie, { title: "初回の作業" });
    const grantId = await createRow("work_grants", boss.cookie, {
      work: workId,
      member: staffMemberId,
      permission: "watcher",
    });

    // **(2-a) 担当者に届いている一覧画面を、アプリの定義から取り出す。**
    const view = await grantListViewOf(staff.cookie);
    const columns = view.columns as string[];
    const pageSize = view.page_size as number;

    // **(2-b) その画面の宣言のとおりに一覧の口を叩く。**
    const listed = await get(`/tables/work_grants/records?limit=${pageSize}`, staff.cookie);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      total: number;
      records: Record<string, unknown>[];
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    const mine = body.records.find((row) => row._id === grantId);
    expect(mine).toBeDefined();
    expect((mine as Record<string, unknown>).member).toBe(staffMemberId);
    // **画面が並べると宣言した列が、返ってきた行に1つも欠けていない。**
    for (const column of columns) {
      expect(Object.hasOwn(mine as Record<string, unknown>, column)).toBe(true);
    }

    // **(2-c) 付与された当人は、その付与が指す業務の行も読める**(付与が効いていることの裏取り)。
    const work = await get(`/tables/work/records/${workId}`, staff.cookie);
    expect(work.status).toBe(200);
  });

  // **【`V18-M3-T02`(`PM-G6`)が反転した。削っていない・`.skip` にしていない・緩めていない】**
  //
  // **根拠の条文**: **`ADR-0435`**(名簿・付与・グループ表の読取に判定を掛ける。限定採用)
  // **+ `ADR-0439`**(授権の表 行11 = **既存の検査を削らずに**反転**することだけを許す**)。
  // **絞り方の正はユーザ決定 `D-V18-21`**(付与表は「その付与行が指す親の行を、その人が
  // 読めるものだけ」)**と `docs/plan/v18/05-v18-m3-plan.md` §11-1 の裁定5点である。**
  //
  // **旧のテスト名と旧の期待値を逐語で残す(1バイトも消していない)**:
  //   `test("(2-d) この一覧は他人あての付与の行も見せる(隠さない。良いこととして書かない)", …`
  //   `// **`work_grants` は `access_control` を宣言しない普通の表なので、表の規則で読める人には`
  //   `// 全員分が見える。** **説明書の本文はこれを名指しで書いている。**`
  //   `expect(body.records.some((row) => row.member === otherMemberId)).toBe(true);`
  //
  // **【説明書の本文はこの葉では1バイトも直していない】** —— **`plugins/` は
  // `ADR-0435` の授権の表にも `ADR-0439` にも1行も無い。** **出荷文の訂正は
  // `V18-M3-T04`、射程と限界の記録は `V18-M3-T05` の持ち物である。**
  test("(2-d) この一覧は他人あての付与の行を見せない(`PM-G6` / `ADR-0435` が反転させた)", async () => {
    const workId = await createRow("work", boss.cookie, { title: "別の作業" });
    await createRow("work_grants", boss.cookie, {
      work: workId,
      member: otherMemberId,
      permission: "watcher",
    });

    const listed = await get("/tables/work_grants/records", staff.cookie);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { records: { member: string }[] };
    // **`staff` は「別の作業」の行を1件も読めない** —— **したがってその作業を指す
    // 付与行も返らない**(`D-V18-21`。**親の可視性に連れられる**)。
    expect(body.records.some((row) => row.member === otherMemberId)).toBe(false);
  });

  test("(4-b) 足した一覧画面が、アプリの定義として担当者に届いている", async () => {
    const response = await get("/manifest", staff.cookie);
    expect(response.status).toBe(200);
    const manifest = (await response.json()) as {
      app: { views: Record<string, unknown>[]; roles: RoleDecl[] };
    };
    const view = manifest.app.views.find(
      (v) => v.table === "work_grants" && v.type === "list_view",
    );
    expect(view).toBeDefined();
    expect((view as Record<string, unknown>).menu_listed).toBe(true);

    const staffRole = manifest.app.roles.find((r) => r.id === "staff");
    expect(
      (staffRole?.rules ?? []).some(
        (rule) => rule.target === "view" && rule.view === (view as { id: string }).id,
      ),
    ).toBe(true);
  });
});

// =====================================================================================
// **【`V23-M9-T11`。決定 `D-V23-249`・`D-V23-241`・`D-V23-245`】組織と評価機関の骨格
// (`app-build/reference/scs-skeleton.md`)の差分を、本体のカーネルに書かれた順に当てる。**
//
// **この器に足した理由**: 新しい検査ファイルを作ると、アプリを作るためにカーネルから
// `createApp` / `KernelMetaStore` を値として取り込む行が増え、`kernel-import-drift` の
// 一覧が動く(`D-V23-266` は、その形を授権しない)。 この2つの名は本ファイルが既に
// 取り込んでいるので、同じ器に置けば取り込みの一覧は1行も動かない。
//
// **説明書の差分は、`json` のコードブロック1つが差分1本(`diff_id` / `intent` /
// `operations`)である。** 説明書は MCP の `dry_run_diff` → `apply_diff` で当てる手順だけを
// 書く。 検査の中では、同じ差分を HTTP の差分の口(運営者として)へ送って当てる
// (検査の中の手段であって、説明書には書かない)。
//
// **測るもの**: (S-1) 全部の差分が書かれた順に通る。 (S-2) 1人1組織の置き場
// (組織の付与の表の相手の列に `unique` と `unique_message`)が、2つ目の組織の作成を
// アプリの文言で断り、組織の行も残さない。 相手の列が空の付与の行(評価機関を相手にした
// 付与)は何本あっても断られない。 (S-3) 本人は名簿の自分の行の `name` を直せる。
// (S-4) 評価機関のコードの招待を承諾すると、評価機関の人が組織と評価を読め、告知を作れ、
// 組織の行と評価の行は直せない。 評価の行の変更は履歴に残る。
// =====================================================================================

const SCS_SKELETON_PATH = resolve(
  HERE,
  "../plugins/smailtalk/skills/app-build/reference/scs-skeleton.md",
);
const SCS_APP_ID = "scs-skeleton";
const SCS_UNIQUE_MESSAGE = "既に別の組織に所属しています";

type ScsDiff = { diff_id: string; intent: string; operations: AnyOp[] };

/** **説明書の `json` のコードブロックを、書かれた順に1本ずつ差分として読む。** */
function scsSkeletonDiffs(): ScsDiff[] {
  const text = readFileSync(SCS_SKELETON_PATH, "utf-8");
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  return blocks.map((block) => JSON.parse(block) as ScsDiff);
}

describe("D-V23-249: 組織と評価機関の骨格(app-build の reference/scs-skeleton.md)", () => {
  let dataRoot = "";
  let app: ReturnType<typeof createServerApp>;

  const path = (rest: string): string => `/api/apps/${SCS_APP_ID}${rest}`;

  async function send(
    method: "POST" | "PATCH",
    rest: string,
    cookie: string,
    body: unknown,
    version?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      cookie,
      origin: TEST_ORIGIN,
      "content-type": "application/json",
    };
    if (version !== undefined) {
      headers["if-match"] = version;
    }
    return await app.request(path(rest), { method, headers, body: JSON.stringify(body) });
  }

  async function read(rest: string, cookie: string): Promise<Response> {
    return await app.request(path(rest), { method: "GET", headers: { cookie } });
  }

  /** **更新は今の版(If-Match)を添えて送る。 版は運営者が読んで取る(読めない人の断りを見るため)。** */
  async function patch(
    table: string,
    id: string,
    reader: string,
    cookie: string,
    fields: Record<string, unknown>,
  ): Promise<Response> {
    const current = await read(`/tables/${table}/records/${id}`, reader);
    expect(current.status).toBe(200);
    const version = current.headers.get("etag") ?? "";
    expect(version).not.toBe("");
    return await send("PATCH", `/tables/${table}/records/${id}`, cookie, fields, version);
  }

  /**
   * **消すのも今の版(If-Match)を添えて送る。 版は運営者が読んで取る。**
   * 運営者にも読めない(既に消えた)ときは、その読取の応答をそのまま返す(赤の出力に全部の句を出すため)。
   */
  async function removeRow(
    table: string,
    id: string,
    reader: string,
    cookie: string,
  ): Promise<Response> {
    const current = await read(`/tables/${table}/records/${id}`, reader);
    if (current.status !== 200) {
      return current;
    }
    return await app.request(path(`/tables/${table}/records/${id}`), {
      method: "DELETE",
      headers: { cookie, origin: TEST_ORIGIN, "if-match": current.headers.get("etag") ?? "" },
    });
  }

  /** **`removeRow` と同じ形の更新**(既に消えた行では、運営者の読取の応答をそのまま返す)。 */
  async function editRow(
    table: string,
    id: string,
    reader: string,
    cookie: string,
    fields: Record<string, unknown>,
  ): Promise<Response> {
    const current = await read(`/tables/${table}/records/${id}`, reader);
    if (current.status !== 200) {
      return current;
    }
    return await send(
      "PATCH",
      `/tables/${table}/records/${id}`,
      cookie,
      fields,
      current.headers.get("etag") ?? "",
    );
  }

  async function created(table: string, cookie: string, fields: Record<string, unknown>) {
    const response = await send("POST", `/tables/${table}/records`, cookie, fields);
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body };
  }

  async function idOf(table: string, cookie: string, fields: Record<string, unknown>) {
    const result = await created(table, cookie, fields);
    expect(result.status).toBe(201);
    return (result.body.record as { _id: string })._id;
  }

  /**
   * **1本目(役割の名前)を当てた後に人を置き、残りを当てる** —— 2本目の名簿の自動登録が、
   * 宣言を足した差分の適用の時点で既に役割を持つ人を名簿に入れる(画面から登録した人と同じ行になる)。
   */
  async function buildFromSkeleton() {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-scs-skeleton-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "組織と評価機関の骨格", { app_id: SCS_APP_ID });
    } finally {
      store.close();
    }
    app = createServerApp({ dataRoot });
    const boss = seedSession(dataRoot, SCS_APP_ID, { role: "owner", username: "boss" });
    const diffs = scsSkeletonDiffs();
    const statuses: number[] = [];
    const first = diffs[0] as ScsDiff;
    const firstResponse = await send("POST", "/diffs", boss.cookie, first);
    statuses.push(firstResponse.status);
    const people = {
      boss,
      orgOwnerA: seedSession(dataRoot, SCS_APP_ID, { role: "org_user", username: "org_a_owner" }),
      orgMemberA: seedSession(dataRoot, SCS_APP_ID, { role: "org_user", username: "org_a_member" }),
      agencyOwnerX: seedSession(dataRoot, SCS_APP_ID, { role: "expert", username: "ag_x_owner" }),
      expertX: seedSession(dataRoot, SCS_APP_ID, { role: "expert", username: "ag_x_expert" }),
      agencyOwnerY: seedSession(dataRoot, SCS_APP_ID, { role: "expert", username: "ag_y_owner" }),
    };
    for (const diff of diffs.slice(1)) {
      const response = await send("POST", "/diffs", boss.cookie, diff);
      if (response.status !== 201) {
        // **どの差分がなぜ断られたかを、赤の出力に残す。**
        console.error(diff.diff_id, response.status, await response.text());
      }
      statuses.push(response.status);
    }
    return { diffs, statuses, people };
  }

  /** **運営者が評価機関を作り、専門家をその管理者に招き、承諾させてコードを発行させる。** */
  async function agencyWithCode(
    boss: ReturnType<typeof seedSession>,
    admin: ReturnType<typeof seedSession>,
    name: string,
  ): Promise<{ agencyId: string; code: string }> {
    const agencyId = await idOf("agencies", boss.cookie, { name });
    const invited = await send(
      "POST",
      `/tables/agencies/records/${agencyId}/invitations`,
      boss.cookie,
      {
        login: admin.username,
        permission: "ag_admin",
      },
    );
    expect(invited.status).toBe(202);
    await acceptAll(admin);
    const issued = await send(
      "POST",
      `/tables/agencies/records/${agencyId}/invite-code`,
      admin.cookie,
      {},
    );
    expect(issued.status).toBe(200);
    const code = ((await issued.json()) as { code: string }).code;
    expect(code.length).toBeGreaterThan(0);
    return { agencyId, code };
  }

  async function acceptAll(person: ReturnType<typeof seedSession>): Promise<void> {
    const listed = await read("/invitations", person.cookie);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { invitations: { id: string }[] };
    expect(body.invitations.length).toBeGreaterThan(0);
    for (const invitation of body.invitations) {
      const answered = await send("POST", `/invitations/${invitation.id}`, person.cookie, {
        action: "accept",
      });
      expect(answered.status).toBe(200);
    }
  }

  afterEach(async () => {
    if (dataRoot !== "") {
      await rm(dataRoot, { recursive: true, force: true });
      dataRoot = "";
    }
  });

  test("(S-0) D-V23-249: 説明書は MCP の dry_run_diff と apply_diff だけで当て、回避の道を書かない", () => {
    const text = readFileSync(SCS_SKELETON_PATH, "utf-8");
    expect(text).toContain("dry_run_diff");
    expect(text).toContain("apply_diff");
    for (const workaround of ["/diffs", "custom_css", "app.sqlite", "sqlite3"]) {
      expect(text.includes(workaround)).toBe(false);
    }
    // **D-V23-241 と D-V23-245 の2文を骨格にも書く。**
    expect(text).toContain("付与した側が付与の行を消す");
    expect(text).toContain("コードを作り直す");
  });

  test("(S-1) D-V23-249: 骨格の差分を書かれた順に当てると、1本残らず 201 で通る", async () => {
    const { diffs, statuses } = await buildFromSkeleton();
    expect(diffs.length).toBeGreaterThanOrEqual(4);
    expect(statuses).toEqual(diffs.map(() => 201));
  });

  test("(S-2) D-V23-249: 2つ目の組織はアプリの文言で断られ、評価機関を相手にした付与の行は何本でも通る", async () => {
    const { people } = await buildFromSkeleton();
    const { boss, orgOwnerA, orgMemberA, agencyOwnerX, agencyOwnerY } = people;
    // **組織の人は、登録した直後(名簿は自動で入る)から組織を作れる。**
    const orgA = await idOf("orgs", orgOwnerA.cookie, { name: "組織A" });
    // **同じ人が2つ目の組織を作ると、アプリの文言で断られ、組織の行も残らない。**
    const second = await created("orgs", orgOwnerA.cookie, { name: "組織B" });
    expect(second.status).toBe(422);
    expect(JSON.stringify(second.body)).toContain(SCS_UNIQUE_MESSAGE);
    const listed = await read("/tables/orgs/records", boss.cookie);
    const rows = ((await listed.json()) as { records: { name: string }[] }).records;
    expect(rows.map((row) => row.name)).toEqual(["組織A"]);

    // **評価機関2つをコードで組織Aに結ぶ** —— 付与の行の相手の列は空のまま2本になる。
    for (const [admin, name] of [
      [agencyOwnerX, "評価機関X"],
      [agencyOwnerY, "評価機関Y"],
    ] as const) {
      const { code } = await agencyWithCode(boss, admin, name);
      const invited = await send(
        "POST",
        `/tables/orgs/records/${orgA}/invitations`,
        orgOwnerA.cookie,
        {
          code,
          permission: "assessor",
        },
      );
      expect(invited.status).toBe(202);
      await acceptAll(admin);
    }
    // **既に組織Bのオーナーになった人が組織Aへの招待を承諾すると、同じ文言で断られ、招待は残る。**
    const orgB = await idOf("orgs", orgMemberA.cookie, { name: "組織B" });
    expect(orgB).not.toBe(orgA);
    const toA = await send("POST", `/tables/orgs/records/${orgA}/invitations`, orgOwnerA.cookie, {
      login: orgMemberA.username,
      permission: "org_member",
    });
    expect(toA.status).toBe(202);
    const pending = await read("/invitations", orgMemberA.cookie);
    const pendingIds = ((await pending.json()) as { invitations: { id: string }[] }).invitations;
    expect(pendingIds).toHaveLength(1);
    const refused = await send(
      "POST",
      `/invitations/${(pendingIds[0] as { id: string }).id}`,
      orgMemberA.cookie,
      {
        action: "accept",
      },
    );
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain(SCS_UNIQUE_MESSAGE);
    const still = await read("/invitations", orgMemberA.cookie);
    expect(((await still.json()) as { invitations: unknown[] }).invitations).toHaveLength(1);

    const grants = await read("/tables/org_grants/records", boss.cookie);
    const grantRows = ((await grants.json()) as { records: Record<string, unknown>[] }).records;
    expect(
      grantRows.filter(
        (row) => row.agency !== null && row.agency !== undefined && row.agency !== "",
      ),
    ).toHaveLength(2);
  });

  test("(S-3) D-V23-249: 本人は名簿の自分の行の name を直せる(名簿への書込の規則が骨格に在る)", async () => {
    const { people } = await buildFromSkeleton();
    const { orgMemberA } = people;
    const listed = await read("/tables/members/records", orgMemberA.cookie);
    expect(listed.status).toBe(200);
    const rows = ((await listed.json()) as { records: Record<string, unknown>[] }).records;
    const mine = rows.find((row) => row.account === orgMemberA.userId);
    expect(mine).toBeDefined();
    const renamed = await patch(
      "members",
      (mine as { _id: string })._id,
      orgMemberA.cookie,
      orgMemberA.cookie,
      { name: "表示名を直した" },
    );
    expect(renamed.status).toBe(200);
  });

  test("(S-4) D-V23-249: 結んだ評価機関の人は組織と評価を読み、告知を作れるが、組織と評価は直せない。評価の変更は履歴に残る", async () => {
    const { people } = await buildFromSkeleton();
    const { boss, orgOwnerA, orgMemberA, agencyOwnerX, expertX, agencyOwnerY } = people;
    const orgA = await idOf("orgs", orgOwnerA.cookie, { name: "組織A" });
    // **組織のオーナーがメンバーをログイン名で招き、本人が承諾する。**
    const invited = await send(
      "POST",
      `/tables/orgs/records/${orgA}/invitations`,
      orgOwnerA.cookie,
      {
        login: orgMemberA.username,
        permission: "org_member",
      },
    );
    expect(invited.status).toBe(202);
    await acceptAll(orgMemberA);

    // **評価機関X: 運営者が作り、オーナーを招く。オーナーが専門家を招く。**
    const { agencyId, code } = await agencyWithCode(boss, agencyOwnerX, "評価機関X");
    const staff = await send(
      "POST",
      `/tables/agencies/records/${agencyId}/invitations`,
      agencyOwnerX.cookie,
      {
        login: expertX.username,
        permission: "ag_staff",
      },
    );
    expect(staff.status).toBe(202);
    await acceptAll(expertX);
    // **評価機関Y は組織Aと結ばない(関係の無い専門家の対照)。**
    await agencyWithCode(boss, agencyOwnerY, "評価機関Y");

    // **組織のオーナーがコードで評価機関Xを招き、評価機関Xのオーナーが承諾する。**
    const byCode = await send(
      "POST",
      `/tables/orgs/records/${orgA}/invitations`,
      orgOwnerA.cookie,
      {
        code: ` ${code.toLowerCase()} `,
        permission: "assessor",
      },
    );
    expect(byCode.status).toBe(202);
    await acceptAll(agencyOwnerX);

    // **組織のメンバーが評価の行を作り、直す。**
    const assessmentId = await idOf("assessments", orgMemberA.cookie, {
      org: orgA,
      criterion: "基準1",
      status: "未着手",
    });
    const updated = await patch("assessments", assessmentId, boss.cookie, orgMemberA.cookie, {
      status: "達成",
    });
    expect(updated.status).toBe(200);

    // **評価機関Xの専門家(オーナーでない人)が組織と評価を読める。 関係の無い評価機関Yの人は読めない。**
    expect((await read(`/tables/orgs/records/${orgA}`, expertX.cookie)).status).toBe(200);
    expect((await read(`/tables/assessments/records/${assessmentId}`, expertX.cookie)).status).toBe(
      200,
    );
    expect((await read(`/tables/orgs/records/${orgA}`, agencyOwnerY.cookie)).status).not.toBe(200);

    // **専門家は告知を作れるが、組織の行と評価の行は直せない。**
    await idOf("notices", expertX.cookie, { org: orgA, title: "確認のお願い" });
    const editOrg = await patch("orgs", orgA, boss.cookie, expertX.cookie, { name: "書換" });
    expect(editOrg.status).toBe(403);
    const editAssessment = await patch("assessments", assessmentId, boss.cookie, expertX.cookie, {
      status: "未着手",
    });
    expect(editAssessment.status).toBe(403);

    // **評価の行の変更は履歴に残り、組織の人に見える。**
    const history = await read(
      `/tables/assessments/records/${assessmentId}?history=1`,
      orgOwnerA.cookie,
    );
    expect(history.status).toBe(200);
    expect(JSON.stringify(await history.json())).toContain("達成");
  });

  // =====================================================================================
  // **【決定 `D-V23-312`。担保する決定 `D-V23-297`・`D-V23-275`・`D-V23-311`】骨格の 5-6 を当てた後の、
  // 消せる人・名前を変えられる人・告知を直せる人。**
  // 5-6 を当てない骨格では、メンバーが組織を消せ、所属の専門家が評価機関を改名・削除でき、
  // メンバーが他の人の告知を書き換え・消せ、メンバーが組織の名前を直せる(写しで撃って確かめた形)。
  // =====================================================================================
  // 【V23-M10-T01d】題の句のうち撃っていなかった3つ(運営者の組織の改名と削除・運営者の評価機関の
  // 改名)と、組織の人が組織を作れること(5-6 の「今日どおり」)を表に足した。
  test("(S-5) D-V23-312: 5-6 を当てた後、組織の人は組織を作れ、組織の改名と削除はオーナーと運営者、評価機関の改名はオーナーと運営者で削除は運営者だけ、告知を直す・消すのは書いた人と組織のオーナーと運営者だけ", async () => {
    const { people } = await buildFromSkeleton();
    const { boss, orgOwnerA, orgMemberA, agencyOwnerX, expertX } = people;
    const orgA = await idOf("orgs", orgOwnerA.cookie, { name: "組織A" });
    const invited = await send(
      "POST",
      `/tables/orgs/records/${orgA}/invitations`,
      orgOwnerA.cookie,
      { login: orgMemberA.username, permission: "org_member" },
    );
    expect(invited.status).toBe(202);
    await acceptAll(orgMemberA);
    const { agencyId, code } = await agencyWithCode(boss, agencyOwnerX, "評価機関X");
    const staff = await send(
      "POST",
      `/tables/agencies/records/${agencyId}/invitations`,
      agencyOwnerX.cookie,
      { login: expertX.username, permission: "ag_staff" },
    );
    expect(staff.status).toBe(202);
    await acceptAll(expertX);
    const byCode = await send(
      "POST",
      `/tables/orgs/records/${orgA}/invitations`,
      orgOwnerA.cookie,
      { code, permission: "assessor" },
    );
    expect(byCode.status).toBe(202);
    await acceptAll(agencyOwnerX);

    // **どの句が崩れたかを赤の出力に全部出すため、状態コードを1つの表に集めて最後に1回だけ比べる。**
    const got: Record<string, number> = {};
    const want: Record<string, number> = {};
    const shoot = async (name: string, expected: number, run: () => Promise<Response>) => {
      want[name] = expected;
      got[name] = (await run()).status;
    };
    const rename = (table: string, id: string, cookie: string, name: string) => () =>
      editRow(table, id, boss.cookie, cookie, { name });
    const retitle = (id: string, cookie: string, title: string) => () =>
      editRow("notices", id, boss.cookie, cookie, { title });
    const remove = (table: string, id: string, cookie: string) => () =>
      removeRow(table, id, boss.cookie, cookie);

    // **組織の改名(D-V23-311)**: メンバーと結んだ評価機関の専門家は 403、オーナーは 200。
    await shoot(
      "組織: メンバーの改名",
      403,
      rename("orgs", orgA, orgMemberA.cookie, "メンバーが直す"),
    );
    await shoot("組織: 専門家の改名", 403, rename("orgs", orgA, expertX.cookie, "専門家が直す"));
    await shoot(
      "組織: オーナーの改名",
      200,
      rename("orgs", orgA, orgOwnerA.cookie, "組織A(直した)"),
    );
    await shoot("組織: 運営者の改名", 200, rename("orgs", orgA, boss.cookie, "組織A(運営)"));

    // **組織の削除(D-V23-297)**: メンバーと専門家は 403。 子の行がまだ無いうちに撃つ
    // (子の行があると、子を消せるかの判定で先に断られ、組織の表の規則の歯を見られない)。
    await shoot("組織: メンバーの削除", 403, remove("orgs", orgA, orgMemberA.cookie));
    await shoot("組織: 所属の専門家の削除", 403, remove("orgs", orgA, expertX.cookie));
    await shoot("組織: 評価機関のオーナーの削除", 403, remove("orgs", orgA, agencyOwnerX.cookie));

    // **評価機関(D-V23-275)**: 所属の改名と削除は 403、オーナーの改名は 200 で削除は 403、運営者の削除は 204。
    const agencyZ = await idOf("agencies", boss.cookie, { name: "評価機関Z" });
    await shoot("評価機関: 所属の改名", 403, rename("agencies", agencyId, expertX.cookie, "所属"));
    await shoot("評価機関: 所属の削除", 403, remove("agencies", agencyId, expertX.cookie));
    await shoot(
      "評価機関: オーナーの改名",
      200,
      rename("agencies", agencyId, agencyOwnerX.cookie, "X(直した)"),
    );
    await shoot("評価機関: オーナーの削除", 403, remove("agencies", agencyId, agencyOwnerX.cookie));
    await shoot(
      "評価機関: 運営者の改名",
      200,
      rename("agencies", agencyId, boss.cookie, "X(運営)"),
    );
    await shoot("評価機関: 運営者の削除", 204, remove("agencies", agencyZ, boss.cookie));

    // **告知(D-V23-297)**: 書いた人と組織のオーナーと運営者だけが直せ・消せる。
    // **作成も表に入れる**(5-6 を当てない骨格では、所属の専門家が評価機関を消せてしまい、その後の作成が断られる)。
    const writeNotice = async (name: string, cookie: string, title: string) => {
      const result = await created("notices", cookie, { org: orgA, title });
      want[name] = 201;
      got[name] = result.status;
      return ((result.body.record as { _id?: string } | undefined)?._id ?? "missing") as string;
    };
    const byOwner = await writeNotice("告知: オーナーが作る", orgOwnerA.cookie, "オーナーの告知");
    const byMember = await writeNotice("告知: メンバーが作る", orgMemberA.cookie, "メンバーの告知");
    const byExpert = await writeNotice("告知: 専門家が作る", expertX.cookie, "専門家の告知");
    await shoot(
      "告知: メンバーがオーナーの告知を直す",
      403,
      retitle(byOwner, orgMemberA.cookie, "書換"),
    );
    await shoot(
      "告知: メンバーがオーナーの告知を消す",
      403,
      remove("notices", byOwner, orgMemberA.cookie),
    );
    await shoot(
      "告知: 専門家がオーナーの告知を直す",
      403,
      retitle(byOwner, expertX.cookie, "書換"),
    );
    await shoot(
      "告知: 専門家がメンバーの告知を消す",
      403,
      remove("notices", byMember, expertX.cookie),
    );
    await shoot(
      "告知: 評価機関のオーナーがメンバーの告知を直す",
      403,
      retitle(byMember, agencyOwnerX.cookie, "書換"),
    );
    await shoot(
      "告知: メンバーが自分の告知を直す",
      200,
      retitle(byMember, orgMemberA.cookie, "直した"),
    );
    await shoot("告知: 専門家が自分の告知を直す", 200, retitle(byExpert, expertX.cookie, "直した"));
    await shoot(
      "告知: オーナーが専門家の告知を直す",
      200,
      retitle(byExpert, orgOwnerA.cookie, "直した"),
    );
    await shoot(
      "告知: 運営者がメンバーの告知を直す",
      200,
      retitle(byMember, boss.cookie, "直した"),
    );
    await shoot(
      "告知: オーナーがメンバーの告知を消す",
      204,
      remove("notices", byMember, orgOwnerA.cookie),
    );
    await shoot("告知: 専門家が自分の告知を消す", 204, remove("notices", byExpert, expertX.cookie));

    // **子の行を片付けた後、オーナーは組織を消せる(204)。**
    await shoot(
      "告知: オーナーが自分の告知を消す",
      204,
      remove("notices", byOwner, orgOwnerA.cookie),
    );
    await shoot("組織: オーナーの削除", 204, remove("orgs", orgA, orgOwnerA.cookie));

    // **組織の作成は今日どおり(5-6 の「変わらないこと」)。 まだどの組織にも居ない組織の人が組織を作り、
    // 子の行の無いその組織を運営者が消す(運営者はその組織の付与を持たない)。**
    const orgOwnerB = seedSession(dataRoot, SCS_APP_ID, {
      role: "org_user",
      username: "org_b_owner",
    });
    await idOf("members", boss.cookie, { name: "組織Bのオーナー", account: orgOwnerB.userId });
    const orgB = await created("orgs", orgOwnerB.cookie, { name: "組織B" });
    want["組織: 組織の人が作る"] = 201;
    got["組織: 組織の人が作る"] = orgB.status;
    const orgBId = ((orgB.body.record as { _id?: string } | undefined)?._id ?? "missing") as string;
    await shoot("組織: 運営者の削除", 204, remove("orgs", orgBId, boss.cookie));

    expect(got).toEqual(want);
  });
});
