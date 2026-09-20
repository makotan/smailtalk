/**
 * **発行直後だけコードを見せ、一覧では伏せることの実証**(`V19-M3-T04`。台帳 `SV-G7b`)。
 *
 * ## **このファイルは「移植」である**(計画 `§0-4` 裁定3 / `§3` 上乗せ1)
 *
 * **`V19-M1-T03` が書いた「ブラウザの保存領域と画面の DOM を走査して招待コードを数える式」は、
 * 版管理の外(`data-v19-probe-e2e/storage-probe.e2e.ts`)に在った。** **台を自前で組んでいたので
 * そのままでは製品側で動かない** —— **本ファイルは同じ式を、製品側の台
 * (`web/e2e/fixture-app.ts` の `provisionApp`。既定セッションは `owner`)の上へ移したものである。**
 *
 * **【禁止の履行】移す前の版管理外の式を「実 CI に載っている」と書かない。** **載るのは本ファイルである。**
 *
 * ## 測る先は**3つだけ**(`CP-V19` 条件4。個別限定③)
 *
 * | 測る先 | 誰が測るか |
 * |---|---|
 * | **一覧の応答** | **`V19-M2-T02`**(`src/server/invitation-issuance.test.ts` の `(h)` / `(h3)`)。**本ファイルは1度も測っていない** |
 * | **画面の DOM** | **本ファイル**(`countInvitationCodeInDom`)+ 既存の `invitation-list.e2e.ts` (4) / `invitation-states.e2e.ts` (4) |
 * | **ブラウザの保存領域** | **本ファイル**(`countInvitationCodeInBrowserStorage`)—— **`localStorage` / `sessionStorage` / IndexedDB の3つ** |
 *
 * **【禁止】「どこにも出ない」と書かない。** **【禁止】「コードが守られるようになった」と書かない。**
 * **測ったのは上の3つだけである。**
 *
 * ## ここで証明していないこと(**誇張しない。先に書く**)
 *
 * - **`app.sqlite` の中は1バイトも見ていない**(射程外。**コードは今日も表に平文で在る**)。
 * - **運営者自身が控えたコード**(手で書き写した紙・別のアプリに貼った文字列)は射程外である。
 * - **期限切れの行・旧形式の行は1件も作っていない。**
 * - **Cookie / `window.name` / Cache Storage / Service Worker の保管庫は見ていない** ——
 *   **「ブラウザの保存領域」を `localStorage` / `sessionStorage` / IndexedDB の3つと読んだ**
 *   (`V19-M1-T03` の読み替えをそのまま引き継いでいる)。
 * - **発行できる人の範囲は1つも測っていない**(この台の既定セッションは `owner` である)。
 * - **passkey 経路は1度も通していない**(password 経路だけ)。
 */
import { expect, type Page, test } from "@playwright/test";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

/**
 * **招待コードの綴りの形**(`src/auth/store.ts` の `INVITATION_CODE_ALPHABET` と
 * `INVITATION_CODE_LENGTH` から機械的に導いた)。
 *
 * **アルファベットは Crockford 系の32記号** `0123456789ABCDEFGHJKMNPQRSTVWXYZ`
 * —— **`I` / `L` / `O` / `U` の4文字を持たない。** 文字クラスはその4文字を外してある。**長さは 8。**
 *
 * **【誇張しない】これは「らしき」であって「招待コードである」ではない。**
 * 8文字の英数字はこの形に当たりうるので、**偽陽性を含む**。
 */
const INVITATION_CODE_LIKE = "\\b[0-9A-HJKMNP-TV-Z]{8}\\b";

/** 保存領域を数えた結果。 */
type StorageCount = {
  /** **招待コードの綴りに当たった総数**。 */
  total: number;
  /** 当たった場所の内訳(どの保管庫のどのキーか)。 */
  hits: { store: string; key: string; where: string }[];
  /** **保管庫ごとの総項目数**(0件が「空だから0」なのか「入っているが当たらない」のかを分ける)。 */
  entries: { localStorage: number; sessionStorage: number; indexedDB: number };
  /** IndexedDB の列挙で起きた問題(在れば)。 */
  notes: string[];
};

/**
 * **開いている画面の `localStorage` / `sessionStorage` / IndexedDB を**全部**読み、
 * 与えた綴り(`needle`)が現れる件数を数える**(`V19-M1-T03` 完了条件 (a) の式。**移植**)。
 *
 * - `localStorage` / `sessionStorage` は **キーと値の両方**を見る。
 * - IndexedDB は **`indexedDB.databases()` で全データベースを列挙**し、
 *   各オブジェクトストアの **キーと値の両方**を見る。
 * - **1件も無いときは `total: 0` を返す。** **`entries` を併せて返すので、
 *   「空だから0」と「入っているが当たらない」を取り違えない。**
 */
export async function countInvitationCodeInBrowserStorage(
  page: Page,
  needle: string,
): Promise<StorageCount> {
  return await page.evaluate(async (needle: string) => {
    const hits: { store: string; key: string; where: string }[] = [];
    const notes: string[] = [];

    /** `localStorage` / `sessionStorage` を1つ走査する(キーと値の両方)。 */
    const scanWebStorage = (storage: Storage, label: string): number => {
      let count = 0;
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === null) {
          continue;
        }
        count += 1;
        const value = storage.getItem(key) ?? "";
        if (key.includes(needle)) {
          hits.push({ store: label, key, where: "key" });
        }
        if (value.includes(needle)) {
          hits.push({ store: label, key, where: "value" });
        }
      }
      return count;
    };

    const localCount = scanWebStorage(window.localStorage, "localStorage");
    const sessionCount = scanWebStorage(window.sessionStorage, "sessionStorage");

    // --- IndexedDB -----------------------------------------------------------------
    let idbEntries = 0;
    try {
      const databases =
        typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
      if (typeof indexedDB.databases !== "function") {
        notes.push("indexedDB.databases() を持たないブラウザなので列挙できていない");
      }
      for (const info of databases) {
        const name = info.name;
        if (name === undefined) {
          continue;
        }
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("open failed"));
          request.onblocked = () => reject(new Error("blocked"));
        });
        for (const storeName of Array.from(db.objectStoreNames)) {
          const transaction = db.transaction(storeName, "readonly");
          const objectStore = transaction.objectStore(storeName);
          const read = <T>(request: IDBRequest<T>): Promise<T> =>
            new Promise<T>((resolve, reject) => {
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error ?? new Error("read failed"));
            });
          const values = await read(objectStore.getAll());
          const keys = await read(objectStore.getAllKeys());
          idbEntries += values.length;
          const serialize = (input: unknown): string => {
            try {
              return JSON.stringify(input) ?? String(input);
            } catch {
              return String(input);
            }
          };
          keys.forEach((key, index) => {
            if (serialize(key).includes(needle)) {
              hits.push({
                store: `indexedDB:${name}/${storeName}`,
                key: String(key),
                where: "key",
              });
            }
            if (serialize(values[index]).includes(needle)) {
              hits.push({
                store: `indexedDB:${name}/${storeName}`,
                key: String(key),
                where: "value",
              });
            }
          });
        }
        db.close();
      }
    } catch (error) {
      notes.push(`IndexedDB の走査で例外: ${String(error)}`);
    }

    return {
      total: hits.length,
      hits,
      entries: { localStorage: localCount, sessionStorage: sessionCount, indexedDB: idbEntries },
      notes,
    };
  }, needle);
}

/** 画面の DOM を数えた結果。 */
type DomCount = {
  /** **招待コードの綴りそのもの**が DOM に現れた総数。 */
  exactTotal: number;
  /** 内訳: 描画された HTML / 見えている文字 / 入力欄の値。 */
  exact: { html: number; text: number; inputValues: number };
  /** **招待コード「らしき」8文字**が見えている文字と入力欄に現れた総数。 */
  likeTotal: number;
  /** らしき文字列の実物(重複を含む)。 */
  likeSamples: string[];
};

/**
 * **画面の DOM を走査して招待コードらしき文字列を数える**(`V19-M1-T03` `§9-B9` の (g) の式。**移植**)。
 *
 * **2通りで数える** ——
 * 1. **綴りそのもの**(`needle`)。**発行した実物のコードなので、偽陽性が無い。**
 * 2. **らしき8文字**(`INVITATION_CODE_LIKE`)。**偽陽性を含む**が、綴りに依らず見られる。
 *
 * **入力欄は `outerHTML` に値が出ない**(利用者が打った値は属性にならない)ので、
 * **`input.value` を別に見る。**
 */
export async function countInvitationCodeInDom(page: Page, needle: string): Promise<DomCount> {
  return await page.evaluate(
    ({ needle, likeSource }: { needle: string; likeSource: string }) => {
      const countOccurrences = (haystack: string, target: string): number =>
        target === "" ? 0 : haystack.split(target).length - 1;

      const html = document.documentElement.outerHTML;
      const text = document.body === null ? "" : (document.body.innerText ?? "");
      const fields = Array.from(document.querySelectorAll("input, textarea")) as (
        | HTMLInputElement
        | HTMLTextAreaElement
      )[];
      const fieldValues = fields.map((field) => field.value ?? "");

      const exact = {
        html: countOccurrences(html, needle),
        text: countOccurrences(text, needle),
        inputValues: fieldValues.reduce((sum, value) => sum + countOccurrences(value, needle), 0),
      };

      const likeSamples = [
        ...(text.match(new RegExp(likeSource, "g")) ?? []),
        ...fieldValues.flatMap((value) => value.match(new RegExp(likeSource, "g")) ?? []),
      ];

      return {
        exactTotal: exact.html + exact.text + exact.inputValues,
        exact,
        likeTotal: likeSamples.length,
        likeSamples,
      };
    },
    { needle, likeSource: INVITATION_CODE_LIKE },
  );
}

/** 測った結果を1段ぶん印字する(記録にそのまま貼れる形)。 */
function report(stage: string, storage: StorageCount, dom: DomCount): void {
  console.log(
    `\n===== ${stage} =====\n` +
      `保存領域(b の式): total=${storage.total} ` +
      `entries=localStorage:${storage.entries.localStorage} ` +
      `sessionStorage:${storage.entries.sessionStorage} ` +
      `indexedDB:${storage.entries.indexedDB}\n` +
      `  hits=${JSON.stringify(storage.hits)}\n` +
      `  notes=${JSON.stringify(storage.notes)}\n` +
      `画面の DOM(g の式): exactTotal=${dom.exactTotal} ` +
      `(html:${dom.exact.html} text:${dom.exact.text} inputValues:${dom.exact.inputValues}) ` +
      `likeTotal=${dom.likeTotal}\n` +
      `  likeSamples=${JSON.stringify(dom.likeSamples)}`,
  );
}

type LooseRole = { id: string; name?: string; signup?: "invite" | "open"; rules?: unknown[] };

/**
 * そのアプリに `staff`(招待制)を宣言する。
 *
 * **差し替えの口は既存のもの**(`POST /__e2e__/apps/:app_id/manifest`。
 * `invitation-signup.e2e.ts` と同じ作法)。**製品のサーバにはマニフェストを変更する口が
 * 1本も無い**(`ADR-0003`)。
 */
async function declareInviteRole(
  request: Parameters<typeof provisionApp>[0],
  app: FixtureApp,
): Promise<void> {
  const declared = structuredClone(app.manifest) as unknown as { app: { roles?: LooseRole[] } };
  const roles = declared.app.roles ?? [];
  roles.push({
    id: "staff",
    name: "スタッフ",
    signup: "invite",
    rules: [
      { target: "view", view: app.manifest.app.views[0]?.id, can: ["read"] },
      { target: "table", table: app.manifest.app.tables[0]?.id, can: ["read"] },
    ],
  });
  declared.app.roles = roles;
  const applied = await request.post(`/__e2e__/apps/${app.appId}/manifest`, { data: declared });
  expect(applied.status(), await applied.text()).toBe(200);
}

test.describe("発行直後だけコードが出る(`V19-M3-T04` / `SV-G7b`)", () => {
  test("招待コードが画面の DOM とブラウザの保存領域に現れる件数を数える", async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(120_000);

    // --- 台を起こす(**製品側の `provisionApp`**。既定セッションは `owner`)-----------------
    const app = await provisionApp(request);
    await declareInviteRole(request, app);

    // --- 招待を1件、実際に発行する(**綴りは実物である**)---------------------------------
    const invited = `invited-${Date.now()}`;
    const issued = await request.post(`/api/apps/${app.appId}/auth/invitations`, {
      headers: { ...app.authHeaders, origin: "http://localhost:3210" },
      data: { username: invited, role: "staff" },
    });
    expect(issued.status(), await issued.text()).toBe(200);
    const code = ((await issued.json()) as { invitation: { code: string } }).invitation.code;
    console.log(`\n【発行した招待コードの綴り】 ${code}(長さ ${code.length})`);

    // --- 段1: 未ログインの登録画面 ---------------------------------------------------------
    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("auth-invitation-code")).toBeVisible();
    report(
      "段1 未ログインの登録画面(コードをまだ打っていない)",
      await countInvitationCodeInBrowserStorage(page, code),
      await countInvitationCodeInDom(page, code),
    );

    // --- 段2: 招待コードを打ち込んだ直後 ---------------------------------------------------
    // **【この段を左辺にしない】** **ここで立つ件数は利用者が入力欄に打った値であって、
    // アプリが出したものではない**(`records/v19-m1.md` の申し送り4)。**報告のためだけに測る。**
    await page.getByTestId("auth-username").fill(invited);
    await page.getByTestId("auth-password").fill("correct-horse-battery-staple");
    await page.getByTestId("auth-user-kind").selectOption("staff");
    await page.getByTestId("auth-invitation-code").fill(code);
    report(
      "段2 招待コードを入力欄に打った直後(まだ送っていない。**左辺に使わない**)",
      await countInvitationCodeInBrowserStorage(page, code),
      await countInvitationCodeInDom(page, code),
    );

    // --- 段3: 登録が通った直後 -------------------------------------------------------------
    await page.getByTestId("customer-password-register").click();
    await expect(page.getByTestId("current-user")).toHaveText(invited);
    const invitedStorage = await countInvitationCodeInBrowserStorage(page, code);
    const invitedDom = await countInvitationCodeInDom(page, code);
    report("段3 招待コードで登録が通った直後(招待された本人の画面)", invitedStorage, invitedDom);
    // **個別限定① の判定点その1** —— 招待された本人のブラウザにコードが1件も残らない。
    expect(invitedStorage.total, "段3: 招待された本人の保存領域にコードが残っている").toBe(0);
    expect(invitedDom.exactTotal, "段3: 登録が通った後の画面にコードが出ている").toBe(0);

    // --- 段4: 運営者(owner)の画面とユーザ管理 --------------------------------------------
    // **台の起こし方を `provisionApp` に合わせた箇所** —— cookie を手で組み立てず、
    // フィクスチャが持つ `authenticate(context)` に入れさせる。
    const ownerContext = await browser.newContext();
    await app.authenticate(ownerContext);
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(`/apps/${app.appId}`);
    await expect(ownerPage.getByTestId("current-user")).toBeVisible();
    report(
      "段4-1 運営者(owner)が開いたアプリの画面",
      await countInvitationCodeInBrowserStorage(ownerPage, code),
      await countInvitationCodeInDom(ownerPage, code),
    );

    // --- 段4-2: 運営者がユーザ管理を開いた画面(**本段の左辺**)-----------------------------
    // **【移植元との違い。最重】** 移植元は「導線が1つも無ければ開かない」分岐を持っていた。
    // **その分岐に落ちると左辺そのものが消える**(「0件だった」ではなく「開けていなかった」)。
    // **本ファイルは分岐を持たず、導線が1本在ることを数えてから開く** —— 無ければ赤くなる。
    const adminTrigger = ownerPage.getByTestId("open-user-admin");
    const triggerCount = await adminTrigger.count();
    console.log(`\n【段4-2 の前提】 open-user-admin の件数 = ${triggerCount}(0 なら開けていない)`);
    expect(triggerCount, "段4-2 を開く導線が画面に1つも無い").toBe(1);
    await adminTrigger.click();
    await expect(ownerPage.getByTestId("user-admin")).toBeVisible();
    await expect(ownerPage.getByTestId("user-admin-invitations")).toBeVisible();
    const adminStorage = await countInvitationCodeInBrowserStorage(ownerPage, code);
    const adminDom = await countInvitationCodeInDom(ownerPage, code);
    report(
      "段4-2 運営者がユーザ管理(`open-user-admin` → `user-admin`)を開いた画面",
      adminStorage,
      adminDom,
    );
    // **個別限定① / ②の判定点** —— **本段の左辺はここである。**
    expect(adminStorage.total, "段4-2: 運営者の保存領域にコードが残っている").toBe(0);
    expect(adminStorage.entries.localStorage >= 0, "localStorage を数えられていない").toBe(true);
    expect(adminDom.exactTotal, "段4-2: ユーザ管理の画面にコードが出ている").toBe(0);

    // --- 段4-3: 再読み込みしたあとの一覧(**起票 (b) の左辺**)------------------------------
    await ownerPage.reload();
    await expect(ownerPage.getByTestId("open-user-admin")).toHaveCount(1);
    await ownerPage.getByTestId("open-user-admin").click();
    await expect(ownerPage.getByTestId("user-admin")).toBeVisible();
    // **行が1件出ていること**(空の画面を数えて0と言わないため)。
    await expect(ownerPage.getByTestId("invitation-row").filter({ hasText: invited })).toHaveCount(
      1,
    );
    const reloadedStorage = await countInvitationCodeInBrowserStorage(ownerPage, code);
    const reloadedDom = await countInvitationCodeInDom(ownerPage, code);
    report("段4-3 再読み込みしたあとの一覧(行は1件出ている)", reloadedStorage, reloadedDom);
    expect(reloadedStorage.total, "段4-3: 再読み込み後の保存領域にコードが残っている").toBe(0);
    expect(reloadedDom.exactTotal, "段4-3: 再読み込み後の一覧にコードが出ている").toBe(0);

    await ownerContext.close();

    // --- 段5: 陽性対照 ---------------------------------------------------------------------
    // **同じ綴りを3つの保管庫に自分で書いてから、同じ関数を打つ。**
    // **ここが 0 を返したら、上の 0 は「測れていない値」である。**
    await page.evaluate(async (needle: string) => {
      window.localStorage.setItem("v19-probe-local", `code=${needle}`);
      window.sessionStorage.setItem("v19-probe-session", `code=${needle}`);
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("v19-probe-positive-control", 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("codes");
        };
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("codes", "readwrite");
          transaction.objectStore("codes").put({ code: needle }, "probe-key");
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error ?? new Error("put failed"));
        };
        request.onerror = () => reject(request.error ?? new Error("open failed"));
      });
    }, code);

    const control = await countInvitationCodeInBrowserStorage(page, code);
    const controlDom = await countInvitationCodeInDom(page, code);
    report("段5 陽性対照(3つの保管庫に綴りを自分で書いた後)", control, controlDom);

    expect(control.total, "陽性対照が 0。式が空振りしている").toBeGreaterThan(0);
    expect(
      control.hits.filter((hit) => hit.store === "localStorage").length,
      "localStorage の腕が空振り",
    ).toBeGreaterThan(0);
    expect(
      control.hits.filter((hit) => hit.store === "sessionStorage").length,
      "sessionStorage の腕が空振り",
    ).toBeGreaterThan(0);
    expect(
      control.hits.filter((hit) => hit.store.startsWith("indexedDB:")).length,
      "IndexedDB の腕が空振り",
    ).toBeGreaterThan(0);

    // --- 段6: DOM の式の陽性対照 -----------------------------------------------------------
    await page.evaluate((needle: string) => {
      const marker = document.createElement("p");
      marker.textContent = `positive control ${needle}`;
      document.body.appendChild(marker);
    }, code);
    const domControl = await countInvitationCodeInDom(page, code);
    console.log(
      `\n===== 段6 陽性対照(DOM に綴りを1つ差し込んだ後) =====\n` +
        `exactTotal=${domControl.exactTotal} ` +
        `(html:${domControl.exact.html} text:${domControl.exact.text} ` +
        `inputValues:${domControl.exact.inputValues}) likeTotal=${domControl.likeTotal}`,
    );
    expect(domControl.exactTotal, "DOM の式が空振りしている").toBeGreaterThan(0);
  });
});
