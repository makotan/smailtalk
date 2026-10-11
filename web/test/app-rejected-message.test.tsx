/**
 * **アプリが決めた断りの文言を、画面で確かめる**(`V23-M2-T08`。上位:
 * `docs/adr/0498-unique-message-reject-and-atomic-creator-grant.md` §Decision 1 の「応答」、
 * 計画 `docs/plan/v23/00-v23-plan.md` §21-2 の T08 と §21-4 の「T08 の赤の定義」)。
 *
 * サーバは、一意違反の文言(`unique_message`)と島の断り(`reject`)で書込を断ると、`422` と
 * 本文の最上位の `kind: "app_rejected"` と `errors` に作者の文言を返す。 手動起動のボタンでは `200` で
 * `failures` に「アプリが定めた理由で断りました: 」に続けて文言が載る。
 *
 * このファイルが固定すること:
 *
 * - (F-1) 作成のフォームで `422` / `kind: "app_rejected"`(項目の位置が空)を受けると、文言がフォームの上
 *   (最初の入力欄より前)にそのまま出る。 版の食い違い・権限不足の表示に吸われない。
 * - (F-2) 項目の位置が画面に出ている項目(`/code`)でも、文言はフォームの上に1回だけ出る。
 * - (F-3) 項目の位置が画面に出ていない項目(付与を記録する表の `/member` など)でも、フォームの上に出る。
 * - (F-4) 編集のフォーム(`PATCH`)でも同じ。
 * - (F-5) 陰性対照: `kind` の無い `400` は今日どおり(位置の空の失敗はフォームの下の器、項目の失敗は項目の下)で、
 *   フォームの上の器は出ない。 文言の差し替えが混ざった `400` も同じ。
 * - (B-1) 一覧の行のボタン: `failures` の文(前置きつき)が、前置きを足さず切り詰めずにそのまま出る(200文字の文言でも)。
 * - (B-2) 詳細画面のボタン: 同じ。
 *
 * **このファイルが証明しないこと**: `fetch` を差し替えており、本物のサーバを叩いていない。 サーバの 422 と
 * 文言は `src/server/unique-message.test.ts`・`src/server/island-reject.test.ts` が、ブラウザでの実測は
 * `web/e2e/unique-message.e2e.ts`(`V23-M2-T10`)が持つ。 表示が切り詰められないことは DOM の文字で見るだけで、
 * 描いたときの見切れ(折り返し・はみ出し)は見ていない。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DetailView, ListView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { DetailViewRenderer } from "../src/views/DetailViewRenderer.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "reject-app";
const OWNER: Role = "owner";
const VERSION = "2026-09-29T00:00:00.000Z";
const RECORDS_PATH = `/api/apps/${APP_ID}/tables/entries/records`;
const MSG = "その番号はもう使われています";
const MSG_MEMBER = "既に別のグループに所属しています";
/** 手動起動の `failures` の1件(サーバが作る前置き + 作者の文言)。 */
const PREFIX = "アプリが定めた理由で断りました: ";
const LONG = "あ".repeat(200);

const ROW = {
  _id: "entry-1",
  _created_at: VERSION,
  _updated_at: VERSION,
  title: "件名1",
  code: "C-001",
};

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "断りのアプリ",
      tables: [
        {
          id: "entries",
          name: "記録",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "code", name: "番号", type: "text", unique: true, unique_message: MSG },
          ],
        },
        { id: "logs", name: "履歴", fields: [{ id: "note", name: "メモ", type: "text" }] },
      ],
      views: [
        { id: "entry-form", type: "form", table: "entries", fields: ["title", "code"] },
        {
          id: "entry-list",
          type: "list_view",
          table: "entries",
          columns: ["title", "code"],
          actions: [{ run: "stamp", name: "印を付ける" }],
        },
        {
          id: "entry-detail",
          type: "detail_view",
          table: "entries",
          actions: [{ id: "stamp_it", run: "stamp", name: "印を付ける" }],
        },
      ],
      workflows: [
        {
          id: "stamp",
          name: "印を付ける",
          trigger: { type: "manual", table: "entries" },
          actions: [{ action: "run_function", function: "gate" }],
          history_table: "logs",
        },
      ],
    },
  } as unknown as Manifest;
}

type Call = { url: string; method: string };
let calls: Call[];
let routes: Map<string, [number, unknown]>;
let originalFetch: typeof fetch;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  routes = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === "string" ? input : input.toString()).split("?")[0] ?? "";
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const hit = routes.get(`${method} ${url}`);
    if (hit !== undefined) {
      return jsonResponse(hit[1], hit[0]);
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${method} ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", `/apps/${APP_ID}`);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

function renderForm(recordId?: string) {
  const built = manifest();
  const view = built.app.views.find((candidate) => candidate.id === "entry-form");
  if (view === undefined || view.type !== "form") {
    throw new Error("fixture broken");
  }
  return render(
    <RoleProvider role={OWNER} actorId="u-alice">
      <FormRenderer appId={APP_ID} manifest={built} view={view} recordId={recordId} />
    </RoleProvider>,
  );
}

/** 文言ちょうどを持つ要素(子に同じ文字を持つ親は除く = いちばん内側)。 */
function exactElements(text: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("*")].filter(
    (element) =>
      element.textContent === text &&
      [...element.children].every((child) => child.textContent !== text),
  );
}

/**
 * `a` が `b` より文書の前にあるか。 **`compareDocumentPosition` を使わない** —— happy-dom では、
 * 同じ親の下で前にある要素に対しても「後ろにある」を返すことを実測した(この検査を書く途中で、
 * 文言がフォームの最初の子に描かれているのに偽が返った)。 `querySelectorAll("*")` の並び(文書の順)で比べる。
 */
function precedes(a: Element, b: Element): boolean {
  const all = [...document.querySelectorAll("*")];
  const ia = all.indexOf(a);
  const ib = all.indexOf(b);
  if (ia < 0 || ib < 0) {
    throw new Error("文書に無い要素を比べた");
  }
  return ia < ib;
}

async function submitAndWaitFor(text: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: /保存/ }));
  await waitFor(() => expect(exactElements(text).length).toBeGreaterThan(0));
  const found = exactElements(text);
  expect(found).toHaveLength(1);
  return found[0] as HTMLElement;
}

function firstInput(): Element {
  const input = screen.getByTestId("view-renderer-form").querySelector("input, textarea, select");
  if (input === null) {
    throw new Error("入力欄が1つも無い");
  }
  return input;
}

describe("フォーム: 422 と kind: app_rejected の文言はフォームの上に出る", () => {
  test("(F-1) 作成で位置の空の文言 → フォームの上にそのまま1回出る", async () => {
    routes.set(`POST ${RECORDS_PATH}`, [
      422,
      { kind: "app_rejected", errors: [{ path: "", message: MSG }] },
    ]);
    renderForm();
    const shown = await submitAndWaitFor(MSG);
    expect(precedes(shown, firstInput())).toBe(true);
    expect(screen.queryByTestId("write-conflict")).toBeNull();
    expect(screen.queryByTestId("write-forbidden")).toBeNull();
  });

  test("(F-2) 位置が画面の項目(/code)でも、フォームの上に1回だけ出る", async () => {
    routes.set(`POST ${RECORDS_PATH}`, [
      422,
      { kind: "app_rejected", errors: [{ path: "/code", message: MSG }] },
    ]);
    renderForm();
    const shown = await submitAndWaitFor(MSG);
    expect(precedes(shown, firstInput())).toBe(true);
  });

  test("(F-3) 位置が画面に無い項目(付与を記録する表の /member)でも、フォームの上に出る", async () => {
    routes.set(`POST ${RECORDS_PATH}`, [
      422,
      { kind: "app_rejected", errors: [{ path: "/member", message: MSG_MEMBER }] },
    ]);
    renderForm();
    const shown = await submitAndWaitFor(MSG_MEMBER);
    expect(precedes(shown, firstInput())).toBe(true);
  });

  test("(F-4) 編集(PATCH)でも、フォームの上に出る", async () => {
    routes.set(`GET ${RECORDS_PATH}/entry-1`, [200, { record: ROW }]);
    routes.set(`PATCH ${RECORDS_PATH}/entry-1`, [
      422,
      { kind: "app_rejected", errors: [{ path: "", message: MSG }] },
    ]);
    renderForm("entry-1");
    await screen.findByDisplayValue("件名1");
    const shown = await submitAndWaitFor(MSG);
    expect(precedes(shown, firstInput())).toBe(true);
    expect(calls.some((call) => call.method === "PATCH")).toBe(true);
  });

  test("(F-5) 陰性対照: kind の無い 400 は今日どおりの場所に出て、フォームの上の器は出ない", async () => {
    routes.set(`POST ${RECORDS_PATH}`, [
      400,
      {
        errors: [
          { path: "", message: "位置の空の失敗" },
          { path: "/code", message: MSG },
        ],
      },
    ]);
    renderForm();
    fireEvent.click(await screen.findByRole("button", { name: /保存/ }));
    await waitFor(() =>
      expect(screen.getByTestId("form-errors").textContent).toContain("位置の空の失敗"),
    );
    // 項目の失敗は今日どおり項目の下(差し替えた文言が 400 に混ざっても、場所は今日のまま)。
    expect(screen.getByTestId("field-error-code").textContent).toContain(MSG);
    // 位置の空の失敗は今日どおり入力欄より後ろ(フォームの下の器)。
    expect(precedes(firstInput(), screen.getByTestId("form-errors"))).toBe(true);
    expect(screen.queryByTestId("form-app-rejected")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 【`V23-M12-T05`】断りの文 (4): 入力画面の 403(`D-V23-360`・`D-V23-398`・`D-V23-406`・`D-V23-413` (1))
// ---------------------------------------------------------------------------

/** 一律の文(今日の文)。 */
const UNIFORM = "権限がありません(閲覧のみ)。";
/** 見分けの綴り(`D-V23-413` (1)。この2つのどちらかを含む断りは一律の文)。 */
const LAYER_MARKERS = ["(止めた層:", "権限がありません("] as const;

const BODY_SHOWN: { label: string; message: string; hint: string }[] = [
  {
    label: "作れる立場の断り",
    message:
      "この表に行を作れる立場が決められており、あなたの立場はそこに挙がっていないため、行を作れません。",
    hint: "アプリを作った人に、行を作れる立場の一覧へあなたの立場を足してもらってください(この表の行の権限をもらっても、この断りは変わりません)。",
  },
  {
    label: "付与の書込の断り",
    message: "この行に権限を付けられるのは、この行で「管理」の権限を持つ人と運営者だけです。",
    hint: "この行で「管理」の権限を持つ人か、アプリの運営者に頼んでください。",
  },
  {
    label: "名簿の断り",
    message:
      "参加者の表で書き換えられるのは、自分の行の名前だけです。ほかの欄と、ほかの人の行は、アプリの運営者だけが書き換えられます。",
    hint: "自分の所属や、自分のアカウントの結びつきを自分で書き換えることはできません(書き換えられると、他の人に配ってある権限を受け取れてしまうためです)。変更が必要なときは、アプリの運営者に頼んでください。",
  },
  {
    label: "内部表の断り",
    message: "この表はアプリの中の記録のために製品が使う表なので、書き換えられません。",
    hint: "",
  },
];

const LAYERED: { label: string; message: string; hint: string }[] = [
  {
    label: "役割の層の断り",
    message: '表 "entries" に対する書き込みは、あなたの役割に許されていません(止めた層: role)。',
    hint: "アプリの役割の一覧(roles)で、この対象にその操作を許す規則(rules)を持つ役割が要ります。規則は足すことしかできません(拒否は書けません) —— set_roles で役割に規則を足してください。",
  },
  {
    label: "付与の層の断り(層の名)",
    message: "書き込む権限がありません(止めた層: role / grant)。",
    hint: "",
  },
  {
    label: "付与の層の断り(行の書換)",
    message: "この行を書き換える権限がありません(読むことはできます)。",
    hint: "この行を編集できる権限を、この行を作った人か運営者に付けてもらってください。",
  },
];

async function submitForbidden(message: string, hint: string): Promise<string> {
  routes.set(`POST ${RECORDS_PATH}`, [
    403,
    { errors: [hint === "" ? { path: "", message } : { path: "", message, hint }] },
  ]);
  renderForm();
  fireEvent.click(await screen.findByRole("button", { name: /保存/ }));
  const shown = await screen.findByTestId("write-forbidden");
  return shown.textContent ?? "";
}

describe("V23-M12-T05 D-V23-398・D-V23-406: 入力画面の 403 は、層の名が混じらない断りなら本当の理由の文を出す", () => {
  for (const sample of BODY_SHOWN) {
    test(`P4 D-V23-398: ${sample.label}は本文の文だけが出る(添える文と一律の文は出ない)`, async () => {
      const text = await submitForbidden(sample.message, sample.hint);
      expect(text).toBe(sample.message);
      if (sample.hint !== "") expect(document.body.textContent).not.toContain(sample.hint);
      expect(document.body.textContent).not.toContain(UNIFORM);
    });
  }

  for (const sample of LAYERED) {
    test(`P4 D-V23-406: ${sample.label}は今日の一律の文(本文・添える文・道具の名・表の ID は出ない)`, async () => {
      const text = await submitForbidden(sample.message, sample.hint);
      expect(text).toBe(UNIFORM);
      const page = document.body.textContent ?? "";
      expect({
        message: page.includes(sample.message),
        tool: page.includes("set_roles"),
        table: page.includes('"entries"'),
      }).toEqual({ message: false, tool: false, table: false });
    });
  }

  test("P4 D-V23-413 (1): 見分けの綴りは「(止めた層:」と「権限がありません(」の2つ。 一律の文の側の断りはどれも片方を含み、本文を出す側は1つも含まない", () => {
    expect(
      LAYERED.map((sample) => LAYER_MARKERS.some((marker) => sample.message.includes(marker))),
    ).toEqual(LAYERED.map(() => true));
    expect(
      BODY_SHOWN.map((sample) => LAYER_MARKERS.some((marker) => sample.message.includes(marker))),
    ).toEqual(BODY_SHOWN.map(() => false));
  });

  test("P4 D-V23-398: 編集(PATCH)の 403 も同じ(本文の文が出る)", async () => {
    routes.set(`GET ${RECORDS_PATH}/entry-1`, [200, { record: ROW }]);
    routes.set(`PATCH ${RECORDS_PATH}/entry-1`, [
      403,
      { errors: [{ path: "", message: BODY_SHOWN[2]?.message, hint: BODY_SHOWN[2]?.hint }] },
    ]);
    renderForm("entry-1");
    await screen.findByDisplayValue("件名1");
    fireEvent.click(await screen.findByRole("button", { name: /保存/ }));
    expect((await screen.findByTestId("write-forbidden")).textContent).toBe(
      BODY_SHOWN[2]?.message ?? "",
    );
  });
});

// ---------------------------------------------------------------------------
// 【`V23-M12-T05b`】入力画面の 403 は、出してよい文の一覧(許可の一覧)に当たる文だけを出す
// (`D-V23-418`・`D-V23-419`)。 一覧に当たらない文(欄の ID・表の ID・層の名などの内部の綴りが混じる文)は
// 今日の一律の文。
// ---------------------------------------------------------------------------

/** 本体のサーバの文を読む(突き合わせ。関数の名から最初の `message` の文字列を取り出す)。 */
const SERVER_SOURCE = readFileSync(resolve(import.meta.dir, "../../src/server/app.ts"), "utf8");

function serverMessageOf(name: string): string {
  const start = SERVER_SOURCE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`関数が無い: ${name}`);
  const body = SERVER_SOURCE.slice(start, SERVER_SOURCE.indexOf("\n}\n", start));
  const found = /message:\s*(?:"((?:[^"\\]|\\.)*)"|`([^`]*)`)/.exec(body);
  if (found === null) throw new Error(`message が無い: ${name}`);
  // 差し込みの穴(`${…}`)は見本の綴りで埋める(表の ID・リクエスト元)。
  return (found[1] ?? found[2] ?? "").replace(/\$\{[^}]*\}/g, "orders");
}

/** 作成と更新の口(と前段の中継・付与と作成の関門の翻訳)が呼ぶ断りの関数の全部(数え上げの見張り)。 */
function refusalFunctionsReachableFromForm(): string[] {
  const regionOf = (start: string, end: string): string => {
    const i = SERVER_SOURCE.indexOf(start);
    if (i < 0) throw new Error(`場所が無い: ${start}`);
    return SERVER_SOURCE.slice(i, SERVER_SOURCE.indexOf(end, i + start.length));
  };
  const regions = [
    regionOf(
      "const recordsAuthMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {",
      "\n  };\n",
    ),
    regionOf('app.post("/api/apps/:app_id/tables/:table_id/records", async (c) => {', "\n  });\n"),
    regionOf(
      'app.patch("/api/apps/:app_id/tables/:table_id/records/:record_id", async (c) => {',
      "\n  });\n",
    ),
    regionOf("function createParentDenial(", "\n}\n"),
    regionOf("function grantWriteDenial(", "\n}\n"),
  ];
  const names = new Set<string>();
  for (const region of regions) {
    const code = region
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    for (const hit of code.matchAll(/\b([a-zA-Z]+Error)\(/g)) names.add(hit[1] ?? "");
  }
  return [...names].sort();
}

/** 入力画面に届きうる 403 のうち、本文を出す文を返す関数(許可の一覧に当たる)。 */
const SHOWN_FUNCTIONS = [
  "internalTableWriteError",
  "forbiddenOwnerSpoofError",
  "forbiddenRootCreatableRoleError",
  "forbiddenUndeclaredRootCreateError",
  "forbiddenCreateParentAccessError",
  "forbiddenNamedPermissionMissingError",
  "forbiddenPreviousParentAccessError",
  "forbiddenUngovernedParentError",
  "forbiddenSelfGrantError",
  "forbiddenGrantParentAccessError",
  "forbiddenPrincipalRowWriteError",
];
/** 入力画面に届きうる 403 のうち、一律の文にする文を返す関数(内部の綴りか層の名が混じる)。 */
const UNIFORM_FUNCTIONS = [
  "originRejectedError",
  "forbiddenDirectCreateError",
  "forbiddenOwnerError",
  "forbiddenRecordWriteError",
];
/** 名簿の断り(1つの関数が3つの文を返す。逐語でサーバの文に在ることも見る)。 */
const MEMBERSHIP_TEXTS = [
  "参加者の表は、アプリの運営者だけが書き換えられます。",
  "グループの表は、アプリの運営者だけが書き換えられます。",
  "参加者の表で書き換えられるのは、自分の行の名前だけです。ほかの欄と、ほかの人の行は、アプリの運営者だけが書き換えられます。",
];

type ShownModule = {
  formForbiddenTextShown?: (text: string) => boolean;
  FORM_FORBIDDEN_SHOWN_TEXTS?: readonly RegExp[];
};

async function shownOf(): Promise<(text: string) => boolean> {
  const loaded = (await import("../src/views/WriteForbidden.tsx")) as ShownModule;
  expect(typeof loaded.formForbiddenTextShown).toBe("function");
  return loaded.formForbiddenTextShown as (text: string) => boolean;
}

describe("V23-M12-T05b D-V23-418・D-V23-419: 入力画面の 403 は、出してよい文の一覧に当たる文だけを出す", () => {
  test("N D-V23-418: 欄の ID を含む断り(st_owner の文)は今日の一律の文", async () => {
    const text = await submitForbidden(serverMessageOf("forbiddenOwnerError"), "");
    expect(text).toBe(UNIFORM);
    expect(document.body.textContent).not.toContain("st_owner");
  });

  test("N D-V23-418: 表の ID を含む断り(直接作れない表の文)は今日の一律の文", async () => {
    const text = await submitForbidden(serverMessageOf("forbiddenDirectCreateError"), "");
    expect(text).toBe(UNIFORM);
    expect(document.body.textContent).not.toContain('"orders"');
  });

  test("N D-V23-418: 一覧に無い文(リクエスト元の断り・項目の役割の断り・知らない文)も今日の一律の文", async () => {
    for (const message of [
      serverMessageOf("originRejectedError"),
      '項目 "code" に対する書き込みは、あなたの役割に許されていません(止めた層: role)。',
      "まだ誰も見たことのない断り。",
    ]) {
      cleanup();
      expect(await submitForbidden(message, "")).toBe(UNIFORM);
    }
  });

  test("P D-V23-418: 綴りの混じらない文(作成の条件・付与の書込・名簿・持ち主の詐称)は今日どおり本文が出る", async () => {
    for (const message of [
      serverMessageOf("forbiddenRootCreatableRoleError"),
      serverMessageOf("forbiddenCreateParentAccessError"),
      serverMessageOf("forbiddenOwnerSpoofError"),
      "この行の権限を外せるのは、この行で「管理」か「編集」の権限を持つ人と運営者だけです。",
      MEMBERSHIP_TEXTS[2] ?? "",
    ]) {
      cleanup();
      expect(await submitForbidden(message, "")).toBe(message);
    }
  });

  test("突き合わせ D-V23-419: 作成と更新の口が呼ぶ断りの関数は数え上げた全部で、403 の関数は出す・出さないのどちらかに分けてある", () => {
    expect(refusalFunctionsReachableFromForm()).toEqual(
      [
        // 403 で本文を出す
        ...SHOWN_FUNCTIONS,
        // 403 で一律の文
        ...UNIFORM_FUNCTIONS,
        // 403 で一律の文(層の名を含む。見本の文で別に見る)
        "forbiddenRoleAccessError",
        // 403 で本文を出す(文を組む関数。下の検査で見る)
        "grantWriteRefusalError",
        "forbiddenMembershipWriteError",
        // 403 でないもの(400・401・404・409・429・500。GET だけの 403 を含む)
        "applyInProgressError",
        "creatorGrantUnreachableError",
        "creatorGrantWriteFailedError",
        "forbiddenSystemTableReadError",
        "lastRowAdminError",
        "missingIfMatchError",
        "mixedPrincipalRowHolderError",
        "notAMemberError",
        "rateLimitError",
        "readOnlyTableError",
        "recordAccessLimitError",
        "unauthenticatedError",
        "unknownGrantHolderError",
        "unknownGrantTargetError",
        "unknownRecordError",
      ].sort(),
    );
  });

  test("突き合わせ D-V23-418・D-V23-419: サーバの文を一覧に当てると、出す文は全部当たり、一律の文は1つも当たらない", async () => {
    const shown = await shownOf();
    const { grantWriteRefusalError } = await import("../../src/server/errors.ts");
    const { forbiddenRoleAccessError } = await import("../../src/server/app.ts");
    const shownTexts = [
      ...SHOWN_FUNCTIONS.map(serverMessageOf),
      ...MEMBERSHIP_TEXTS,
      ...(["create", "update", "delete"] as const).flatMap((op) =>
        [["管理"], ["管理", "編集"], []].map((names) => grantWriteRefusalError(op, names).message),
      ),
    ];
    // 名簿の文は「${what}の表は、…」の差し込みと、名前の欄の文の逐語でサーバに在る。
    expect(SERVER_SOURCE).toContain('const what = kind === "member" ? "参加者" : "グループ";');
    expect(SERVER_SOURCE).toContain(
      ["`$", "{what}の表は、アプリの運営者だけが書き換えられます。`"].join(""),
    );
    expect(SERVER_SOURCE).toContain(MEMBERSHIP_TEXTS[2] ?? "");
    const uniformTexts = [
      ...UNIFORM_FUNCTIONS.map(serverMessageOf),
      forbiddenRoleAccessError('表 "orders"', "書き込み").message,
      forbiddenRoleAccessError('表 "orders" のボタン', "作成").message,
      forbiddenRoleAccessError('表 "orders" のこの行', "更新").message,
      forbiddenRoleAccessError('項目 "code"', "書き込み").message,
      "書き込む権限がありません(止めた層: role / grant)。",
    ];
    expect({
      shownMissed: shownTexts.filter((text) => !shown(text)),
      uniformHit: uniformTexts.filter((text) => shown(text)),
    }).toEqual({ shownMissed: [], uniformHit: [] });
  });
});

describe("手動起動のボタン: failures の文は前置きを足さず切り詰めずに出る", () => {
  test("(B-1) 一覧の行のボタン", async () => {
    routes.set(`GET ${RECORDS_PATH}`, [200, { records: [ROW], total: 1 }]);
    routes.set(`POST /api/apps/${APP_ID}/views/entry-list/actions/run`, [
      200,
      { workflow: "stamp", record: "entry-1", failures: [`${PREFIX}${LONG}`] },
    ]);
    const built = manifest();
    render(
      <RoleProvider role={OWNER}>
        <ListViewRenderer appId={APP_ID} manifest={built} view={built.app.views[1] as ListView} />
      </RoleProvider>,
    );
    fireEvent.click(await screen.findByTestId("list-action-run-stamp"));
    await waitFor(() => expect(screen.queryByTestId("list-action-run-error")).not.toBeNull());
    const shown = screen.getByTestId("list-action-run-error");
    expect(shown.textContent).toBe(`${PREFIX}${LONG}`);
    expect(shown.className).not.toMatch(/truncate|line-clamp|text-ellipsis/);
  });

  test("(B-2) 詳細画面のボタン", async () => {
    routes.set(`GET ${RECORDS_PATH}/entry-1`, [200, { record: ROW }]);
    routes.set(`POST /api/apps/${APP_ID}/views/entry-detail/actions/run`, [
      200,
      { workflow: "stamp", record: "entry-1", failures: [`${PREFIX}${LONG}`] },
    ]);
    const built = manifest();
    // 詳細画面の名前つきのボタンは、役割の規則で名指ししないと出ない(既定で閉じる)。
    (built.app as { roles?: unknown[] }).roles = [
      {
        id: "owner",
        name: "持ち主",
        rules: [
          { target: "table", table: "entries", can: ["read", "write", "delete"] },
          { target: "view", view: "entry-detail", can: ["read"] },
          { target: "action", view: "entry-detail", action: "stamp_it", can: ["read"] },
        ],
      },
      { id: "editor", name: "編集者" },
      { id: "viewer", name: "閲覧者" },
    ];
    render(
      <RoleProvider role={OWNER}>
        <DetailViewRenderer
          appId={APP_ID}
          manifest={built}
          view={built.app.views[2] as DetailView}
          recordId="entry-1"
        />
      </RoleProvider>,
    );
    fireEvent.click(await screen.findByTestId("action-run-stamp"));
    await waitFor(() => expect(screen.queryByTestId("detail-action-run-error")).not.toBeNull());
    const shown = screen.getByTestId("detail-action-run-error");
    expect(shown.textContent).toBe(`${PREFIX}${LONG}`);
    expect(shown.className).not.toMatch(/truncate|line-clamp|text-ellipsis/);
  });
});
