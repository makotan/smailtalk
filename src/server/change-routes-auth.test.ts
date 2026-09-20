/**
 * **読み物3本の認証境界**(`V17-M4-T02` / 台帳 `AC-G20`。計画 `docs/plan/v17/05-v17-m4-plan.md` §2b の 2)。
 *
 * ## この検査が撃つもの
 *
 * **`GET /api/apps/:app_id/changelog` / `GET .../undo/preview` / `GET .../requirements` の3本は、
 * 着手前(2026-09-08)まで cookie を1つも載せずに 200 が返っていた。** 本ファイルはその3本に
 * 認証を要求させ、**未ログインでは 401** になることを撃つ。
 *
 * ## **この検査が主張しないこと(丸めない)**
 *
 * - **「未ログインで読める口を塞いだ」ではない。** **`GET /api/apps`(アプリの一覧)/
 *   `GET .../public` / `GET .../files/:file_id` / `GET .../views/:view_id/custom.css` /
 *   `POST .../comments` は今日どおり未ログインで通る。** 書けるのは「関門が1本も無い8本のうち
 *   3本を閉じた」までである(数え直しは `docs/plan/v17/records/v17-m4.md` §0-8)。
 * - **MCP の道具(`get_changelog` / `preview_undo` / `generate_requirements_doc`)を1バイトも
 *   塞いでいない。** **同じ3つの読み物は MCP の道具として今日どおり読める。**
 * - **`runner` プロファイルの挙動は1ミリも変えていない** —— **3本はもともと `runner` に
 *   登録されておらず、今日どおり 404 である**((C-3) が撃つ)。
 *
 * ## 着手前の値をこのファイルが新規に採った理由
 *
 * **ログイン済みの `requirements` の応答本文を撃つ検査は、着手前の `src/server/` に1本も
 * 無かった**(実施担当が走査した)。**「応答本文が着手前と1バイトも変わらない」を測る基準が
 * 存在しないので、本ファイルが着手前に採って凍結した。**
 *
 * **時刻依存のキーは無い** —— **`generated_at` のようなキーは1つも無く、揺れるのは
 * `applied_at`(changelog / preview / requirements の本文に埋まる ISO 文字列)だけである。**
 * **したがって ISO のタイムスタンプだけを `<TS>` に置き換えたうえで、
 * 残り全部をバイト単位(長さと sha256)で凍結する。** **2回続けて起こして同じ値になることも
 * 着手前に確かめた。**
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "./app.ts";
import { authed, seedSession } from "./test-helpers.ts";

const APP_ID = "chauth";
const PREVIEW_BASE_URL = "http://127.0.0.1:3000";
/** 名乗りがあれば通る側(`create_app` は利用者を解決しない)。 */
const BOOTSTRAP_ACTOR = "bootstrap";

/**
 * **土台はカーネルの関数ではなく MCP の道具(`create_app` / `apply_diff`)で組む** ——
 * **`scripts/kernel-import-drift.test.ts`(層またぎのスナップショット)を、この検査のためだけに
 * 太らせないためである**(`src/server/report-view-access.test.ts` と同じ判断)。
 * **本ファイルは `src/kernel/` から値を1つも import していない。**
 */
const SETUP_DIFF = {
  diff_id: "setup",
  intent: "メモの表と一覧の画面を用意する",
  operations: [
    {
      op: "add_table",
      table: {
        id: "memo",
        name: "メモ",
        fields: [{ id: "title", name: "見出し", type: "text", required: true }],
      },
    },
    {
      op: "add_view",
      view: { id: "memo_list", type: "list_view", table: "memo", columns: ["title"] },
    },
  ],
};

/** 変更履歴と undo の対象を1件作るための差分(未ログインで何が読めていたかの題材)。 */
const ADD_NOTE_DIFF = {
  diff_id: "add-note",
  intent: "一覧でメモを見たいという要望に応えて、メモ欄を足した",
  operations: [
    { op: "add_field", table: "memo", field: { id: "note", name: "メモ", type: "long_text" } },
    { op: "update_view", view: "memo_list", changes: { columns: ["title", "note"] } },
  ],
};

/** **サーバを1つ起こし、道具を1回叩き、落とす**(名乗りは起動設定である。`ADR-0327` の ③-1)。 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  actor: string,
): Promise<CallToolResult> {
  const server = createMcpServer({ dataRoot, previewBaseUrl: PREVIEW_BASE_URL, actor });
  const client = new Client({ name: "change-routes-auth-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError === true) {
      throw new Error(`ツールが失敗した: ${JSON.stringify(result.structuredContent)}`);
    }
    return result;
  } finally {
    await client.close();
    await server.close();
  }
}

const changelogPath = (appId: string = APP_ID) => `/api/apps/${appId}/changelog`;
const previewPath = (appId: string = APP_ID) => `/api/apps/${appId}/undo/preview`;
const requirementsPath = (appId: string = APP_ID) => `/api/apps/${appId}/requirements`;

/**
 * **着手前(2026-09-08。実装を1バイトも書く前)に実施担当が採った、ログイン済みの応答本文。**
 *
 * **測り方**: 応答本文の文字列から ISO のタイムスタンプ(`\d{4}-..T..:..:..\.\d{3}Z`)だけを
 * `<TS>` に置き換え、その UTF-8 バイト数と sha256 を採る。**それ以外は1バイトも触っていない。**
 */
const FROZEN_AUTHED_BODIES: ReadonlyArray<{
  readonly label: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}> = [
  {
    label: "changelog",
    path: changelogPath(),
    bytes: 1155,
    sha256: "36cb953f9fe2c5e672f008317583f894ed66d7eaae3aa871c5ff23d6be1dd88b",
  },
  {
    label: "undo/preview",
    path: previewPath(),
    bytes: 791,
    sha256: "1692913377c6139a1d06a9a0b316cdf4ab115611e3c1472d6d75a39f8060acab",
  },
  {
    label: "requirements?format=json",
    path: `${requirementsPath()}?format=json`,
    bytes: 24505,
    sha256: "1c5c1c0d8902c379f53d11e3e8ee4c3b09b054a771ddbf4f624086cdceaff936",
  },
  {
    label: "requirements(既定 = markdown)",
    path: requirementsPath(),
    bytes: 13871,
    sha256: "57b9035eeefaecc264804e376286a303980fa1619cf3af8d4cb0f76b02417fbe",
  },
];

/** 着手前に採った要件定義書の文の並び(42本ちょうど)。 */
const FROZEN_STATEMENT_IDS: readonly string[] = Array.from(
  { length: 42 },
  (_, i) => `S-${String(i + 1).padStart(3, "0")}`,
);

/** タイムスタンプだけを畳んだ本文(凍結の測り方そのもの)。 */
function normalize(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TS>");
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;
let cookie: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-change-routes-auth-"));
  await callTool("create_app", { name: "認証境界確認", app_id: APP_ID }, BOOTSTRAP_ACTOR);
  const admin = seedSession(dataRoot, APP_ID, { username: "admin" });
  cookie = admin.cookie;
  // 変更履歴を2件と、戻せる差分を1件作る(未ログインで「何が読めていたか」を撃つ題材)。
  await callTool("apply_diff", { app_id: APP_ID, diff: SETUP_DIFF }, admin.username);
  await callTool("apply_diff", { app_id: APP_ID, diff: ADD_NOTE_DIFF }, admin.username);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** **cookie を1つも載せずに叩く。** */
function anonymous(path: string): Promise<Response> {
  return Promise.resolve(app.request(path));
}

describe("AC-G20 未ログインの読み物3本(着手前は 200 が返っていた)", () => {
  test("(A-1) 未ログインの GET /changelog は 401 になる", async () => {
    const res = await anonymous(changelogPath());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { errors: Array<{ message: string }> };
    expect(body.errors[0]?.message).toBe("認証が必要です。ログインしてください。");
  });

  test("(A-2) 未ログインの GET /undo/preview は 401 になる", async () => {
    const res = await anonymous(previewPath());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { errors: Array<{ message: string }> };
    expect(body.errors[0]?.message).toBe("認証が必要です。ログインしてください。");
  });

  test("(A-3) 未ログインの GET /requirements は 401 になる(json も markdown も)", async () => {
    for (const path of [`${requirementsPath()}?format=json`, requirementsPath()]) {
      const res = await anonymous(path);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { errors: Array<{ message: string }> };
      expect(body.errors[0]?.message).toBe("認証が必要です。ログインしてください。");
    }
  });
});

describe("AC-G20 陰性対照(着手後も着手前と1ミリも変わらないもの)", () => {
  test("(C-1) ログイン済みの応答本文は着手前と1バイトも変わらない(4本とも)", async () => {
    const measured: Array<{ label: string; status: number; bytes: number; sha256: string }> = [];
    for (const frozen of FROZEN_AUTHED_BODIES) {
      const res = await app.request(authed(cookie)(frozen.path));
      const text = normalize(await res.text());
      measured.push({
        label: frozen.label,
        status: res.status,
        bytes: Buffer.byteLength(text, "utf-8"),
        sha256: createHash("sha256").update(text, "utf-8").digest("hex"),
      });
    }
    expect(measured).toEqual(
      FROZEN_AUTHED_BODIES.map((f) => ({
        label: f.label,
        status: 200,
        bytes: f.bytes,
        sha256: f.sha256,
      })),
    );
  });

  test("(C-1b) ログイン済みの要件定義書の形(キーと文の並び)も着手前と同じ", async () => {
    const res = await app.request(authed(cookie)(`${requirementsPath()}?format=json`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      requirements: {
        app_id: string;
        format: string;
        section: unknown;
        statements: Array<{ id: string }>;
      };
    };
    expect(Object.keys(body)).toEqual(["requirements"]);
    expect(Object.keys(body.requirements)).toEqual([
      "app_id",
      "format",
      "section",
      "statements",
      "markdown",
      "identifiers",
    ]);
    expect({
      app_id: body.requirements.app_id,
      format: body.requirements.format,
      section: body.requirements.section,
    }).toEqual({ app_id: APP_ID, format: "json", section: null });
    expect(body.requirements.statements.map((s) => s.id)).toEqual([...FROZEN_STATEMENT_IDS]);
  });

  test("(C-2) 存在しないアプリへの未ログイン要求は今日どおり 404(関門はアプリの実在を先に見る)", async () => {
    for (const path of [
      changelogPath("no-such-app"),
      previewPath("no-such-app"),
      requirementsPath("no-such-app"),
    ]) {
      const res = await anonymous(path);
      expect(res.status).toBe(404);
    }
  });

  test("(C-3) runner プロファイルでは3本とも今日どおり 404 + 本文マーカーである", async () => {
    const runnerRoot = await mkdtemp(join(tmpdir(), "gp-change-routes-auth-runner-"));
    try {
      const runner = createServerApp({ dataRoot: runnerRoot, profile: "runner" });
      for (const path of [changelogPath(), previewPath(), requirementsPath()]) {
        const res = await runner.request(path);
        expect(res.status).toBe(404);
        const body = (await res.json()) as { errors: Array<{ message: string }> };
        expect(body.errors[0]?.message).toContain("に対応するエンドポイントはありません");
      }
    } finally {
      await rm(runnerRoot, { recursive: true, force: true });
    }
  });
});
