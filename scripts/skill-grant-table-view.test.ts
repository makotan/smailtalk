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
