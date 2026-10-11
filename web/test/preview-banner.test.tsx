/**
 * **下見の画面**(`V20-M13-T02c`。計画 `docs/plan/v20/15-v20-m13-plan.md` §9-6 / §10-4 / §10-9 の 19、
 * ユーザ決定 `D-V20-43` / `D-V20-45` / `D-V20-46`)。
 *
 * 前段(`src/server/preview-front.ts`。`V20-M13-T02b`)が返す形を写した差し替えの応答で、画面が
 *
 * - 下見の頭(`X-Smailtalk-Preview: mode=…; expires_at=…`)を受けたときだけ、上端に帯を出す
 *   (見本のときは「見本のデータで表示中」を添える)。本物のアプリには出さない(陰性対照)。
 * - 保存・削除のボタンを隠さず、押したときの 403 の `errors[0].message` をそのまま出す
 *   (「権限がありません(閲覧のみ)」を出さない)。
 * - 410 を受けたら「この下見は期限切れです」の画面を出す(空の画面・ログイン画面にしない)。
 * - 下見の画面の間は `<meta name="referrer" content="no-referrer">` を効かせる。
 * - 下見で 401 が来ても本物のログイン画面へ誘導しない。
 *
 * ことを撃つ。**ブラウザでの実測は `web/e2e/preview-banner.e2e.ts` が採る。**
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { ApiError, isForbidden } from "../src/api.ts";
import {
  formatPreviewDeadline,
  isPreviewAppId,
  parsePreviewHeader,
  previewBannerText,
  resetPreviewStates,
} from "../src/preview.ts";
import { grantRules, tableCan, viewRead } from "./role-rules.ts";

const PV = `pv-${"0123456789abcdef".repeat(2)}`;
const REAL = "memo-app";
const EXPIRES_AT = "2026-09-26T03:04:00.000Z";
const READ_ONLY = "下見なので保存されません";
const EXPIRED = "この下見は期限切れです";

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
      views: [
        { id: "note-list", type: "list_view", table: "notes", columns: ["title"] },
        { id: "note-form", type: "form", table: "notes", fields: ["title"] },
        { id: "note-detail", type: "detail_view", table: "notes" },
      ],
    },
  };
  return grantRules(
    built,
    ["owner"],
    [
      viewRead("note-list"),
      viewRead("note-form"),
      viewRead("note-detail"),
      tableCan("notes", "read", "write", "delete"),
    ],
  );
}

const ROW = {
  _id: "r1",
  _created_at: "2026-09-26T00:00:00.000Z",
  _updated_at: "2026-09-26T00:00:00.000Z",
  title: "見本 1",
};

type Handler = (method: string) => { status: number; body?: unknown } | undefined;

let requests: { url: string; method: string }[];
let originalFetch: typeof fetch;
/** 下見の頭を付ける値(`null` なら付けない)。 */
let previewHeader: string | null;
let routes: Record<string, Handler>;

function respond(url: string, status: number, body: unknown): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (previewHeader !== null && url.startsWith(`/api/apps/${PV}/`) && status !== 410) {
    headers.set("X-Smailtalk-Preview", previewHeader);
  }
  return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers });
}

function baseRoutes(appId: string): Record<string, Handler> {
  return {
    "/api/apps": () => ({
      status: 200,
      body: {
        apps: [
          { app_id: REAL, name: "メモ", created_at: "2026-01-01T00:00:00Z", status: "active" },
        ],
      },
    }),
    [`/api/apps/${appId}/auth/me`]: () => ({
      status: 200,
      body: { user: { id: "u1", username: "alice", displayName: null, role: "owner" } },
    }),
    [`/api/apps/${appId}/manifest`]: () => ({ status: 200, body: memoManifest(appId) }),
    [`/api/apps/${appId}/tables/notes/records/r1`]: (method) =>
      method === "DELETE"
        ? {
            status: 403,
            body: { errors: [{ path: "", message: READ_ONLY, hint: "下見の hint" }] },
          }
        : { status: 200, body: { record: ROW } },
    [`/api/apps/${appId}/tables/notes/records`]: (method) =>
      method === "POST"
        ? {
            status: 403,
            body: { errors: [{ path: "", message: READ_ONLY, hint: "下見の hint" }] },
          }
        : undefined,
  };
}

beforeEach(() => {
  requests = [];
  previewHeader = `mode=real; expires_at=${EXPIRES_AT}`;
  routes = baseRoutes(PV);
  resetPreviewStates();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    const handled = (routes[url] ?? routes[url.split("?")[0] ?? ""])?.(method);
    if (handled === undefined) {
      return respond(url, 404, { errors: [{ path: "", message: `no stub for ${method} ${url}` }] });
    }
    return respond(url, handled.status, handled.body);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
  resetPreviewStates();
});

function open(path: string): void {
  window.history.replaceState({}, "", path);
  render(<App />);
}

function referrerMeta(): string | null {
  return document.head.querySelector('meta[name="referrer"]')?.getAttribute("content") ?? null;
}

describe("(1) 純粋な部品", () => {
  test("下見のアプリID の綴りは pv- + 16進32桁だけ", () => {
    expect(isPreviewAppId(PV)).toBe(true);
    expect(isPreviewAppId(REAL)).toBe(false);
    expect(isPreviewAppId(`pv-${"0".repeat(31)}`)).toBe(false);
    expect(isPreviewAppId(`pv-${"0".repeat(33)}`)).toBe(false);
    expect(isPreviewAppId(`pv-${"A".repeat(32)}`)).toBe(false);
  });

  test("下見の頭を読む(壊れた頭は無いのと同じ)", () => {
    expect(parsePreviewHeader(`mode=real; expires_at=${EXPIRES_AT}`)).toEqual({
      mode: "real",
      expiresAt: EXPIRES_AT,
    });
    expect(parsePreviewHeader(`mode=sample; expires_at=${EXPIRES_AT}`)).toEqual({
      mode: "sample",
      expiresAt: EXPIRES_AT,
    });
    expect(parsePreviewHeader(null)).toBeNull();
    expect(parsePreviewHeader("")).toBeNull();
    expect(parsePreviewHeader(`mode=other; expires_at=${EXPIRES_AT}`)).toBeNull();
    expect(parsePreviewHeader("mode=real; expires_at=not-a-date")).toBeNull();
    expect(parsePreviewHeader("mode=real")).toBeNull();
  });

  test("期限は利用者の時計の HH:MM(2桁ずつ)", () => {
    const expected = new Date(EXPIRES_AT);
    const hh = String(expected.getHours()).padStart(2, "0");
    const mm = String(expected.getMinutes()).padStart(2, "0");
    expect(formatPreviewDeadline(EXPIRES_AT)).toBe(`${hh}:${mm}`);
  });

  test("帯の文言(実データ / 見本)", () => {
    const hhmm = formatPreviewDeadline(EXPIRES_AT);
    expect(previewBannerText({ mode: "real", expiresAt: EXPIRES_AT })).toBe(
      `下見(適用前)。保存されません。期限 ${hhmm}`,
    );
    expect(previewBannerText({ mode: "sample", expiresAt: EXPIRES_AT })).toBe(
      `下見(適用前)。保存されません。期限 ${hhmm}。見本のデータで表示中`,
    );
  });

  test("下見の断り(頭つきの 403 で前段の2文言)は権限不足と読まない", () => {
    const refused = new ApiError(403, [{ path: "", message: READ_ONLY }], "mode=real");
    expect(isForbidden(refused)).toBe(false);
    expect(
      isForbidden(new ApiError(403, [{ path: "", message: "下見では開けません" }], "mode=real")),
    ).toBe(false);
    // 陰性対照: 頭の無い 403 は今日どおり権限不足。
    const plain = new ApiError(403, [{ path: "", message: READ_ONLY }]);
    expect(plain.preview).toBeNull();
    expect(isForbidden(plain)).toBe(true);
    // 陰性対照: 頭つきでも前段の文言でない 403(写しの中の権限の断り)は権限不足。
    const inner = new ApiError(403, [{ path: "", message: "権限の断り" }], "mode=real");
    expect(isForbidden(inner)).toBe(true);
  });
});

describe("(2) 上端の帯", () => {
  test("実データの下見: 上端(シェルの見出しより前)に帯が出る", async () => {
    open(`/apps/${PV}/views/note-list`);
    const banner = await screen.findByTestId("preview-banner");
    const hhmm = formatPreviewDeadline(EXPIRES_AT);
    expect(banner.textContent).toContain(`下見(適用前)。保存されません。期限 ${hhmm}`);
    expect(banner.textContent).not.toContain("見本のデータで表示中");
    expect(banner.getAttribute("data-preview-mode")).toBe("real");
    // 上端: 画面の器(`main.shell`)の最初の子。
    expect(document.querySelector("main.shell")?.firstElementChild).toBe(banner);
    // 帯は役割の色の Tailwind の組で描く(新しい色の値を持たない)。
    expect(banner.className).toContain("bg-muted");
    expect(banner.className).toContain("text-foreground");
    expect(/#[0-9a-f]{3,8}|rgb\(|oklch\(/i.test(banner.outerHTML)).toBe(false);
  });

  test("見本の下見: 帯に「見本のデータで表示中」を添える", async () => {
    previewHeader = `mode=sample; expires_at=${EXPIRES_AT}`;
    open(`/apps/${PV}/views/note-list`);
    const banner = await screen.findByTestId("preview-banner");
    expect(banner.textContent).toContain("下見(適用前)。保存されません。期限");
    expect(within(banner).getByTestId("preview-banner-sample").textContent).toBe(
      "見本のデータで表示中",
    );
    expect(banner.getAttribute("data-preview-mode")).toBe("sample");
  });

  test("陰性対照: 本物のアプリには帯が出ない", async () => {
    routes = baseRoutes(REAL);
    open(`/apps/${REAL}/views/note-list`);
    await screen.findByTestId("view-list");
    expect(screen.queryByTestId("preview-banner")).toBeNull();
  });

  test("陰性対照: pv- の綴りでも下見の頭が来なければ帯は出ない(同じ綴りの本物のアプリ)", async () => {
    previewHeader = null;
    open(`/apps/${PV}/views/note-list`);
    await screen.findByTestId("view-list");
    expect(screen.queryByTestId("preview-banner")).toBeNull();
  });

  test("陰性対照: アプリ一覧には帯が出ない", async () => {
    open("/");
    await screen.findByTestId("app-list");
    expect(screen.queryByTestId("preview-banner")).toBeNull();
  });
});

describe("(3) Referer を送らない", () => {
  test("下見の画面の間だけ meta referrer=no-referrer が在り、離れると消える", async () => {
    expect(referrerMeta()).toBeNull();
    open(`/apps/${PV}/views/note-list`);
    await screen.findByTestId("preview-banner");
    expect(referrerMeta()).toBe("no-referrer");
    cleanup();
    expect(referrerMeta()).toBeNull();
  });

  test("陰性対照: 本物のアプリでは付けない", async () => {
    routes = baseRoutes(REAL);
    open(`/apps/${REAL}/views/note-list`);
    await screen.findByTestId("view-list");
    expect(referrerMeta()).toBeNull();
  });
});

describe("(4) 出したまま断る", () => {
  test("フォームの保存: ボタンは出ていて、押すと前段の文言が出る(閲覧のみの文言は出ない)", async () => {
    open(`/apps/${PV}/views/note-form`);
    await screen.findByTestId("preview-banner");
    const input = await waitFor(() => {
      const found = screen.getByTestId("view-renderer-form").querySelector("input");
      if (found === null) throw new Error("入力欄が無い");
      return found;
    });
    const form = screen.getByTestId("view-renderer-form");
    fireEvent.change(input, { target: { value: "下見で保存" } });
    const save = within(form).getByRole("button", { name: "保存" });
    fireEvent.click(save);
    await waitFor(() => {
      expect(screen.getByTestId("view-renderer-form").textContent).toContain(READ_ONLY);
    });
    expect(document.body.textContent).not.toContain("権限がありません(閲覧のみ)");
    expect(screen.queryByTestId("write-forbidden")).toBeNull();
    expect(requests.some((r) => r.method === "POST" && r.url.endsWith("/records"))).toBe(true);
  });

  test("詳細の削除: ボタンは出ていて、押すと前段の文言が出る", async () => {
    open(`/apps/${PV}/views/note-detail/records/r1`);
    await screen.findByTestId("preview-banner");
    fireEvent.click(await screen.findByTestId("detail-delete"));
    fireEvent.click(await screen.findByTestId("detail-delete-execute"));
    await waitFor(() => {
      expect(screen.getByTestId("detail-errors").textContent).toContain(READ_ONLY);
    });
    expect(document.body.textContent).not.toContain("権限がありません(閲覧のみ)");
  });

  // **【`V23-M12-T05`。`D-V23-398`・`D-V23-406`・授権 `ADR-0572` §2-1 の5 で打ち直した。題の旧の字面は消さず決定の番号を足した】**
  // 旧の期待(逐語):
  //     expect((await screen.findByTestId("write-forbidden")).textContent).toContain(
  //       "権限がありません(閲覧のみ)",
  //     );
  // 今日の正: 本物のアプリの 403 は今日どおり権限不足の器(write-forbidden)に出る。 断りの文に層の名
  // (「(止めた層:」「権限がありません(」)が混じらないので、器の中身は本文の文になる。
  // **【`V23-M12-T05b`】題に決定の番号を足した(旧の字面は消していない)。**
  test("陰性対照: 本物のアプリの 403 は今日どおり「権限がありません(閲覧のみ)」(D-V23-398・D-V23-406: 層の名が混じらない断りは、権限不足の器に本文の文を出す)(D-V23-418: 出してよい文の一覧に当たらない文は一律の文)", async () => {
    routes = baseRoutes(REAL);
    open(`/apps/${REAL}/views/note-form`);
    const input = await waitFor(() => {
      const found = screen.getByTestId("view-renderer-form").querySelector("input");
      if (found === null) throw new Error("入力欄が無い");
      return found;
    });
    const form = screen.getByTestId("view-renderer-form");
    fireEvent.change(input, { target: { value: "本物で保存" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    // **【`V23-M12-T05b`。`D-V23-418`・`D-V23-419`】出してよい文の一覧に当たらない文は今日の一律の文に戻した。
    // T05 の期待(逐語)**: `expect((await screen.findByTestId("write-forbidden")).textContent).toBe(READ_ONLY);`
    expect((await screen.findByTestId("write-forbidden")).textContent).toBe(
      "権限がありません(閲覧のみ)。",
    );
    expect(document.body.textContent).not.toContain(READ_ONLY);
    expect(document.body.textContent).not.toContain("下見の hint");
  });
});

describe("(5) 期限切れ", () => {
  test("開いた時点で 410: 「この下見は期限切れです」の画面(ログイン画面にしない)", async () => {
    const gone: Handler = () => ({
      status: 410,
      body: { errors: [{ path: "", message: EXPIRED, hint: "作り直してください" }] },
    });
    routes[`/api/apps/${PV}/manifest`] = gone;
    routes[`/api/apps/${PV}/auth/me`] = gone;
    open(`/apps/${PV}/views/note-list`);
    const expired = await screen.findByTestId("preview-expired");
    expect(expired.textContent).toContain(EXPIRED);
    expect(expired.textContent).toContain("作り直してください");
    expect(screen.queryByTestId("login-page")).toBeNull();
    expect(screen.queryByTestId("preview-banner")).toBeNull();
    // 期限切れの画面でも Referer は送らない。
    expect(referrerMeta()).toBe("no-referrer");
  });

  test("開いた後で 410(削除を押した時点で期限が切れていた): 期限切れの画面に替わる", async () => {
    routes[`/api/apps/${PV}/tables/notes/records/r1`] = (method) =>
      method === "DELETE"
        ? { status: 410, body: { errors: [{ path: "", message: EXPIRED }] } }
        : { status: 200, body: { record: ROW } };
    open(`/apps/${PV}/views/note-detail/records/r1`);
    await screen.findByTestId("preview-banner");
    fireEvent.click(await screen.findByTestId("detail-delete"));
    fireEvent.click(await screen.findByTestId("detail-delete-execute"));
    expect((await screen.findByTestId("preview-expired")).textContent).toContain(EXPIRED);
    expect(screen.queryByTestId("preview-banner")).toBeNull();
  });

  test("陰性対照: 本物のアプリの綴りの 410 は期限切れの画面にしない", async () => {
    routes = baseRoutes(REAL);
    routes[`/api/apps/${REAL}/manifest`] = () => ({
      status: 410,
      body: { errors: [{ path: "", message: "消えた" }] },
    });
    open(`/apps/${REAL}/views/note-list`);
    await screen.findByTestId("errors");
    expect(screen.queryByTestId("preview-expired")).toBeNull();
  });
});

describe("(6) ログイン画面に落とさない", () => {
  test("下見の頭つきで auth/me が 401 でも、本物のログイン画面を出さない", async () => {
    routes[`/api/apps/${PV}/auth/me`] = () => ({
      status: 401,
      body: { errors: [{ path: "", message: "ログインが必要です。" }] },
    });
    open(`/apps/${PV}/views/note-list`);
    await screen.findByTestId("preview-banner");
    expect(await screen.findByTestId("preview-unavailable")).toBeDefined();
    expect(screen.queryByTestId("login-page")).toBeNull();
  });

  test("陰性対照: 本物のアプリで auth/me が 401 ならログイン画面", async () => {
    routes = baseRoutes(REAL);
    routes[`/api/apps/${REAL}/auth/me`] = () => ({
      status: 401,
      body: { errors: [{ path: "", message: "ログインが必要です。" }] },
    });
    open(`/apps/${REAL}`);
    expect(await screen.findByTestId("login-page")).toBeDefined();
  });
});
