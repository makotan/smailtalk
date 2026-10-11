/**
 * **見比べの画面**(`V20-M14-T01C`。計画 `docs/plan/v20/16-v20-m14-plan.md` §9-3 / §10-3、
 * ユーザ決定 `D-V20-47`〜`D-V20-54`、変更 ADR `ADR-0478`)。
 *
 * 前段(`src/server/preview-front.ts` の `/compare`。`V20-M14-T01B`)が返す形を写した差し替えの応答で、
 *
 * - `/apps/pv-<束>/` を開くと先に `/compare` を1回引き、200 なら見比べ、404 なら1案の下見、410 なら期限切れ。
 * - 案ごとに名前・トレードオフ(切らない)・注意・`<iframe src="/apps/pv-<案>/">` を並べる(1〜3案)。
 * - 幅の切り替え(モバイル 390px / デスクトップ 1280px。既定はモバイル)は iframe の幅だけを変える。
 * - 「この案にする」→ 確認の小窓 → OK → `/compare` を引き直して `stale` を見る → 本物の `POST /diffs` へ1回だけ。
 * - 応答ごとの文言(201 / 401 / 403 の2種 / 400)と、古い案(開いた時点 / OK の直後)で POST が0回。
 *
 * ことを撃つ。**幅で iframe の中の描画が変わることは `bun test` では測らない**(`web/e2e/preview-compare.e2e.ts`)。
 *
 * **【V20-M15-T01C の追記】**(計画 `docs/plan/v20/17-v20-m15-plan.md` §9・§10-5 の中10、変更 ADR `ADR-0479`
 * §Decision 4-5・4-6、決定 `D-V20-56`・`D-V20-57`・`D-V20-59`・`D-V20-63`・`D-V20-64`):
 *
 * - 送る本文 = 案の差分の `operations` の末尾に `remember_design`(`choice` だけ)を1本足したもの。
 *   理由は前後の空白を落とし、空なら `reason` のキーを送らない。
 * - 小窓は成功(201)するまで閉じず、理由の入力を保つ。 OK を1回押すごとに `/compare` を引き直してから
 *   `POST /diffs` を1回。 成功は束の中で1回だけ。
 * - 理由の欄の下に注意書き(`D-V20-63` の逐語)、上に固定文(`ADR-0479` §Decision 4-6 の逐語)。
 * - 案の `off_pattern` が真なら見出しに「このアプリの型と違う」。 無い・偽なら出ない(陰性)。
 * - 案の中の `remember_design`(`patterns` を持つ)は「型を変える」の1行と「要確認」の印。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { formatPreviewDeadline, resetPreviewStates } from "../src/preview.ts";
import {
  COMPARE_FRAME_HEIGHT,
  COMPARE_OPERATION_LABELS,
  compareBannerText,
  compareLayout,
  describeCompareOperations,
  resetCompareLookups,
  withDesignChoice,
} from "../src/preview-compare.ts";
import { grantRules, tableCan, viewRead } from "./role-rules.ts";

const WEB_SRC = join(import.meta.dir, "..", "src");

const GROUP = `pv-${"a".repeat(32)}`;
const CAND = [`pv-${"1".repeat(32)}`, `pv-${"2".repeat(32)}`, `pv-${"3".repeat(32)}`] as const;
const SINGLE = `pv-${"0123456789abcdef".repeat(2)}`;
const REAL = "memo-app";
const EXPIRES_AT = "2026-09-26T03:04:00.000Z";
const EXPIRED = "この下見は期限切れです";
const STALE_TEXT = "案が古くなりました。AI に作り直してもらってください";

/** 案の名前・トレードオフ・意図は**検査の側だけ**に在る綴り(製品に文面の表が無いことを撃つため)。 */
const NAMES = ["案ぬ-一覧を詰める", "案る-二列にする", "案を-見出しを大きく"] as const;
const TRADEOFFS = [
  "とれーどおふ壱: 一覧に並ぶ行が増えるが、一行あたりの文字は小さくなる",
  "とれーどおふ弐: 入力が一画面に収まるが、項目の順が横へ流れる",
  "とれーどおふ参: 見出しが目立つが、縦に長くなる",
] as const;
const INTENTS = ["いんてんと壱の文", "いんてんと弐の文", "いんてんと参の文"] as const;

type Candidate = {
  id: string;
  url: string;
  name: string;
  tradeoff: string;
  intent: string;
  diff: unknown;
  design_notices: { rule: string; view: string; path: string; count: number; message: string }[];
  stale: boolean;
  /** `V20-M15-T01B` で9キー目。 */
  off_pattern: boolean;
};

function candidate(index: number, overrides: Partial<Candidate> = {}): Candidate {
  const id = CAND[index] as string;
  return {
    id,
    url: `/apps/${id}/`,
    name: NAMES[index] as string,
    tradeoff: TRADEOFFS[index] as string,
    intent: INTENTS[index] as string,
    diff: {
      diff_id: `d-compare-${index}`,
      intent: INTENTS[index],
      operations: [
        { op: "update_view", view: "note-list", changes: { name: `一覧(案${index + 1})` } },
      ],
    },
    design_notices: [],
    stale: false,
    off_pattern: false,
    ...overrides,
  };
}

function compareBody(candidates: Candidate[]) {
  return {
    compare: {
      group: GROUP,
      app_id: REAL,
      mode: "real",
      expires_at: EXPIRES_AT,
      candidates,
    },
  };
}

type Reply = { status: number; body?: unknown; preview?: boolean };
type Handler = (method: string, body: string | undefined) => Reply | undefined;

let requests: { url: string; method: string; body: string | undefined; credentials?: string }[];
let routes: Record<string, Handler>;
let originalFetch: typeof fetch;

function memoManifest(appId: string): Manifest {
  const built: Manifest = {
    app: {
      id: appId,
      name: "メモ",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "title", name: "題名", type: "text", required: true }],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
    },
  };
  return grantRules(built, ["owner"], [viewRead("note-list"), tableCan("notes", "read")]);
}

/** 1案の下見(束でない識別子)の応答。前段は案の識別子への `/compare` に 404 を返す。 */
function singlePreviewRoutes(appId: string): Record<string, Handler> {
  return {
    [`/api/apps/${appId}/compare`]: () => ({
      status: 404,
      preview: true,
      body: { errors: [{ path: "", message: "この下見は見比べの束ではありません" }] },
    }),
    [`/api/apps/${appId}/auth/me`]: () => ({
      status: 200,
      preview: true,
      body: { user: { id: "u1", username: "下見", displayName: null, role: "owner" } },
    }),
    [`/api/apps/${appId}/manifest`]: () => ({
      status: 200,
      preview: true,
      body: memoManifest(appId),
    }),
    [`/api/apps/${appId}/tables/notes/records`]: () => ({
      status: 200,
      preview: true,
      body: { records: [], total: 0 },
    }),
  };
}

function setCompare(candidates: Candidate[] | (() => Candidate[])): void {
  routes[`/api/apps/${GROUP}/compare`] = () => ({
    status: 200,
    body: compareBody(typeof candidates === "function" ? candidates() : candidates),
  });
}

function setDiffReply(reply: Reply): void {
  routes[`/api/apps/${REAL}/diffs`] = (method) => (method === "POST" ? reply : undefined);
}

/** happy-dom の設定(同じ過程の他の検査へ持ち越さないよう、終わったら戻す)。 */
function happySettings(): Record<string, unknown> | undefined {
  return (window as unknown as { happyDOM?: { settings?: Record<string, unknown> } }).happyDOM
    ?.settings;
}
let iframeLoadingBefore: unknown;

beforeAll(() => {
  // **iframe の中身を happy-dom に読ませない**(中の描画は E2E が測る。ここでは枠の属性だけを見る)。
  // 読ませないと happy-dom は `http://localhost/apps/pv-…/` を取りに行く。 読まないときは
  // 「Iframe page loading is disabled.」を出力に書くが、検査の合否には関わらない。
  const settings = happySettings();
  iframeLoadingBefore = settings?.disableIframePageLoading;
  if (settings !== undefined) {
    settings.disableIframePageLoading = true;
  }
});

afterAll(() => {
  const settings = happySettings();
  if (settings !== undefined) {
    settings.disableIframePageLoading = iframeLoadingBefore;
  }
});

beforeEach(() => {
  requests = [];
  routes = {
    "/api/apps": () => ({ status: 200, body: { apps: [] } }),
    ...singlePreviewRoutes(SINGLE),
  };
  resetPreviewStates();
  resetCompareLookups();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({
      url,
      method,
      body,
      ...(init?.credentials === undefined ? {} : { credentials: init.credentials }),
    });
    const handled = (routes[url] ?? routes[url.split("?")[0] ?? ""])?.(method, body);
    const reply = handled ?? {
      status: 404,
      body: { errors: [{ path: "", message: `no stub for ${method} ${url}` }] },
    };
    const headers = new Headers({ "content-type": "application/json" });
    if (reply.preview === true) {
      headers.set("X-Smailtalk-Preview", `mode=real; expires_at=${EXPIRES_AT}`);
    }
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
  resetPreviewStates();
  resetCompareLookups();
});

function open(path: string): void {
  window.history.replaceState({}, "", path);
  render(<App />);
}

function posts(): typeof requests {
  return requests.filter((request) => request.method === "POST");
}

function compareGets(appId: string): typeof requests {
  return requests.filter(
    (request) => request.method === "GET" && request.url === `/api/apps/${appId}/compare`,
  );
}

async function cards(): Promise<HTMLElement[]> {
  return await screen.findAllByTestId("compare-candidate");
}

function frameOf(card: HTMLElement): HTMLIFrameElement {
  const frame = card.querySelector("iframe");
  if (frame === null) throw new Error("iframe が無い");
  return frame;
}

async function choose(index: number): Promise<HTMLElement> {
  const card = (await cards())[index];
  if (card === undefined) throw new Error(`案 ${index} が無い`);
  fireEvent.click(within(card).getByTestId("compare-choose"));
  return await screen.findByTestId("compare-confirm");
}

function confirmOk(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByTestId("compare-confirm-ok"));
}

// ---------------------------------------------------------------------------

describe("(1) 純粋な部品", () => {
  test("帯の文言は D-V20-51 の逐語で、期限は利用者の時計の HH:MM", () => {
    expect(compareBannerText(EXPIRES_AT)).toBe(
      `見比べ(適用前)。選んで確認するとアプリに反映されます。期限 ${formatPreviewDeadline(EXPIRES_AT)}`,
    );
  });

  test("並べ方: 収まるなら縮めない / 収まらないなら縮める / 縮めすぎるなら段を折る", () => {
    // 3案 × 390px が 1300px に収まる → 1段・縮めない。
    expect(compareLayout({ available: 1300, gap: 16, count: 3, frameWidth: 390 })).toEqual({
      columns: 3,
      scale: 1,
    });
    // 3案 × 390px が 900px に収まらない → 1段のまま縮める((900 - 32) / 3 / 390)。
    const narrow = compareLayout({ available: 900, gap: 16, count: 3, frameWidth: 390 });
    expect(narrow.columns).toBe(3);
    expect(narrow.scale).toBeCloseTo((900 - 32) / 3 / 390, 10);
    // 1280px は 900px の中で3段に折り、1枚ずつ縮める(半分より小さくしない)。
    const desktop = compareLayout({ available: 900, gap: 16, count: 3, frameWidth: 1280 });
    expect(desktop.columns).toBe(1);
    expect(desktop.scale).toBeCloseTo(900 / 1280, 10);
    // 測れない(幅 0)なら縮めない。
    expect(compareLayout({ available: 0, gap: 16, count: 2, frameWidth: 1280 })).toEqual({
      columns: 1,
      scale: 1,
    });
  });
});

describe("(1b) 案の変更の一覧(D-V20-55。`V20-M14` 点検の処置 中3)", () => {
  /** 18種の op を1つずつ(中身の細部は検査の側だけが持つ綴り。`V20-M15-T01C` で `remember_design` を足した)。 */
  const ALL_OPS = [
    { op: "add_table", table: { id: "books", name: "本", fields: [] } },
    { op: "add_field", table: "books", field: { id: "memo", name: "メモ", type: "text" } },
    {
      op: "add_view",
      view: { id: "book-list", type: "list_view", table: "books", name: "本の一覧" },
    },
    { op: "update_view", view: "note-list", changes: { name: "一覧" } },
    { op: "remove_view", view: "old-list" },
    { op: "remove_field", table: "books", field: "memo" },
    { op: "remove_table", table: "books" },
    { op: "change_table", table: "books", changes: { name: "書籍" } },
    { op: "change_field", table: "books", field: "memo", changes: { name: "備考" } },
    {
      op: "add_workflow",
      workflow: { id: "notify", name: "通知する", trigger: { secret_step: "しくみ壱" } },
    },
    { op: "update_workflow", workflow: { id: "notify", name: "通知する", steps: ["しくみ弐"] } },
    { op: "remove_workflow", workflow: { id: "notify" } },
    { op: "add_function", function: { id: "total", name: "合計", code: "しくみ参" } },
    { op: "update_function", function: { id: "total", name: "合計" } },
    { op: "remove_function", function: { id: "total" } },
    { op: "set_theme", theme: { slots: { primary: "#123456" } } },
    {
      op: "set_roles",
      roles: [
        { id: "owner", name: "持ち主", rules: [{ when: "じょうけん式" }] },
        { id: "staff", name: "店員" },
      ],
    },
    { op: "remember_design", design_memory: { patterns: ["かたの文壱", "かたの文弐"] } },
    // **【`V22-M2-T05`】19種目 `set_workspace` を1つ足した**(`ADR-0487` 行60)。
    { op: "set_workspace", workspace: { navigation: { placement: "top" } } },
  ];

  test("op ごとに1行・日本語の言い方と対象の名前・印は権限と自動処理にだけ", () => {
    const lines = describeCompareOperations({ diff_id: "d", intent: "i", operations: ALL_OPS });
    expect(lines.length).toBe(ALL_OPS.length);
    expect(lines.map((line) => [line.label, line.target])).toEqual([
      ["表を足す", "本(books)"],
      ["項目を足す", "books の メモ(memo)"],
      ["画面を足す", "本の一覧(book-list)"],
      ["画面を変える", "note-list"],
      ["画面を消す", "old-list"],
      ["項目を消す", "books の memo"],
      ["表を消す", "books"],
      ["表を変える", "books"],
      ["項目を変える", "books の memo"],
      ["自動処理を足す", "通知する(notify)"],
      ["自動処理を変える", "通知する(notify)"],
      ["自動処理を消す", "notify"],
      ["関数を足す", "合計(total)"],
      ["関数を変える", "合計(total)"],
      ["関数を消す", "total"],
      ["配色を変える", ""],
      ["権限の設定を変える", "持ち主(owner)、店員(staff)"],
      ["型を変える", "型 2 件"],
      // **【`V22-M2-T05`】足した期待**(`ADR-0487` 行60)。
      ["メニューの置き方を変える", ""],
    ]);
    expect(lines.filter((line) => line.flagged).map((line) => line.op)).toEqual([
      "add_workflow",
      "update_workflow",
      "remove_workflow",
      "set_roles",
      "remember_design",
    ]);
    // 中身の細部(条件式・手順・色の値・型の文)は出さない。
    const text = JSON.stringify(lines);
    for (const secret of [
      "しくみ壱",
      "しくみ弐",
      "しくみ参",
      "じょうけん式",
      "#123456",
      "かたの文壱",
      "かたの文弐",
    ]) {
      expect(text.includes(secret)).toBe(false);
    }
  });

  test("言い方の表は18種で、差分操作の全量と同じ綴り(V20-M15-T01C の (b))", () => {
    // **【`V22-M2-T05b`。`ADR-0487` 行60 の訂正】19種目 `set_workspace` の言い方を足したので 18 → 19。旧行の逐語**:
    //   `expect(Object.keys(COMPARE_OPERATION_LABELS).length).toBe(18);`
    expect(Object.keys(COMPARE_OPERATION_LABELS).length).toBe(19);
    expect(Object.keys(COMPARE_OPERATION_LABELS).sort()).toEqual(
      ALL_OPS.map((operation) => operation.op).sort(),
    );
    expect(COMPARE_OPERATION_LABELS.remember_design).toBe("型を変える");
  });

  test("remember_design の印は中身で決まる: 型の空配列 →「型をすべて外す」と印 / choice だけ → 印なし", () => {
    const lines = describeCompareOperations({
      operations: [
        { op: "remember_design", design_memory: { patterns: [] } },
        { op: "remember_design", design_memory: { choice: { name: "な", tradeoff: "と" } } },
        { op: "remember_design", design_memory: { patterns: ["ひとつ"] } },
      ],
    });
    expect(lines.map((line) => [line.label, line.target, line.flagged])).toEqual([
      ["型を変える", "型をすべて外す", true],
      ["型を変える", "", false],
      ["型を変える", "型 1 件", true],
    ]);
  });

  test("形の違う差分でも投げない(operations が無い → 0行 / 知らない op → そのままの名前で1行・印なし)", () => {
    expect(describeCompareOperations(null)).toEqual([]);
    expect(describeCompareOperations({ operations: "x" })).toEqual([]);
    const lines = describeCompareOperations({ operations: [{ op: "brand_new" }, 7] });
    expect(lines.length).toBe(2);
    expect(lines[0]).toEqual({
      op: "brand_new",
      label: "その他の変更(brand_new)",
      target: "",
      flagged: false,
    });
  });
});

describe("(1c) 送る本文を作る(D-V20-56・D-V20-57。ADR-0479 §Decision 4-5)", () => {
  const base = {
    diff_id: "d-base",
    intent: "いと",
    operations: [{ op: "update_view", view: "note-list", changes: { name: "一覧" } }],
  };
  const chosen = { name: "なまえ", tradeoff: "とれーど" };

  test("末尾に remember_design(choice だけ)を1本。diff_id と intent は案のまま。元の差分を書き換えない", () => {
    const before = JSON.stringify(base);
    const sent = withDesignChoice(base, chosen, "りゆう");
    expect(sent).toEqual({
      diff_id: "d-base",
      intent: "いと",
      operations: [
        { op: "update_view", view: "note-list", changes: { name: "一覧" } },
        {
          op: "remember_design",
          design_memory: { choice: { name: "なまえ", tradeoff: "とれーど", reason: "りゆう" } },
        },
      ],
    });
    expect(JSON.stringify(base)).toBe(before);
  });

  test("理由は前後の空白を落とす。空白だけ・空なら reason のキーを送らない", () => {
    const choiceOf = (reason: string) => {
      const sent = withDesignChoice(base, chosen, reason) as {
        operations: { design_memory?: { choice?: Record<string, unknown> } }[];
      };
      return sent.operations[sent.operations.length - 1]?.design_memory?.choice;
    };
    expect(choiceOf("  \u3000 前後に空白 \t ")).toEqual({
      name: "なまえ",
      tradeoff: "とれーど",
      reason: "前後に空白",
    });
    for (const empty of ["", "   ", " \u3000\t "]) {
      const choice = choiceOf(empty);
      expect(choice).toEqual({ name: "なまえ", tradeoff: "とれーど" });
      expect(Object.keys(choice ?? {})).toEqual(["name", "tradeoff"]);
    }
  });

  test("案が型(patterns)の remember_design を持つときは remember_design が2本並ぶ(案の1本が先)", () => {
    const withPatterns = {
      ...base,
      operations: [
        ...base.operations,
        { op: "remember_design", design_memory: { patterns: ["かた"] } },
      ],
    };
    const sent = withDesignChoice(withPatterns, chosen, "") as { operations: unknown[] };
    expect(sent.operations.length).toBe(3);
    expect(sent.operations.slice(1)).toEqual([
      { op: "remember_design", design_memory: { patterns: ["かた"] } },
      {
        op: "remember_design",
        design_memory: { choice: { name: "なまえ", tradeoff: "とれーど" } },
      },
    ]);
  });
});

describe("(2) 並ぶ(3案・2案・1案)", () => {
  test("3案: 名前・トレードオフ(3つとも別の文)・iframe が並ぶ。/compare は開いた時点で1回", async () => {
    setCompare([candidate(0), candidate(1), candidate(2)]);
    open(`/apps/${GROUP}/`);
    const list = await cards();
    expect(list.length).toBe(3);
    const names = list.map(
      (card) => within(card).getByTestId("compare-candidate-name").textContent,
    );
    expect(names).toEqual([...NAMES]);
    const tradeoffs = list.map(
      (card) => within(card).getByTestId("compare-candidate-tradeoff").textContent,
    );
    expect(tradeoffs).toEqual([...TRADEOFFS]);
    expect(new Set(tradeoffs).size).toBe(3);
    expect(list.map((card) => frameOf(card).getAttribute("src"))).toEqual(
      CAND.map((id) => `/apps/${id}/`),
    );
    expect(compareGets(GROUP).length).toBe(1);
    // 見比べの画面は本物のアプリ・写しの読み物を1本も引かない(/compare と一覧だけ)。
    expect(
      requests
        .filter((request) => request.url.startsWith("/api/apps/"))
        .map((request) => request.url),
    ).toEqual([`/api/apps/${GROUP}/compare`]);
    expect(posts().length).toBe(0);
  });

  test("2案: 2つ並ぶ", async () => {
    setCompare([candidate(0), candidate(1)]);
    open(`/apps/${GROUP}/`);
    expect((await cards()).length).toBe(2);
  });

  test("1案でも出して選べる(D-V20-53)", async () => {
    setCompare([candidate(0)]);
    open(`/apps/${GROUP}/`);
    const list = await cards();
    expect(list.length).toBe(1);
    const button = within(list[0] as HTMLElement).getByTestId("compare-choose");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  test("上端に見比べの帯(下見の帯は出ない)", async () => {
    setCompare([candidate(0), candidate(1)]);
    open(`/apps/${GROUP}/`);
    const banner = await screen.findByTestId("compare-banner");
    expect(banner.textContent).toBe(
      `見比べ(適用前)。選んで確認するとアプリに反映されます。期限 ${formatPreviewDeadline(EXPIRES_AT)}`,
    );
    expect(document.querySelector("main.shell")?.firstElementChild).toBe(banner);
    expect(screen.queryByTestId("preview-banner")).toBeNull();
    // 帯は役割の色の Tailwind の組で描く(色の値を持たない)。
    expect(banner.className).toContain("bg-muted");
    expect(/#[0-9a-f]{3,8}|rgb\(|oklch\(/i.test(banner.outerHTML)).toBe(false);
    // Referer を送らない指定が効いている(下見の綴り)。
    expect(
      document.head.querySelector('meta[name="referrer"]')?.getAttribute("content") ?? null,
    ).toBe("no-referrer");
  });

  test("長いトレードオフ(80字)を切らずに全部出す(折り返す)", async () => {
    const long = `${"長".repeat(40)}${"い".repeat(39)}末`;
    expect([...long].length).toBe(80);
    setCompare([candidate(0, { tradeoff: long }), candidate(1)]);
    open(`/apps/${GROUP}/`);
    const card = (await cards())[0] as HTMLElement;
    const shown = within(card).getByTestId("compare-candidate-tradeoff");
    expect(shown.textContent).toBe(long);
    for (const cut of [
      "truncate",
      "line-clamp",
      "text-ellipsis",
      "whitespace-nowrap",
      "overflow-hidden",
    ]) {
      expect(shown.className).not.toContain(cut);
    }
    expect(shown.className).toContain("break-words");
    expect(shown.getAttribute("title")).toBeNull();
  });

  test("注意の付いた案は件数と文を添えて並ぶ(注意の無い案には出ない)", async () => {
    setCompare([
      candidate(0, {
        design_notices: [
          {
            rule: "too_many_buttons",
            view: "note-list",
            path: "/app/views/0",
            count: 9,
            message: "注意の文その一",
          },
          {
            rule: "too_many_fields",
            view: "note-list",
            path: "/app/views/0",
            count: 11,
            message: "注意の文その二",
          },
        ],
      }),
      candidate(1),
    ]);
    open(`/apps/${GROUP}/`);
    const [first, second] = (await cards()) as [HTMLElement, HTMLElement];
    const notices = within(first).getByTestId("compare-candidate-notices");
    expect(notices.textContent).toContain("注意 2件");
    expect(notices.textContent).toContain("注意の文その一");
    expect(notices.textContent).toContain("注意の文その二");
    expect(within(second).queryByTestId("compare-candidate-notices")).toBeNull();
  });

  test("off_pattern の案の見出しに「このアプリの型と違う」(D-V20-59)。偽・無い案には出ない(陰性)。外れた案も選べる", async () => {
    const missing = candidate(2) as Partial<Candidate>;
    delete missing.off_pattern;
    setCompare([candidate(0, { off_pattern: true }), candidate(1), missing as Candidate]);
    open(`/apps/${GROUP}/`);
    const [off, plain, absent] = (await cards()) as [HTMLElement, HTMLElement, HTMLElement];
    const badge = within(off).getByTestId("compare-candidate-off-pattern");
    expect(badge.textContent).toBe("このアプリの型と違う");
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(within(plain).queryByTestId("compare-candidate-off-pattern")).toBeNull();
    expect(within(absent).queryByTestId("compare-candidate-off-pattern")).toBeNull();
    expect(document.body.textContent?.split("このアプリの型と違う").length).toBe(2);
    expect((within(off).getByTestId("compare-choose") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("(3) 幅の切り替え", () => {
  test("既定はモバイル(390px)。デスクトップ(1280px)に切り替えると iframe の幅だけが変わる", async () => {
    setCompare([candidate(0), candidate(1)]);
    open(`/apps/${GROUP}/`);
    const mobile = await screen.findByRole("button", { name: "モバイル(390px)" });
    const desktop = screen.getByRole("button", { name: "デスクトップ(1280px)" });
    expect(mobile.getAttribute("aria-pressed")).toBe("true");
    expect(desktop.getAttribute("aria-pressed")).toBe("false");
    const before = (await cards()).map((card) => frameOf(card));
    expect(before.map((frame) => frame.style.width)).toEqual(["390px", "390px"]);
    expect(before.map((frame) => frame.style.height)).toEqual([
      `${COMPARE_FRAME_HEIGHT}px`,
      `${COMPARE_FRAME_HEIGHT}px`,
    ]);
    const srcBefore = before.map((frame) => frame.getAttribute("src"));
    const styleElementsBefore = document.querySelectorAll("style").length;

    fireEvent.click(desktop);
    await waitFor(() => {
      expect(desktop.getAttribute("aria-pressed")).toBe("true");
    });
    const after = (await cards()).map((card) => frameOf(card));
    expect(after.map((frame) => frame.style.width)).toEqual(["1280px", "1280px"]);
    // 変わらないもの: 中身の URL・高さ・<style> 要素の数(枠の中に宣言を1つも足さない)。
    expect(after.map((frame) => frame.getAttribute("src"))).toEqual(srcBefore);
    expect(after.map((frame) => frame.style.height)).toEqual([
      `${COMPARE_FRAME_HEIGHT}px`,
      `${COMPARE_FRAME_HEIGHT}px`,
    ]);
    expect(document.querySelectorAll("style").length).toBe(styleElementsBefore);
    // iframe が持つ見た目は幅・高さ・縮め(transform)・その起点だけ。
    for (const frame of after) {
      const keys = [...Array.from({ length: frame.style.length }, (_, i) => frame.style.item(i))];
      for (const key of keys) {
        expect(["width", "height", "transform", "transform-origin"]).toContain(key);
      }
    }
    // 戻す。
    fireEvent.click(screen.getByRole("button", { name: "モバイル(390px)" }));
    await waitFor(async () => {
      expect((await cards()).map((card) => frameOf(card).style.width)).toEqual(["390px", "390px"]);
    });
  });
});

describe("(4) 確認 → 適用(POST は1回だけ・中身は候補の差分の末尾に選んだ記録を1本足したもの)", () => {
  test("押しただけでは送らない。確認の小窓に名前・トレードオフ・変更の意図・注意が出る", async () => {
    setCompare([
      candidate(0),
      candidate(1, {
        design_notices: [
          { rule: "r", view: "note-list", path: "/app/views/0", count: 3, message: "小窓の注意文" },
        ],
      }),
    ]);
    setDiffReply({ status: 201, body: { change: { entry: { diff_id: "d-compare-1" } } } });
    open(`/apps/${GROUP}/`);
    const dialog = await choose(1);
    expect(dialog.textContent).toContain(NAMES[1]);
    expect(dialog.textContent).toContain(TRADEOFFS[1]);
    expect(dialog.textContent).toContain(INTENTS[1]);
    expect(dialog.textContent).toContain("小窓の注意文");
    expect(dialog.textContent).toContain("注意 1件");
    expect(posts().length).toBe(0);
    expect(compareGets(GROUP).length).toBe(1);
    // やめる → 送らない。
    fireEvent.click(within(dialog).getByTestId("compare-confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("compare-confirm")).toBeNull();
    });
    expect(posts().length).toBe(0);
  });

  test("確認の小窓に案の変更の一覧が op の数だけ出て、印は権限と自動処理の行にだけ付く(D-V20-55)", async () => {
    setCompare([
      candidate(0, {
        diff: {
          diff_id: "d-compare-ops",
          intent: INTENTS[0],
          operations: [
            { op: "update_view", view: "note-list", changes: { name: "一覧" } },
            { op: "set_roles", roles: [{ id: "owner", name: "持ち主" }] },
            { op: "add_workflow", workflow: { id: "notify", name: "通知する" } },
            { op: "set_theme", theme: { slots: {} } },
          ],
        },
      }),
    ]);
    open(`/apps/${GROUP}/`);
    const dialog = await choose(0);
    const rows = within(dialog).getAllByTestId("compare-confirm-operation");
    expect(rows.length).toBe(4);
    expect(rows.map((row) => row.getAttribute("data-op"))).toEqual([
      "update_view",
      "set_roles",
      "add_workflow",
      "set_theme",
    ]);
    expect(rows[0]?.textContent).toContain("画面を変える");
    expect(rows[0]?.textContent).toContain("note-list");
    expect(rows[1]?.textContent).toContain("権限の設定を変える");
    expect(rows[2]?.textContent).toContain("自動処理を足す");
    expect(rows[3]?.textContent).toContain("配色を変える");
    const flagged = rows.map(
      (row) => within(row).queryByTestId("compare-confirm-operation-flag") !== null,
    );
    expect(flagged).toEqual([false, true, true, false]);
    expect(within(dialog).getAllByTestId("compare-confirm-operation-flag")[0]?.textContent).toBe(
      "要確認",
    );
    expect(posts().length).toBe(0);
  });

  test("OK → /compare を引き直してから、本物の POST /diffs へ1回だけ、候補の diff の末尾に選んだ記録を1本足して送る", async () => {
    setCompare([candidate(0), candidate(1), candidate(2)]);
    setDiffReply({ status: 201, body: { change: { entry: { diff_id: "d-compare-2" } } } });
    open(`/apps/${GROUP}/`);
    const dialog = await choose(2);
    confirmOk(dialog);
    await waitFor(() => {
      expect(posts().length).toBe(1);
    });
    const posted = posts()[0];
    expect(posted?.url).toBe(`/api/apps/${REAL}/diffs`);
    expect(posted?.credentials).toBe("include");
    // 理由を書かない → reason のキーを持たない choice の1本(D-V20-56 / D-V20-57)。
    const original = candidate(2).diff as { operations: unknown[] };
    expect(JSON.parse(posted?.body ?? "null")).toEqual({
      ...original,
      operations: [
        ...original.operations,
        {
          op: "remember_design",
          design_memory: { choice: { name: NAMES[2], tradeoff: TRADEOFFS[2] } },
        },
      ],
    });
    // 成功したら小窓は閉じる。
    await waitFor(() => {
      expect(screen.queryByTestId("compare-confirm")).toBeNull();
    });
    // 順序: 開いた時点の /compare → OK の直後の /compare → POST。
    const order = requests
      .filter((request) => request.url !== "/api/apps")
      .map((request) => `${request.method} ${request.url}`);
    expect(order).toEqual([
      `GET /api/apps/${GROUP}/compare`,
      `GET /api/apps/${GROUP}/compare`,
      `POST /api/apps/${REAL}/diffs`,
    ]);
    // 201: 「適用しました」と本物のアプリへの導線。残りの案は押せない。
    const result = await screen.findByTestId("compare-result");
    expect(result.textContent).toContain("適用しました");
    const link = within(result).getByRole("link");
    expect(link.getAttribute("href")).toBe(`/apps/${REAL}/`);
    for (const card of await cards()) {
      expect((within(card).getByTestId("compare-choose") as HTMLButtonElement).disabled).toBe(true);
    }
    // もう一度押しても送らない。
    fireEvent.click(within((await cards())[0] as HTMLElement).getByTestId("compare-choose"));
    expect(screen.queryByTestId("compare-confirm")).toBeNull();
    expect(posts().length).toBe(1);
  });
});

describe("(4b) 確認の小窓の作り替え(V20-M15-T01C。計画 §10-5 の中10・D-V20-57・D-V20-63・D-V20-64)", () => {
  const NOTICE = "ここに書いた文は、このアプリにログインできる人なら誰でも読めます";
  const FIXED = "この案の名前とトレードオフを、このアプリの選んだ記録に残します(最新20件まで)。";

  function reasonInput(dialog: HTMLElement): HTMLInputElement {
    return within(dialog).getByTestId("compare-confirm-reason") as HTMLInputElement;
  }

  function sentChoice(index: number): Record<string, unknown> | undefined {
    const body = JSON.parse(posts()[index]?.body ?? "null") as {
      operations: { op: string; design_memory?: { choice?: Record<string, unknown> } }[];
    };
    const last = body.operations[body.operations.length - 1];
    expect(last?.op).toBe("remember_design");
    return last?.design_memory?.choice;
  }

  test("理由の欄(任意・1行・字数で止めない)の上に固定文、下に注意書き(D-V20-63 の逐語)", async () => {
    setCompare([candidate(0)]);
    open(`/apps/${GROUP}/`);
    const dialog = await choose(0);
    const input = reasonInput(dialog);
    expect(input.tagName).toBe("INPUT");
    expect(input.value).toBe("");
    expect(input.required).toBe(false);
    expect(input.getAttribute("maxlength")).toBeNull();
    // ラベルで結ばれている。
    expect(within(dialog).getByLabelText("理由(任意)")).toBe(input);
    const fixed = within(dialog).getByTestId("compare-confirm-choice-note");
    const notice = within(dialog).getByTestId("compare-confirm-reason-notice");
    expect(fixed.textContent).toBe(FIXED);
    expect(notice.textContent).toBe(NOTICE);
    // 並び: 固定文 → 理由の欄 → 注意書き。
    expect(fixed.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(input.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 画面が足す choice の1本は変更の一覧に混ぜない(案の op の数だけ)。
    expect(within(dialog).getAllByTestId("compare-confirm-operation").length).toBe(1);
    expect(posts().length).toBe(0);
  });

  test("書いた理由は前後の空白を落として送る(1本の POST の末尾の choice.reason)", async () => {
    setCompare([candidate(0), candidate(1)]);
    setDiffReply({ status: 201, body: { change: { entry: { diff_id: "d-compare-1" } } } });
    open(`/apps/${GROUP}/`);
    const dialog = await choose(1);
    fireEvent.change(reasonInput(dialog), { target: { value: "  りゆうの文  " } });
    confirmOk(dialog);
    await screen.findByText(/適用しました/);
    expect(posts().length).toBe(1);
    expect(sentChoice(0)).toEqual({ name: NAMES[1], tradeoff: TRADEOFFS[1], reason: "りゆうの文" });
  });

  test("空白だけの理由は reason のキーを送らない", async () => {
    setCompare([candidate(0)]);
    setDiffReply({ status: 201, body: { change: { entry: { diff_id: "d-compare-0" } } } });
    open(`/apps/${GROUP}/`);
    const dialog = await choose(0);
    fireEvent.change(reasonInput(dialog), { target: { value: " \u3000 " } });
    confirmOk(dialog);
    await screen.findByText(/適用しました/);
    expect(posts().length).toBe(1);
    expect(Object.keys(sentChoice(0) ?? {})).toEqual(["name", "tradeoff"]);
  });

  test("400 のとき小窓は閉じず、理由の入力を保ち、エラーを小窓の中に出す。押し直すと /compare を引き直して POST をもう1回。成功は1回だけ", async () => {
    setCompare([candidate(0), candidate(1)]);
    let replies = 0;
    routes[`/api/apps/${REAL}/diffs`] = (method) => {
      if (method !== "POST") return undefined;
      replies += 1;
      return replies === 1
        ? {
            status: 400,
            body: {
              errors: [
                { path: "/operations/1/design_memory/choice/reason", message: "長すぎの文" },
              ],
            },
          }
        : { status: 201, body: { change: { entry: { diff_id: "d-compare-0" } } } };
    };
    open(`/apps/${GROUP}/`);
    const dialog = await choose(0);
    const long = "り".repeat(201);
    fireEvent.change(reasonInput(dialog), { target: { value: long } });
    confirmOk(dialog);
    await waitFor(() => {
      expect(within(dialog).getByTestId("errors").textContent).toContain("長すぎの文");
    });
    // 閉じていない・入力は保たれている・エラーは小窓の中。
    expect(screen.getByTestId("compare-confirm")).toBe(dialog);
    expect(within(dialog).getByTestId("compare-result")).toBeDefined();
    expect(reasonInput(dialog).value).toBe(long);
    expect(posts().length).toBe(1);
    expect(compareGets(GROUP).length).toBe(2);
    expect(screen.queryByText(/適用しました/)).toBeNull();
    await waitFor(() => {
      expect((within(dialog).getByTestId("compare-confirm-ok") as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    // 短くして押し直す → /compare をもう一度引いてから POST をもう1回。
    fireEvent.change(reasonInput(dialog), { target: { value: "みじかい" } });
    confirmOk(dialog);
    await screen.findByText(/適用しました/);
    expect(posts().length).toBe(2);
    expect(compareGets(GROUP).length).toBe(3);
    expect(sentChoice(0)?.reason).toBe(long);
    expect(sentChoice(1)?.reason).toBe("みじかい");
    const order = requests
      .filter((request) => request.url !== "/api/apps")
      .map((request) => `${request.method} ${request.url}`);
    expect(order).toEqual([
      `GET /api/apps/${GROUP}/compare`,
      `GET /api/apps/${GROUP}/compare`,
      `POST /api/apps/${REAL}/diffs`,
      `GET /api/apps/${GROUP}/compare`,
      `POST /api/apps/${REAL}/diffs`,
    ]);
    // 成功で小窓が閉じ、どの案も押せない(成功は束の中で1回だけ)。
    await waitFor(() => {
      expect(screen.queryByTestId("compare-confirm")).toBeNull();
    });
    for (const card of await cards()) {
      expect((within(card).getByTestId("compare-choose") as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(within((await cards())[1] as HTMLElement).getByTestId("compare-choose"));
    expect(screen.queryByTestId("compare-confirm")).toBeNull();
    expect(posts().length).toBe(2);
  });

  test("OK を続けて2回押しても、送っている間は POST 1回(OK を1回押すごとに1回)", async () => {
    setCompare([candidate(0)]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plainFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") await gate;
      return plainFetch(input, init);
    }) as typeof fetch;
    setDiffReply({ status: 201, body: { change: { entry: { diff_id: "d-compare-0" } } } });
    open(`/apps/${GROUP}/`);
    const dialog = await choose(0);
    confirmOk(dialog);
    confirmOk(dialog);
    await waitFor(() => {
      expect((within(dialog).getByTestId("compare-confirm-ok") as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    confirmOk(dialog);
    release();
    await screen.findByText(/適用しました/);
    await settleRequests();
    expect(posts().length).toBe(1);
    expect(compareGets(GROUP).length).toBe(2);
  });

  test("押し直しの前の /compare で古くなっていたら、小窓の中に文言を出して送らない(OK も止まる)", async () => {
    let calls = 0;
    setCompare(() => {
      calls += 1;
      return [candidate(0, { stale: calls > 2 })];
    });
    setDiffReply({ status: 409, body: { errors: [{ path: "", message: "競合の文" }] } });
    open(`/apps/${GROUP}/`);
    const dialog = await choose(0);
    confirmOk(dialog);
    await waitFor(() => {
      expect(within(dialog).getByTestId("errors").textContent).toContain("競合の文");
    });
    expect(posts().length).toBe(1);
    await waitFor(() => {
      expect((within(dialog).getByTestId("compare-confirm-ok") as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    confirmOk(dialog);
    await waitFor(() => {
      expect(within(dialog).getByTestId("compare-result").textContent).toContain(STALE_TEXT);
    });
    expect(compareGets(GROUP).length).toBe(3);
    expect(posts().length).toBe(1);
    expect((within(dialog).getByTestId("compare-confirm-ok") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("案の中の型の変更(patterns)は「型を変える」の1行と要確認の印。送る差分には remember_design が2本(D-V20-64)", async () => {
    const diff = {
      diff_id: "d-compare-pat",
      intent: INTENTS[0],
      operations: [
        { op: "update_view", view: "note-list", changes: { name: "一覧" } },
        {
          op: "remember_design",
          design_memory: { patterns: ["かたの文A", "かたの文B", "かたの文C"] },
        },
      ],
    };
    setCompare([candidate(0, { diff, off_pattern: true })]);
    setDiffReply({ status: 201, body: { change: { entry: { diff_id: "d-compare-pat" } } } });
    open(`/apps/${GROUP}/`);
    const dialog = await choose(0);
    const rows = within(dialog).getAllByTestId("compare-confirm-operation");
    expect(rows.map((row) => row.getAttribute("data-op"))).toEqual([
      "update_view",
      "remember_design",
    ]);
    expect(rows[1]?.textContent).toContain("型を変える: 型 3 件");
    expect(
      within(rows[1] as HTMLElement).getByTestId("compare-confirm-operation-flag").textContent,
    ).toBe("要確認");
    expect(
      within(rows[0] as HTMLElement).queryByTestId("compare-confirm-operation-flag"),
    ).toBeNull();
    // 型の文そのものは小窓に出さない。
    expect(dialog.textContent?.includes("かたの文A")).toBe(false);
    confirmOk(dialog);
    await screen.findByText(/適用しました/);
    const body = JSON.parse(posts()[0]?.body ?? "null") as { operations: { op: string }[] };
    expect(body.operations.map((operation) => operation.op)).toEqual([
      "update_view",
      "remember_design",
      "remember_design",
    ]);
  });

  test("やめる → 開き直すと理由の欄は空に戻る", async () => {
    setCompare([candidate(0)]);
    open(`/apps/${GROUP}/`);
    let dialog = await choose(0);
    fireEvent.change(reasonInput(dialog), { target: { value: "かきかけ" } });
    fireEvent.click(within(dialog).getByTestId("compare-confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("compare-confirm")).toBeNull();
    });
    dialog = await choose(0);
    expect(reasonInput(dialog).value).toBe("");
    expect(posts().length).toBe(0);
  });
});

describe("(5) 古い案は送らない(D-V20-49)", () => {
  test("開いた時点で stale: ボタンが最初から止まり、理由が出る。POST は0回", async () => {
    setCompare([candidate(0, { stale: true }), candidate(1)]);
    open(`/apps/${GROUP}/`);
    const [stale, fresh] = (await cards()) as [HTMLElement, HTMLElement];
    const button = within(stale).getByTestId("compare-choose") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(stale).getByTestId("compare-candidate-stale").textContent).toBe(STALE_TEXT);
    expect((within(fresh).getByTestId("compare-choose") as HTMLButtonElement).disabled).toBe(false);
    expect(within(fresh).queryByTestId("compare-candidate-stale")).toBeNull();
    fireEvent.click(button);
    expect(screen.queryByTestId("compare-confirm")).toBeNull();
    expect(posts().length).toBe(0);
  });

  test("OK の直後の /compare で stale: 文言を出して POST は0回。ボタンが止まる", async () => {
    let calls = 0;
    setCompare(() => {
      calls += 1;
      return [candidate(0, { stale: calls > 1 }), candidate(1, { stale: calls > 1 })];
    });
    setDiffReply({ status: 201, body: { change: { entry: { diff_id: "x" } } } });
    open(`/apps/${GROUP}/`);
    confirmOk(await choose(0));
    const result = await screen.findByTestId("compare-result");
    await waitFor(() => {
      expect(result.textContent).toContain(STALE_TEXT);
    });
    expect(compareGets(GROUP).length).toBe(2);
    expect(posts().length).toBe(0);
    await waitFor(async () => {
      const first = (await cards())[0] as HTMLElement;
      expect((within(first).getByTestId("compare-choose") as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
  });

  test("OK の直後の /compare に案が居ない(消えた)ときも送らない", async () => {
    let calls = 0;
    setCompare(() => {
      calls += 1;
      return calls > 1 ? [candidate(1)] : [candidate(0), candidate(1)];
    });
    setDiffReply({ status: 201, body: { change: { entry: { diff_id: "x" } } } });
    open(`/apps/${GROUP}/`);
    confirmOk(await choose(0));
    const result = await screen.findByTestId("compare-result");
    await waitFor(() => {
      expect(result.textContent).toContain(STALE_TEXT);
    });
    expect(posts().length).toBe(0);
  });
});

describe("(6) 応答ごとの文言", () => {
  async function applyWith(reply: Reply): Promise<HTMLElement> {
    setCompare([candidate(0), candidate(1)]);
    setDiffReply(reply);
    open(`/apps/${GROUP}/`);
    confirmOk(await choose(0));
    await waitFor(() => {
      expect(posts().length).toBe(1);
    });
    return await screen.findByTestId("compare-result");
  }

  test("401: 「適用するにはログインが要ります」と、本物のアプリを別のタブで開くリンク(D-V20-54)", async () => {
    const result = await applyWith({
      status: 401,
      body: { errors: [{ path: "", message: "ログインが必要です。" }] },
    });
    await waitFor(() => {
      expect(result.textContent).toContain("適用するにはログインが要ります");
    });
    const link = within(result).getByRole("link");
    expect(link.getAttribute("href")).toBe(`/apps/${REAL}/`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel") ?? "").toContain("noopener");
    // ログイン画面に落とさない。押し直せる。
    expect(screen.queryByTestId("login-page")).toBeNull();
    expect(
      (within((await cards())[0] as HTMLElement).getByTestId("compare-choose") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test("403(Origin の不一致): 「この画面からは適用できません」", async () => {
    const result = await applyWith({
      status: 403,
      body: {
        errors: [
          {
            path: "",
            message: 'リクエスト元 "http://127.0.0.1:3000" は許可されていません。',
            allowed_values: ["http://localhost:3000"],
            hint: "…",
          },
        ],
      },
    });
    await waitFor(() => {
      expect(result.textContent).toContain("この画面からは適用できません");
    });
    expect(result.textContent).not.toContain("権限がありません");
  });

  test("403(権限): 「権限がありません」", async () => {
    const result = await applyWith({
      status: 403,
      body: { errors: [{ path: "", message: "アプリの定義を変えられるのは…" }] },
    });
    await waitFor(() => {
      expect(result.textContent).toContain("権限がありません");
    });
    expect(result.textContent).not.toContain("この画面からは適用できません");
  });

  test("400: サーバのエラー一覧をそのまま出す", async () => {
    const result = await applyWith({
      status: 400,
      body: { errors: [{ path: "/operations/0", message: "拒否の文その一" }] },
    });
    await waitFor(() => {
      expect(within(result).getByTestId("errors").textContent).toContain("拒否の文その一");
    });
  });

  test("409: サーバのエラー一覧をそのまま出す", async () => {
    const result = await applyWith({
      status: 409,
      body: { errors: [{ path: "", message: "競合の文" }] },
    });
    await waitFor(() => {
      expect(within(result).getByTestId("errors").textContent).toContain("競合の文");
    });
  });
});

describe("(7) 束でない識別子・期限切れ", () => {
  test("404: 今日どおり1案の下見(下見の帯と画面)。/compare は1回だけ引く", async () => {
    open(`/apps/${SINGLE}/views/note-list`);
    expect(await screen.findByTestId("preview-banner")).toBeDefined();
    await screen.findByTestId("view-list");
    expect(screen.queryByTestId("compare-banner")).toBeNull();
    expect(screen.queryAllByTestId("compare-candidate").length).toBe(0);
    expect(compareGets(SINGLE).length).toBe(1);
    // /compare の後で本物の読み物へ進む(最初の要求が /compare)。
    const first = requests.find((request) => request.url.startsWith(`/api/apps/${SINGLE}/`));
    expect(first?.url).toBe(`/api/apps/${SINGLE}/compare`);
  });

  test("404 の頭では下見の帯を出さない(帯が出る時刻は今日どおり、写しの読み物の応答で決まる)", async () => {
    // 前段は案の識別子への /compare の 404 にも下見の頭を付ける(T01B の決めごと 3)。 それで帯を出すと、
    // 作業画面が読み込まれる前に帯が出る(今日より早い)。 写しの読み物が頭を持たなければ帯は出ない。
    routes[`/api/apps/${SINGLE}/auth/me`] = () => ({
      status: 200,
      body: { user: { id: "u1", username: "下見", displayName: null, role: "owner" } },
    });
    routes[`/api/apps/${SINGLE}/manifest`] = () => ({ status: 200, body: memoManifest(SINGLE) });
    routes[`/api/apps/${SINGLE}/tables/notes/records`] = () => ({
      status: 200,
      body: { records: [], total: 0 },
    });
    open(`/apps/${SINGLE}/views/note-list`);
    await screen.findByTestId("view-list");
    expect(compareGets(SINGLE).length).toBe(1);
    expect(screen.queryByTestId("preview-banner")).toBeNull();
  });

  test("410: 期限切れの画面(既存の文面)。案も帯も出ない", async () => {
    routes[`/api/apps/${GROUP}/compare`] = () => ({
      status: 410,
      body: { errors: [{ path: "", message: EXPIRED, hint: "作り直してください" }] },
    });
    open(`/apps/${GROUP}/`);
    const expired = await screen.findByTestId("preview-expired");
    expect(expired.textContent).toContain(EXPIRED);
    expect(screen.queryByTestId("compare-banner")).toBeNull();
    expect(screen.queryAllByTestId("compare-candidate").length).toBe(0);
    expect(screen.queryByTestId("login-page")).toBeNull();
  });

  test("陰性対照: 本物のアプリ(pv- の綴りでない)では /compare を引かない", async () => {
    routes[`/api/apps/${REAL}/auth/me`] = () => ({
      status: 401,
      body: { errors: [{ path: "", message: "ログインが必要です。" }] },
    });
    routes[`/api/apps/${REAL}/public`] = () => ({
      status: 200,
      body: { app: { id: REAL, name: "メモ" }, views: [] },
    });
    open(`/apps/${REAL}`);
    await waitFor(() => {
      expect(requests.some((request) => request.url.startsWith(`/api/apps/${REAL}/`))).toBe(true);
    });
    expect(requests.some((request) => request.url.endsWith("/compare"))).toBe(false);
  });
});

describe("(8) 製品に文面の表が無い(トレードオフは候補から来る)", () => {
  test("見比べの画面の源に、トレードオフ・名前・意図の文面の定数が無い", () => {
    for (const file of ["preview-compare.ts", "ComparePage.tsx"]) {
      const source = readFileSync(join(WEB_SRC, file), "utf8");
      // `tradeoff:` / `name:` に文字列の値を直に書いた行が0件。
      expect(source.match(/\b(tradeoff|intent)\s*:\s*["'`]/g) ?? []).toEqual([]);
      for (const fixture of [...NAMES, ...TRADEOFFS, ...INTENTS]) {
        expect(source.includes(fixture)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (9) 負荷の回数(`V20-M14-T05`。計画 §3 T05 / §10-5。**回数だけを数える。時間は測らない**)
//
// **ここで数えるのは親の頁が出す要求だけ**(happy-dom は iframe の中身を読まない。上の `beforeAll`)。
// iframe の中の回数(1案の下見を開く回数 N と、k 案の総量)は `web/e2e/preview-compare.e2e.ts` の (7) が
// chromium の要求の監視で数える。 差し替えの応答なので、ここの数は「画面が何を引きに行くか」であって
// 本物の前段の応答ではない。
// ---------------------------------------------------------------------------

/** 要求が落ち着くまで待つ(画面が引き終えた後に遅れて出る要求が無いことを見る)。 */
async function settleRequests(): Promise<void> {
  let last = -1;
  for (let round = 0; round < 20; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (requests.length === last) return;
    last = requests.length;
  }
  throw new Error("要求が落ち着かなかった");
}

/** 道筋の並び(問い合わせの文字列 `?…` は落とす。道筋ごとに数えるため)。 */
function routeList(): string[] {
  return requests.map((request) => `${request.method} ${request.url.split("?")[0]}`);
}

describe("(9) 負荷の回数(親の頁。回数だけ。時間は測らない)", () => {
  test("1案の下見(入口)を開く要求: アプリの一覧 1 + /compare 1 + /auth/me 1 + /manifest 1。行の取得は0", async () => {
    open(`/apps/${SINGLE}/`);
    await screen.findByTestId("preview-banner");
    await settleRequests();
    expect(routeList().sort()).toEqual(
      [
        "GET /api/apps",
        `GET /api/apps/${SINGLE}/compare`,
        `GET /api/apps/${SINGLE}/auth/me`,
        `GET /api/apps/${SINGLE}/manifest`,
      ].sort(),
    );
    expect(requests.filter((request) => request.url.includes("/records")).length).toBe(0);
  });

  test("1案の下見(一覧の画面)を開くと、入口の4本に行の取得が1本足される", async () => {
    open(`/apps/${SINGLE}/views/note-list`);
    await screen.findByTestId("view-list");
    await settleRequests();
    expect(routeList().sort()).toEqual(
      [
        "GET /api/apps",
        `GET /api/apps/${SINGLE}/compare`,
        `GET /api/apps/${SINGLE}/auth/me`,
        `GET /api/apps/${SINGLE}/manifest`,
        `GET /api/apps/${SINGLE}/tables/notes/records`,
      ].sort(),
    );
  });

  for (const k of [1, 2, 3]) {
    test(`${k}案の見比べ: 親の頁は2本(/compare 1 + アプリの一覧 1)で、案の数に依らない`, async () => {
      setCompare([candidate(0), candidate(1), candidate(2)].slice(0, k));
      open(`/apps/${GROUP}/`);
      expect((await cards()).length).toBe(k);
      await settleRequests();
      expect(routeList().sort()).toEqual(["GET /api/apps", `GET /api/apps/${GROUP}/compare`]);
    });
  }

  test("OK の直後は /compare 1 + POST /diffs 1 が足される(開いた時点の2本とは別に数える)", async () => {
    setCompare([candidate(0), candidate(1)]);
    setDiffReply({ status: 201, body: { change: { entry: { diff_id: "d-compare-0" } } } });
    open(`/apps/${GROUP}/`);
    await cards();
    await settleRequests();
    const opened = requests.length;
    expect(opened).toBe(2);
    confirmOk(await choose(0));
    await screen.findByTestId("compare-result");
    await settleRequests();
    expect(routeList().slice(opened)).toEqual([
      `GET /api/apps/${GROUP}/compare`,
      `POST /api/apps/${REAL}/diffs`,
    ]);
  });
});

describe("(V22-M2-T05) 19種目 set_workspace の言い方", () => {
  test("set_workspace は「その他の変更(set_workspace)」ではなく「メニューの置き方を変える」で出る。 印は付かない", () => {
    const lines = describeCompareOperations({
      diff_id: "d",
      intent: "i",
      operations: [
        {
          op: "set_workspace",
          workspace: {
            navigation: { placement: "top", by_role: [{ role: "staff", placement: "side" }] },
          },
        },
      ],
    });
    expect(lines).toEqual([
      { op: "set_workspace", label: "メニューの置き方を変える", target: "", flagged: false },
    ]);
    expect(COMPARE_OPERATION_LABELS.set_workspace).toBe("メニューの置き方を変える");
  });
});
