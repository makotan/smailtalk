/**
 * **MCP から積まれたコメントを読む**(`V10-M12-T01`。台帳 `CM-G7` = **限定採用**(門A)。
 * 門A 本審査 = `V10-M9`。`docs/adr/0368-mcp-comment-read-tool.md`)。
 *
 * ## この検査が固定するもの
 *
 * | 群 | 何を |
 * |---|---|
 * | (A) | **`list_comments` が器の行をそのまま返す** —— **`total` は切る前の可視集合の件数である** |
 * | (B) | **限定3 / 限定4 / 限定6** —— **ソースの上で固定する**(対照を必ず同じ検査の中に置く) |
 * | (C) | **名乗り** —— **名乗りが無ければ失敗し、名乗りが違えば返る集合も `total` も変わる** |
 *
 * ## **【必ず読むこと】名乗りは起動設定であって引数ではない**(`ADR-0327` の ③-1)
 *
 * **`ST_MCP_ACTOR` は起動時に一度だけ決める**(`D-V8-46`)。**したがって (C-2) は
 * サーバを2度起こして比べる** —— **`connectInMemory(actor)` は呼ばれるたびに
 * `createMcpServer({ actor })` を新しく作り、終わったら閉じる。**
 * **【禁止】道具の引数に主体を足さない**(`ADR-0368` 限定4)。
 *
 * ## 器を値 import している理由(**隠さずに書く**)
 *
 * **可視性の合成(`src/server/comment-visibility.ts`)は器を1度も開かない** ——
 * 呼び出し側が `comments` を渡す形である。**したがって題材を積むには器を開くしかない。**
 * **本ファイルは `src/kernel/comment-store.ts` を値として import しており、その1件が
 * `scripts/kernel-import-snapshot.txt` に載る**(`src/mcp/tools/read.ts` の側も同じ)。
 * **`src/mcp/tools/read-report.test.ts` の「カーネルから値を1つも import しない」という
 * 作法を、本ファイルは守っていない** —— **守ると題材を1件も積めないからである。**
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * - **ブラウザを1度も開いていない。** **HTTP の読出の口は今日1本も無い。**
 * - **本ファイルはプロセスを2つ起こしていない**(`InMemoryTransport` の直結である)。
 *   **実プロセスを2度起こした実測は `docs/plan/v10/records/v10-m12.md` に貼る。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CommentStore } from "../../kernel/comment-store.ts";
import { seedSession } from "../../server/test-helpers.ts";
import { createMcpServer } from "../server.ts";

const APP_ID = "shop";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";
/** 名乗りがあれば通る側(`create_app` は解決しない)。 */
const BOOTSTRAP_ACTOR = "bootstrap";
const READ_TS = join(dirname(fileURLToPath(import.meta.url)), "read.ts");

let dataRoot = "";
/** **運営**(`owner`)。**アプリの作りを書き換えられるので全件見える。** */
let admin: ReturnType<typeof seedSession>;
/** **客**(`customer`)。**`cart` の画面だけを読める。** */
let buyer: ReturnType<typeof seedSession>;
/** **通りすがり**(`viewer`)。**画面を1枚も読めない。** */
let stranger: ReturnType<typeof seedSession>;

async function connectInMemory(
  actor?: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(
    actor === undefined
      ? { dataRoot, previewBaseUrl: PREVIEW_BASE_URL }
      : { dataRoot, previewBaseUrl: PREVIEW_BASE_URL, actor },
  );
  const client = new Client({ name: "list-comments-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * **サーバを1つ起こし、道具を1回叩き、落とす。**
 *
 * **これが「起動時に一度だけ名乗る」の実物である** —— **2つの主体で比べるときは、
 * この関数を2度呼ぶ**(= サーバを2度起こす)。
 */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  actor?: string,
): Promise<CallToolResult> {
  const { client, close } = await connectInMemory(actor);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await close();
  }
}

function okData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
  }
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

type CommentRow = {
  id: string;
  appId: string;
  anchorForm: string;
  anchorParts: string[];
  body: string;
  createdAt: string;
};
type CommentsBody = { comments: CommentRow[]; total: number };

async function listComments(
  actor: string | undefined,
  args: Record<string, unknown> = {},
): Promise<CommentsBody> {
  return okData(
    await callTool("list_comments", { app_id: APP_ID, ...args }, actor),
  ) as unknown as CommentsBody;
}

/** 本文の集合で突き合わせる(`id` は uuid で、同時刻の並びは uuid 順になるため)。 */
function bodiesOf(body: CommentsBody): string[] {
  return body.comments.map((comment) => comment.body).sort();
}

/**
 * **`read.ts` から道具1本の範囲だけを切り出す。**
 *
 * **終端は「次の `server.registerTool(`」に統一する** —— 引数の折り返しに依らない。
 * **見つからなければ例外を投げる**(黙って全ファイルを走査して、対照ごと偽にしない)。
 */
function toolSource(name: string): string {
  const source = readFileSync(READ_TS, "utf-8");
  const opener = new RegExp(`server\\.registerTool\\(\\s*"${name}"`);
  const match = opener.exec(source);
  if (match === null) {
    throw new Error(`道具 "${name}" の登録が read.ts に見つからない(切り出しが壊れている)`);
  }
  const start = match.index;
  const next = source.indexOf("server.registerTool(", start + match[0].length);
  return source.slice(start, next < 0 ? source.length : next);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const setupViews = {
  diff_id: "setup-views",
  intent: "画面を2枚用意する",
  operations: [
    {
      op: "add_view",
      view: {
        id: "cart",
        type: "list_view",
        table: "items",
        name: "買い物かご",
        columns: ["title"],
      },
    },
    {
      op: "add_view",
      view: {
        id: "admin",
        type: "list_view",
        table: "items",
        name: "管理",
        columns: ["title"],
      },
    },
  ],
};

const setupTable = {
  diff_id: "setup-table",
  intent: "商品の表を1つ用意する",
  operations: [
    {
      op: "add_table",
      table: {
        id: "items",
        name: "商品",
        fields: [{ id: "title", name: "名前", type: "text", required: true }],
      },
    },
  ],
};

/**
 * **役割を書き戻す**(`add_view` が生やした規則を、この宣言でちょうどに固定する)。
 * **`owner` だけが `{target:"app"} × write` を持つ。**
 */
const setupRoles = {
  diff_id: "setup-roles",
  intent: "客は買い物かごの画面だけを読める形にする",
  operations: [
    {
      op: "set_roles",
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "items", can: ["read", "write", "delete"] },
            { target: "view", view: "cart", can: ["read"] },
            { target: "view", view: "admin", can: ["read"] },
          ],
        },
        {
          id: "customer",
          name: "客",
          rules: [
            { target: "table", table: "items", can: ["read"] },
            { target: "view", view: "cart", can: ["read"] },
          ],
        },
        // **既定の3役割は消せない**ので `editor` も書く。**本検査では1度も使わない。**
        { id: "editor", name: "係", rules: [{ target: "view", view: "cart", can: ["read"] }] },
        // **画面を1枚も読めない人。** `cart` は `customer` が名指ししているので管轄内であり、
        // この人は閉じる側に落ちる。**規則を0本にはできない**(語彙の検査が1件以上を要求する)
        // ので、**画面を1枚も名指ししない規則を1本だけ**書く。
        {
          id: "viewer",
          name: "通りすがり",
          rules: [{ target: "table", table: "items", can: ["read"] }],
        },
      ],
    },
  ],
};

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-mcp-list-comments-"));
  okData(await callTool("create_app", { name: "売店", app_id: APP_ID }, BOOTSTRAP_ACTOR));

  admin = seedSession(dataRoot, APP_ID, { username: "admin" });
  buyer = seedSession(dataRoot, APP_ID, { username: "buyer", role: "customer" });
  stranger = seedSession(dataRoot, APP_ID, { username: "stranger", role: "viewer" });

  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupTable }, admin.username));
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupViews }, admin.username));
  okData(await callTool("apply_diff", { app_id: APP_ID, diff: setupRoles }, admin.username));

  // **4件。** **`cart` 宛て2件 / `admin` 宛て1件 / アプリ全体宛て1件。**
  const store = CommentStore.openForKernel(dataRoot);
  try {
    store.addComment({
      appId: APP_ID,
      anchorForm: "view",
      anchorParts: ["cart"],
      body: "かごの画面が使いにくい",
    });
    store.addComment({
      appId: APP_ID,
      anchorForm: "view_action",
      anchorParts: ["cart", "checkout"],
      body: "会計のボタンが押しにくい",
    });
    store.addComment({
      appId: APP_ID,
      anchorForm: "view",
      anchorParts: ["admin"],
      body: "管理の一覧が長い",
    });
    store.addComment({
      appId: APP_ID,
      anchorForm: "app",
      anchorParts: [],
      body: "アプリ全体の名前を変えたい",
    });
  } finally {
    store.close();
  }
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// =====================================================================================
// (A) 返る形
// =====================================================================================

test("(A-1) list_comments は app_id だけで呼べ、器の行をそのまま返す", async () => {
  const body = await listComments(admin.username);
  expect(body.total).toBe(4);
  expect(bodiesOf(body)).toEqual(
    [
      "かごの画面が使いにくい",
      "会計のボタンが押しにくい",
      "管理の一覧が長い",
      "アプリ全体の名前を変えたい",
    ].sort(),
  );
  // **器の行そのものである**(写し替えていない)。
  // **【`V10-M13-T01`(2026-08-24。台帳 `CM-G10` / `ADR-0369`)。この検査の名前は1バイトも
  // 書き換えていない。本計画(`PLAN-M13.md` §3-1)はこのファイルを変更予定に挙げていなかった
  // ——`Comment` に `writer` が増えた波及で、この場所だけが赤くなった】**
  // **旧のキー(逐語。1バイトも消していない。`V10-M13-T01` より前の6本)**:
  //   ["anchorForm", "anchorParts", "appId", "body", "createdAt", "id"]
  // **`writer` が増えて7本になった。MCP はここに絞り込みの条件式を1つも持たない**
  // (limit の判定は今日も無いのと同じで、器が返した `Comment` をそのまま渡す)。
  // **【`V10-M13-T02`(2026-08-24。台帳 `CM-G19` / `ADR-0369`)。同じ理由でもう一度赤くなった。
  // この検査の名前も1バイトも書き換えていない。本計画(`PLAN-M13.md` §5)もこのファイルを
  // 変更予定に挙げていなかった ——`Comment` に `state` が増えた波及で、また同じ場所だけが
  // 赤くなった(`T01` の §4 が予告したとおりの型である)】**
  // **`writer` の7本(直上の逐語)から `state` が増えて8本になった。**
  // **【`V10-M13-T03`(2026-08-24。台帳 `CM-G20` / `ADR-0369`)。同じ理由でもう一度赤くなった。
  // この検査の名前も1バイトも書き換えていない。本計画(`PLAN-M13.md` §6)もこのファイルを
  // 変更予定に挙げていなかった ——`Comment` に `reason` が増えた波及で、また同じ場所だけが
  // 赤くなった(`T01` / `T02` の §4 が予告したとおりの型である)】**
  // **`state` の8本(直上の逐語)から `reason` が増えて9本になった。**
  // **【`V10-M15-T01`(2026-08-24。台帳 `CM-G14` / `ADR-0370`)。同じ理由でもう一度赤くなった。
  // この検査の名前も1バイトも書き換えていない。本計画(`PLAN-M15.md` §3-1 (c))はこの波及を
  // 予告している ——`Comment` に `diffId` が増えた波及で、また同じ場所だけが赤くなった
  // (`writer` → `state` → `reason` に続く**4世代目**である)。**
  // **`reason` の9本(直上の逐語)から `diffId` が増えて10本になった。**
  const row = body.comments.find((comment) => comment.anchorForm === "view_action");
  expect(Object.keys(row ?? {}).sort()).toEqual([
    "anchorForm",
    "anchorParts",
    "appId",
    "body",
    "createdAt",
    "diffId",
    "id",
    "reason",
    "state",
    "writer",
  ]);
  expect(row?.anchorParts).toEqual(["cart", "checkout"]);
  expect(row?.appId).toBe(APP_ID);
});

test("(A-2) total は limit / offset で切る前の件数である", async () => {
  const whole = await listComments(admin.username);
  const page = await listComments(admin.username, { limit: 1, offset: 1 });
  expect(page.comments).toHaveLength(1);
  // **切るのは `comments` だけである** —— **`total` は切る前のままである。**
  expect(page.total).toBe(4);
  expect(page.total).toBe(whole.total);
  // **`offset` が末尾を越えても `total` は動かない。**
  const beyond = await listComments(admin.username, { offset: 99 });
  expect(beyond.comments).toHaveLength(0);
  expect(beyond.total).toBe(4);
});

test("(A-3) anchor_form / view_id で絞り込める(絞りは道具が持ち、可視性の絞りは合成が持つ)", async () => {
  const byForm = await listComments(admin.username, { anchor_form: "view" });
  expect(bodiesOf(byForm)).toEqual(["かごの画面が使いにくい", "管理の一覧が長い"].sort());
  expect(byForm.total).toBe(2);

  const byView = await listComments(admin.username, { view_id: "cart" });
  expect(bodiesOf(byView)).toEqual(["かごの画面が使いにくい", "会計のボタンが押しにくい"].sort());
  expect(byView.total).toBe(2);

  // **両方渡すと `AND` である。**
  const both = await listComments(admin.username, { anchor_form: "view", view_id: "cart" });
  expect(bodiesOf(both)).toEqual(["かごの画面が使いにくい"]);
  expect(both.total).toBe(1);

  // **アプリ全体宛ては部品を1つも持たないので、`view_id` を渡すと1件も返らない。**
  const appForm = await listComments(admin.username, { anchor_form: "app" });
  expect(bodiesOf(appForm)).toEqual(["アプリ全体の名前を変えたい"]);
  expect(await listComments(admin.username, { anchor_form: "app", view_id: "cart" })).toMatchObject(
    {
      total: 0,
    },
  );
});

test("(A-4) 絞る前の集合は必ず可視集合である(絞りをすり抜けて見えない行が出る経路が無い)", async () => {
  // **客に見えるのは `cart` 宛ての2件だけである**(絞り無し = 母集団)。
  const visible = bodiesOf(await listComments(buyer.username));
  expect(visible).toEqual(["かごの画面が使いにくい", "会計のボタンが押しにくい"].sort());

  // **どの絞り方をしても、可視集合の外の行は1件も出ない。**
  const filters: Record<string, unknown>[] = [
    {},
    { anchor_form: "view" },
    { anchor_form: "view_action" },
    { anchor_form: "app" },
    { view_id: "cart" },
    { view_id: "admin" },
    { anchor_form: "view", view_id: "admin" },
    { limit: 99 },
    { offset: 0, limit: 99 },
  ];
  for (const filter of filters) {
    const body = await listComments(buyer.username, filter);
    for (const comment of body.comments) {
      expect(visible).toContain(comment.body);
    }
    expect(body.total).toBeLessThanOrEqual(visible.length);
  }

  // **陽性対照** —— **同じ絞りを運営で打つと、客には出なかった行が出る**
  //(すなわち上のループは「そもそも題材が無い」空振りではない)。
  const adminAdmin = await listComments(admin.username, { view_id: "admin" });
  expect(bodiesOf(adminAdmin)).toEqual(["管理の一覧が長い"]);
  expect(bodiesOf(await listComments(buyer.username, { view_id: "admin" }))).toEqual([]);
});

// =====================================================================================
// (B) ソースの上で固定する(限定3 / 限定4 / 限定6)
// =====================================================================================

test("(B-1) 【限定3】ハンドラは judgeRoleAccess を1度も呼ばず、可視性の合成1本だけを通る", () => {
  const subject = toolSource("list_comments");
  expect(occurrences(subject, "judgeRoleAccess(")).toBe(0);
  // **呼ぶのは合成1本ちょうどである。**
  expect(occurrences(subject, "visibleComments(")).toBe(1);
  // **陽性対照** —— **同じ切り出し・同じ数え方で `list_records` は2件返す**
  //(切り出しが壊れていれば、この行が先に落ちる)。
  expect(occurrences(toolSource("list_records"), "judgeRoleAccess(")).toBe(2);
});

test("(B-2) 【限定4】inputSchema のキーに actor / as / act_as / user / user_id / role / roles が1つも無い", async () => {
  const forbidden = ["actor", "as", "act_as", "user", "user_id", "role", "roles"];
  const carriesSubject = (keys: readonly string[]): boolean =>
    keys.some((key) => forbidden.includes(key));

  const { client, close } = await connectInMemory(admin.username);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "list_comments");
    expect(tool).toBeDefined();
    const keys = Object.keys(tool?.inputSchema?.properties ?? {});
    expect(keys.sort()).toEqual(["anchor_form", "app_id", "limit", "offset", "view_id"]);
    expect(carriesSubject(keys)).toBe(false);
  } finally {
    await close();
  }

  // **陰性対照** —— **今日、7語のどれかを引数に持つ道具は1本も無い**ので、
  // **偽物のキー並びを作って、この判定が本当に `true` を返すことを示す**
  //(「歯」を確かめないと、綴りを間違えた検査が緑のまま素通りする)。
  for (const word of forbidden) {
    expect(carriesSubject(["app_id", word])).toBe(true);
  }
});

test("(B-3) 【限定6】ハンドラは changelog を1度も読まない", () => {
  const subject = toolSource("list_comments");
  expect(occurrences(subject, "getChangelog(")).toBe(0);
  // **陽性対照** —— **同じ切り出し・同じ数え方で `get_changelog` は1件以上返す。**
  expect(occurrences(toolSource("get_changelog"), "getChangelog(")).toBeGreaterThanOrEqual(1);
});

// =====================================================================================
// (C) 名乗り
// =====================================================================================

test("(C-1) 名乗りが無いと isError を返す", async () => {
  const result = await callTool("list_comments", { app_id: APP_ID });
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { errors?: { message?: string }[] } | undefined;
  expect(structured?.errors?.length).toBeGreaterThan(0);
});

test("(C-2) 名乗りが違うと返る集合と total の両方が変わる", async () => {
  // **サーバを3度起こしている**(名乗りは起動時に一度だけ決まる)。
  const byAdmin = await listComments(admin.username);
  const byBuyer = await listComments(buyer.username);
  const byStranger = await listComments(stranger.username);

  expect(bodiesOf(byAdmin)).not.toEqual(bodiesOf(byBuyer));
  expect(bodiesOf(byBuyer)).toEqual(["かごの画面が使いにくい", "会計のボタンが押しにくい"].sort());
  expect(bodiesOf(byStranger)).toEqual([]);

  // **`total` も割れている**(`CM-G5` 限定5。件数は可視集合の長さから採る)。
  expect(byAdmin.total).toBe(4);
  expect(byBuyer.total).toBe(2);
  expect(byStranger.total).toBe(0);

  // **陰性対照** —— **同じ名乗りで2度起こすと同じ集合が返る**(揺れではない)。
  expect(bodiesOf(await listComments(buyer.username))).toEqual(bodiesOf(byBuyer));
});
// =====================================================================================
// (D) `V10-M27-T04` —— 規則を1本も書いていないアプリ(`ADR-0375`)
// =====================================================================================
//
// **実装は0バイトである。** **`list_comments` は可視性の合成
// (`src/server/comment-visibility.ts` の `visibleComments()`)を共有しているので、
// 合成に足した枝がそのまま MCP にも届く。** **`src/mcp/tools/read.ts` を1バイトも
// 書き換えていない。**
//
// **【「全員」の範囲は経路で違う。丸めない】**
// - **HTTP** の読出の口は、規則ゼロのアプリでは**未ログインにも開く**(401 にしない)。
// - **MCP** は**今日どおり名乗りが要る** —— **名乗りが無ければ、アプリが規則を1本も
//   書いていなくても断る**(下の (D-2))。 **断っているのは合成ではなく、その手前の
//   `requireActorAndApp` である。**
// **【禁止】「未ログインでも AI から読める」と書かない** —— **読めない。**

/**
 * **そのアプリの `manifest.json` から `roles` を丸ごと落とす。**
 *
 * **これは「役割の宣言を落とした古いアプリ」の実物である** —— **`create_app` は持ち主に
 * 規則を2行入れ、`set_roles` は既定3役割と持ち主の2行を必須にするので、`apply_diff` を
 * どう並べても規則ゼロには到達できない。** **到達できる形は「`roles` を1つも持たない
 * 定義」だけであり、それは今日も語彙の検査を通る**(`roles` は省略可)。
 * **カーネルの関数を1つも値 import していない** —— **読んで書くのは JSON ファイル1本である。**
 */
function stripRolesFromManifest(appId: string): void {
  const path = join(dataRoot, "apps", appId, "manifest.json");
  expect(existsSync(path)).toBe(true);
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as { app: Record<string, unknown> };
  // **陽性対照** —— 落とす前は規則が在る(落とすものが無い空振りではない)。
  expect(Array.isArray(manifest.app.roles)).toBe(true);
  delete manifest.app.roles;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

test("(D-1) 規則を1本も書いていないアプリでは、名乗りのある相手に全件返る", async () => {
  // 落とす前 —— 画面を1枚も読めない人には1件も見えない(着手前の実測)。
  expect(bodiesOf(await listComments(stranger.username))).toEqual([]);
  expect((await listComments(stranger.username)).total).toBe(0);

  stripRolesFromManifest(APP_ID);

  // 落とした後 —— **同じ名乗りで4件とも返る。**
  const after = await listComments(stranger.username);
  expect(after.total).toBe(4);
  expect(bodiesOf(after)).toEqual(
    [
      "かごの画面が使いにくい",
      "会計のボタンが押しにくい",
      "管理の一覧が長い",
      "アプリ全体の名前を変えたい",
    ].sort(),
  );
  // **運営でも客でも同じ4件である**(名乗りで割れなくなる)。
  expect(bodiesOf(await listComments(admin.username))).toEqual(bodiesOf(after));
  expect(bodiesOf(await listComments(buyer.username))).toEqual(bodiesOf(after));
});

test("(D-2) 陰性対照 —— 規則ゼロのアプリでも、名乗りが無ければ今日どおり断る", async () => {
  stripRolesFromManifest(APP_ID);
  const result = await callTool("list_comments", { app_id: APP_ID });
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { errors?: { message?: string }[] } | undefined;
  expect(structured?.errors?.length).toBeGreaterThan(0);
  // **陽性対照** —— 同じアプリ・同じ状態で、名乗れば4件返る(空振りではない)。
  expect((await listComments(stranger.username)).total).toBe(4);
});

test("(D-3) 絞り込みは規則ゼロのアプリでも今日どおり効く(開いたのは可否だけである)", async () => {
  stripRolesFromManifest(APP_ID);
  expect(bodiesOf(await listComments(stranger.username, { view_id: "admin" }))).toEqual([
    "管理の一覧が長い",
  ]);
  expect(bodiesOf(await listComments(stranger.username, { anchor_form: "app" }))).toEqual([
    "アプリ全体の名前を変えたい",
  ]);
});
