/**
 * **明暗のモードの決め方の単体検査**(`V20-M10-T03`。計画 §9-3 の 2 / §10 の 5、
 * ユーザ決定 `D-V20-31` / `D-V20-32`、`ADR-0458` 限定9)。
 *
 * ## 何を固定しているか
 *
 * 1. **効いているモード = 覚えた値 ?? OS の設定。** 覚えた値は `light` / `dark` の2値だけ(他は無いのと同じ)。
 * 2. **`<html>` の属性**: 覚えた値があればその値、無ければ属性を外す(OS への追随は CSS の配色設定の
 *    `@media` が受け持つ)。**強制で明るくしている間は `light`。**
 * 3. **スイッチ = 反対へ。反対が OS と同じなら記憶を消し、属性を外す**(`D-V20-32`)。
 * 4. **強制(`D-V20-31`)は記憶を書き換えない。** OS の変化の購読は強制を上書きしない。
 *    強制を外すと元の属性に戻る。強制は数えて重ねられる(同じ画面の張り替えで外れない)。
 * 5. **保存領域が使えないブラウザでは「覚えない」**(例外を握りつぶす。切り替えはそのページの中では効く)。
 * 6. **別タブの変化は購読しない**(計画 §10 の 12(iii))。**`data-theme` の書き手はこのモジュールだけ**
 *    (計画 §10 の 5)。**入口で最初の描画の前に1度当てる**(計画 §9-3 の 2)。
 * 7. **【V20-M10 点検 中1 の処置】覚えた値は制御の中に1つ。** 保存領域を読むのは作るときと入口で当てる
 *    とき(`load()`)だけ。保存領域を外から書き換えても、効いているモードと属性は食い違わない。
 *
 * ## 証明しないこと(誇張しない)
 *
 * - **色が実際に変わることは証明しない。** happy-dom は CSS を解かない。計算値は
 *   `web/e2e/color-scheme.e2e.ts`(chromium の `getComputedStyle`)が測る。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  COLOR_SCHEME_STORAGE_KEY,
  type ColorSchemeEnvironment,
  createColorSchemeController,
} from "../src/color-scheme.ts";

type Listener = (event: { matches: boolean }) => void;

function fakeEnvironment(options: {
  stored?: string;
  osDark?: boolean;
  storageThrows?: boolean;
  storageGetterThrows?: boolean;
  noMatchMedia?: boolean;
}) {
  const attributes = new Map<string, string>();
  const store = new Map<string, string>();
  if (options.stored !== undefined) store.set(COLOR_SCHEME_STORAGE_KEY, options.stored);
  const state = { osDark: options.osDark ?? false };
  const listeners = new Set<Listener>();
  const fail = (): never => {
    throw new Error("保存領域は使えません");
  };
  const storage = options.storageThrows
    ? { getItem: fail, setItem: fail, removeItem: fail }
    : {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      };
  const media = {
    get matches() {
      return state.osDark;
    },
    addEventListener: (_type: "change", listener: Listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "change", listener: Listener) => {
      listeners.delete(listener);
    },
  };
  const env: ColorSchemeEnvironment = {
    root: {
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      },
      removeAttribute: (name: string) => {
        attributes.delete(name);
      },
    },
    storage: () => {
      if (options.storageGetterThrows) fail();
      return storage;
    },
    matchMedia: options.noMatchMedia ? undefined : () => media,
  };
  return {
    env,
    attribute: () => attributes.get("data-theme"),
    stored: () => store.get(COLOR_SCHEME_STORAGE_KEY),
    setOs: (dark: boolean) => {
      state.osDark = dark;
      for (const listener of listeners) listener({ matches: dark });
    },
    listenerCount: () => listeners.size,
    /** 別タブが同じ保存領域へ書いたことの代わり(この制御を通さずに書く)。 */
    writeFromOtherTab: (value: string | null) => {
      if (value === null) store.delete(COLOR_SCHEME_STORAGE_KEY);
      else store.set(COLOR_SCHEME_STORAGE_KEY, value);
    },
  };
}

describe("効いているモードと <html> の属性(覚えた値 ?? OS)", () => {
  test("覚えた値が無く OS が明るい → 明るい・属性なし", () => {
    const fake = fakeEnvironment({ osDark: false });
    const controller = createColorSchemeController(fake.env);
    controller.apply();
    expect(controller.preferred()).toBe("light");
    expect(fake.attribute()).toBeUndefined();
  });

  test("覚えた値が無く OS が暗い → 暗い・属性なし(CSS の配色設定の @media が暗くする)", () => {
    const fake = fakeEnvironment({ osDark: true });
    const controller = createColorSchemeController(fake.env);
    controller.apply();
    expect(controller.preferred()).toBe("dark");
    expect(fake.attribute()).toBeUndefined();
  });

  test("覚えた値 light と OS が暗い → 明るい・属性 light", () => {
    const fake = fakeEnvironment({ osDark: true, stored: "light" });
    const controller = createColorSchemeController(fake.env);
    controller.apply();
    expect(controller.preferred()).toBe("light");
    expect(fake.attribute()).toBe("light");
  });

  test("覚えた値 dark と OS が明るい → 暗い・属性 dark", () => {
    const fake = fakeEnvironment({ osDark: false, stored: "dark" });
    const controller = createColorSchemeController(fake.env);
    controller.apply();
    expect(controller.preferred()).toBe("dark");
    expect(fake.attribute()).toBe("dark");
  });

  test("2値の外の覚えた値は無いのと同じ(3つ目のモードを作らない。ADR-0458 限定9)", () => {
    for (const stored of ["auto", "system", "blue", "", "DARK"]) {
      const fake = fakeEnvironment({ osDark: true, stored });
      const controller = createColorSchemeController(fake.env);
      controller.apply();
      expect(controller.preferred(), stored).toBe("dark");
      expect(fake.attribute(), stored).toBeUndefined();
    }
  });

  test("matchMedia が無い環境では OS を明るいと読む", () => {
    const fake = fakeEnvironment({ noMatchMedia: true });
    const controller = createColorSchemeController(fake.env);
    controller.apply();
    expect(controller.preferred()).toBe("light");
    expect(fake.attribute()).toBeUndefined();
  });
});

describe("スイッチ(反対へ。反対が OS と同じなら忘れる。D-V20-32)", () => {
  test("OS が暗い → 押すと明るく覚え、もう1度押すと記憶を消して OS に追随する", () => {
    const fake = fakeEnvironment({ osDark: true });
    const controller = createColorSchemeController(fake.env);
    controller.apply();

    controller.toggle();
    expect(controller.preferred()).toBe("light");
    expect(fake.stored()).toBe("light");
    expect(fake.attribute()).toBe("light");

    controller.toggle();
    expect(controller.preferred()).toBe("dark");
    expect(fake.stored()).toBeUndefined();
    expect(fake.attribute()).toBeUndefined();
  });

  test("OS が明るい → 押すと暗く覚え、もう1度押すと記憶を消す", () => {
    const fake = fakeEnvironment({ osDark: false });
    const controller = createColorSchemeController(fake.env);
    controller.toggle();
    expect(controller.preferred()).toBe("dark");
    expect(fake.stored()).toBe("dark");
    expect(fake.attribute()).toBe("dark");

    controller.toggle();
    expect(controller.preferred()).toBe("light");
    expect(fake.stored()).toBeUndefined();
    expect(fake.attribute()).toBeUndefined();
  });

  test("覚えた値が OS と同じ側になっていた(OS が後から変わった)ときも、押すと反対へ動く", () => {
    const fake = fakeEnvironment({ osDark: true, stored: "dark" });
    const controller = createColorSchemeController(fake.env);
    controller.toggle();
    // 反対 = light は OS(暗い)と違うので覚える。
    expect(fake.stored()).toBe("light");
    expect(fake.attribute()).toBe("light");
  });

  test("押すと購読している相手に知らせる", () => {
    const fake = fakeEnvironment({ osDark: false });
    const controller = createColorSchemeController(fake.env);
    let calls = 0;
    const unsubscribe = controller.subscribe(() => {
      calls += 1;
    });
    controller.toggle();
    expect(calls).toBe(1);
    unsubscribe();
    controller.toggle();
    expect(calls).toBe(1);
  });
});

describe("保存領域が使えないブラウザでは「覚えない」(例外を握りつぶす)", () => {
  test("読み書きが例外を投げても、切り替えはそのページの中で効く", () => {
    const fake = fakeEnvironment({ osDark: false, storageThrows: true });
    const controller = createColorSchemeController(fake.env);
    expect(() => controller.apply()).not.toThrow();
    expect(() => controller.toggle()).not.toThrow();
    expect(controller.preferred()).toBe("dark");
    expect(fake.attribute()).toBe("dark");
    // 新しいページ(= 新しい制御)では覚えていない。
    const next = createColorSchemeController(fakeEnvironment({ osDark: false }).env);
    expect(next.preferred()).toBe("light");
  });

  test("保存領域を取り出すこと自体が例外を投げても落ちない", () => {
    const fake = fakeEnvironment({ osDark: true, storageGetterThrows: true });
    const controller = createColorSchemeController(fake.env);
    expect(() => controller.apply()).not.toThrow();
    expect(controller.preferred()).toBe("dark");
    expect(() => controller.toggle()).not.toThrow();
    expect(controller.preferred()).toBe("light");
    expect(fake.attribute()).toBe("light");
  });
});

describe("OS の変化の購読", () => {
  test("覚えた値が無いとき、OS の変化で効いているモードが変わり、知らせが届く(属性は付けない)", () => {
    const fake = fakeEnvironment({ osDark: false });
    const controller = createColorSchemeController(fake.env);
    controller.apply();
    let calls = 0;
    controller.subscribe(() => {
      calls += 1;
    });
    fake.setOs(true);
    expect(controller.preferred()).toBe("dark");
    expect(fake.attribute()).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("購読は OS の変化1本だけ(制御1つにつき1つ)", () => {
    const fake = fakeEnvironment({ osDark: false });
    const controller = createColorSchemeController(fake.env);
    controller.subscribe(() => {});
    controller.subscribe(() => {});
    expect(fake.listenerCount()).toBe(1);
  });
});

describe("強制で明るくする口(D-V20-31。暗い側の組を持たないテーマのアプリを開いている間)", () => {
  test("覚えた値が dark でも属性は light。記憶は書き換えない。外すと dark に戻る", () => {
    const fake = fakeEnvironment({ osDark: false, stored: "dark" });
    const controller = createColorSchemeController(fake.env);
    controller.apply();
    expect(fake.attribute()).toBe("dark");

    const release = controller.forceLight();
    expect(fake.attribute()).toBe("light");
    expect(controller.forced()).toBe(true);
    expect(fake.stored()).toBe("dark");

    release();
    expect(fake.attribute()).toBe("dark");
    expect(controller.forced()).toBe(false);
  });

  test("OS が暗くなっても(購読が走っても)強制を上書きしない", () => {
    const fake = fakeEnvironment({ osDark: false });
    const controller = createColorSchemeController(fake.env);
    const release = controller.forceLight();
    expect(fake.attribute()).toBe("light");
    fake.setOs(true);
    expect(fake.attribute()).toBe("light");
    fake.setOs(false);
    fake.setOs(true);
    expect(fake.attribute()).toBe("light");
    release();
    // 覚えた値が無いので属性を外し、OS(暗い)に追随する。
    expect(fake.attribute()).toBeUndefined();
    expect(controller.preferred()).toBe("dark");
  });

  test("強制は数えて重なる(2つ掛けて1つ外しても明るいまま)。外す関数を2度呼んでも1つしか外れない", () => {
    const fake = fakeEnvironment({ osDark: true });
    const controller = createColorSchemeController(fake.env);
    const first = controller.forceLight();
    const second = controller.forceLight();
    first();
    first();
    expect(fake.attribute()).toBe("light");
    second();
    expect(fake.attribute()).toBeUndefined();
  });
});

describe("別タブで切り替えた後(V20-M10 点検 中1。保存領域を読むのは作るときと入口で当てるときだけ)", () => {
  test("保存領域を外から書き換えても、効いているモードと <html> の属性は食い違わない(開き直すまで動かない)", () => {
    const fake = fakeEnvironment({ osDark: true });
    const controller = createColorSchemeController(fake.env);
    controller.apply();
    expect(controller.preferred()).toBe("dark");
    expect(fake.attribute()).toBeUndefined();

    fake.writeFromOtherTab("light");
    // 描画のたびに読まれる口。保存領域を読み直さない。
    expect(controller.preferred()).toBe("dark");
    expect(controller.preferred()).toBe("dark");
    expect(fake.attribute()).toBeUndefined();

    // 強制を掛けて外しても(apply が走っても)、覚えた値は読み直さない。
    const release = controller.forceLight();
    release();
    expect(controller.preferred()).toBe("dark");
    expect(fake.attribute()).toBeUndefined();
  });

  test("別タブの後にスイッチを押すと、このタブで見えている側の反対へ動く(表示と属性と記憶が揃う)", () => {
    const fake = fakeEnvironment({ osDark: false, stored: "dark" });
    const controller = createColorSchemeController(fake.env);
    controller.apply();
    expect(fake.attribute()).toBe("dark");

    fake.writeFromOtherTab(null);
    expect(controller.preferred()).toBe("dark");

    controller.toggle();
    // 見えていた側(暗い)の反対 = 明るい = OS と同じ → 記憶を消し、属性を外す。
    expect(controller.preferred()).toBe("light");
    expect(fake.attribute()).toBeUndefined();
    expect(fake.stored()).toBeUndefined();
  });

  test("入口で当て直す口(load)は保存領域を読み直し、属性と知らせを揃える(開き直したときに効く)", () => {
    const fake = fakeEnvironment({ osDark: true });
    const controller = createColorSchemeController(fake.env);
    controller.apply();
    let calls = 0;
    controller.subscribe(() => {
      calls += 1;
    });
    fake.writeFromOtherTab("light");
    controller.load();
    expect(controller.preferred()).toBe("light");
    expect(fake.attribute()).toBe("light");
    expect(calls).toBe(1);
  });

  test("新しい制御(= 開き直したページ)は別タブで覚えた値を読む", () => {
    const fake = fakeEnvironment({ osDark: true });
    const first = createColorSchemeController(fake.env);
    first.apply();
    fake.writeFromOtherTab("light");
    const reopened = createColorSchemeController(fake.env);
    reopened.apply();
    expect(reopened.preferred()).toBe("light");
    expect(fake.attribute()).toBe("light");
  });
});

// ---------------------------------------------------------------------------
// ソースの形(計画 §10 の 5 / 12(iii) / §9-3 の 2)
// ---------------------------------------------------------------------------

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("ソースの形", () => {
  test("<html> の data-theme の書き手は color-scheme.ts の1本だけ(注釈を除く綴りが他のファイルに無い)", () => {
    const writers = sourceFiles(SRC).filter((path) => {
      const code = withoutComments(readFileSync(path, "utf-8"));
      return code.includes("data-theme") || /dataset\.theme\b/.test(code);
    });
    expect(writers.map((path) => path.slice(SRC.length + 1))).toEqual(["color-scheme.ts"]);
  });

  test("別タブの変化(storage の知らせ)は購読しない", () => {
    const code = withoutComments(readFileSync(join(SRC, "color-scheme.ts"), "utf-8"));
    expect(code.includes('"storage"')).toBe(false);
    expect(code.includes("'storage'")).toBe(false);
  });

  test("マニフェストにもサーバにも送らない(color-scheme.ts は fetch も api も読まない)", () => {
    const code = withoutComments(readFileSync(join(SRC, "color-scheme.ts"), "utf-8"));
    expect(code.includes("fetch(")).toBe(false);
    expect(code.includes("./api")).toBe(false);
  });

  test("2つの入口は最初の描画(createRoot)の前に1度当てる", () => {
    for (const entry of ["main.tsx", "runner-main.tsx"]) {
      const code = withoutComments(readFileSync(join(SRC, entry), "utf-8"));
      const apply = code.indexOf("applyInitialColorScheme()");
      const render = code.indexOf("createRoot(");
      expect(apply, entry).toBeGreaterThan(-1);
      expect(apply, entry).toBeLessThan(render);
      expect(code.split("applyInitialColorScheme()").length - 1, entry).toBe(1);
    }
  });

  test("強制の口を呼ぶのは製品の器(AppThemeScope)だけ。事前の見た目の2枠は呼ばない", () => {
    const callers = sourceFiles(SRC)
      .filter((path) => !path.endsWith("color-scheme.ts"))
      .filter((path) =>
        withoutComments(readFileSync(path, "utf-8")).includes("forceLightColorScheme"),
      )
      .map((path) => path.slice(SRC.length + 1));
    expect(callers).toEqual(["AppWorkspace.tsx"]);
    for (const panel of ["ThemeImportPanel.tsx", "ThemePreviewPanel.tsx"]) {
      const code = withoutComments(readFileSync(join(SRC, panel), "utf-8"));
      expect(code.includes("color-scheme"), panel).toBe(false);
    }
  });
});
