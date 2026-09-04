/**
 * seed-shared-app.ts のテスト。
 *
 * このスクリプトが作るのは**シナリオ `shared-lending-app` の事前状態**である。
 * 事前状態が不成立だと、本物の LLM を回したあとで初めて
 * 「名乗った利用者は、このアプリに登録されていません」が全ターンに出る ——
 * **失敗のコストが高く、しかも失敗の見え方が本題と無関係**になる。
 *
 * ここで押さえるのは次の3点:
 *
 * 1. 引数のパースが既定値ごと固定されていること(純関数なので単体で問える)
 * 2. アプリが1つ・利用者が1人だけできること
 * 3. **`requireActorAndApp` が `ok: true` を返すこと** —— 本番の21本が通る関門そのもの。
 *    これが**唯一の担保**であり、1と2が通っても3が落ちれば事前状態は役に立たない。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../../src/auth/store.ts";
import { KernelMetaStore } from "../../src/kernel/index.ts";
import { requireActorAndApp } from "../../src/mcp/actor-guard.ts";
import { parseSeedSharedAppOptions, seedSharedApp } from "./seed-shared-app.ts";

let root: string;

beforeEach(async () => {
  // `assertIsolatedDataRoot` が `data-` 接頭辞を要求するので、一時ディレクトリもそれに合わせる。
  root = await mkdtemp(join(tmpdir(), "data-shared-lending-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseSeedSharedAppOptions", () => {
  test("既定値(何も指定しなくても走れる)", () => {
    const options = parseSeedSharedAppOptions([]);
    expect(options.dataRoot).toBe("data-shared-lending-app");
    expect(options.appId).toBe("bihin-kashidashi");
    expect(options.appName).toBe("備品貸し出し");
    expect(options.actor).toBe("unei");
    expect(options.force).toBe(false);
  });

  test("全部上書きできる", () => {
    const options = parseSeedSharedAppOptions([
      "--data-root",
      "data-x",
      "--app-id",
      "y",
      "--app-name",
      "ゆー",
      "--actor",
      "kanri",
      "--force",
    ]);
    expect(options).toEqual({
      dataRoot: "data-x",
      appId: "y",
      appName: "ゆー",
      actor: "kanri",
      force: true,
    });
  });

  test("知らないフラグは落とす", () => {
    expect(() => parseSeedSharedAppOptions(["--nope"])).toThrow(/--nope/);
  });

  test("値の要るフラグに値が無ければ落とす", () => {
    expect(() => parseSeedSharedAppOptions(["--app-id"])).toThrow(/--app-id/);
  });
});

describe("seedSharedApp", () => {
  test("空のアプリが1つと、そこに登録済みの利用者が1人できる", () => {
    const created = seedSharedApp({
      dataRoot: root,
      appId: "bihin-kashidashi",
      appName: "備品貸し出し",
      actor: "unei",
      force: false,
    });

    expect(created.appId).toBe("bihin-kashidashi");
    expect(created.username).toBe("unei");

    const store = KernelMetaStore.open(root);
    try {
      expect(store.listApps().map((app) => app.app_id)).toEqual(["bihin-kashidashi"]);
    } finally {
      store.close();
    }

    const auth = AuthStore.openForApp(root, "bihin-kashidashi");
    try {
      // **読み返して1人だけ居ることを確かめる**(作った側の戻り値ではなく、DB を見る)。
      expect(auth.countUsers()).toBe(1);
      expect(auth.listUsers()[0]?.username).toBe("unei");
      expect(auth.listUsers()[0]?.role).toBe("owner");
    } finally {
      auth.close();
    }
  });

  test("作ったアプリは中身が空である(AI が1から育てる余地を残す)", () => {
    seedSharedApp({
      dataRoot: root,
      appId: "bihin-kashidashi",
      appName: "備品貸し出し",
      actor: "unei",
      force: false,
    });
    const store = KernelMetaStore.open(root);
    try {
      expect(store.listApps()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("requireActorAndApp が ok: true を返す(これが本番で効くかどうかの唯一の担保)", () => {
    seedSharedApp({
      dataRoot: root,
      appId: "bihin-kashidashi",
      appName: "備品貸し出し",
      actor: "unei",
      force: false,
    });

    const resolved = requireActorAndApp(root, "bihin-kashidashi", "unei");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.username).toBe("unei");
      expect(resolved.value.roles).toContain("owner");
    }
  });

  test("名乗っていない・登録されていない相手は通らない(関門が素通りしていない)", () => {
    seedSharedApp({
      dataRoot: root,
      appId: "bihin-kashidashi",
      appName: "備品貸し出し",
      actor: "unei",
      force: false,
    });
    expect(requireActorAndApp(root, "bihin-kashidashi", undefined).ok).toBe(false);
    expect(requireActorAndApp(root, "bihin-kashidashi", "dare-mo-shiranai").ok).toBe(false);
  });

  test("data- で始まらないデータルートは拒否する", () => {
    expect(() =>
      seedSharedApp({
        dataRoot: join(root, "..", "nope"),
        appId: "bihin-kashidashi",
        appName: "備品貸し出し",
        actor: "unei",
        force: false,
      }),
    ).toThrow(/data-/);
  });

  test("既にアプリがあるとき、--force が無ければ拒否する", () => {
    const seed = {
      dataRoot: root,
      appId: "bihin-kashidashi",
      appName: "備品貸し出し",
      actor: "unei",
      force: false,
    };
    seedSharedApp(seed);
    expect(() => seedSharedApp(seed)).toThrow(/--force/);
  });

  test("--force なら作り直せる(利用者は1人のまま)", () => {
    const seed = {
      dataRoot: root,
      appId: "bihin-kashidashi",
      appName: "備品貸し出し",
      actor: "unei",
      force: false,
    };
    seedSharedApp(seed);
    seedSharedApp({ ...seed, force: true });

    const auth = AuthStore.openForApp(root, "bihin-kashidashi");
    try {
      expect(auth.countUsers()).toBe(1);
    } finally {
      auth.close();
    }
    expect(requireActorAndApp(root, "bihin-kashidashi", "unei").ok).toBe(true);
  });
});
