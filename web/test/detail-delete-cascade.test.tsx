/**
 * **確認パネルの2つ目の状態**(`V18-M7-T05` / `PM-G5` / `ADR-0444` §Decision 5 の 行6 / 行7)。
 *
 * **着手前の形**: **詳細画面の削除の確認は1状態しか持たず**(「このレコードを削除します。元に戻せ
 * ません。」+「削除する」/「やめる」)、**サーバが `V18-M7-T02` で足した2本の断り**(`403` = 中に
 * 自分では消せない行が在る / `409` = 件数の印が無い・合わない)**は、どちらも `catch` の最後の
 * `setConfirmingDelete(false)` でパネルごと閉じられ、`detail-errors` の素の一覧に落ちていた**。
 *
 * **本ファイルが測るのは、その `setConfirmingDelete(false)` を分岐させた結果である。**
 *
 * | 画面の状態 | いつ出るか | 何が出るか |
 * |---|---|---|
 * | 1つ目(着手前と1バイトも同じ) | 「削除」を押した直後 | 「このレコードを削除します。元に戻せません。」+「削除する」/「やめる」 |
 * | 2つ目(件数) | `409` で断られたとき | **件数と表のID**(サーバの文面のまま)+「中身ごとまとめて消す」/「やめる」 |
 * | 2つ目(消せない) | `403` で断られたとき | **件数を1文字も出さず**「…あなたには消せないものがあります」+「やめる」だけ |
 *
 * **【禁止】これを「安全になった」と読まない** —— **止めているのはサーバであり、画面は断りを
 * 読んで出しているだけである。**
 *
 * **文面はサーバの断り文をそのまま出す**(画面側で書き直さない)—— **件数と表のIDは
 * `ValidationError` の `message` / `hint` の**文の中**にしか無く**(`ADR-0444` §Decision 5 の 行30。
 * 応答の鍵は4本のまま)、**画面で書き直すと同じ文が2箇所に増えて必ずずれる。** **画面が自分で足す
 * のは「まとめて消した行は取り消しでは戻りません。」の1行だけである**(`409` の ⑤ の `hint` には
 * この断りが1文字も無いため)。
 *
 * **サーバの逐語は `apps/smailtalk/src/server/app.ts` の `forbiddenCascadeDeleteError` /
 * `cascadeChildrenConfirmationError` から写した。** **(D) がその写しが今日も実物と一致することを
 * ソースを読んで固定する** —— **文面がずれたら画面は断りを読めなくなる。**
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, Manifest } from "../../src/kernel/types.ts";
import {
  ApiError,
  isApplyInProgress,
  isForbidden,
  isWriteConflict,
  type Role,
  readCascadeDeleteDenial,
} from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";

const WRITER_ROLE: Role = "owner";
const APP_ID = "cascade-app";
const RECORD_ID = "parent-0001";
const PARENTS_PATH = `/api/apps/${APP_ID}/tables/parents/records`;
const VERSION = "2026-09-14T00:00:00.000Z";

// --- サーバの断り文の逐語(`src/server/app.ts` から写した)-----------------------------
const FORBIDDEN_MESSAGE =
  "この行にぶら下がっている行の中に、あなたには消せないものがあります。この行は消せません。";
const FORBIDDEN_HINT =
  "ぶら下がっている行は、あなたが1件ずつ消せるものだけがまとめて消えます。どの行が消せないかは、この応答では示しません。ぶら下がっている行を消せる人に、先に消してもらうか、この行の削除を依頼してください。";
const confirmMessage = (total: number, where: string): string =>
  `この行には、ぶら下がっている行が ${total} 件あります(${where})。まとめて消してよければ、件数の印を付けて同じ操作をもう一度実行してください。1行も消していません。`;
const confirmHint = (total: number): string =>
  `件数の印は If-Match-Children ヘッダで、値は10進の整数 ${total} です。版の印(If-Match)とは別のもので、版の印は今までどおり必要です。まとめて消した行は取り消しでは戻りません。`;
const mismatchMessage = (seal: number, total: number, where: string): string =>
  `ぶら下がっている行の件数が、指定された件数の印(${seal})と合いません。今は ${total} 件です(${where})。1行も消していません。`;
const mismatchHint = (total: number): string =>
  `件数の印(If-Match-Children)に ${total} を指定して、同じ操作をもう一度実行してください。版の印(If-Match)ではありません。ぶら下がっている行は、数えた後にも増えたり減ったりします。`;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "親子",
      tables: [
        {
          id: "parents",
          name: "親",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
      ],
      views: [
        { id: "parent-list", type: "list_view", table: "parents", columns: ["title"] },
        { id: "parent-detail", type: "detail_view", table: "parents" },
      ],
    },
  };
}

function detailView(source: Manifest): DetailView {
  const view = source.app.views.find((candidate) => candidate.id === "parent-detail");
  if (view === undefined || view.type !== "detail_view") {
    throw new Error("fixture broken");
  }
  return view;
}

const PARENT_ROW = {
  _id: RECORD_ID,
  _created_at: VERSION,
  _updated_at: VERSION,
  title: "親の行",
};

type Sent = { url: string; method: string; headers: Record<string, string> };

let sent: Sent[];
let deleteResponses: [number, unknown][];
let originalFetch: typeof fetch;

function headerBag(init?: RequestInit): Record<string, string> {
  const bag: Record<string, string> = {};
  const raw = init?.headers;
  if (raw !== undefined) {
    for (const [key, value] of Object.entries(raw as Record<string, string>)) {
      bag[key.toLowerCase()] = value;
    }
  }
  return bag;
}

beforeEach(() => {
  sent = [];
  deleteResponses = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    sent.push({ url, method, headers: headerBag(init) });
    if (method === "DELETE") {
      const next = deleteResponses.shift() ?? [204, undefined];
      if (next[1] === undefined) {
        return new Response(null, { status: next[0] });
      }
      return new Response(JSON.stringify(next[1]), {
        status: next[0],
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "GET" && url === `${PARENTS_PATH}/${RECORD_ID}`) {
      return new Response(JSON.stringify({ record: PARENT_ROW }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ records: [PARENT_ROW] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}/views/parent-detail/records/${RECORD_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderDetail() {
  const source = manifest();
  return render(
    <RoleProvider role={WRITER_ROLE}>
      <DetailViewRenderer
        appId={APP_ID}
        manifest={source}
        view={detailView(source)}
        recordId={RECORD_ID}
      />
    </RoleProvider>,
  );
}

/** 「削除」→「削除する」まで押して、1回目の `DELETE` を撃たせる。 */
async function fireFirstDelete(): Promise<void> {
  fireEvent.click(await screen.findByTestId("detail-delete"));
  fireEvent.click(screen.getByTestId("detail-delete-execute"));
}

const deletes = (): Sent[] => sent.filter((entry) => entry.method === "DELETE");

// ---------------------------------------------------------------------------
// (A) 1つ目の状態 —— 着手前と1バイトも同じ
// ---------------------------------------------------------------------------
describe("(A) 1つ目の状態", () => {
  test("(A-1) 「削除」を押した直後は、着手前の文面とボタン2本だけが出る", async () => {
    renderDetail();
    fireEvent.click(await screen.findByTestId("detail-delete"));
    const panel = screen.getByTestId("detail-delete-confirm");
    expect(panel.textContent).toContain("このレコードを削除します。元に戻せません。");
    expect(screen.getByTestId("detail-delete-execute")).toBeDefined();
    expect(screen.getByTestId("detail-delete-cancel")).toBeDefined();
    // **2つ目の状態は、断られる前には1つも出ない。**
    expect(screen.queryByTestId("detail-delete-children")).toBeNull();
    expect(screen.queryByTestId("detail-delete-children-execute")).toBeNull();
    expect(deletes()).toHaveLength(0);
  });

  test("(A-2) 子が0件のときは着手前どおり1往復で消え、件数の印を1つも送らない", async () => {
    renderDetail();
    await fireFirstDelete();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/parent-list`);
    });
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]?.headers["if-match"]).toBe(VERSION);
    expect(deletes()[0]?.headers["if-match-children"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (B) 2つ目の状態(件数)—— `409`
// ---------------------------------------------------------------------------
describe("(B) 2つ目の状態(件数)", () => {
  const denial409 = (total: number, where: string): [number, unknown] => [
    409,
    {
      errors: [{ path: "", message: confirmMessage(total, where), hint: confirmHint(total) }],
    },
  ];

  test("(B-1) 件数で断られてもパネルは閉じず、件数と表のIDが画面に出る", async () => {
    deleteResponses = [denial409(3, "children")];
    renderDetail();
    await fireFirstDelete();

    const panel = await screen.findByTestId("detail-delete-children");
    // **件数**と**どの表に在るか**が、利用者の目に入る。
    expect(panel.textContent).toContain("3 件");
    expect(panel.textContent).toContain("children");
    // **パネルそのものは閉じていない**(`setConfirmingDelete(false)` を分岐させた結果)。
    expect(screen.getByTestId("detail-delete-confirm")).toBeDefined();
    // **1つ目の状態の「削除する」は消え、2つ目のボタンに置き換わる。**
    expect(screen.queryByTestId("detail-delete-execute")).toBeNull();
    expect(screen.getByTestId("detail-delete-children-execute").textContent).toBe(
      "中身ごとまとめて消す",
    );
    expect(screen.getByTestId("detail-delete-cancel")).toBeDefined();
    // **取り消しでは戻らないことを必ず出す。**
    expect(panel.textContent).toContain("取り消しでは戻りません");
    // **版不一致・適用中・閲覧のみの表示に吸われていない。**
    expect(screen.queryByTestId("write-conflict")).toBeNull();
    expect(screen.queryByTestId("apply-in-progress")).toBeNull();
    expect(screen.queryByTestId("write-forbidden")).toBeNull();
    // **画面はまだ動いていない**(1行も消えていない)。
    expect(window.location.pathname).toBe(
      `/apps/${APP_ID}/views/parent-detail/records/${RECORD_ID}`,
    );
  });

  test("(B-2) 「中身ごとまとめて消す」は件数の印を載せて撃ち直し、版の印は変わらない", async () => {
    deleteResponses = [denial409(3, "children"), [204, undefined]];
    renderDetail();
    await fireFirstDelete();
    fireEvent.click(await screen.findByTestId("detail-delete-children-execute"));

    await waitFor(() => {
      expect(deletes()).toHaveLength(2);
    });
    const second = deletes()[1];
    expect(second?.headers["if-match-children"]).toBe("3");
    // **版の印の載せ方は1ビットも変わらない。**
    expect(second?.headers["if-match"]).toBe(VERSION);
    expect(second?.url).toBe(`${PARENTS_PATH}/${RECORD_ID}`);
    // **1回目には件数の印が載っていない。**
    expect(deletes()[0]?.headers["if-match-children"]).toBeUndefined();
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/apps/${APP_ID}/views/parent-list`);
    });
  });

  test("(B-3) 印の件数が合わなければ、今の件数に差し替えてもう一度出す", async () => {
    deleteResponses = [
      denial409(3, "children"),
      [
        409,
        {
          errors: [{ path: "", message: mismatchMessage(3, 5, "children"), hint: mismatchHint(5) }],
        },
      ],
    ];
    renderDetail();
    await fireFirstDelete();
    fireEvent.click(await screen.findByTestId("detail-delete-children-execute"));

    await waitFor(() => {
      expect(screen.getByTestId("detail-delete-children").textContent).toContain("今は 5 件です");
    });
    // **ボタンはまだ在り、次は 5 を送る。**
    fireEvent.click(screen.getByTestId("detail-delete-children-execute"));
    await waitFor(() => {
      expect(deletes()).toHaveLength(3);
    });
    expect(deletes()[2]?.headers["if-match-children"]).toBe("5");
  });

  test("(B-4) 「やめる」でパネルごと閉じ、2つ目の状態も消える", async () => {
    deleteResponses = [denial409(3, "children")];
    renderDetail();
    await fireFirstDelete();
    await screen.findByTestId("detail-delete-children");
    fireEvent.click(screen.getByTestId("detail-delete-cancel"));
    expect(screen.queryByTestId("detail-delete-confirm")).toBeNull();
    expect(screen.queryByTestId("detail-delete-children")).toBeNull();
    // **押し直すと1つ目の状態から始まる。**
    fireEvent.click(screen.getByTestId("detail-delete"));
    expect(screen.getByTestId("detail-delete-execute")).toBeDefined();
    expect(screen.queryByTestId("detail-delete-children")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (C) 2つ目の状態(消せない)—— `403`
// ---------------------------------------------------------------------------
describe("(C) 2つ目の状態(消せない)", () => {
  const denial403: [number, unknown] = [
    403,
    { errors: [{ path: "", message: FORBIDDEN_MESSAGE, hint: FORBIDDEN_HINT }] },
  ];

  test("(C-1) 件数を1文字も出さず、まとめて消すボタンも出さない", async () => {
    deleteResponses = [denial403];
    renderDetail();
    await fireFirstDelete();

    const panel = await screen.findByTestId("detail-delete-children-forbidden");
    expect(panel.textContent).toContain("あなたには消せないものがあります");
    // **件数は1文字も出ない**(`ADR-0444` §Decision 3 の ③)。
    expect(/[0-9]+ 件/.test(panel.textContent ?? "")).toBe(false);
    expect(screen.queryByTestId("detail-delete-children-execute")).toBeNull();
    expect(screen.queryByTestId("detail-delete-execute")).toBeNull();
    // **「やめる」だけが残る。**
    expect(screen.getByTestId("detail-delete-cancel")).toBeDefined();
    expect(screen.getByTestId("detail-delete-confirm")).toBeDefined();
    // **「閲覧のみ」の表示には落とさない**(止めているのは子であって、この画面の書込権ではない)。
    expect(screen.queryByTestId("write-forbidden")).toBeNull();
  });

  test("(C-2) 押し直しても2往復目を撃たない", async () => {
    deleteResponses = [denial403];
    renderDetail();
    await fireFirstDelete();
    await screen.findByTestId("detail-delete-children-forbidden");
    expect(deletes()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (D) 既存の断りを1ビットも動かしていない / 文面の写しが今日も実物と一致する
// ---------------------------------------------------------------------------
describe("(D) 既存の断りと、文面の写し", () => {
  test("(D-1) 版不一致の 409 は今までどおり吸われ、パネルは閉じる", async () => {
    deleteResponses = [
      [
        409,
        {
          errors: [
            {
              path: "",
              message: "このレコードは、あなたが取得した後に別の操作で変更されています。",
            },
          ],
        },
      ],
    ];
    renderDetail();
    await fireFirstDelete();
    await screen.findByTestId("write-conflict");
    expect(screen.queryByTestId("detail-delete-confirm")).toBeNull();
    expect(screen.queryByTestId("detail-delete-children")).toBeNull();
  });

  test("(D-2) 子と関係ない 403 は今までどおり「閲覧のみ」に落ちる", async () => {
    deleteResponses = [
      [403, { errors: [{ path: "", message: "この操作を行う権限がありません。" }] }],
    ];
    renderDetail();
    await fireFirstDelete();
    await screen.findByTestId("write-forbidden");
    expect(screen.queryByTestId("detail-delete-confirm")).toBeNull();
    expect(screen.queryByTestId("detail-delete-children-forbidden")).toBeNull();
  });

  test("(D-3) 新しい 409 は `isWriteConflict` にも `isApplyInProgress` にも吸われない", () => {
    const error = new ApiError(409, [
      { path: "", message: confirmMessage(3, "children"), hint: confirmHint(3) },
    ]);
    expect(isWriteConflict(error)).toBe(false);
    expect(isApplyInProgress(error)).toBe(false);
    const denial = readCascadeDeleteDenial(error);
    expect(denial?.kind).toBe("children_confirmation");
    expect(denial?.kind === "children_confirmation" ? denial.total : -1).toBe(3);
  });

  test("(D-4) 新しい 403 は `isForbidden` では区別できず、読み取りの1本が分ける", () => {
    const error = new ApiError(403, [
      { path: "", message: FORBIDDEN_MESSAGE, hint: FORBIDDEN_HINT },
    ]);
    // **`isForbidden` は今日どおり真である**(1ビットも変えていない)。
    expect(isForbidden(error)).toBe(true);
    expect(readCascadeDeleteDenial(error)?.kind).toBe("children_forbidden");
    // **関係ない 403 / 409 は掴まない。**
    expect(
      readCascadeDeleteDenial(new ApiError(403, [{ path: "", message: "権限なし" }])),
    ).toBeNull();
    expect(
      readCascadeDeleteDenial(new ApiError(409, [{ path: "", message: "適用中です" }])),
    ).toBeNull();
    expect(readCascadeDeleteDenial(new Error("網の外"))).toBeNull();
  });

  test("(D-5) 画面が読む文面は、今日のサーバの逐語と1文字も違わない", () => {
    const source = readFileSync(resolve(import.meta.dir, "../../src/server/app.ts"), "utf8");
    // **③ の逐語**
    expect(source).toContain(FORBIDDEN_MESSAGE);
    // **④ / ⑤ の逐語**(件数の箇所だけテンプレートに戻して突き合わせる。
    // **綴りを素の文字列で書くと `noTemplateCurlyInString` が赤くなるので正規表現で撃つ**)
    expect(
      /この行には、ぶら下がっている行が \$\{total\} 件あります\$\{where\}。/.test(source),
    ).toBe(true);
    expect(/今は \$\{total\} 件です\$\{where\}。/.test(source)).toBe(true);
    // **どちらにも「変更されています」が1度も無い**(あると版不一致の表示に吸われる)。
    expect(source.includes("変更されています")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (E) **同じ一文が2度出ない**(`V18-M7-T07b`。実測台が見つけた)
//
// **着手前の形**: **画面は「まとめて消した行は取り消しでは戻りません。」を**必ず**自分で足して
// いた。** **ところが ④(件数の印が無い)の `hint` は、その一文で**終わっている** —— **利用者は
// 同じ文を2度読む。** **⑤(件数が合わない)の `hint` にはこの一文が1文字も無いので、画面が足す
// 側が要る。**
//
// **【サーバの文面は1バイトも変えない】** —— **直すのは画面の出し分けだけである**
// (`ADR-0444` 追記10-3 の 行7)。
// ---------------------------------------------------------------------------
describe("(E) 取り消しの断りが2度出ない", () => {
  const denial409 = (total: number, where: string, hint: string): [number, unknown] => [
    409,
    { errors: [{ path: "", message: confirmMessage(total, where), hint }] },
  ];

  /** パネルの本文に `needle` が何度出るか。 */
  const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

  const UNDO_WARNING = "まとめて消した行は取り消しでは戻りません。";

  test("(E-1) ④(印が無い)では、サーバの hint に在る一文を画面が2度目に出さない", async () => {
    deleteResponses = [denial409(5, "children", confirmHint(5))];
    renderDetail();
    await fireFirstDelete();

    const panel = await screen.findByTestId("detail-delete-children");
    // **サーバの hint は今日どおりこの一文で終わっている**(サーバを1バイトも変えていない裏)。
    expect(confirmHint(5).endsWith(UNDO_WARNING)).toBe(true);
    // **画面には1度しか出ない。**
    expect(occurrences(panel.textContent ?? "", UNDO_WARNING)).toBe(1);
  });

  test("(E-2) ⑤(件数が合わない)では、hint に無いので画面が1度だけ出す", async () => {
    deleteResponses = [
      [
        409,
        {
          errors: [{ path: "", message: mismatchMessage(4, 5, "children"), hint: mismatchHint(5) }],
        },
      ],
    ];
    renderDetail();
    await fireFirstDelete();

    const panel = await screen.findByTestId("detail-delete-children");
    // **⑤ の hint にはこの一文が1文字も無い**(だから画面が足す側が要る)。
    expect(mismatchHint(5)).not.toContain(UNDO_WARNING);
    expect(occurrences(panel.textContent ?? "", UNDO_WARNING)).toBe(1);
  });
});
