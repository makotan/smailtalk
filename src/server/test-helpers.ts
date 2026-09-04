/**
 * サーバテスト用の認証ヘルパ(V1-M3-T01 / 計画 v3 §D・アプリ単位認証)。
 *
 * per-app 認証境界(ADR-0014 v3)を張ったので、そのアプリの**レコード** API を叩く既存
 * テストは認証済みで叩く。ここでは対象アプリの `app.sqlite` 内の `_auth_*`(=`openForApp`)に
 * user+session を直接書き込み、`st_session` cookie 文字列を返す(app 側とは別接続だが同一
 * ファイルなので可視)。**cookie の Path はサーバ側 setCookie の話**で、テストはヘッダで
 * 送る(name=value)ので Path は不要。
 *
 * `authed(cookie)` は `app.request(...)` に渡す入力へ Cookie と Origin を注入する薄い
 * ラッパで、文字列パス・`Request` オブジェクトのどちらの呼び方も受ける。
 */
import { AuthStore } from "../auth/store.ts";
import type { Role } from "../auth/types.ts";

/** 既定の期待 origin(`loadAuthConfig` の既定と一致させる)。 */
export const TEST_ORIGIN = "http://localhost:5173";

export type SeededSession = {
  cookie: string;
  userId: string;
  username: string;
  sessionId: string;
  role: Role;
  /** **実効ロール集合**(`V8-M16` / `J-G3`。列の1値 ∪ 付与表)。 */
  roles: Role[];
};

/** `seedSession` の任意オプション。 */
export type SeedSessionOptions = {
  username?: string;
  /** シードするユーザのロール(V1-M3-T02)。既定 `owner`。**列の1値 = 既定の1本目。** */
  role?: Role;
  /**
   * **付与表(`_auth_user_roles`)に足す2本目以降の役割**(`V8-M16` / `J-G3`)。既定は空。
   * **実効ロール集合 = `role` ∪ `grants`** —— **判定はその和集合と宣言集合の積で決まる。**
   */
  grants?: readonly Role[];
};

/**
 * 対象アプリ(`<dataRoot>/apps/<appId>/app.sqlite`)の `_auth_*` に user と session を
 * 1件ずつ作り、`st_session=<id>` cookie 文字列を返す。username は衝突しないよう既定で
 * ランダム化する。**app.sqlite が既に存在している前提**(createApp / applyManifest の後に
 * 呼ぶ)—— `openForApp` は `CREATE TABLE IF NOT EXISTS` で `_auth_*` を足すだけで、既存の
 * アプリデータテーブルには触れない。
 *
 * ロールの既定は **`owner`**(V1-M3-T02)。既存テストの多くが「seed してから records を
 * **書く**」ため、既定 viewer だと書込が 403 になる。書込・管理ができる owner を既定にし、
 * viewer/editor の拒否テストだけ明示的に `{ role }` を渡す。第3引数は後方互換で username
 * 文字列も受ける(その場合 role は owner)。
 */
export function seedSession(
  dataRoot: string,
  appId: string,
  opts?: string | SeedSessionOptions,
): SeededSession {
  const options: SeedSessionOptions = typeof opts === "string" ? { username: opts } : (opts ?? {});
  const role: Role = options.role ?? "owner";
  const store = AuthStore.openForApp(dataRoot, appId);
  try {
    const name = options.username ?? `tester-${Math.random().toString(36).slice(2, 10)}`;
    const user = store.createUser({ username: name, role });
    // **【`V8-M16` / `J-G3`】2本目以降の役割は付与表に入れる**(列は1本しか持てない)。
    for (const granted of options.grants ?? []) {
      store.grantRole(user.id, granted);
    }
    const session = store.createSession(user.id, 3600);
    return {
      cookie: `st_session=${session.id}`,
      userId: user.id,
      username: name,
      sessionId: session.id,
      role,
      roles: store.effectiveRoles(user.id),
    };
  } finally {
    store.close();
  }
}

/**
 * `app.request(...)` 互換の入力に Cookie / Origin を注入するラッパを返す。
 * - 文字列パス: `http://localhost` を前置して Request を組む(init の method/body は活かす)。
 * - Request: 既にヘッダを持っている(`post`/`patch` ヘルパ由来)ので、そのまま通す。
 */
export function authed(cookie: string, origin: string = TEST_ORIGIN) {
  return (input: string | Request, init?: RequestInit): Request => {
    if (input instanceof Request) {
      return input;
    }
    const url = input.startsWith("http") ? input : `http://localhost${input}`;
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    if (!headers.has("origin")) {
      headers.set("origin", origin);
    }
    return new Request(url, { ...init, headers });
  };
}

/*
 * =====================================================================================
 * **【`V8-M26-T05`】検査の題材に、既定3役割の規則を足す下ごしらえ**
 * =====================================================================================
 *
 * ## なぜ要るのか(**着手前の実測**)
 *
 * **`V8-M26-T03` が面(役割に束ねた権限)の既定を「閉じる」側へ倒した** ——
 * **規則を1本も名指ししていない `table` / `view` / `action` は拒否される**
 * (`field` は今日どおり開いたまま)。**役割を1つも宣言していないアプリも閉じる。**
 *
 * **その埋め合わせとして `V8-M26-T04` が `src/kernel/apply-diff.ts` に自動付与を入れた**
 * —— **`add_table` / `add_view` / `update_view` を畳み込むたびに、既定3役割
 * (`owner` / `editor` / `viewer`)へ規則が1本ずつ入る。**
 *
 * **ところがサーバ層の検査の題材は `applyManifest` を直接呼ぶので、差分の畳み込みを
 * 1度も通らない = 自動付与に乗らない。** **したがって題材が `app.roles[].rules` を
 * 持たないかぎり、実アプリでは通る操作が検査の中だけ 403 になる。**
 *
 * **本ヘルパは、その差を埋めるためだけに在る** —— **`apply-diff.ts` の自動付与と
 * 同じ規則を、題材のマニフェストへ後から足す。**
 *
 * ## 【正直に書く】ここは判定を1ミリも緩めない
 *
 * - **`src/server/owner-scope.ts` は1バイトも触っていない。** **変えたのは題材の側だけである。**
 * - **配る動詞は `apply-diff.ts` の `DEFAULT_ROLE_RULE_VERBS` と同じである** ——
 *   **表 = 持ち主 `read`/`write`/`delete`・編集者 `read`/`write`・閲覧者 `read`、
 *   画面とボタン = 3役割とも `read` 1語**(スキーマが `read` しか許さない)。
 *   **「全部に全許可」を配ってはいない** —— **閲覧者は今日も書けないし消せない。**
 * - **項目(`field`)の規則は1本も足さない** —— **`T03` が項目を閉じていないからである
 *   (台帳 `T-G1b` = 却下)。**
 * - **`anonymous` には1本も足さない**(`D-V8-45` / `T-G26a`)。
 * - **同じ対象を名指しした規則が既に在る役割には足さない** —— **題材が自分で書いた宣言を
 *   上書きしない**(`apply-diff.ts` の条件3と同じ)。
 * - **`skipTables` / `skipViews` に挙げた対象には1本も足さない** —— **「面が閉じたままの
 *   対象」を検査が要る場面(v7 の行ごとの付与だけで通ることを測る検査など)で使う。**
 *
 * **【禁止】これを「既定を閉じたことの回避策」と読まない** —— **実アプリが差分を通せば
 * 必ず入る規則を、差分を通さない題材へ同じ形で入れているだけである。**
 */

/** 既定3役割の識別子(`src/kernel/types.ts` の `DEFAULT_ROLE_IDS` と同じ3語)。 */
const TEST_DEFAULT_ROLE_IDS = ["owner", "editor", "viewer"] as const;

/** 既定3役割の表示名(`src/kernel/create-app.ts` の `DEFAULT_ROLE_NAMES` と同じ)。 */
const TEST_DEFAULT_ROLE_NAMES: Record<(typeof TEST_DEFAULT_ROLE_IDS)[number], string> = {
  owner: "持ち主",
  editor: "編集者",
  viewer: "閲覧者",
};

/** 対象の種類 × 役割 → 配る動詞(`apply-diff.ts` の `DEFAULT_ROLE_RULE_VERBS` の写し)。 */
const TEST_DEFAULT_RULE_VERBS: Record<
  "table" | "view" | "action",
  Record<(typeof TEST_DEFAULT_ROLE_IDS)[number], readonly string[]>
> = {
  table: { owner: ["read", "write", "delete"], editor: ["read", "write"], viewer: ["read"] },
  view: { owner: ["read"], editor: ["read"], viewer: ["read"] },
  action: { owner: ["read"], editor: ["read"], viewer: ["read"] },
};

/** {@link withDefaultRoleRules} の任意オプション。 */
export type DefaultRoleRuleOptions = {
  /** **この表には規則を1本も足さない**(面を閉じたまま測りたい表)。 */
  skipTables?: readonly string[];
  /** **この画面(と、その画面のボタン)には規則を1本も足さない。** */
  skipViews?: readonly string[];
  /** **画面とボタンには一切足さない**(表だけ開けたいとき)。 */
  skipAllViews?: boolean;
};

type LooseRule = Record<string, unknown>;
type LooseRole = { id?: unknown; name?: unknown; rules?: LooseRule[] };

function namesSameTarget(rule: LooseRule, target: LooseRule): boolean {
  if (rule.target !== target.target) {
    return false;
  }
  switch (target.target) {
    case "table":
      return rule.table === target.table;
    case "view":
      return rule.view === target.view;
    case "action":
      return rule.view === target.view && rule.action === target.action;
    default:
      return false;
  }
}

function grantTo(roles: LooseRole[], target: LooseRule): void {
  for (const roleId of TEST_DEFAULT_ROLE_IDS) {
    const declaration = roles.find((candidate) => candidate.id === roleId);
    if (declaration === undefined) {
      continue;
    }
    const rules = declaration.rules;
    if (rules !== undefined && rules.some((rule) => namesSameTarget(rule, target))) {
      continue;
    }
    const rule: LooseRule = {
      ...target,
      can: [...TEST_DEFAULT_RULE_VERBS[target.target as "table" | "view" | "action"][roleId]],
    };
    if (rules === undefined) {
      declaration.rules = [rule];
    } else {
      rules.push(rule);
    }
  }
}

/**
 * **持ち主(`owner`)に必ず入る2行**(`V8-M28`。ユーザ決定 `D-V8-59` / 台帳 `T-G16a`)。
 *
 * **`src/kernel/create-app.ts` の `OWNER_DEFAULT_RULES` の写しである** ——
 * **本ヘルパは題材のマニフェストを直に組み立てるので `create-app` を通らず、
 * それでも適用時検査(`referential-integrity.ts` の類型17 の拡張)がこの2行を要求する。**
 * **【正直に書く】同じ2行が3箇所(`create-app.ts` / `referential-integrity.ts` /
 * 本ファイル)に在る。** **片方だけを変えると黙ってずれる。**
 */
const TEST_OWNER_DEFINITION_RULES: readonly LooseRule[] = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
];

/** 持ち主の宣言に、上の2行のうち欠けているものを足す(既に在れば1本も足さない)。 */
function grantOwnerDefinitionRules(roles: LooseRole[]): void {
  const owner = roles.find((role) => role.id === "owner");
  if (owner === undefined) {
    return;
  }
  for (const required of TEST_OWNER_DEFINITION_RULES) {
    const rules = owner.rules;
    if (
      rules !== undefined &&
      rules.some(
        (rule) =>
          rule.target === required.target &&
          Array.isArray(rule.can) &&
          (rule.can as unknown[]).includes("write"),
      )
    ) {
      continue;
    }
    const rule: LooseRule = { ...required, can: [...(required.can as string[])] };
    if (rules === undefined) {
      owner.rules = [rule];
    } else {
      rules.push(rule);
    }
  }
}

/**
 * **題材のマニフェストを複製し、既定3役割の規則を足して返す**(元の値は1バイトも変えない)。
 *
 * **`app.roles` を持たない題材には、既定3役割の宣言そのものを足す** ——
 * **`src/kernel/create-app.ts` が新規アプリに入れているのと同じ3宣言であり、
 * 適用時検査(`referential-integrity.ts` 類型15)が3語すべてを要求するからである。**
 *
 * **【2026-08-11 追記(`V8-M28`。`D-V8-59` / 台帳 `T-G16a`)】**
 * **持ち主(`owner`)には `{"target":"app","can":["write"]}` と
 * `{"target":"role","can":["write"]}` の2行も足す** —— **足さないと、類型17 の拡張が
 * 題材のマニフェストを丸ごと拒否する**(`applyManifest` が `valid: false` を返す)。
 * **これは判定を1ミリも緩めていない** —— **実アプリでは `create-app` が必ず入れる2行を、
 * `create-app` を通らない題材へ同じ形で入れているだけである。**
 */
export function withDefaultRoleRules<M>(manifest: M, options?: DefaultRoleRuleOptions): M {
  const clone = structuredClone(manifest) as { app?: Record<string, unknown> };
  const app = clone.app;
  if (app === undefined) {
    return clone as M;
  }
  const existing = Array.isArray(app.roles) ? (app.roles as LooseRole[]) : undefined;
  const roles: LooseRole[] =
    existing ??
    TEST_DEFAULT_ROLE_IDS.map((id) => ({ id, name: TEST_DEFAULT_ROLE_NAMES[id] }) as LooseRole);
  for (const id of TEST_DEFAULT_ROLE_IDS) {
    if (!roles.some((role) => role.id === id)) {
      roles.push({ id, name: TEST_DEFAULT_ROLE_NAMES[id] });
    }
  }
  const skipTables = new Set(options?.skipTables ?? []);
  const skipViews = new Set(options?.skipViews ?? []);
  for (const table of (app.tables ?? []) as { id?: unknown }[]) {
    if (typeof table.id !== "string" || skipTables.has(table.id)) {
      continue;
    }
    grantTo(roles, { target: "table", table: table.id });
  }
  if (options?.skipAllViews !== true) {
    for (const view of (app.views ?? []) as { id?: unknown; actions?: { id?: unknown }[] }[]) {
      if (typeof view.id !== "string" || skipViews.has(view.id)) {
        continue;
      }
      grantTo(roles, { target: "view", view: view.id });
      for (const action of view.actions ?? []) {
        if (typeof action.id !== "string") {
          continue;
        }
        grantTo(roles, { target: "action", view: view.id, action: action.id });
      }
    }
  }
  // **【`V8-M28`】持ち主の2行は、`skipTables` / `skipViews` の指定に関わらず必ず入れる** ——
  // **この2行は表にも画面にも紐づかない**(名指しする対象を持たない)。
  grantOwnerDefinitionRules(roles);
  app.roles = roles;
  return clone as M;
}
