/**
 * **画面からコメントを1件書く導線**の描画テスト(`V10-M11-T01` の2手目。台帳 `CM-G4` =
 * **門外**(`Δ7`)/ 判定値 = 限定採用)。
 *
 * ## この検査が主張すること
 *
 * > **アプリを使う人が、開いている画面から、その画面宛てのコメントを1件書ける。**
 * > **書く先は `POST /api/apps/:app_id/comments`(`V10-M11-T01` の1手目が足した口)の1本だけである。**
 *
 * ## この検査が主張**しない**こと(**先に書く。丸めない**)
 *
 * 1. **「未ログインでも書ける」とは1文字も主張しない。** **未ログインには導線が1つも出ない** ——
 *    **`src/mcp/vocabulary.ts` の `CANNOT_DO` (f)「未ログインには書き込みの導線を1つも出しません」は
 *    今日も真である。** **開けるのは `V10-M11-T03`(`CM-G6`)であって本工程ではない。**
 * 2. **「書いたものが読める」とは1文字も主張しない。** **読み出しの口は HTTP に1本も無い**
 *    (足すのは `V10-M15-T05`)。 **したがってこの導線は書きっぱなしであり、
 *    書いた本人が画面で読み返せない**(`CM-G4` §1-8 の限界1)。
 * 3. **画面から指せる宛先の形は `view`(画面そのもの)1形だけである。** **今日の登録簿は11形あるが、
 *    残る10形(`app` / `view_action` / `view_field` / `view_related` / `view_report_node` /
 *    `view_field_group` / `view_field_link` / `view_row` / `view_after_save` / `view_after_delete`)は
 *    画面から1つも指せない。** **この検査はその「指せなさ」を数で固定する**(下の (8))。
 * 4. **役割で1つも絞っていない**(`D-V10-5` = 使う人も含めて誰でも書ける)。 **絞りは
 *    「ログインしているか」の1点だけであり、サーバ側も役割の規則を1度も見ない。**
 *
 * ## 【`V10-M32-T03`(2026-08-26)】**上の 2. は今日の正ではない**
 *
 * **上の 1.〜4. を1バイトも書き換えていない**(制定時の記述としてそのまま残す。
 * `ADR-0007` §6 規律1 と同じ作法)。 **1. / 3. / 4. は今日も真である。**
 * **偽になったのは 2. の中の2文であり、内訳が違うので分けて書く:**
 *
 * - **「読み出しの口は HTTP に1本も無い」は既に偽である** ——
 *   **`GET /api/apps/:app_id/comments` が `src/server/auth-routes.ts` に在る。**
 *   **偽にしたのは `V10-M15-T05`(`CM-G21` / `ADR-0370`)であり、2026-08-24 の時点で
 *   既に偽だった。**
 * - **「書いた本人が画面で読み返せない」も今日は偽である** —— **偽にしたのは
 *   `V10-M32-T01`(台帳 `CM-G40`)である。** **本工程(`V10-M32-T03`)はそれを
 *   本物のブラウザで実測しただけであり、`web/src/` を1バイトも書き換えていない**
 *   (`web/e2e/comment-read.e2e.ts` の1本目)。
 *
 * **「この検査が『書いたものが読める』とは1文字も主張しない」ことそのものは今日も真である**
 * —— **本ファイルは読み出しの口を1度も叩かない**(下の「読出は今日0本」がそのまま緑である)。
 *
 * ## 【`V10-M32-T03`】**読み返せる場所と、読める範囲**(**誇張しない**)
 *
 * - **読み返せる場所はこの書く欄ではない** —— **作業画面の上にある「コメント」の導線
 *   (`data-testid="open-comment-list"`)から開く一覧(`web/src/CommentList.tsx`)である。**
 *   **この欄の中に読み出しの要素は1つも足されていない。**
 * - **読めるのは「その人に見える範囲」であって、「自分が書いたもの」とは一致しない** ——
 *   **絞っているのは `src/server/comment-visibility.ts` の可視集合だけであり、書き手が
 *   自分かで絞る規則は今日1本も無い。**
 * - **アプリごとの設定 `comment_visibility.read` が OFF なら、導線も一覧も1要素も出ない。**
 *   **既定は OFF である**(利用者決定 `D-V10-40`)。 **`write` と `read` は別なので、
 *   この書く欄が出ていても読む場所が出ているとは限らない**(`D-V10-36`)。
 * - **止めているのは画面に出すことだけで、口は1バイトも閉じていない**(`D-V10-38`)——
 *   **`GET /api/apps/:app_id/comments` は設定を今日1度も見ない。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { COMMENT_ANCHOR_FORMS } from "../../src/kernel/comment-store.ts";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { CommentPanel } from "../src/CommentPanel.tsx";
import { CommentVisibilityProvider, ViewHost } from "../src/views/ViewHost.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "sample-app";
/**
 * **器に差し込まれていることを見るときの立場**(**運営者ではない**)。
 * **リテラルではなく定数で渡している** —— **`role="viewer"` と直書きすると biome の
 * `lint/a11y/useValidAriaRole` が ARIA の `role` 属性と読み違えて赤くなる**
 * (既存の `web/test/flow-*.test.tsx` も同じ理由で定数を通している)。
 */
const VIEWER_ROLE = "viewer" as const;
const VIEW_ID = "note-list";
const COMMENTS_PATH = `/api/apps/${APP_ID}/comments`;

function manifest(): Manifest {
  const built: Manifest = {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
      ],
      views: [
        { id: VIEW_ID, name: "メモの一覧", type: "list_view", table: "notes", columns: ["title"] },
      ],
    },
  };
  return grantRules(built, ["viewer"], [viewRead(VIEW_ID)]);
}

function viewOf(): View {
  const view = manifest().app.views.find((candidate) => candidate.id === VIEW_ID);
  if (view === undefined) {
    throw new Error("題材が壊れている: 画面が無い");
  }
  return view;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Seen = { url: string; method: string; body: unknown };

let seen: Seen[];
let nextResponse: [number, unknown] | null;
let originalFetch: typeof fetch;

beforeEach(() => {
  seen = [];
  nextResponse = null;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    seen.push({ url, method, body });
    if (method === "POST" && url === COMMENTS_PATH) {
      if (nextResponse !== null) {
        return jsonResponse(nextResponse[1], nextResponse[0]);
      }
      const sent = body as { anchorForm: string; anchorParts: string[]; body: string };
      return jsonResponse(
        {
          comment: {
            id: "c-1",
            appId: APP_ID,
            anchorForm: sent.anchorForm,
            anchorParts: sent.anchorParts,
            body: sent.body,
            createdAt: "2026-08-24T00:00:00.000Z",
          },
        },
        201,
      );
    }
    // 一覧の描画が読むレコードなど、本ファイルの主題でない口は空で返す。
    return jsonResponse({ records: [], total: 0 }, 200);
  }) as typeof fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** ログイン済みの立場で導線だけを描く。 */
function renderPanel(role: "owner" | "editor" | "viewer" | "customer" = "viewer") {
  return render(
    <RoleProvider role={role}>
      <CommentPanel appId={APP_ID} view={viewOf()} />
    </RoleProvider>,
  );
}

/** 器に送られた POST を1件だけ取り出す。 */
function sentComment(): { anchorForm: string; anchorParts: string[]; body: string } {
  const posts = seen.filter((entry) => entry.method === "POST" && entry.url === COMMENTS_PATH);
  expect(posts).toHaveLength(1);
  return posts[0]?.body as { anchorForm: string; anchorParts: string[]; body: string };
}

// ---------------------------------------------------------------------------

test("V10-M11-T01: ログインしている利用者には、この画面へコメントを書く導線が1つ出る", () => {
  renderPanel();
  expect(screen.getAllByTestId("comment-panel")).toHaveLength(1);
  expect(screen.getByTestId("comment-body")).toBeDefined();
  expect(screen.getByTestId("comment-submit")).toBeDefined();
});

test("V10-M11-T01: 運営者でない立場でも導線が出る(役割で1つも絞らない。D-V10-5)", () => {
  for (const role of ["owner", "editor", "viewer", "customer"] as const) {
    cleanup();
    renderPanel(role);
    expect(screen.getAllByTestId("comment-panel")).toHaveLength(1);
  }
});

test("V10-M11-T01: 未ログイン(役割の供給が無い)には導線が1つも出ない —— 開けるのは V10-M11-T03", () => {
  render(<CommentPanel appId={APP_ID} view={viewOf()} />);
  expect(screen.queryByTestId("comment-panel")).toBeNull();
});

test("V10-M11-T01: 送ると書込の口が1回だけ呼ばれ、宛先の形と部品の数が登録簿の定義と一致する", async () => {
  renderPanel();
  fireEvent.change(screen.getByTestId("comment-body"), {
    target: { value: "ここは数量を先に出したい" },
  });
  fireEvent.click(screen.getByTestId("comment-submit"));
  await waitFor(() => {
    expect(seen.some((entry) => entry.method === "POST" && entry.url === COMMENTS_PATH)).toBe(true);
  });
  const sent = sentComment();
  expect(sent.body).toBe("ここは数量を先に出したい");
  // **手で焼いた形の名前にも件数にも依らない** —— **登録簿(`COMMENT_ANCHOR_FORMS`)から導く。**
  const entry = COMMENT_ANCHOR_FORMS.find((candidate) => candidate.form === sent.anchorForm);
  expect(entry === undefined ? `登録簿に無い形: ${sent.anchorForm}` : entry.form).toBe(
    sent.anchorForm,
  );
  expect(sent.anchorParts).toHaveLength(entry === undefined ? -1 : entry.parts.length);
  // **部品は開いている画面の ID そのものである**(器は宛先が実在するかを1度も見ない)。
  expect(sent.anchorParts).toEqual([VIEW_ID]);
});

test("V10-M11-T01: 受け付けられると入力欄が空になり、受け付けた旨が1つ出る", async () => {
  renderPanel();
  const box = screen.getByTestId("comment-body") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "並び順を変えたい" } });
  fireEvent.click(screen.getByTestId("comment-submit"));
  await waitFor(() => {
    expect(screen.getAllByTestId("comment-sent")).toHaveLength(1);
  });
  expect((screen.getByTestId("comment-body") as HTMLTextAreaElement).value).toBe("");
});

test("V10-M11-T01: 器が拒否した理由は、言い換えずにそのまま画面に出る", async () => {
  nextResponse = [400, { errors: [{ path: "", message: "コメントの本文は空にできません。" }] }];
  renderPanel();
  fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "   " } });
  fireEvent.click(screen.getByTestId("comment-submit"));
  await waitFor(() => {
    expect(screen.getByText("コメントの本文は空にできません。")).toBeDefined();
  });
  // **拒否されたら入力は消さない**(書いたものを黙って捨てない)。
  expect((screen.getByTestId("comment-body") as HTMLTextAreaElement).value).toBe("   ");
});

test("V10-M11-T01: この導線はコメントを読む口を1度も叩かない(読出は今日0本)", async () => {
  renderPanel();
  fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "読まない" } });
  fireEvent.click(screen.getByTestId("comment-submit"));
  await waitFor(() => {
    expect(seen.some((entry) => entry.method === "POST" && entry.url === COMMENTS_PATH)).toBe(true);
  });
  const reads = seen.filter((entry) => entry.method !== "POST" && entry.url.includes("/comments"));
  expect(reads).toEqual([]);
});

test("V10-M11-T01: 画面から指せる宛先は `view` の1形だけで、残りは1つも指せない", () => {
  renderPanel();
  fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "1形だけ" } });
  fireEvent.click(screen.getByTestId("comment-submit"));
  // **画面が宛先の形を選ばせる口(選択肢)を1つも出していない**ことを、要素の数で固定する。
  expect(screen.queryAllByTestId("comment-anchor-choice")).toHaveLength(0);
  // **指せない形の数は、登録簿の総数から「指せる1形」を引いたものである**(手で焼かない)。
  expect(COMMENT_ANCHOR_FORMS.length - 1).toBeGreaterThan(0);
});

test("V10-M11-T01: 画面の器(ViewHost)に差し込まれていて、画面を描くと導線が出る", async () => {
  const built = manifest();
  // **【2026-08-25。`V10-M31-T02`。台帳 `CM-G38` / `ADR-0379` 限定2 / 利用者決定 `D-V10-40`】**
  // **書く欄はアプリごとの設定で出し入れするようになり、**既定は OFF**である** ——
  // **器を描くだけでは出なくなったので、設定を ON にして包む。**
  // **旧の描画(逐語。1バイトも消していない)**:
  //   `render(`
  //   `  <RoleProvider role={VIEWER_ROLE}>`
  //   `    <ViewHost appId={APP_ID} manifest={built} view={viewOf()} />`
  //   `  </RoleProvider>,`
  //   `);`
  // **この検査が測っているのは「器に差し込まれているか」であり、出し入れそのものではない**
  // (出し入れの実測は `web/test/comment-visibility-toggle.test.tsx` が持つ)。
  // **残り8本は `CommentPanel` を直に描くので、設定を1つも通らない**(1バイトも触っていない)。
  // **【2026-08-26。`V10-M33-T01`。台帳 `CM-G43`】旧行の逐語(1バイトも消していない)**:
  //   `<CommentVisibilityProvider value={{ write: true, read: false }}>`
  // **`panel` を1本足しただけである** —— **器は書く欄の部品をコンテキストで受け取る形に
  // なった(配る版の成果物から落とすため)。** **測っているもの(器に差し込まれているか)は
  // 1ミリも弱めていない。**
  render(
    <CommentVisibilityProvider value={{ write: true, read: false }} panel={CommentPanel}>
      <RoleProvider role={VIEWER_ROLE}>
        <ViewHost appId={APP_ID} manifest={built} view={viewOf()} />
      </RoleProvider>
    </CommentVisibilityProvider>,
  );
  await waitFor(() => {
    expect(screen.getAllByTestId("comment-panel")).toHaveLength(1);
  });
});
