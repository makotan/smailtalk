/**
 * History API ベースの最小ルータのテスト(V1-M0-T12)。
 *
 * 検査対象は `web/src/navigation.tsx` の3つの export、`useRoute` / `navigate` /
 * `RouteLink` だけである。URL 文字列と `Route` の相互変換(`parseRoute` /
 * `routePath`)は `src/shared/route.test.ts` が既に固定しているので、ここでは
 * 再実装せず「URL が変わったことが購読側に届くか」「リンクがページ遷移を
 * 起こさずにルート変更になるか」だけを見る。
 *
 * ここに出てくるアプリID・ビューID はこのテストファイル内だけのフィクスチャで
 * あり、実装側には現れない(CP-3 確認方法4)。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { navigate, RouteLink, resolveDetailViewTarget, useRoute } from "../src/navigation.tsx";
import { type Route, routePath } from "../src/route.ts";

/** 実装が購読に使う自前イベント名(`navigation.tsx` の `NAVIGATION_EVENT`)。 */
const NAVIGATION_EVENT = "gp:navigate";

const APP_ID = "sample-app";
const LIST_ROUTE: Route = { kind: "view", appId: APP_ID, viewId: "item-list" };
const FORM_ROUTE: Route = { kind: "view", appId: APP_ID, viewId: "item-form" };
const DETAIL_ROUTE: Route = {
  kind: "view",
  appId: APP_ID,
  viewId: "item-detail",
  recordId: "item-0001",
};

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

/** `useRoute()` の返り値をそのまま観測するための最小コンポーネント。 */
function RouteProbe() {
  const route = useRoute();
  return <div data-testid="route">{JSON.stringify(route)}</div>;
}

function observedRoute(): Route {
  return JSON.parse(screen.getByTestId("route").textContent ?? "null") as Route;
}

/**
 * `navigate()` が呼ばれたかを数える。
 *
 * 修飾キー付きクリックではブラウザ(happy-dom)が `<a>` の既定動作として実際に
 * URL を進めてしまうため、`location` だけでは「実装が navigate したか」を区別
 * できない。実装が必ず流す自前イベントの回数で見る。
 */
function withNavigationEventCount<T>(body: (count: () => number) => T): T {
  let fired = 0;
  const listener = () => {
    fired += 1;
  };
  window.addEventListener(NAVIGATION_EVENT, listener);
  try {
    return body(() => fired);
  } finally {
    window.removeEventListener(NAVIGATION_EVENT, listener);
  }
}

/**
 * 「同テーブル先頭 detail_view 規約」のテスト用マニフェスト。
 * ここに出てくる ID はこのファイル内だけのフィクスチャである(CP-3 確認方法4)。
 */
function manifestWith(views: View[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "entries",
          name: "エントリ",
          fields: [{ id: "f_text", name: "テキスト", type: "text", required: true }],
        },
        {
          id: "others",
          name: "その他",
          fields: [{ id: "f_text", name: "テキスト", type: "text", required: true }],
        },
      ],
      views,
    },
  };
}

describe("resolveDetailViewTarget", () => {
  test("同じテーブルの detail_view が無ければ undefined", () => {
    const manifest = manifestWith([
      { id: "entry-list", type: "list_view", table: "entries", columns: ["f_text"] },
      { id: "other-detail", type: "detail_view", table: "others" },
    ]);
    expect(resolveDetailViewTarget(manifest, "entries")).toBeUndefined();
  });

  test("同じテーブルの detail_view が1つならそれを返す", () => {
    const only: View = { id: "entry-detail", type: "detail_view", table: "entries" };
    const manifest = manifestWith([
      { id: "entry-list", type: "list_view", table: "entries", columns: ["f_text"] },
      only,
    ]);
    expect(resolveDetailViewTarget(manifest, "entries")).toBe(only);
  });

  test("2つ以上あれば app.views の定義順で最初のものを返す", () => {
    const first: View = { id: "entry-detail-a", type: "detail_view", table: "entries" };
    const second: View = { id: "entry-detail-b", type: "detail_view", table: "entries" };
    const manifest = manifestWith([first, second]);
    const resolved = resolveDetailViewTarget(manifest, "entries");
    expect(resolved?.id).toBe("entry-detail-a");
    // 「後ろに置いた方ではない」ことを明示する(実装が最後を採っていたら落ちる)。
    expect(resolved).not.toBe(second);
    expect(resolved).toBe(first);
  });

  test("定義順を入れ替えれば返るものも入れ替わる(配列順そのものを見ている)", () => {
    const first: View = { id: "entry-detail-b", type: "detail_view", table: "entries" };
    const second: View = { id: "entry-detail-a", type: "detail_view", table: "entries" };
    const manifest = manifestWith([first, second]);
    // ID の辞書順(a < b)ではなく定義順で決まる。
    expect(resolveDetailViewTarget(manifest, "entries")?.id).toBe("entry-detail-b");
  });

  test("別テーブルの detail_view は選ばれない", () => {
    const manifest = manifestWith([
      { id: "other-detail", type: "detail_view", table: "others" },
      { id: "entry-detail", type: "detail_view", table: "entries" },
    ]);
    expect(resolveDetailViewTarget(manifest, "entries")?.id).toBe("entry-detail");
  });

  test("同じテーブルの list_view / form は選ばれない", () => {
    const manifest = manifestWith([
      { id: "entry-list", type: "list_view", table: "entries", columns: ["f_text"] },
      { id: "entry-form", type: "form", table: "entries", fields: ["f_text"] },
    ]);
    expect(resolveDetailViewTarget(manifest, "entries")).toBeUndefined();
  });

  test("存在しないテーブルID なら undefined", () => {
    const manifest = manifestWith([{ id: "entry-detail", type: "detail_view", table: "entries" }]);
    expect(resolveDetailViewTarget(manifest, "no-such-table")).toBeUndefined();
  });

  test("ビューが1つも無くても壊れない", () => {
    expect(resolveDetailViewTarget(manifestWith([]), "entries")).toBeUndefined();
  });
});

/**
 * **一続きの流れの段になっている `detail_view` を、行を押したときの行き先から外す**
 * (`FU-G1a`。`V10-M18-T01` / `ADR-0362` §Decision 1〜3)。
 *
 * ## ここで固定するもの
 *
 * - **第3引数を渡さない呼び出しは、今日と1ビットも同じである**(`ADR-0362` 限定2)——
 *   **`web/src/views/FormRenderer.tsx:837`(保存が成立したあとの行き先)がその呼び出しである。**
 * - **外すのは「`flow` を宣言している `detail_view`」すべてであり、`flow.id` の同一性を
 *   1文字も見ていない**(`V10-M18` の決定1)—— **`resolveDetailViewTarget` は呼び出し元の
 *   ビューを1つも受け取らないので、「同じ流れかどうか」を判定する材料がそもそも無い。**
 * - **外した結果0個なら `undefined` である。別の画面へ倒さない**(`ADR-0362` §Decision 3)。
 *
 * ## ここが固定しないこと(**誇張しない**)
 *
 * - **画面(DOM)を1つも見ていない。** 3つの遷移点で実際に押せなくなることは
 *   `web/test/record-navigation.test.tsx` / `web/test/list-view.test.tsx` /
 *   `web/test/field-display.test.tsx` が持ち、chromium の実測は
 *   `web/e2e/checkout-flow.e2e.ts` が持つ。
 * - **注記(`DetailTargetNote`)の文面を1文字も見ていない** —— **`countDetailViewTargets` を
 *   1バイトも触っていないので、段になった `detail_view` も今日どおり個数に入る**
 *   (`ADR-0362` 限定1)。
 */
describe("resolveDetailViewTarget と一続きの流れの段(FU-G1a / ADR-0362)", () => {
  const FLOW = { id: "kaimono", step: 3, kind: "input" } as const;
  const CONFIRM = { id: "kaimono", step: 4, kind: "confirm" } as const;
  const OTHER_FLOW = { id: "betsunonagare", step: 1, kind: "input" } as const;

  test("(a) 第3引数を渡さなければ、段になった detail_view も今日どおり選ぶ", () => {
    const stepView: View = {
      id: "entry-detail-step",
      type: "detail_view",
      table: "entries",
      flow: FLOW,
    };
    const manifest = manifestWith([stepView]);
    expect(resolveDetailViewTarget(manifest, "entries")).toBe(stepView);
  });

  test("(a) skipFlowStepViews に false を明示しても既定と1ビットも同じ", () => {
    const stepView: View = {
      id: "entry-detail-step",
      type: "detail_view",
      table: "entries",
      flow: FLOW,
    };
    const manifest = manifestWith([stepView]);
    expect(resolveDetailViewTarget(manifest, "entries", { skipFlowStepViews: false })).toBe(
      stepView,
    );
    expect(resolveDetailViewTarget(manifest, "entries", {})).toBe(stepView);
  });

  test("(b) 外すよう渡すと、段になった detail_view は候補から落ちる", () => {
    const manifest = manifestWith([
      { id: "entry-detail-step", type: "detail_view", table: "entries", flow: FLOW },
    ]);
    expect(
      resolveDetailViewTarget(manifest, "entries", { skipFlowStepViews: true }),
    ).toBeUndefined();
  });

  test("(b) kind が confirm の段も落ちる(2値のどちらでも外す)", () => {
    const manifest = manifestWith([
      { id: "entry-detail-confirm", type: "detail_view", table: "entries", flow: CONFIRM },
    ]);
    expect(
      resolveDetailViewTarget(manifest, "entries", { skipFlowStepViews: true }),
    ).toBeUndefined();
  });

  test("(b) 別の流れの段も落ちる(同じ flow.id の段だけを外すのではない)", () => {
    const manifest = manifestWith([
      { id: "entry-detail-other", type: "detail_view", table: "entries", flow: OTHER_FLOW },
      { id: "entry-detail-step", type: "detail_view", table: "entries", flow: FLOW },
    ]);
    expect(
      resolveDetailViewTarget(manifest, "entries", { skipFlowStepViews: true }),
    ).toBeUndefined();
  });

  test("(c) 段になっていない detail_view が後ろに在れば、それが選ばれる(定義順は保つ)", () => {
    const manifest = manifestWith([
      { id: "entry-detail-step", type: "detail_view", table: "entries", flow: FLOW },
      { id: "entry-detail-plain", type: "detail_view", table: "entries" },
    ]);
    expect(resolveDetailViewTarget(manifest, "entries", { skipFlowStepViews: true })?.id).toBe(
      "entry-detail-plain",
    );
    // **第3引数を渡さなければ今日どおり定義順の先頭である。**
    expect(resolveDetailViewTarget(manifest, "entries")?.id).toBe("entry-detail-step");
  });

  test("(c) 段でないものが2つ在れば、外したあとも定義順の先頭が選ばれる", () => {
    const manifest = manifestWith([
      { id: "entry-detail-step", type: "detail_view", table: "entries", flow: FLOW },
      { id: "entry-detail-a", type: "detail_view", table: "entries" },
      { id: "entry-detail-b", type: "detail_view", table: "entries" },
    ]);
    expect(resolveDetailViewTarget(manifest, "entries", { skipFlowStepViews: true })?.id).toBe(
      "entry-detail-a",
    );
  });

  test("(d) 候補が全部段なら undefined を返す —— 別の画面へ倒さない(ADR-0362 §Decision 3)", () => {
    const manifest = manifestWith([
      { id: "entry-detail-step3", type: "detail_view", table: "entries", flow: FLOW },
      { id: "entry-detail-step4", type: "detail_view", table: "entries", flow: CONFIRM },
      // **同じテーブルの一覧も入力画面も在るが、そこへは倒れない。**
      { id: "entry-list", type: "list_view", table: "entries", columns: ["f_text"] },
      { id: "entry-form", type: "form", table: "entries", fields: ["f_text"] },
      // **別テーブルの段でない詳細も在るが、そこへも倒れない。**
      { id: "other-detail", type: "detail_view", table: "others" },
    ]);
    expect(
      resolveDetailViewTarget(manifest, "entries", { skipFlowStepViews: true }),
    ).toBeUndefined();
  });

  test("(b) 段を宣言しているのが list_view / form の側なら、外す指示があっても結果は変わらない", () => {
    const manifest = manifestWith([
      { id: "entry-list", type: "list_view", table: "entries", columns: ["f_text"], flow: FLOW },
      { id: "entry-form", type: "form", table: "entries", fields: ["f_text"], flow: OTHER_FLOW },
      { id: "entry-detail-plain", type: "detail_view", table: "entries" },
    ]);
    expect(resolveDetailViewTarget(manifest, "entries", { skipFlowStepViews: true })?.id).toBe(
      "entry-detail-plain",
    );
  });

  test("(f) 段を1つも宣言していないマニフェストでは、第3引数の有無で結果が1つも変わらない", () => {
    const manifest = manifestWith([
      { id: "entry-list", type: "list_view", table: "entries", columns: ["f_text"] },
      { id: "entry-detail-a", type: "detail_view", table: "entries" },
      { id: "entry-detail-b", type: "detail_view", table: "entries" },
      { id: "other-detail", type: "detail_view", table: "others" },
    ]);
    for (const tableId of ["entries", "others", "no-such-table"]) {
      expect(resolveDetailViewTarget(manifest, tableId, { skipFlowStepViews: true })).toBe(
        resolveDetailViewTarget(manifest, tableId),
      );
    }
    // **1つも落ちていないことを、当たり先の名前でも見る。**
    expect(resolveDetailViewTarget(manifest, "entries", { skipFlowStepViews: true })?.id).toBe(
      "entry-detail-a",
    );
  });
});

describe("useRoute", () => {
  test("初期表示では現在の URL に対応する Route を返す", () => {
    window.history.replaceState({}, "", routePath(DETAIL_ROUTE));
    render(<RouteProbe />);
    expect(observedRoute()).toEqual(DETAIL_ROUTE);
  });

  test("navigate() の後は返す Route が変わる", () => {
    render(<RouteProbe />);
    expect(observedRoute()).toEqual({ kind: "app-list" });

    act(() => {
      navigate(LIST_ROUTE);
    });

    expect(window.location.pathname).toBe(routePath(LIST_ROUTE));
    expect(observedRoute()).toEqual(LIST_ROUTE);
  });

  test("navigate() を続けて呼べば、そのたびに Route が変わる", () => {
    render(<RouteProbe />);
    act(() => {
      navigate(LIST_ROUTE);
    });
    act(() => {
      navigate(DETAIL_ROUTE);
    });
    expect(observedRoute()).toEqual(DETAIL_ROUTE);
  });

  test("popstate(ブラウザの戻る)でも返す Route が変わる", () => {
    render(<RouteProbe />);
    act(() => {
      navigate(LIST_ROUTE);
    });
    expect(observedRoute()).toEqual(LIST_ROUTE);

    // ブラウザの「戻る」= URL が巻き戻ったうえで popstate が飛ぶ、を再現する。
    act(() => {
      window.history.replaceState({}, "", "/");
      window.dispatchEvent(new Event("popstate"));
    });

    expect(observedRoute()).toEqual({ kind: "app-list" });
  });

  test("解釈できないパスは not-found としてそのまま観測できる(黙って一覧に化けない)", () => {
    window.history.replaceState({}, "", "/nope/deep");
    render(<RouteProbe />);
    expect(observedRoute()).toEqual({ kind: "not-found", path: "/nope/deep" });
  });

  test("アンマウント後にリスナが残らない", () => {
    // `mockRestore()` は記録も消すので、復元する前に呼び出し履歴を写し取る。
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    const addSpy = spyOn(window, "addEventListener");
    const removeSpy = spyOn(window, "removeEventListener");
    try {
      const view = render(<RouteProbe />);
      view.unmount();
    } finally {
      for (const call of addSpy.mock.calls) {
        added.push([call[0] as string, call[1]]);
      }
      for (const call of removeSpy.mock.calls) {
        removed.push([call[0] as string, call[1]]);
      }
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }

    for (const type of ["popstate", NAVIGATION_EVENT]) {
      const addedHandlers = added.filter((call) => call[0] === type).map((call) => call[1]);
      const removedHandlers = removed.filter((call) => call[0] === type).map((call) => call[1]);
      // そもそも購読していないと「残っていない」が自明に通ってしまうので、
      // 購読が起きたこと自体も確かめる。
      expect(addedHandlers.length).toBeGreaterThan(0);
      expect(addedHandlers.filter((handler) => !removedHandlers.includes(handler))).toEqual([]);
    }
  });
});

describe("navigate", () => {
  test("違うパスなら pushState で履歴を進める", () => {
    const pushSpy = spyOn(window.history, "pushState");
    try {
      navigate(LIST_ROUTE);
      expect(pushSpy).toHaveBeenCalledTimes(1);
    } finally {
      pushSpy.mockRestore();
    }
    expect(window.location.pathname).toBe(routePath(LIST_ROUTE));
  });

  test("同じパスなら pushState しない", () => {
    window.history.replaceState({}, "", routePath(LIST_ROUTE));
    const pushSpy = spyOn(window.history, "pushState");
    try {
      navigate(LIST_ROUTE);
      expect(pushSpy).not.toHaveBeenCalled();
    } finally {
      pushSpy.mockRestore();
    }
  });

  test("同じパスでもイベントは常に発火する(購読側が取り残されない)", () => {
    window.history.replaceState({}, "", routePath(LIST_ROUTE));
    let fired = 0;
    const listener = () => {
      fired += 1;
    };
    window.addEventListener(NAVIGATION_EVENT, listener);
    try {
      navigate(LIST_ROUTE);
      navigate(LIST_ROUTE);
    } finally {
      window.removeEventListener(NAVIGATION_EVENT, listener);
    }
    expect(fired).toBe(2);
  });

  test("パスが同じでもクエリが残っていれば別の URL として進める", () => {
    window.history.replaceState({}, "", `${routePath(LIST_ROUTE)}?record=item-0001`);
    const pushSpy = spyOn(window.history, "pushState");
    try {
      navigate(LIST_ROUTE);
      expect(pushSpy).toHaveBeenCalledTimes(1);
    } finally {
      pushSpy.mockRestore();
    }
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe(routePath(LIST_ROUTE));
  });
});

describe("prefill 付きの遷移(EC-G14 / ADR-0045)", () => {
  const PREFILL_ROUTE: Route = {
    kind: "view",
    appId: APP_ID,
    viewId: "cart-form",
    prefill: { field: "product", value: "prod-1" },
  };

  test("navigate(prefill 付き)の後、useRoute が prefill を載せた Route を返す", () => {
    render(<RouteProbe />);
    act(() => {
      navigate(PREFILL_ROUTE);
    });
    expect(observedRoute()).toEqual(PREFILL_ROUTE);
  });

  test("prefill はパスに現れない(6セグメント不変・クエリ文字列に載る)", () => {
    /*
     * **【V5-M24-T01 / L-G17 で書き換えたテストである】**
     * 着手前のテスト名は「prefill は URL に現れない(6セグメント不変・一時状態)」で、
     * `window.location.search` が `""` であることを固定していた(`web/test/navigation.test.tsx:312-319`)。
     * **前段(「URL に現れない」)は偽になった。後段(「6セグメント不変」)は今日も真である。**
     */
    render(<RouteProbe />);
    act(() => {
      navigate(PREFILL_ROUTE);
    });
    expect(window.location.pathname).toBe("/apps/sample-app/views/cart-form");
    expect(window.location.search).toBe("?prefill.product=prod-1");
  });

  test("プリフィル付き URL を直接開くと、history に何も積まれていなくても prefill が復元される(L-G19)", () => {
    // 共有されたリンクを踏んだ場合・リロードした場合と同じ状況。`history.state` は `{}`。
    window.history.replaceState({}, "", "/apps/sample-app/views/cart-form?prefill.product=prod-1");
    render(<RouteProbe />);
    expect(observedRoute()).toEqual(PREFILL_ROUTE);
  });

  test("プリフィル付き URL からの戻る/進む(popstate)でも prefill が URL どおりに復元される", () => {
    render(<RouteProbe />);
    act(() => {
      navigate(PREFILL_ROUTE);
    });
    act(() => {
      // 戻る相当。`history.state` を消しても URL が残っていれば prefill は消えない。
      window.history.replaceState(null, "", routePath(LIST_ROUTE));
      window.dispatchEvent(new Event("popstate"));
    });
    expect(observedRoute()).toEqual(LIST_ROUTE);
    act(() => {
      window.history.replaceState(null, "", routePath(PREFILL_ROUTE));
      window.dispatchEvent(new Event("popstate"));
    });
    expect(observedRoute()).toEqual(PREFILL_ROUTE);
  });

  test("prefill 無しの別遷移では prefill が引き継がれない(後方互換・一時状態)", () => {
    render(<RouteProbe />);
    act(() => {
      navigate(PREFILL_ROUTE);
    });
    expect(observedRoute()).toEqual(PREFILL_ROUTE);
    act(() => {
      navigate(DETAIL_ROUTE);
    });
    // DETAIL_ROUTE は prefill を持たない。前の prefill が漏れ残らないこと。
    expect(observedRoute()).toEqual(DETAIL_ROUTE);
  });
});

describe("RouteLink", () => {
  test("href は routePath(to) の本物の URL になっている", () => {
    render(<RouteLink to={DETAIL_ROUTE}>詳細</RouteLink>);
    const link = screen.getByText("詳細") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(routePath(DETAIL_ROUTE));
  });

  test("クリックはページ遷移させず、ルート変更になる", () => {
    render(
      <>
        <RouteProbe />
        <RouteLink to={FORM_ROUTE}>フォームへ</RouteLink>
      </>,
    );

    const notPrevented = fireEvent.click(screen.getByText("フォームへ"));

    // `<a>` の既定動作(実際のページ遷移)は止まっていること。
    expect(notPrevented).toBe(false);
    expect(window.location.pathname).toBe(routePath(FORM_ROUTE));
    expect(observedRoute()).toEqual(FORM_ROUTE);
  });

  for (const modifier of ["metaKey", "ctrlKey", "shiftKey"] as const) {
    test(`${modifier} 付きのクリックはブラウザ本来の挙動に任せる`, () => {
      render(<RouteLink to={FORM_ROUTE}>フォームへ</RouteLink>);

      const notPrevented = withNavigationEventCount((count) => {
        const result = fireEvent.click(screen.getByText("フォームへ"), { [modifier]: true });
        // 既定動作を止めていない = 新規タブ等はブラウザに任せられる。
        expect(result).toBe(true);
        // `navigate()` は呼ばれない(自前イベントが流れない)。
        expect(count()).toBe(0);
        return result;
      });

      expect(notPrevented).toBe(true);
    });
  }

  test("既に defaultPrevented のクリックでは navigate しない", () => {
    render(
      // 先に preventDefault する外側(モーダルの背景など)を再現するためのテスト用ラッパ。
      <div
        onClickCapture={(event) => {
          event.preventDefault();
        }}
      >
        <RouteLink to={FORM_ROUTE}>フォームへ</RouteLink>
      </div>,
    );

    withNavigationEventCount((count) => {
      fireEvent.click(screen.getByText("フォームへ"));
      expect(count()).toBe(0);
    });

    expect(window.location.pathname).toBe("/");
  });
});
