/**
 * 実物プレビュー選択の画面のテスト(V3-M4-T01 / D-G7。**門外 Δ7**)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m4.md` §2 の「V3-M4-T01」節、判定の正は
 * `docs/plan/v3/records/v3-m4-gate-a-intake.md` §3 と台帳 §8 の 2026-07-26 の D-G7 の行。
 *
 * ## 何を固定しているか
 *
 * 1. **入口は owner 限定である**(完了条件11)。既存の owner 限定 UI(ユーザ管理・接続の管理)と
 *    同じ置き方で、非 owner には出さない。
 *    **UI が押させないことはサーバ側の遮断の代わりにならない** —— `POST /api/apps/:app_id/diffs`
 *    は今日も認証を要求しない(v0 からの状態。本タスクは `src/server/` を1バイトも変えていない)。
 *    **したがってここで固定しているのは「押させない」ことだけであって、「叩けない」ことではない。**
 * **【V4-FIX1 項目(5) による改訂。上の記述は制定時のものであり1バイトも書き換えていない】**
 * **`POST /api/apps/:app_id/diffs` は今日、認証を要求する**(未認証 401 / owner 以外 403)。
 * **ユーザ決定「書き換えの口は塞ぐ …(必須)」の履行であり、担保はサーバ側にある。**
 * **それでも「安全にした」とは書かない** —— `GET /manifest` / `GET /changelog` /
 * `GET /undo/preview` / `GET /requirements` は今日も未認証で通り、MCP 経路は1ミリも守られない。
 * 2. **N 枚が同時に在る**(完了条件1 / D-M4-3)。切替式ではないので、DOM 上に候補と同数の枠が
 *    同時に存在する。
 * 3. **各枠に25スロットちょうどが inline style で立つ**(恒等写像。`AppWorkspace` の
 *    `AppThemeScope` と同じ規則。**2本目の変換規則を作らない**)。
 * 4. **枠の中身は当該アプリの実データである**(完了条件1 の「実物」の条件)。
 *    枠は同じ `ViewHost` を描き、レコードは製品と同じ API 経路から来る。
 * 5. **N 枚同時の代償を数える**(完了条件6 / D-M4-3)。**回数だけを数える。時間は測らない。**
 * 6. **適用は既存の差分1件である**(完了条件4 / 12)。web が送るのは `set_theme` 1 op で、
 *    `intent` は候補名とIDを含む機械生成の定型文である。
 *
 * ## このファイルが証明しないこと(誇張しない)
 *
 * - **並べた結果が見比べられることは証明していない。** happy-dom は CSS のカスケードも
 *   継承も解かないので、色が実際に違って見えることは分からない。**それは
 *   `web/e2e/theme-preview.e2e.ts`(chromium)の担当である。**
 * - **人間が「選べた」と感じたかは測っていない**(計画 §0-4 の3)。
 * - **時間は1秒も測っていない**(同 §0-4 の2)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Role } from "../../src/auth/types.ts";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { THEME_CANDIDATES } from "../src/theme-candidates.ts";
import { ADMIN_ROLES, grantRules, tableCan, viewRead } from "./role-rules.ts";

const APP_ID = "sample-app";
const REPO_ROOT = dirname(dirname(import.meta.dir));
const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "manifest.schema.json");

function themeSlotNames(): string[] {
  const schema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf-8")) as {
    $defs: { theme: { properties: Record<string, unknown> } };
  };
  return Object.keys(schema.$defs.theme.properties);
}

function sampleManifest(): Manifest {
  const manifest: Manifest = {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [{ id: "label", name: "ラベル", type: "text", required: true }],
        },
      ],
      views: [
        {
          id: "entry-list",
          name: "エントリ一覧",
          type: "list_view",
          table: "entries",
          columns: ["label"],
        },
      ],
    },
  };
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】画面の既定が「閉じる」側へ倒れた。**
  //
  // **着手前の逐語(1バイトも消していない): この題材は `app.roles` を1つも持たず、
  // それでも `ViewHost` が `entry-list` を描いていた。** **今日は描かない** ——
  // **`web/src/auth/authz.tsx` の `canUseView` は `judgeRoleAccess` を呼び、
  // 「その画面を名指しした規則が1本も無い」ものを拒否する**(役割を1つも宣言していない
  // アプリも同じく閉じる)。**その結果プレビューの枠の中身が空になり、枠そのものにも
  // 到達しなくなっていた。**
  //
  // **足すのは画面 `entry-list` の読取と、表 `entries` の読取だけである** ——
  // **この検査の主題はテーマの枠と適用経路であって権限ではない。書込・削除・ボタン・項目の
  // 規則は1本も足さない。** **判定は1バイトも緩めていない(足すのは題材の側の宣言だけ)。**
  return grantRules(manifest, ADMIN_ROLES, [viewRead("entry-list"), tableCan("entries", "read")]);
}

/** このアプリの実データ(サンプルデータではないことを、値の字面で見分ける)。 */
const REAL_ROW = {
  _id: "entry-0001",
  _created_at: "",
  _updated_at: "",
  label: "実データの行",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { url: string; method: string; body: string | undefined };

let originalFetch: typeof fetch;
let calls: Call[];
/** 差分 POST の応答(既定は 201。失敗系のテストだけ差し替える)。 */
let diffResponse: () => Response;

function stubFetch(role: Role = "owner"): void {
  calls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input);
    const url = raw.split("?")[0] ?? raw;
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(
        jsonResponse({ user: { id: "u1", username: "alice", displayName: null, role } }),
      );
    }
    if (url === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(jsonResponse(sampleManifest()));
    }
    if (url === `/api/apps/${APP_ID}/tables/entries/records`) {
      return Promise.resolve(jsonResponse({ records: [REAL_ROW], total: 1 }));
    }
    if (url === `/api/apps/${APP_ID}/diffs` && method === "POST") {
      return Promise.resolve(diffResponse());
    }
    return Promise.resolve(
      jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404),
    );
  }) as typeof fetch;
}

/** レコード取得の呼び出し回数(N 倍化を数える対象)。 */
function recordCallCount(): number {
  return calls.filter((call) => call.url.includes("/tables/") && call.method === "GET").length;
}

/** 枠の inline style に立っているカスタムプロパティ。 */
function injectedProperties(element: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of (element.getAttribute("style") ?? "").split(";")) {
    const text = chunk.trim();
    if (text === "") continue;
    const colon = text.indexOf(":");
    const name = text.slice(0, colon).trim();
    if (!name.startsWith("--")) continue;
    out[name] = text.slice(colon + 1).trim();
  }
  return out;
}

async function openWorkspace(role: Role = "owner", path = `/apps/${APP_ID}`): Promise<void> {
  window.history.replaceState({}, "", path);
  stubFetch(role);
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  diffResponse = () => jsonResponse({ change: { entry: { diff_id: "theme-x" } } }, 201);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

// ---------------------------------------------------------------------------
// 1. 入口(完了条件11)
// ---------------------------------------------------------------------------

describe("入口は owner 限定である(完了条件11)", () => {
  test("owner には導線が出る", async () => {
    await openWorkspace("owner");
    expect(screen.getByTestId("open-theme-preview")).toBeDefined();
  });

  test("editor / viewer / customer には導線が出ない", async () => {
    for (const role of ["editor", "viewer", "customer"] as const) {
      await openWorkspace(role);
      expect(screen.queryByTestId("open-theme-preview")).toBeNull();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. N 枚同時(完了条件1 / D-M4-3)
// ---------------------------------------------------------------------------

describe("候補が同時に並ぶ(切替式にしない)", () => {
  test("候補と同数の枠が同時に存在し、候補IDが1件ずつ対応する", async () => {
    await openWorkspace("owner");
    fireEvent.click(screen.getByTestId("open-theme-preview"));

    const frames = await screen.findAllByTestId("theme-preview-frame");
    expect(frames.length).toBe(THEME_CANDIDATES.length);
    expect(frames.map((frame) => frame.getAttribute("data-candidate-id"))).toEqual(
      THEME_CANDIDATES.map((candidate) => candidate.id),
    );
    // 候補の名前も同時に読める(どれがどれか分かる)。
    for (const candidate of THEME_CANDIDATES) {
      expect(screen.getAllByText(candidate.name).length).toBeGreaterThan(0);
    }
  });

  test("各枠に25スロットちょうどが inline style で立つ(恒等写像)", async () => {
    await openWorkspace("owner");
    fireEvent.click(screen.getByTestId("open-theme-preview"));
    const frames = await screen.findAllByTestId("theme-preview-frame");

    const expected = themeSlotNames().sort();
    frames.forEach((frame, index) => {
      const injected = injectedProperties(frame);
      expect(Object.keys(injected).sort()).toEqual(expected);
      expect(injected).toEqual({ ...THEME_CANDIDATES[index]?.slots });
    });
  });

  test("枠の中身は当該アプリの実データである(サンプルデータではない)", async () => {
    await openWorkspace("owner");
    fireEvent.click(screen.getByTestId("open-theme-preview"));
    await screen.findAllByTestId("theme-preview-frame");

    // 実データの値が枠の数だけ出る(枠ごとに同じ行が描かれている)。
    await waitFor(() => {
      expect(screen.getAllByText(REAL_ROW.label).length).toBe(THEME_CANDIDATES.length);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. N 倍化の実測(完了条件6 / D-M4-3 の代償)
// ---------------------------------------------------------------------------

describe("N 枚同時の代償を数える(回数だけ。時間は測らない)", () => {
  test("プレビューを開くとレコード取得の回数が候補数の倍だけ増える", async () => {
    await openWorkspace("owner", `/apps/${APP_ID}/views/entry-list`);
    // 1画面ぶんの取得が終わるのを待つ。
    await waitFor(() => expect(recordCallCount()).toBeGreaterThan(0));
    const single = recordCallCount();

    fireEvent.click(screen.getByTestId("open-theme-preview"));
    await screen.findAllByTestId("theme-preview-frame");
    await waitFor(() => {
      expect(recordCallCount()).toBe(single + single * THEME_CANDIDATES.length);
    });

    // 実測値をそのまま固定する(記録に書く数字はこの2つである)。
    expect(single).toBe(1);
    expect(recordCallCount()).toBe(1 + 3);
  });
});

// ---------------------------------------------------------------------------
// 4. 適用(完了条件4 / 12)
// ---------------------------------------------------------------------------

describe("選んだ候補を既存の差分経路で適用する", () => {
  test("差分の POST は1回だけで、set_theme 1 op と機械生成の intent を運ぶ", async () => {
    await openWorkspace("owner");
    fireEvent.click(screen.getByTestId("open-theme-preview"));
    const frames = await screen.findAllByTestId("theme-preview-frame");

    const candidate = THEME_CANDIDATES[1];
    if (candidate === undefined) {
      throw new Error("候補が2件未満");
    }
    const apply = frames[1]?.querySelector('[data-testid="apply-theme-candidate"]');
    if (apply === null || apply === undefined) {
      throw new Error("適用ボタンが無い");
    }
    fireEvent.click(apply);

    await waitFor(() => {
      expect(calls.filter((call) => call.method === "POST").length).toBe(1);
    });
    const posted = calls.find((call) => call.method === "POST");
    expect(posted?.url).toBe(`/api/apps/${APP_ID}/diffs`);
    const body = JSON.parse(posted?.body ?? "{}") as {
      diff_id: string;
      intent: string;
      operations: { op: string; theme: { slots: Record<string, string> } }[];
    };
    expect(body.operations.length).toBe(1);
    expect(body.operations[0]?.op).toBe("set_theme");
    expect(body.operations[0]?.theme.slots).toEqual({ ...candidate.slots });
    expect(body.intent).toContain(candidate.name);
    expect(body.diff_id).toContain(candidate.id);

    // 結果を黙って隠さない(何が起きたかを画面に出す)。
    await waitFor(() => {
      expect(screen.getByTestId("theme-preview-result")).toBeDefined();
    });
  });

  test("サーバが拒否したらエラーを画面に出す(黙って成功にしない)", async () => {
    await openWorkspace("owner");
    diffResponse = () =>
      jsonResponse({ errors: [{ path: "/app/theme", message: "拒否しました。" }] }, 400);
    fireEvent.click(screen.getByTestId("open-theme-preview"));
    const frames = await screen.findAllByTestId("theme-preview-frame");
    const apply = frames[0]?.querySelector('[data-testid="apply-theme-candidate"]');
    if (apply === null || apply === undefined) {
      throw new Error("適用ボタンが無い");
    }
    fireEvent.click(apply);

    await waitFor(() => {
      expect(screen.getByText("拒否しました。")).toBeDefined();
    });
    expect(screen.queryByTestId("theme-preview-result")).toBeNull();
  });

  test("閉じるとワークスペースへ戻る", async () => {
    await openWorkspace("owner");
    fireEvent.click(screen.getByTestId("open-theme-preview"));
    await screen.findAllByTestId("theme-preview-frame");
    fireEvent.click(screen.getByTestId("close-theme-preview"));
    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
    expect(screen.queryAllByTestId("theme-preview-frame").length).toBe(0);
  });
});
