/**
 * 取り込みの入口(owner 確認 UI)のテスト(V3-M6-T02 / D-G9。**門A / 将来送り**)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m6.md` §2 の「V3-M6-T02」節(10点)、審査の正は
 * `docs/plan/v3/records/v3-m6-gate-a.md` §4(判定)と **§8-1(越えてはならない線12点)**、
 * 入口/出口の非対称の決定の正は `docs/plan/v3/records/v3-m6-gate-a-import.md` §4-2。
 *
 * ## 何を固定しているか
 *
 * 1. **入口は owner 限定である**(`AppWorkspace` の `isOwner` 分岐)。**ただしこれは遮断ではない**
 *    —— `POST /api/apps/:app_id/diffs` は**誰でも書ける**(実測値は実施記録 §4。未認証 /
 *    viewer / customer / editor の4通りとも **201**)。**固定しているのは「押させない」ことだけで
 *    あって「叩けない」ことではない。**
 * 2. **適用の前にプレビューが見られる**(完了条件2)。プレビューは既存の `AppThemeScope`
 *    (`web/src/AppWorkspace.tsx`)と既存の `ViewHost` で描く。**新しいレンダラーを作っていない。**
 * 3. **コントラスト検査に落ちる値は、理由が見える形で拒否される**(完了条件3。fail-closed かつ
 *    loud)。**画面に出るのはカーネル(`src/kernel/theme-contrast.ts`)が作った文そのまま**である
 *    —— このファイルはスタブの応答を**カーネルの `checkThemeContrast` に作らせる**ので、
 *    「テストが自分で書いた文をテストが確かめる」循環になっていない。
 * 4. **web 側にコントラスト検査の写しを作っていない**(線10)—— 落ちる値でもプレビューは出る。
 *    **判定はサーバの1箇所だけにある。**
 * 5. **`theme.json` を出す口を1つも置いていない**(線9。理由4点は審査本体 §4-2)。
 * 6. **候補プレビューの候補集合に結線していない**(線8)。
 *
 * ## このファイルが証明しないこと(誇張しない)
 *
 * - **owner 確認が構造の担保であることは1点も証明していない。** 会話側 AI は今日も
 *   `apply_diff` の `set_theme` で直接テーマを書ける。**この画面はその経路を1本も塞がない。**
 * - **画面が実際にどう見えるかは分からない。** happy-dom は CSS のカスケードも継承も解かない。
 *   **chromium の実測は V3-M6-T04 の担当である。**
 * - **抽出の正しさは1件も検証していない**(`v3-m6.md` §0-4 の5)。貼る25値は
 *   **T01 が `fixtures/theme-import/brand-guide.md` から取り出したもの**であり、
 *   「どの記述をどのスロットに当てるべきか」を判定する機械は1つも無い。
 * - **本物の LLM を1度も呼んでいない**(同 §0-4 の1)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Role } from "../../src/auth/types.ts";
import { checkThemeContrast } from "../../src/kernel/theme-contrast.ts";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { parseImportedTheme, themeImportDiff } from "../src/ThemeImportPanel.tsx";
import { THEME_CANDIDATES } from "../src/theme-candidates.ts";
import { ADMIN_ROLES, grantRules, tableCan, viewRead } from "./role-rules.ts";

const APP_ID = "sample-app";
const REPO_ROOT = dirname(dirname(import.meta.dir));
const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "manifest.schema.json");
const BRAND_GUIDE_PATH = join(REPO_ROOT, "fixtures", "theme-import", "brand-guide.md");
const PANEL_SOURCE_PATH = join(dirname(import.meta.dir), "src", "ThemeImportPanel.tsx");

/** `$defs/theme` の properties キー(**ファイルとして読む**。ADR-0009 限定2)。 */
function themeSlotNames(): string[] {
  const schema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf-8")) as {
    $defs: { theme: { properties: Record<string, unknown> } };
  };
  return Object.keys(schema.$defs.theme.properties);
}

/**
 * 貼り付ける25スロットの実値。
 *
 * **V3-M6-T01 が `fixtures/theme-import/brand-guide.md` から取り出した25値と同一である**
 * (`web/test/theme-import.test.ts` の `IMPORTED_SLOTS`)。**製品コードには1バイトも入れない**
 * —— 入れると「この製品が持つ候補の表」になり、線8 と ADR-0054 の緊張に触れる。
 *
 * **T01 の値と字面が同じであることは、下の「資産との対応」の describe が資産の側で照合する**
 * (T01 と同型の非循環な根拠。**テストがテストを参照する形にしない**)。
 */
const IMPORTED_SLOTS: Record<string, string> = {
  "--color-text": "#14281d",
  "--color-text-secondary": "#405146",
  "--color-text-label": "#33443a",
  "--color-text-placeholder": "#4d5e53",
  "--color-danger": "#8c1d18",
  "--color-page-background": "#fffdf8",
  "--color-surface-highlight": "#eef2ea",
  "--color-border": "#6b7a70",
  "--focus-outline-color": "#1a5fb4",
  "--focus-outline-width": "2px",
  "--font-family-base": "Hiragino Sans, Yu Gothic, sans-serif",
  "--font-size-secondary": "0.875rem",
  "--font-size-note": "0.75rem",
  "--line-height-base": "1.7",
  "--space-1": "0.25rem",
  "--space-2": "0.5rem",
  "--space-3": "0.75rem",
  "--space-4": "1rem",
  "--space-5": "1.5rem",
  "--space-6": "2.5rem",
  "--border-width": "1px",
  "--control-border-radius": "6px",
  "--surface-shadow": "0 1px 2px #14281d1a",
  "--detail-label-width": "9rem",
  "--login-max-width": "24rem",
};

/**
 * コントラスト検査に落ちる25スロット。**落ちることをカーネルに確かめさせる**(下のテスト)。
 * 前景を地色とほぼ同じにしただけで、他は上の値と同じである。
 */
const UNREADABLE_SLOTS: Record<string, string> = {
  ...IMPORTED_SLOTS,
  "--color-text": "#fffcf5",
  "--color-text-secondary": "#fffcf5",
  "--color-text-label": "#fffcf5",
  "--color-text-placeholder": "#fffcf5",
  "--color-danger": "#fffcf5",
  "--color-border": "#fffdf8",
  "--focus-outline-color": "#fffdf8",
};

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
  // それでも取り込みの画面のプレビュー枠が `ViewHost` で `entry-list` を描いていた。**
  // **今日は描かない** —— **`web/src/auth/authz.tsx` の `canUseView` は
  // `judgeRoleAccess` を呼び、「その画面を名指しした規則が1本も無い」ものを拒否する**
  // (役割を1つも宣言していないアプリも同じく閉じる)。
  //
  // **足すのは画面 `entry-list` の読取と、表 `entries` の読取だけである** ——
  // **この検査の主題は取り込みの入口・プレビュー・拒否の見え方であって権限ではない。
  // 書込・削除・ボタン・項目の規則は1本も足さない。**
  // **判定は1バイトも緩めていない(足すのは題材の側の宣言だけ)。**
  return grantRules(manifest, ADMIN_ROLES, [viewRead("entry-list"), tableCan("entries", "read")]);
}

/** プレビューの枠の中身が「このアプリの実データ」であることを字面で見分ける。 */
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
/** 差分 POST の応答(既定は 201。拒否のテストだけ差し替える)。 */
let diffResponse: () => Response;

function stubFetch(role: Role): void {
  calls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input);
    const url = raw.split("?")[0] ?? raw;
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    // アプリ切替(シェル)の一覧。**stub しないと `errors` の器が画面に1つ増え、
    // 「エラーが出ていない」ことを見る検査が別の理由で赤くなる。**
    if (url === "/api/apps") {
      return Promise.resolve(
        jsonResponse({
          apps: [
            {
              app_id: APP_ID,
              name: "サンプル",
              created_at: "2026-01-01T00:00:00Z",
              status: "active",
            },
          ],
        }),
      );
    }
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

function diffCalls(): Call[] {
  return calls.filter((call) => call.url.endsWith("/diffs") && call.method === "POST");
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

async function openWorkspace(role: Role = "owner"): Promise<void> {
  window.history.replaceState({}, "", `/apps/${APP_ID}`);
  stubFetch(role);
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
}

/** 取り込みの画面を開く(owner 限定)。 */
async function openImportPanel(): Promise<void> {
  await openWorkspace("owner");
  fireEvent.click(screen.getByTestId("open-theme-import"));
  await waitFor(() => expect(screen.getByTestId("theme-import")).toBeDefined());
}

/** 提案を貼って「プレビューする」を押す。 */
function paste(text: string): void {
  fireEvent.change(screen.getByTestId("theme-import-json"), { target: { value: text } });
  fireEvent.click(screen.getByTestId("preview-theme-import"));
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  diffResponse = () => jsonResponse({ change: { entry: { diff_id: "theme-import-1" } } }, 201);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

// ---------------------------------------------------------------------------
// 1. 入口(完了条件1)
// ---------------------------------------------------------------------------

describe("入口(完了条件1。出口と対になる位置に置く)", () => {
  test("owner には導線が出て、押すと取り込みの画面が開き、閉じると画面一覧に戻る", async () => {
    await openWorkspace("owner");
    fireEvent.click(screen.getByTestId("open-theme-import"));
    await waitFor(() => expect(screen.getByTestId("theme-import")).toBeDefined());

    fireEvent.click(screen.getByTestId("close-theme-import"));
    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
  });

  test("editor / viewer / customer には導線が出ない(**遮断ではない。押させないだけである**)", async () => {
    for (const role of ["editor", "viewer", "customer"] as const) {
      await openWorkspace(role);
      expect(screen.queryByTestId("open-theme-import")).toBeNull();
      cleanup();
    }
  });

  test("出口(持ち出し)の導線は今日も在る —— 入口が出口を置き換えたのではない", async () => {
    await openWorkspace("owner");
    expect(screen.getByTestId("open-theme-export")).toBeDefined();
    expect(screen.getByTestId("open-theme-import")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. プレビュー(完了条件2)
// ---------------------------------------------------------------------------

describe("適用の前にプレビューが見られる(完了条件2。新しいレンダラーを作らない)", () => {
  test("25スロットちょうどが枠の inline style に立ち、名前の集合が $defs/theme と完全一致する", async () => {
    await openImportPanel();
    paste(JSON.stringify(IMPORTED_SLOTS));

    const frame = await screen.findByTestId("theme-import-preview");
    const injected = injectedProperties(frame);
    expect(Object.keys(injected).sort()).toEqual(themeSlotNames().sort());
    expect(Object.keys(injected)).toHaveLength(Object.keys(IMPORTED_SLOTS).length);
    // 値は貼ったものそのまま(恒等写像。**2本目の変換規則を作っていない**)。
    for (const [slot, value] of Object.entries(IMPORTED_SLOTS)) {
      expect(injected[slot]).toBe(value);
    }
  });

  test("get_manifest の出力の形({ slots: … })でも同じ結果になる(ラッパの有無だけを吸収する)", async () => {
    await openImportPanel();
    paste(JSON.stringify({ slots: IMPORTED_SLOTS }));

    const frame = await screen.findByTestId("theme-import-preview");
    expect(injectedProperties(frame)).toEqual(IMPORTED_SLOTS);
  });

  test("枠の中身は製品と同じ ViewHost であり、レコードはこのアプリの実データである", async () => {
    await openImportPanel();
    paste(JSON.stringify(IMPORTED_SLOTS));

    const frame = await screen.findByTestId("theme-import-preview");
    await waitFor(() => expect(frame.textContent).toContain("エントリ一覧"));
    expect(frame.textContent).toContain(REAL_ROW.label);
  });

  test("プレビューした時点では差分を1件も送っていない(適用の前である)", async () => {
    await openImportPanel();
    paste(JSON.stringify(IMPORTED_SLOTS));
    await screen.findByTestId("theme-import-preview");

    expect(diffCalls()).toEqual([]);
  });

  test("貼り直すとプレビューが消える(見たものと違うものを当てない)", async () => {
    await openImportPanel();
    paste(JSON.stringify(IMPORTED_SLOTS));
    await screen.findByTestId("theme-import-preview");

    fireEvent.change(screen.getByTestId("theme-import-json"), { target: { value: "{}" } });
    expect(screen.queryByTestId("theme-import-preview")).toBeNull();
    expect(screen.queryByTestId("apply-theme-import")).toBeNull();
  });
});

describe("読めない提案は理由を出して止まる(黙って落ちない)", () => {
  test("JSON として壊れていたら、エラーを出してプレビューを出さない", async () => {
    await openImportPanel();
    paste("{ これは JSON ではない");

    const errors = await screen.findByTestId("errors");
    expect(errors.textContent).toContain("JSON");
    expect(screen.queryByTestId("theme-import-preview")).toBeNull();
  });

  test("空のまま押したら、空だと言う", async () => {
    await openImportPanel();
    paste("   ");

    const errors = await screen.findByTestId("errors");
    expect(errors.textContent).toContain("貼り付け");
    expect(screen.queryByTestId("theme-import-preview")).toBeNull();
  });

  test("値が文字列でないスロットは、どのスロットかを名指しして拒否する", async () => {
    await openImportPanel();
    paste(JSON.stringify({ ...IMPORTED_SLOTS, "--line-height-base": 1.7 }));

    const errors = await screen.findByTestId("errors");
    expect(errors.textContent).toContain("--line-height-base");
    expect(screen.queryByTestId("theme-import-preview")).toBeNull();
  });

  test("配列や数値を貼ったら、オブジェクトが要ると言う", async () => {
    await openImportPanel();
    paste("[1, 2, 3]");

    const errors = await screen.findByTestId("errors");
    expect(errors.textContent).toContain("オブジェクト");
    expect(screen.queryByTestId("theme-import-preview")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. 適用(既存の applyThemeDiff / set_theme 1操作)
// ---------------------------------------------------------------------------

describe("適用は既存の差分1件である(専用の口を作らない)", () => {
  test("プレビューを見る前は適用ボタンが無く、理由が文で出る", async () => {
    await openImportPanel();
    expect(screen.queryByTestId("apply-theme-import")).toBeNull();
    expect(screen.getByTestId("theme-import-preface").textContent).toContain("プレビュー");
  });

  test("POST /api/apps/:app_id/diffs が1回だけ飛び、set_theme 1操作に閉じている", async () => {
    await openImportPanel();
    paste(JSON.stringify(IMPORTED_SLOTS));
    await screen.findByTestId("theme-import-preview");

    fireEvent.click(screen.getByTestId("apply-theme-import"));
    await waitFor(() => expect(screen.getByTestId("theme-import-result")).toBeDefined());

    const sent = diffCalls();
    expect(sent).toHaveLength(1);
    const diff = JSON.parse(sent[0]?.body ?? "{}") as {
      diff_id: string;
      intent: string;
      operations: { op: string; theme: { slots: Record<string, string> } }[];
    };
    expect(diff.operations).toHaveLength(1);
    expect(diff.operations[0]?.op).toBe("set_theme");
    // 貼った値が1バイトも変わらずに載る。
    expect(diff.operations[0]?.theme.slots).toEqual(IMPORTED_SLOTS);
    // intent は機械が組み立てた定型文であり、そう自ら書いている(ADR-0054 と同じ作法)。
    expect(diff.intent).toContain("定型文");
    expect(diff.intent).toContain("人間が書いた意図ではない");
  });

  test("適用に成功したら差分IDと、外側に反映するには再読み込みが要ることを出す", async () => {
    await openImportPanel();
    paste(JSON.stringify(IMPORTED_SLOTS));
    await screen.findByTestId("theme-import-preview");

    fireEvent.click(screen.getByTestId("apply-theme-import"));
    const result = await screen.findByTestId("theme-import-result");
    expect(result.textContent).toContain("theme-import-1");
    expect(result.textContent).toContain("再読み込み");
  });

  test("由来(origin)を貼ったらそのまま載る —— カーネルは真偽を検証しない", () => {
    const parsed = parseImportedTheme(
      JSON.stringify({ slots: IMPORTED_SLOTS, origin: { template_app_id: "org-theme" } }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.theme.origin).toEqual({ template_app_id: "org-theme" });

    const diff = themeImportDiff(parsed.theme, "abc123");
    expect(diff.operations[0].theme.origin).toEqual({ template_app_id: "org-theme" });
    expect(diff.diff_id).toContain("abc123");
  });

  test("由来の形が読めなければ拒否する(黙って落とさない)", () => {
    const parsed = parseImportedTheme(JSON.stringify({ slots: IMPORTED_SLOTS, origin: "org" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((error) => error.message).join()).toContain("origin");
  });
});

// ---------------------------------------------------------------------------
// 4. コントラスト検査(完了条件3 / 線10)
// ---------------------------------------------------------------------------

describe("コントラスト検査に落ちる値は理由が見える形で拒否される(fail-closed かつ loud)", () => {
  /**
   * **応答の中身をカーネルに作らせる。** こうしないと「テストが自分で書いた文を
   * テストが確かめる」循環になる。**web 側に検査の写しを作っていないことの裏側でもある。**
   */
  function contrastErrors(): { path: string; message: string; hint?: string }[] {
    const errors = checkThemeContrast(UNREADABLE_SLOTS);
    if (errors.length === 0) {
      throw new Error("UNREADABLE_SLOTS がコントラスト検査を通ってしまった(前提が壊れている)");
    }
    return errors;
  }

  test("前提: UNREADABLE_SLOTS はカーネルの検査に落ち、IMPORTED_SLOTS は通る", () => {
    expect(checkThemeContrast(UNREADABLE_SLOTS).length).toBeGreaterThan(0);
    expect(checkThemeContrast(IMPORTED_SLOTS)).toEqual([]);
  });

  test("サーバが返した「コントラスト比」の理由が全件そのまま画面に出る", async () => {
    const errors = contrastErrors();
    diffResponse = () => jsonResponse({ errors }, 400);

    await openImportPanel();
    paste(JSON.stringify(UNREADABLE_SLOTS));
    await screen.findByTestId("theme-import-preview");
    fireEvent.click(screen.getByTestId("apply-theme-import"));

    const shown = await screen.findByTestId("errors");
    expect(shown.textContent).toContain("コントラスト比");
    for (const error of errors) {
      expect(shown.textContent).toContain(error.message);
    }
    // 直し方(hint)も捨てない。
    expect(shown.textContent).toContain("以上にしてください");
  });

  test("拒否されたら「適用しました」を出さない(黙って通らない)", async () => {
    diffResponse = () => jsonResponse({ errors: contrastErrors() }, 400);

    await openImportPanel();
    paste(JSON.stringify(UNREADABLE_SLOTS));
    await screen.findByTestId("theme-import-preview");
    fireEvent.click(screen.getByTestId("apply-theme-import"));

    await screen.findByTestId("errors");
    expect(screen.queryByTestId("theme-import-result")).toBeNull();
  });

  test("web 側に検査の写しが無い —— 落ちる値でもプレビューは出る(判定はサーバの1箇所)", async () => {
    await openImportPanel();
    paste(JSON.stringify(UNREADABLE_SLOTS));

    // **プレビューは検査ではない。** ここで止めると web に2本目の判定規則が住むことになる。
    const frame = await screen.findByTestId("theme-import-preview");
    expect(injectedProperties(frame)).toEqual(UNREADABLE_SLOTS);
    expect(screen.getByTestId("theme-import-preface").textContent).toContain("コントラスト");
  });

  test("迂回路が無い —— 適用が叩く URL は /diffs 1本だけである(線10)", async () => {
    await openImportPanel();
    paste(JSON.stringify(IMPORTED_SLOTS));
    await screen.findByTestId("theme-import-preview");

    const before = calls.length;
    fireEvent.click(screen.getByTestId("apply-theme-import"));
    await waitFor(() => expect(screen.getByTestId("theme-import-result")).toBeDefined());

    const after = calls.slice(before).filter((call) => call.method === "POST");
    expect(after.map((call) => call.url)).toEqual([`/api/apps/${APP_ID}/diffs`]);
  });
});

// ---------------------------------------------------------------------------
// 5. 越えてはならない線(§8-1 の線8 / 線9)
// ---------------------------------------------------------------------------

describe("越えてはならない線(§8-1)", () => {
  test("線9: theme.json を出す口を1つも置いていない", async () => {
    const source = readFileSync(PANEL_SOURCE_PATH, "utf-8");
    // ダウンロードもコピーも作っていない(**製品コードとして**)。
    expect(source).not.toContain("createObjectURL");
    expect(source).not.toContain("navigator.clipboard");
    expect(source).not.toContain("new Blob(");
    expect(source).not.toContain('download="');

    await openImportPanel();
    expect(screen.queryByTestId("copy-theme-json")).toBeNull();
    expect(screen.queryByTestId("theme-json")).toBeNull();
    // 出口の側にも JSON の口は無いままである(非対称を残した。審査本体 §4-2)。
    fireEvent.click(screen.getByTestId("close-theme-import"));
    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
    fireEvent.click(screen.getByTestId("open-theme-export"));
    await waitFor(() => expect(screen.getByTestId("theme-export")).toBeDefined());
    expect(screen.queryByTestId("copy-theme-json")).toBeNull();
  });

  test("線2: ファイルを読ませる口を1つも置いていない(貼るのは文字だけである)", () => {
    const source = readFileSync(PANEL_SOURCE_PATH, "utf-8");
    expect(source).not.toContain('type="file"');
    expect(source).not.toContain("FileReader");
    expect(source).not.toContain("accept=");
    // **`image` 型にも1バイトも触っていない**(抽出の入力にしない)。
    expect(source).not.toContain('"image"');
  });

  test("線8: 候補プレビューの候補集合に1件も結線していない", async () => {
    await openImportPanel();
    paste(JSON.stringify(IMPORTED_SLOTS));
    await screen.findByTestId("theme-import-preview");

    const text = screen.getByTestId("theme-import").textContent ?? "";
    for (const candidate of THEME_CANDIDATES) {
      expect(text).not.toContain(candidate.name);
      expect(text).not.toContain(candidate.id);
    }
    // 取り込んだテーマが候補として足されることはありえない(表は凍結されている)。
    expect(Object.isFrozen(THEME_CANDIDATES)).toBe(true);
    for (const candidate of THEME_CANDIDATES) {
      expect(Object.isFrozen(candidate)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. 完了条件4(owner 確認は構造の担保ではない)
// ---------------------------------------------------------------------------

describe("完了条件4: owner 確認が構造の担保ではないことを、コードと画面の両方に書く", () => {
  test("ソースに3文が在る(1文に丸めない。審査本体 §3 問1 (c))", () => {
    const source = readFileSync(PANEL_SOURCE_PATH, "utf-8");
    // (1) AI は今日も直接書ける / この画面はその経路を1本も塞がない。
    expect(source).toContain("直接書ける");
    expect(source).toContain("1本も塞がない");
    // (2) 編集上の関門であって構造の担保ではない / 担保は 127.0.0.1 バインドだけ。
    expect(source).toContain("編集上の関門であって");
    expect(source).toContain("構造の担保ではない");
    expect(source).toContain("127.0.0.1");
    // (3) 構造で言えるのはコントラスト検査だけ(言えること / 言えないことを両方書く)。
    expect(source).toContain("読めない配色を取り込むことはできない");
    expect(source).toContain("正しい配色を取り込める");
  });

  test("V3-M5 の逃げ道と同じ強さだと書いていない(禁止文言が0件)", () => {
    const source = readFileSync(PANEL_SOURCE_PATH, "utf-8");
    expect(source).not.toContain("AI が黙って");
    expect(source).not.toContain("同じ強さ");
    expect(source).not.toContain("安全になった");
  });

  test("画面の説明文も同じことを言う(UI が嘘をつかない)", async () => {
    await openImportPanel();
    const preface = screen.getByTestId("theme-import-preface").textContent ?? "";
    expect(preface).toContain("apply_diff");
    expect(preface).toContain("塞いでいません");
  });
});

// ---------------------------------------------------------------------------
// 7. アクセシビリティの最低線(完了条件8。体系的保証はしない)
// ---------------------------------------------------------------------------

describe("アクセシビリティの最低線(完了条件8)", () => {
  test("貼り付け欄はラベルから引ける", async () => {
    await openImportPanel();
    const field = screen.getByLabelText(/取り込み提案/);
    expect(field).toBe(screen.getByTestId("theme-import-json"));
  });

  test("新しく置いた操作要素はすべて button 要素で、名前を持つ(キーボードで到達できる)", async () => {
    await openImportPanel();
    paste(JSON.stringify(IMPORTED_SLOTS));
    await screen.findByTestId("theme-import-preview");

    for (const id of ["preview-theme-import", "apply-theme-import", "close-theme-import"]) {
      const element = screen.getByTestId(id);
      expect(element.tagName).toBe("BUTTON");
      expect(element.getAttribute("type")).toBe("button");
      expect((element.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
    // 導線の側も同じ(header の owner 限定ボタン)。
    fireEvent.click(screen.getByTestId("close-theme-import"));
    await waitFor(() => expect(screen.getByTestId("view-list")).toBeDefined());
    const entry = screen.getByTestId("open-theme-import");
    expect(entry.tagName).toBe("BUTTON");
    expect((entry.textContent ?? "").trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. 資産との対応(非循環。T01 と同型)
// ---------------------------------------------------------------------------

describe("貼る25値は資産の中に実在する(テストが自分で作った値ではない)", () => {
  test("25値すべてが fixtures/theme-import/brand-guide.md にインラインコードとして在る", () => {
    const guide = readFileSync(BRAND_GUIDE_PATH, "utf-8");
    const missing = Object.values(IMPORTED_SLOTS).filter(
      (value) => !guide.includes(`\`${value}\``),
    );
    expect(missing).toEqual([]);
  });

  test("資産はスロット名を1つも書いていない(対応付けは AI の判断である)", () => {
    const guide = readFileSync(BRAND_GUIDE_PATH, "utf-8");
    const named = Object.keys(IMPORTED_SLOTS).filter((slot) => guide.includes(slot));
    expect(named).toEqual([]);
  });
});
