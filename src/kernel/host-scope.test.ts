/**
 * 宛先スコープ判定 `hostAllowed` の純関数テスト(V1-M4-T05 ハードニング / ADR-0020 原則1)。
 *
 * **この関数は enqueue 時(`workflow-runner.ts`)と dispatch 時(`outbox-dispatcher.ts`)の
 * 両方から呼ばれる単一ソースである。**判定ロジックを二重化しないことが、将来 owner が
 * 「接続の許可ホストを狭める」機能を足したときに、enqueue 済みの outbox 行を配送時にも
 * 同じ規則で弾ける根拠になる。ここはその判定そのものを、境界条件で固定する。
 */
import { describe, expect, test } from "bun:test";
import { hostAllowed } from "./host-scope.ts";

describe("hostAllowed", () => {
  test("allowedHosts が空なら常に不許可(既定 deny)", () => {
    expect(hostAllowed([], "https://api.example.com/x")).toBe(false);
  });

  test("ホスト名が一致すれば許可", () => {
    expect(hostAllowed(["api.example.com"], "https://api.example.com/v1/messages")).toBe(true);
  });

  test("大文字小文字を無視して比較する(両側を小文字化)", () => {
    expect(hostAllowed(["API.Example.COM"], "https://api.example.com/x")).toBe(true);
    expect(hostAllowed(["api.example.com"], "https://API.EXAMPLE.COM/x")).toBe(true);
  });

  test("userinfo 偽装 https://good@evil/ は hostname=evil で判定される", () => {
    // allowedHosts に good を挙げても、hostname は evil なので deny。
    expect(hostAllowed(["good"], "https://good@evil/x")).toBe(false);
    // 逆に evil を挙げれば allow(hostname が evil であることの裏取り)。
    expect(hostAllowed(["evil"], "https://good@evil/x")).toBe(true);
  });

  test("サブドメイン偽装 good.example.evil.example は good.example の別物として deny", () => {
    expect(hostAllowed(["good.example"], "https://good.example.evil.example/x")).toBe(false);
  });

  test("URL パースに失敗したら不許可(fail-closed)", () => {
    expect(hostAllowed(["api.example.com"], "not a url")).toBe(false);
    expect(hostAllowed(["api.example.com"], "")).toBe(false);
  });
});
