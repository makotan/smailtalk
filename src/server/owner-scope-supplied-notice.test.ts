/**
 * **`V17-M5-T05`(`AC-G33`)—— 持ち主の列(`st_owner`)を**後から**足したときに、
 * 役割の規則へ条件を補い、そのことを応答で知らせることの検査。**
 *
 * 台帳(`docs/adr/0007-vocabulary-governance.md` §8)の `AC-G33`(`:1862`)、
 * 踏む条文 `ADR-0318` 限定12(引き受けは `ADR-0331`)、および
 * `docs/plan/v17/06-v17-m5-plan.md` §2b の 5 / §3-5 が仕様である。
 *
 * ## この検査が固定すること(**§2b の 5 の5項**)
 *
 * 1. **`add_field` で `st_owner` だけを足した差分の `role_condition_notices` が空でないこと。**
 * 2. **適用後のマニフェストの規則に `when` が付いていること。**
 * 3. **本物のサーバで、他人の行を単件 `GET` すると 404 であること。**
 * 4. **陰性対照**: `st_owner` を持たない表の規則には `when` が付かない(知らせも出ない)。
 * 5. **陰性対照2**: 既に `when` を書いてある規則は1バイトも書き換わらない
 *    (`ADR-0318` 限定12 の逐語「**既に在る規則の動詞を1語も書き換えない・1本も消さない**」)。
 *
 * ## **【着手前の実測。`docs/plan/v17/06-v17-m5-plan.md` §2-3 の #I の履行】**
 *
 * **起票の逐語「他人の行を単件 `GET` すると 404 になる」は目標値であって、
 * 着手前の値ではなかった。** **着手前に本物のサーバへ実 HTTP を打って測った値は次のとおり**
 * (測り方は本ファイルの (3) とまったく同じ手順である):
 *
 * ```
 * POST /diffs status: 201
 * role_condition_notices: []
 *   role=owner  rules[0] table=notes when=undefined
 *   role=editor rules[0] table=notes when=undefined
 *   role=viewer rules[0] table=notes when=undefined
 * alice GET bob's row -> 200
 * bob   GET alice's row -> 200
 * alice GET own row   -> 200
 * ```
 *
 * **したがって 404 は「着手前から満たしている項」ではない。** **【禁止の履行】
 * 「404 にした」と1文字も書かない** —— **本タスクが変えたのは補完の走る位置と知らせであり、
 * 404 はその補完が入った条件(`when`)を、着手前から在る面の判定
 * (`src/server/owner-scope.ts` の `roleReadCrossesOwnerScope` / `ADR-0305` 限定11 の存在秘匿)が
 * 読んだ結果である。** **`src/server/` は本タスクで1バイトも動いていない。**
 *
 * ## この検査が固定していないこと(**誇張しない**)
 *
 * - **拒否を1本も増やしていない** —— **`valid` は今日どおり真であり、HTTP は 201 である。**
 * - **`st_owner` の可視性フィルタ(post-filter)も、面と点の合成の式も1バイトも動いていない。**
 * - **役割 `owner` の規則にも条件が補われ、知らせも出る**(`AC-G18` の3種目
 *   `grants_bypassed` がユーザ決定 `D3` で `owner` を外したのとは**向きが違う** ——
 *   あちらは「意図された設定を知らせない」であり、こちらは「カーネルが実際に書き換えた
 *   ことを黙らない」である)。**その結果、運営者も自分の行と持ち主が空の行しか
 *   扱えなくなる** —— **この検査の (6) がそれを実測で固定している。**
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "owner-scope-supplied";

/** 補われる条件の逐語(`defaultTableGrantPlan` が返すものそのもの。2本目の式を作らない)。 */
const SUPPLIED_WHEN = {
  or: [
    { field: "st_owner", equals_current_user: true },
    { field: "st_owner", is_empty: true },
  ],
};

type LooseRule = { target?: string; table?: string; when?: unknown; can?: string[] };
type LooseRole = { id: string; rules?: LooseRule[] };
type AppliedManifest = { app: { roles: LooseRole[] } };
type NoticeShape = { kind: string; role: string; path: string; message: string; hint: string };

/**
 * 題材。
 *
 * - **`notes`** … **着手時点では `st_owner` を1本も持たない**(あとから `add_field` で足す)。
 * - **`plain`** … **最後まで `st_owner` を持たない**(陰性対照)。
 */
function manifest(): Manifest {
  return withDefaultRoleRules({
    app: {
      id: APP_ID,
      name: "メモ帳",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "title", name: "題", type: "text", required: true }],
        },
        {
          id: "plain",
          name: "掲示",
          fields: [{ id: "title", name: "題", type: "text", required: true }],
        },
      ],
      views: [],
    },
  }) as unknown as Manifest;
}

let dataRoot: string | undefined;
let app: ReturnType<typeof createServerApp> | undefined;

type Session = ReturnType<typeof seedSession>;
let alice: Session | undefined;
let bob: Session | undefined;

async function boot(): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-owner-supplied-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "メモ帳", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **`applyManifest` は補完を1本も走らせない**(補完は差分の畳み込みの側にある)——
  // **したがってここで置いた規則は `when` を1つも持たない状態から始まる。**
  expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  alice = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  bob = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
}

afterEach(async () => {
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
    app = undefined;
    alice = undefined;
    bob = undefined;
  }
});

function req(cookie: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, cookie };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(
    (app as ReturnType<typeof createServerApp>).request(
      new Request(`http://localhost${path}`, init),
    ),
  );
}

async function postDiff(
  diff: Record<string, unknown>,
): Promise<{ status: number; notices: NoticeShape[]; manifest?: AppliedManifest }> {
  const res = await req((alice as Session).cookie, "POST", `/api/apps/${APP_ID}/diffs`, diff);
  if (res.status !== 201) {
    return { status: res.status, notices: [] };
  }
  const body = (await res.json()) as {
    change: { role_condition_notices: NoticeShape[]; manifest: AppliedManifest };
  };
  return {
    status: res.status,
    notices: body.change.role_condition_notices,
    manifest: body.change.manifest,
  };
}

/** `st_owner` だけを足す差分。**これが `AC-G33` の主題である。** */
function addOwnerColumnDiff(diffId: string): Record<string, unknown> {
  return {
    diff_id: diffId,
    intent: "持ち主の列を後から足す",
    operations: [
      {
        op: "add_field",
        table: "notes",
        field: { id: "st_owner", name: "持ち主", type: "text" },
      },
    ],
  };
}

function tableRules(applied: AppliedManifest | undefined, table: string): LooseRule[] {
  const found: LooseRule[] = [];
  for (const role of applied?.app.roles ?? []) {
    for (const rule of role.rules ?? []) {
      if (rule.target === "table" && rule.table === table) {
        found.push(rule);
      }
    }
  }
  return found;
}

async function createRecord(
  cookie: string,
  title: string,
): Promise<{ status: number; id?: string; owner?: unknown }> {
  const res = await req(cookie, "POST", `/api/apps/${APP_ID}/tables/notes/records`, { title });
  if (res.status !== 201) {
    return { status: res.status };
  }
  const record = ((await res.json()) as { record: Record<string, unknown> }).record;
  return { status: 201, id: record._id as string, owner: record.st_owner };
}

// ---------------------------------------------------------------------------
// (1)(2) 知らせが出て、規則に条件が付く
// ---------------------------------------------------------------------------

test("(1) `add_field` で `st_owner` だけを足すと `role_condition_notices` が空でなくなる", async () => {
  await boot();
  // **着手前の実出力(逐語)**: `role_condition_notices: []`
  const applied = await postDiff(addOwnerColumnDiff("d-add-owner"));
  // **拒否ではない** —— **適用は今日どおり成立する。**
  expect(applied.status).toBe(201);
  expect(applied.notices.length).toBeGreaterThan(0);
  expect(applied.notices.every((notice) => notice.kind === "owner_scope_supplied")).toBe(true);
  // **既定3役割の `notes` の規則3本ちょうどに当たる**(`plain` の3本には当たらない)。
  expect(applied.notices.map((notice) => notice.role).sort()).toEqual([
    "editor",
    "owner",
    "viewer",
  ]);
  // **`path` は書いた `when` そのものを指す**(既存2種と同じ `/when` 付きの形である)。
  expect(applied.notices.every((notice) => notice.path.endsWith("/when"))).toBe(true);
});

test("(2) 適用後のマニフェストの `notes` の規則に条件が付いている", async () => {
  await boot();
  const applied = await postDiff(addOwnerColumnDiff("d-add-owner-2"));
  const rules = tableRules(applied.manifest, "notes");
  expect(rules).toHaveLength(3);
  for (const rule of rules) {
    // **補う条件は `defaultTableGrantPlan` が返すものそのものである**(2本目の式を作らない)。
    expect(rule.when).toEqual(SUPPLIED_WHEN);
  }
});

// ---------------------------------------------------------------------------
// (3) 本物のサーバ —— 他人の行を単件 GET すると 404
// ---------------------------------------------------------------------------

test("(3) 他人の行を単件 `GET` すると 404 になる(**着手前は 200 だった**)", async () => {
  await boot();
  expect((await postDiff(addOwnerColumnDiff("d-add-owner-3"))).status).toBe(201);

  const na = await createRecord((alice as Session).cookie, "Aのメモ");
  const nb = await createRecord((bob as Session).cookie, "Bのメモ");
  expect(na.status).toBe(201);
  expect(nb.status).toBe(201);
  expect(na.owner).toBe((alice as Session).userId);
  expect(nb.owner).toBe((bob as Session).userId);

  // **自分の行は今日どおり見える。**
  expect(
    (
      await req(
        (alice as Session).cookie,
        "GET",
        `/api/apps/${APP_ID}/tables/notes/records/${na.id}`,
      )
    ).status,
  ).toBe(200);
  // **他人の行は 404**(存在も伏せる。`ADR-0305` 限定11)。
  // **着手前の実出力(逐語)**: `alice GET bob's row -> 200` / `bob GET alice's row -> 200`
  expect(
    (
      await req(
        (alice as Session).cookie,
        "GET",
        `/api/apps/${APP_ID}/tables/notes/records/${nb.id}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (await req((bob as Session).cookie, "GET", `/api/apps/${APP_ID}/tables/notes/records/${na.id}`))
      .status,
  ).toBe(404);
});

// ---------------------------------------------------------------------------
// (4) 陰性対照 —— `st_owner` を持たない表には付かない
// ---------------------------------------------------------------------------

test("(4) `st_owner` を持たない表の規則には条件が付かず、知らせも出ない", async () => {
  await boot();
  const applied = await postDiff(addOwnerColumnDiff("d-add-owner-4"));
  for (const rule of tableRules(applied.manifest, "plain")) {
    expect(rule.when).toBeUndefined();
  }
  expect(applied.notices.some((notice) => notice.message.includes('"plain"'))).toBe(false);
});

// ---------------------------------------------------------------------------
// (5) 陰性対照2 —— 既に書いてある条件は1バイトも書き換わらない(`ADR-0318` 限定12)
// ---------------------------------------------------------------------------

test("(5) 既に `when` を書いてある規則は1バイトも書き換わらず、知らせにも載らない", async () => {
  await boot();
  const authored = { field: "title", equals: "公開" };
  const roles = [
    {
      id: "owner",
      name: "持ち主",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
        { target: "table", table: "notes", can: ["read", "write", "delete"], when: authored },
      ],
    },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
  ];
  const applied = await postDiff({
    diff_id: "d-authored",
    intent: "条件を自分で書いた規則を置き、同じ差分で持ち主の列を足す",
    operations: [
      { op: "set_roles", roles },
      {
        op: "add_field",
        table: "notes",
        field: { id: "st_owner", name: "持ち主", type: "text" },
      },
    ],
  });
  expect(applied.status).toBe(201);
  const rules = tableRules(applied.manifest, "notes");
  expect(rules).toHaveLength(1);
  // **作者が書いた条件がそのまま残っている** —— **上書きしない。**
  expect(rules[0]?.when).toEqual(authored);
  // **`owner_scope_supplied` の知らせは1件も出ない**(書いた規則は補完の対象外である)。
  expect(applied.notices.filter((notice) => notice.kind === "owner_scope_supplied")).toEqual([]);
});

// ---------------------------------------------------------------------------
// (6) 波及 —— 順序に依らない / 今日すでに黙って走っていた補完にも知らせが出る
// ---------------------------------------------------------------------------

test("(6) 同じ差分で `set_roles` を先に並べても補われ、知らせが出る(順序に依らない)", async () => {
  await boot();
  const roles = [
    {
      id: "owner",
      name: "持ち主",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
        { target: "table", table: "notes", can: ["read", "write", "delete"] },
      ],
    },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
  ];
  const applied = await postDiff({
    diff_id: "d-order",
    intent: "役割を先に置いてから持ち主の列を足す",
    operations: [
      { op: "set_roles", roles },
      {
        op: "add_field",
        table: "notes",
        field: { id: "st_owner", name: "持ち主", type: "text" },
      },
    ],
  });
  expect(applied.status).toBe(201);
  // **着手前は `set_roles` の時点の姿しか見えず、条件は1本も付かなかった**((o-11) の穴)。
  expect(tableRules(applied.manifest, "notes")[0]?.when).toEqual(SUPPLIED_WHEN);
  expect(applied.notices.map((notice) => notice.kind)).toEqual(["owner_scope_supplied"]);
  // **役割 `owner` にも出る** —— **カーネルが実際に書き換えたことを黙らない。**
  expect(applied.notices[0]?.role).toBe("owner");
});

test("(7) 今日すでに黙って走っていた `set_roles` 経由の補完にも、知らせが出る", async () => {
  await boot();
  // **先に `st_owner` を足しておく**(この差分でも補完と知らせが出る)。
  expect((await postDiff(addOwnerColumnDiff("d-pre"))).status).toBe(201);
  // **そのうえで条件なしの規則を置き直す** —— **着手前もここでは黙って補われていた
  // (実出力の逐語: `role_condition_notices: []` / `when=...` が付いた)。**
  const roles = [
    {
      id: "owner",
      name: "持ち主",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
        { target: "table", table: "notes", can: ["read", "write", "delete"] },
      ],
    },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
  ];
  const applied = await postDiff({
    diff_id: "d-silent",
    intent: "条件なしの規則を置き直す",
    operations: [{ op: "set_roles", roles }],
  });
  expect(applied.status).toBe(201);
  expect(applied.notices.map((notice) => notice.kind)).toEqual(["owner_scope_supplied"]);
  expect(tableRules(applied.manifest, "notes")[0]?.when).toEqual(SUPPLIED_WHEN);
});
