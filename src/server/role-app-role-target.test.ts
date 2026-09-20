/**
 * **`V8-M28`(第1波)—— 新しい2対象(アプリの設定 `app` / 人の役割 `role`)の判定の検査。**
 *
 * 台帳 `T-G14` / `T-G17`(`ADR-0007` §8。**どちらも限定採用**)、
 * ユーザ決定 `D-V8-49`(対象の種類を2つ増やす)/ `D-V8-59`(**新しい2対象も既定は閉じる。
 * 持ち主には最初から2行入れておく**)が仕様である。
 *
 * ## この検査が測るもの(**先に書く**)
 *
 * 1. **規則を1本も書いていないアプリで、`{ target: "app" }` / `{ target: "role" }` の
 *    判定が `allowed: false` / `governed: true` / `blockedBy: "role"` を返すこと**
 *    (= **既定で閉じる**。`D-V8-59`)。
 * 2. **`owner` に `app`+`write` を書いたら、`owner` にだけ `allowed: true` になること。**
 *    **別の役割の人には `false` のままであること。**
 * 3. **`role`+`write` も同じであること。**
 * 4. **`judgeRoleAccess` に分岐を1本も足さずに扱えていること** ——
 *    **`unruledRoleAccess` が `field` 以外を閉じるので、新2対象は自動的に閉じる側へ落ちる。**
 *
 * ## この検査が測らないもの(**誇張しない**)
 *
 * - **HTTP の口を1つも叩いていない。** **`POST /diffs` の関門(`app.ts` の
 *   `changeAuthMiddleware`)も、役割を配る口(`PATCH .../auth/users/:user_id`)も、
 *   今日はこの判定を1バイトも読んでいない** —— **配線は `V8-M29` 以降の担当である。**
 *   **【禁止】これを「定義の変更が役割の規則で守られるようになった」と書かない。**
 * - **ブラウザを1度も開いていない。**
 */
import { expect, test } from "bun:test";
import type { Manifest } from "../kernel/index.ts";
import { judgeRoleAccess, type RoleAccessDecision, type RoleAccessTarget } from "./owner-scope.ts";

const APP_TARGET: RoleAccessTarget = { target: "app" };
const ROLE_TARGET: RoleAccessTarget = { target: "role" };

/** 役割の宣言だけを持つマニフェスト(表も画面も1本も要らない —— 新2対象は指し先を持たない)。 */
function manifest(roles?: unknown): Manifest {
  return {
    app: {
      id: "authz",
      name: "権限",
      tables: [],
      views: [],
      ...(roles === undefined ? {} : { roles }),
    },
  } as unknown as Manifest;
}

const CLOSED: RoleAccessDecision = {
  allowed: false,
  governed: true,
  blockedBy: "role",
  conditional: false,
};

// **【2026-09-11 追記(`V18-M2-T10`。ユーザ決定 `D-V18-19` / `ADR-0438` 行11)。
//   旧の逐語を1バイトも消していない】**
//
// **旧**:
//
//     const OPEN: RoleAccessDecision = {
//       allowed: true,
//       governed: true,
//       blockedBy: null,
//       conditional: false,
//     };
//
// **`ADR-0438` 行11 が `RoleAccessDecision` に旗 `unconditionalAllow` を1つ足した。**
// **条件を1つも持たない規則で許可が出た判定には、この鍵が `true` で載る。**
// **`app` / `role` の答えは1ビットも変わっていない**(`allowed` / `governed` /
// `blockedBy` / `conditional` の4つは旧と同じである)。
const OPEN: RoleAccessDecision = {
  allowed: true,
  governed: true,
  blockedBy: null,
  conditional: false,
  unconditionalAllow: true,
};

// --- (a) 規則を1本も書いていなければ、既定で閉じる(`D-V8-59`)------------------------

test("(a) 役割を1つも宣言していないアプリでは、`app` / `role` の判定は閉じる", () => {
  const m = manifest(undefined);
  for (const target of [APP_TARGET, ROLE_TARGET]) {
    expect(judgeRoleAccess({ manifest: m, roles: ["owner"], target, verb: "write" })).toEqual(
      CLOSED,
    );
    // **未ログイン(`roles: null` → 主体 `anonymous`)にも同じ向きが及ぶ。**
    expect(judgeRoleAccess({ manifest: m, roles: null, target, verb: "write" })).toEqual(CLOSED);
  }
});

test("(a-2) 役割は宣言しているが規則を1本も書いていないアプリでも閉じる", () => {
  const m = manifest([{ id: "owner" }, { id: "editor" }, { id: "viewer" }]);
  for (const target of [APP_TARGET, ROLE_TARGET]) {
    expect(judgeRoleAccess({ manifest: m, roles: ["owner"], target, verb: "write" })).toEqual(
      CLOSED,
    );
  }
});

test("(a-3) 別の対象の規則をいくら書いても、`app` / `role` は閉じたままである", () => {
  const m = manifest([
    {
      id: "owner",
      rules: [{ target: "table", table: "orders", can: ["read", "write", "delete"] }],
    },
    { id: "editor" },
    { id: "viewer" },
  ]);
  for (const target of [APP_TARGET, ROLE_TARGET]) {
    expect(judgeRoleAccess({ manifest: m, roles: ["owner"], target, verb: "write" })).toEqual(
      CLOSED,
    );
  }
});

// --- (b) 書けば通る。**書いた役割の人にだけ**通る -----------------------------------

test("(b) `owner` に `app`+`write` を書いたら `owner` は通る", () => {
  const m = manifest([
    { id: "owner", rules: [{ target: "app", can: ["write"] }] },
    { id: "editor" },
    { id: "viewer" },
  ]);
  expect(
    judgeRoleAccess({ manifest: m, roles: ["owner"], target: APP_TARGET, verb: "write" }),
  ).toEqual(OPEN);
});

test("(b-2) 同じ宣言でも、別の役割の人には `false` のままである", () => {
  const m = manifest([
    { id: "owner", rules: [{ target: "app", can: ["write"] }] },
    { id: "editor" },
    { id: "viewer" },
  ]);
  for (const roles of [["editor"], ["viewer"], ["editor", "viewer"]]) {
    expect(judgeRoleAccess({ manifest: m, roles, target: APP_TARGET, verb: "write" })).toEqual(
      CLOSED,
    );
  }
  expect(judgeRoleAccess({ manifest: m, roles: null, target: APP_TARGET, verb: "write" })).toEqual(
    CLOSED,
  );
});

test("(b-3) `role`+`write` も同じである(2つは独立している)", () => {
  const m = manifest([
    { id: "owner", rules: [{ target: "role", can: ["write"] }] },
    { id: "editor" },
    { id: "viewer" },
  ]);
  expect(
    judgeRoleAccess({ manifest: m, roles: ["owner"], target: ROLE_TARGET, verb: "write" }),
  ).toEqual(OPEN);
  // **`app` の方は書いていないので、閉じたままである** —— **2つは別々である(`T-G19`)。**
  expect(
    judgeRoleAccess({ manifest: m, roles: ["owner"], target: APP_TARGET, verb: "write" }),
  ).toEqual(CLOSED);
});

test("(b-4) 「設定は変えられないが人を追加できる受付係」を書ける(`T-G19`)", () => {
  const m = manifest([
    {
      id: "owner",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
      ],
    },
    { id: "editor" },
    { id: "viewer" },
    { id: "reception", name: "受付", rules: [{ target: "role", can: ["write"] }] },
  ]);
  expect(
    judgeRoleAccess({ manifest: m, roles: ["reception"], target: ROLE_TARGET, verb: "write" })
      .allowed,
  ).toBe(true);
  expect(
    judgeRoleAccess({ manifest: m, roles: ["reception"], target: APP_TARGET, verb: "write" })
      .allowed,
  ).toBe(false);
});

// --- (c) 動詞は `write` 1語ちょうど --------------------------------------------------

test("(c) `read` / `delete` で問うても通らない(語彙が `write` 1語に絞っている)", () => {
  const m = manifest([
    {
      id: "owner",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
      ],
    },
    { id: "editor" },
    { id: "viewer" },
  ]);
  for (const target of [APP_TARGET, ROLE_TARGET]) {
    for (const verb of ["read", "delete"] as const) {
      expect(judgeRoleAccess({ manifest: m, roles: ["owner"], target, verb }).allowed).toBe(false);
    }
  }
});

// --- (d) 実効ロール集合は和集合1本である(`J-G3`)------------------------------------

test("(d) 実効ロール集合のどれか1つが持っていれば通る(和集合1本)", () => {
  const m = manifest([
    {
      id: "owner",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
      ],
    },
    { id: "editor" },
    { id: "viewer" },
  ]);
  expect(
    judgeRoleAccess({ manifest: m, roles: ["viewer", "owner"], target: APP_TARGET, verb: "write" })
      .allowed,
  ).toBe(true);
});
