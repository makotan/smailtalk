/**
 * **未ログインの公開画面は、401 / 403 を受けた取得を繰り返さない**(`V21-M4-T07` / 計画 §10-1 /
 * 穴 `H-V21-15`)。
 *
 * **発見(`V21-M1` の実測。`docs/plan/v21/records/v21-m1.md` §4)**: 未ログインの公開画面が、読めない
 * 表(401)の一覧・単件を 2.5秒で約1000〜2000本撃ち続けた。 画面には「サーバと通信できませんでした:
 * Failed to fetch」が出た。 401 の分岐は回数の制限の手前にあるので、サーバ側では止まらない。
 *
 * **固定すること**: 描画の後に再描画を何度も待つ間(下の `SETTLE_MS`)に、**同じ URL への取得が
 * 1回**であること。 画面に「サーバと通信できませんでした」を出さないこと。
 *
 * **配布の器(`RunnerShell`)の同じ検査は `web/test/runner-anonymous-refetch.test.tsx`。**
 *
 * **測らないこと(誇張しない)**: 本物のサーバには当てていない(`fetch` の差し替え)。 実測台での
 * 要求の本数は `docs/plan/v21/records/v21-m4.md` に書く。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { App } from "../src/App.tsx";
import {
  APP_ID,
  countByUrl,
  REFETCH_CASES,
  type RefetchCase,
  SETTLE_MS,
  stubAnonymousDenied,
} from "./anonymous-refetch-fixture.ts";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

async function openAndSettle(testCase: RefetchCase, status: 401 | 403): Promise<string[]> {
  window.history.replaceState({}, "", `/apps/${APP_ID}${testCase.path}`);
  const requested = stubAnonymousDenied(status);
  render(<App />);
  await screen.findByTestId("anonymous-workspace");
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return requested;
}

describe("未ログインの公開画面は、断られた取得を繰り返さない(育成用の版 App)", () => {
  for (const status of [401, 403] as const) {
    for (const testCase of REFETCH_CASES) {
      test(`(R) ${testCase.label}: 行の取得が ${status} のとき、同じ URL への取得は1回`, async () => {
        const requested = await openAndSettle(testCase, status);
        const counts = countByUrl(requested.filter((url) => url.includes("/tables/")));
        // 少なくとも1本は撃っている(0本で緑にならない)。
        expect(Object.keys(counts).length).toBeGreaterThan(0);
        for (const [url, count] of Object.entries(counts)) {
          expect(count, url).toBe(1);
        }
        expect(document.body.textContent ?? "").not.toContain("サーバと通信できませんでした");
      });
    }
  }
});
