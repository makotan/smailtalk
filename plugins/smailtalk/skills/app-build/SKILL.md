---
name: app-build
description: >-
  「アプリを作って」「〜を管理する仕組みがほしい」と頼まれた直後に、最初に開く説明書。SmAIltalk(MCP サーバ smailtalk)でアプリ1本を組み立てる順序と、実アプリから起こした骨格を扱う。まだ差分を1本も書いていない時点、create_app を呼ぶ前後に開く。表・画面・役割・名簿をどの順で書くか、個人スコープ型(st_owner)と共有型(access_control)のどちらで組むかを決めるときにも開く。
when_to_use: >-
  作った直後に「画面は出るのに何も見えない」「最初の1人を登録できない」「差分は通ったのに触ると壊れている」ときにも開く。差分の外側と操作の必須キーは diff-shape、画面の中身は view-shape、ワークフローと関数は automation-shape にある。
allowed-tools: mcp__smailtalk__dry_run_diff mcp__smailtalk__get_manifest mcp__smailtalk__list_apps mcp__smailtalk__list_records
---

# アプリの組み立て方(SmAIltalk)

## この説明書が扱うこと(かつて説明文に書いていた目次)

**【2026-08-16。`V8-M47`】この節は、かつて front matter の `description` に書いていた文である。**
**公式の作法に従い `description` を「何をするか・いつ開くか」だけにしたので、外した文をここへ逐語で移した。1文字も変えていない。**

中身は (1) 個人スコープ型(st_owner)と共有型(access_control + 名簿 + グループ + 付与表)のどちらで組むかの選び方と、両方を同じ表に書いたときに起きること、(2) 表 → 画面 → 役割 → 名簿の最初の1行 → 自動処理 の5段と、各段が前の段に依る理由、(3) 実在するアプリ2本の定義から起こした骨格2つ、(4) 表・画面・ボタンを足した直後に、規則を書いていない対象が持ち主にも閉じること、(5) access_control を宣言した表に最初の1行を入れる手順、(6) 差分は通ったのに触ると壊れている5点と、その1つずつの確かめ方。差分の外側と操作の必須キーは diff-shape に、画面の中身のキーは view-shape に、ワークフローと関数のキーは automation-shape に分けてある。この説明書は書けるキーの全量を1つも持たない —— 形を確かめるときは3本のほうを開く。

---

## この説明書が扱うもの・扱わないもの

**扱うのは「どの順で書くと通るか」と「作った直後に何が起きるか」だけである。**
**書けるキーの全量は1つも持っていない** —— 形は diff-shape / view-shape / automation-shape にある。

| | この説明書 | 既存3本 |
|---|---|---|
| 狙い | **アプリ1本を立てる順序と、立てた直後の状態** | **1つの差分の形**(必須キー・書けるキー・値域) |
| 開く時点 | **依頼を受けた直後**(まだ何も書いていない) | **差分を書く直前**、または拒否が返った直後 |

**既存3本が狙っている上位3類型(必須キーの書き忘れ / 語彙に無いキー / 型の取り違え)は、この説明書は狙っていない。**

---

## 1. 最初に型を選ぶ —— 2つある(3つ目は無い)

**共有の仕組みの組み方は2つで、どちらを採るかを最初に決める。**

| | **個人スコープ型** | **共有型** |
|---|---|---|
| 何で絞るか | 表に `st_owner`(`text` 型)の項目を1本置く | 表に `access_control` を宣言する |
| 見えるもの | **自分が作った行だけ** | **その行に付与(`grant`)がある人だけ** |
| 要る表 | **業務の表だけ** | 業務の表 + 付与表 + 名簿(`members`)+ グループ |
| 向く依頼 | 各自が自分の分だけを持つ | 誰がどの行を扱えるかが人ごとに違う |

**選び方**: **「他人の行を見せる相手を、行ごとに決めたい」なら共有型。それ以外は個人スコープ型。**
共有型は表が3〜4本増え、最初の1行を入れる手順(§6)が必ず要る。

### 同じ表に両方を書いたときに何が起きるか

**差分は通る。拒否されない。** **起きるのは読み方の変化である** ——
**`st_owner` と付与は `AND` になり、その表で読めるのは「自分の行であって、なおかつ付与がある行」だけになる。**
つまり**付与だけを配っても、他人の行は1件も読めない。**

- 実装の逐語(コメント): `src/server/owner-scope.ts:548`「**`st_owner` は今日どおり `AND` で効く。**」
- 検査: `src/server/record-access-visibility.test.ts:689`
  「(D-7) `st_owner` と併せ持つ表では、自分の行かつ付与のある行だけが `total` に入る(AND)」

**面(役割の規則)と点(行ごとの付与)が `OR` であることとは別の話である**(そちらは view-shape §3a)。
**`st_owner` はその `OR` の外側で `AND` になる。**

---

## 2. 作る順序 —— 5段

**表 → 画面 → 役割 → 名簿の最初の1行 → 自動処理。**
**各段は、前の段が作った ID を名指しするので、前の段より先には書けない。**

| 段 | 送るもの | **前の段に依る理由**(裏づけ) |
|---|---|---|
| **1. 表** | `add_table` / `add_field` | 起点。ここだけは他に依らない |
| **2. 画面** | `add_view` | **画面は `table` を必須で名指しする** —— `plugins/smailtalk/skills/view-shape/SKILL.md:31`「**どの種別でも必須**: `id` / `type` / `table`」 |
| **3. 役割** | `set_roles` | **規則は画面IDとボタンIDを名指しする** —— `plugins/smailtalk/skills/view-shape/reference/view-keys.md:185`-`:186`「**ボタンを名指しするときは `view` と `action` の両方を書く** …… `action` は画面の `actions[].id` である。**`id` を書いていないボタンは名指しできない。**」 |
| **4. 名簿の最初の1行** | レコードの登録(差分ではない) | **付与が1件も無いと、持ち主でも行を作れない** —— `docs/plan/v8/records/v8-m33.md:98`「`access_control` を宣言した表 `tickets` に行を作る / **owner(`alice`)でも 400。**」 |
| **5. 自動処理** | `add_function` / `add_workflow` | **実行履歴の表は自動では作られない** —— `plugins/smailtalk/skills/automation-shape/SKILL.md:39`「**`history_table` は自動では作られない。** `add_table` で先に作っておくこと。」 **さらに、島の書込は発火させた人の権限で判定される** —— `src/server/automation-access-control.test.ts:653`「(iii-a) 権限が無い相手の発火で動いた島の書込は落ち、1行も書かれない」**ので、段4 より先に動かすと落ちる** |

**段4 は共有型だけに要る。** 個人スコープ型では飛ばす(名簿を持たないため)。

**段3 を段2 より先に送ると、そのあと足した画面とボタンは、自分で宣言した役割から名指しされないまま残る**(§5)。
**画面の種別は `form` / `list_view` / `detail_view` / `report_view` の4つで、全量は view-shape にある。**

**【この5段が最短であるとは書かない】** —— 段数を1度も測っていない。上の表が示すのは
「この向きでしか名指しできない」ことだけで、**より少ない段で立つ組み方が無いことは保証しない。**

---

## 3. 骨格(個人スコープ型)

**実在するアプリ1本の定義から起こし、業種に依らない語に置き換えたものである**(創作した JSON ではない)。
**表1本・画面3枚・役割4つ。** ID と表示名を替えれば、そのまま出発点にできる。

```json
{ "op": "add_table",
  "table": {
    "id": "item", "name": "記録", "representative_field": "title",
    "fields": [
      { "id": "title",    "name": "件名",   "type": "text", "required": true },
      { "id": "done",     "name": "完了",   "type": "boolean" },
      { "id": "due_on",   "name": "期限",   "type": "date" },
      { "id": "rank",     "name": "重要度", "type": "select", "options": ["高", "中", "低"] },
      { "id": "memo",     "name": "覚書",   "type": "long_text" },
      { "id": "st_owner", "name": "所有者", "type": "text" }
    ] } }
```

**`st_owner` は最後の1本である。** 型は `text`(参照ではない)。

```json
{ "op": "add_view",
  "view": { "id": "item_list", "type": "list_view", "table": "item", "name": "未完了の記録",
    "columns": ["title", "due_on", "rank"],
    "filter": { "field": "done", "equals": false },
    "search_fields": ["title"], "page_size": 20, "menu_listed": true,
    "actions": [ { "id": "open_item", "name": "開く", "view": "item_detail" } ] } }

{ "op": "add_view",
  "view": { "id": "item_form", "type": "form", "table": "item", "name": "記録を登録",
    "fields": ["title", "done", "due_on", "rank", "memo"],
    "after_save": "item_list", "menu_listed": true } }

{ "op": "add_view",
  "view": { "id": "item_detail", "type": "detail_view", "table": "item", "name": "記録",
    "fields": ["title", "done", "due_on", "rank", "memo"], "menu_listed": false,
    "actions": [
      { "id": "complete", "name": "完了にする",
        "set": { "field": "done", "value": true },
        "visible_when": { "field": "done", "equals": false } },
      { "id": "reopen", "name": "未完了に戻す",
        "set": { "field": "done", "value": false },
        "visible_when": { "field": "done", "equals": true } } ] } }
```

**`st_owner` を入力画面(`form`)の `fields` に入れない** —— 書くのはプラットフォームである。

```json
{ "op": "set_roles",
  "roles": [
    { "id": "owner", "name": "管理者",
      "rules": [
        { "target": "app",  "can": ["write"] },
        { "target": "role", "can": ["write"] },
        { "target": "field", "table": "item", "field": "st_owner", "can": ["read"] } ] },
    { "id": "customer", "name": "利用者",
      "rules": [
        { "target": "table", "table": "item", "can": ["read", "write", "delete"],
          "when": { "or": [ { "field": "st_owner", "equals_current_user": true },
                            { "field": "st_owner", "is_empty": true } ] } },
        { "target": "view", "view": "item_list",   "can": ["read"] },
        { "target": "view", "view": "item_form",   "can": ["read"] },
        { "target": "view", "view": "item_detail", "can": ["read"] },
        { "target": "action", "view": "item_list",   "action": "open_item", "can": ["read"] },
        { "target": "action", "view": "item_detail", "action": "complete",  "can": ["read"] },
        { "target": "action", "view": "item_detail", "action": "reopen",    "can": ["read"] } ] },
    { "id": "editor", "name": "編集者" },
    { "id": "viewer", "name": "閲覧者" }
  ] }
```

- **`is_empty` の枝を落とさない** —— これが無いと、**まだ持ち主が決まっていない行が誰にも見えない。**
- **`editor` / `viewer` を消さない。** 規則を持たない宣言として残す。
- **非運営の役割の `id` を `customer` にしてある** —— **理由は §7 の (4) にある**(別の名前にすると、
  登録画面に規則を1本も持たない立場がもう1つ出る)。
- **`set_roles` は全置換である**(§4 の注記)。

### 会員登録が終わった直後に自動で開く画面(宣言する口が無い既定の挙動)

**セルフ登録が成功した直後、プラットフォームが画面を1枚だけ自動で開くことがある。**
**行き先をアプリ側が名指しする書き方は今日1つも無い**(そのキーは語彙に無い)。**選び方は実装に固定されている。**

- **候補になるのは、`st_owner` を宣言した表の `form` のうち、その立場が `{ "target": "view", … "can": ["read"] }` で読めるものだけである。**
- **候補がちょうど1本のときだけ、その画面が開く。**
- **候補が2本以上のときは自動で開かず、登録の直後に出る案内に候補が全部並ぶ。**
  **どれを先に出すかも、並ぶ順序も、宣言する口が1つも無い。**
- **候補が0本のときは何も起きない。**
- **`menu_listed: false` にした画面も候補になる。** **候補の選び方は掲載の設定を1度も見ていない** ——
  **画面一覧から隠した `form` でも、それが唯一の候補なら登録の直後にそこへ運ばれる。**
- **一度きりである。** そのあと自分で別の画面へ移っても、引き戻されることはない。
- **アプリ1本だけを配って動かす版では案内が出ず、自動で開くところだけが効く。**

**上の骨格はちょうど1本に当たる** —— `item_form` が `st_owner` つきの表の唯一の `form` であり、
`customer` にその画面の `read` を与えてあるので、**登録の直後にその入力画面が開く。**
**同じ表に2枚目の `form` を足すと自動では開かなくなり、案内に2本並ぶ形へ変わる**(数が挙動を決める)。

**開くのは入力画面であって、保存を押さなければ行は1件も作られない。**
**その人の行が既にあるかどうかは見ていない** —— **二重に作られることを止める仕組みは無い。**

**2026-08-22 訂正。上の箇条と段落を1行も消していない。** 上の4点は今日の正ではない。

- **候補の条件は今日5つある。** 上の1点目の「読めるものだけである」は今日は成り立たない ——
  **その3つでは足りない。** 今日の候補は次を全部満たしたものだけである:
  (1) `form` であること、(2) その表が `st_owner` を宣言していること、
  (3) その立場がその画面を読めること、(4) **その立場がその表に行を新しく作れること**
  (表そのものへの `write` が許されていて、かつ、その表に行を作るボタンの規則が
  その立場を拒んでいないこと。**作るボタンが1つも無ければ、後者は素通りする**)、
  (5) **その表を1件だけ読んで、その人から見えている行が1件も無いこと。**
- **2026-08-22 再訂正。すぐ上の (4) の丸括弧の中を1文字も消していない。**
  上の (4) の「表そのものへの `write` が許されていて」は、今日の実物とは違う ——
  **表そのものに `write` を許す規則は、ここでは1度も読まれていない。**
  (4) が実際に見ているのは次の2つだけである:
  (i) **その立場が閲覧者(`viewer`)でも未ログインでもないこと**
  (立場の名前だけで決まり、表の宣言を1つも見ていない)、
  (ii) **その表に行を作るボタンの規則が、その立場を拒んでいないこと**
  (**その表を書き先にする作成のボタンが1本も無ければ、この壁は立たず素通りする**)。
  **落ちる相手(閲覧者・未ログイン)は (4) に書いたとおりで、1つも変わらない。**
- **(5) で読み取りが断られた候補も落ちる。** それ以外の失敗(通信できない・見つからない・
  サーバの不調)では落とさない —— 読めなかった候補は残す。
  **断られるのは画面を名指しして読んだときだけであり、表の一覧そのものは
  読み取りの規則が1本も無くても断られず、0件を返す。**
- **(5) は「その人の行があるか」ではなく「その人から見えているか」である。**
  持ち主の欄が空の行は全員に見えるので、**自分の行が1件も無くても候補が落ちる。**
- **落ちた理由は画面に1文字も出ない。** 「もう登録済みです」のような文面は1つも無い。
- **配って動かす版でも案内は出る。** 上の「案内が出ず、自動で開くところだけが効く」は
  今日は偽である。定義を育てる版と同じ案内を、同じ1本で描いている。
  候補が0本のときに何も描かないのは、今日も両方の版で同じである。
- **骨格が候補1本に当たるのは今日も真だが、開くことは無条件ではない。**
  骨格の `customer` は `item` に `write` を持ち、`item` に行を作るボタンが1つも無いので (4) は通る。
  **(5) が条件を足した** —— 登録した人から見えている `item` の行が1件も無いときにだけ
  `item_form` が開く。**持ち主の欄が空の `item` の行が1件でもあると、骨格のままでも開かない**
  (骨格の `customer` の規則が `is_empty` の枝でその行を全員に見せているためである)。
- **上の最後の行は、前半だけが偽である。** 行が既にあるかどうかを、今日は見ている(上の (5))。
  **後半の「二重に作られることを止める仕組みは無い」は今日も真である** ——
  保存の口には何も足していない。止めているのは案内と自動で開くところだけであって、
  自分で `item_form` を開けば2件目も今日どおり保存できる。
- **2026-08-22 再訂正(この節の末尾に足す。上の箇条を1行も消していない)。**
  上の「骨格の `customer` は `item` に `write` を持ち、`item` に行を作るボタンが1つも無いので
  (4) は通る。」は、**結論(通る)だけが真で、理由が実物と違う。**
  **`item` に `write` を持っていることは、(4) の判定に1ミリも効いていない**
  (表そのものに `write` を許す規則は読まれない)。**通る理由は次の2つである** ——
  骨格の `customer` が閲覧者でも未ログインでもないこと、そして
  `item` に行を作るボタンが1本も無いので壁が立たないこと。
  **後半(ボタンが1つも無い)だけが、今日も理由として効いている。**

---

## 4. 骨格(共有型)

**実在するアプリ1本の定義から起こしたものである**(創作した JSON ではない)。
**表4本・画面4枚・役割5つ。** **業務の表・付与表・名簿・グループ・役割の対応が、この1つの形に全部入っている。**

```json
{ "op": "add_table",
  "table": { "id": "member_groups", "name": "グループ", "representative_field": "name",
    "fields": [ { "id": "name", "name": "名前", "type": "text", "required": true } ] } }

{ "op": "add_table",
  "table": { "id": "members", "name": "参加者", "representative_field": "name",
    "fields": [
      { "id": "name",    "name": "名前",     "type": "text", "required": true },
      { "id": "account", "name": "利用者ID", "type": "text", "required": true },
      { "id": "group",   "name": "グループ", "type": "reference", "reference_table": "member_groups" }
    ] } }

{ "op": "add_table",
  "table": { "id": "work_grants", "name": "作業の担当",
    "fields": [
      { "id": "work",       "name": "作業",     "type": "reference", "reference_table": "work" },
      { "id": "member",     "name": "参加者",   "type": "reference", "reference_table": "members" },
      { "id": "group",      "name": "グループ", "type": "reference", "reference_table": "member_groups" },
      { "id": "permission", "name": "権限",     "type": "select", "options": ["lead", "watcher"] }
    ] } }

{ "op": "add_table",
  "table": { "id": "work", "name": "作業", "representative_field": "title",
    "fields": [
      { "id": "title",  "name": "件名",   "type": "text", "required": true },
      { "id": "detail", "name": "内容",   "type": "long_text" },
      { "id": "state",  "name": "状態",   "type": "select", "options": ["受付", "対応中", "完了"] },
      { "id": "due",    "name": "期限",   "type": "date" }
    ],
    "access_control": {
      "enabled": true,
      "permissions": [
        { "id": "lead",    "name": "作業の担当", "read": true, "write": true,  "delete": true },
        { "id": "watcher", "name": "作業の閲覧", "read": true, "write": false, "delete": false }
      ],
      "creator_permission": "lead",
      "grant":   { "table": "work_grants", "target": "work",
                   "member": "member", "group": "group", "permission": "permission" },
      "members": { "table": "members", "account": "account", "group": "group" },
      "groups":  { "table": "member_groups" }
    } } }
```

**対応の読み方**(この4本が1つの宣言で結ばれている):

| 宣言 | 指す先 | 何を意味するか |
|---|---|---|
| `grant.table` | **付与表**(`work_grants`) | 「誰がこの行に何をできるか」を1行ずつ持つ表 |
| `grant.target` | 付与表の中の参照項目 | **業務の表の行**を指す列 |
| `grant.member` / `grant.group` | 同上 | **名簿の行 / グループの行**を指す列 |
| `grant.permission` | 付与表の中の `select` | 値は `permissions[].id` と同じ語であること |
| `members.table` / `members.account` | **名簿**(`members`)とその列 | **ログイン中の人を名簿の行に結びつける列**。入るのは利用者IDである |
| `groups.table` | **グループ**(`member_groups`) | 名簿の行をまとめる表 |
| `creator_permission` | `permissions[].id` の1つ | **行を作った人に自動で入る付与** |

**表の順序に注意** —— `work_grants` は `work` を参照するが、`work` は `work_grants` を
`access_control` から名指しする。**同じ差分の中なら順序は問われない**(1つの差分は全体で1度に検査される)。
**別々の差分に分けるなら、参照先の表を先に作る。**

**画面**(付与表を人が触れるように、**付与表の入力画面も1枚作る**):

```json
{ "op": "add_view",
  "view": { "id": "work_list", "type": "list_view", "table": "work", "name": "作業一覧",
    "columns": ["title", "state", "due"], "search_fields": ["title"],
    "page_size": 50, "menu_listed": true,
    "actions": [ { "id": "open_work", "name": "開く", "view": "work_detail" } ] } }

{ "op": "add_view",
  "view": { "id": "work_form", "type": "form", "table": "work", "name": "作業を登録",
    "fields": ["title", "state", "detail", "due"],
    "after_save": "work_list", "menu_listed": true } }

{ "op": "add_view",
  "view": { "id": "work_detail", "type": "detail_view", "table": "work", "name": "作業",
    "fields": ["title", "state", "detail", "due"], "menu_listed": false,
    "related": [ { "table": "work_grants", "via": "work", "name": "この作業の担当",
                   "columns": ["member", "group", "permission"] } ],
    "actions": [ { "id": "add_grant", "name": "担当を追加",
                   "form": "work_grant_form", "prefill": { "field": "work" } } ] } }

{ "op": "add_view",
  "view": { "id": "work_grant_form", "type": "form", "table": "work_grants", "name": "作業に担当を追加",
    "fields": ["work", "member", "group", "permission"],
    "reference_pickers": { "work": "search", "member": "search", "group": "list" },
    "after_save": "work_list", "menu_listed": false } }
```

**役割**(共有型では、業務の表そのものに規則を書かず、**付与で絞る**のが基本形である):

```json
{ "op": "set_roles",
  "roles": [
    { "id": "owner", "name": "管理者",
      "rules": [
        { "target": "app",  "can": ["write"] },
        { "target": "role", "can": ["write"] },
        { "target": "table", "table": "members",       "can": ["read", "write", "delete"] },
        { "target": "table", "table": "member_groups", "can": ["read", "write", "delete"] },
        { "target": "table", "table": "work_grants",   "can": ["read", "write", "delete"] },
        { "target": "view",  "view": "work_list",   "can": ["read"] },
        { "target": "view",  "view": "work_form",   "can": ["read"] },
        { "target": "view",  "view": "work_detail", "can": ["read"] },
        { "target": "view",  "view": "work_grant_form", "can": ["read"] },
        { "target": "action", "view": "work_list",   "action": "open_work", "can": ["read"] },
        { "target": "action", "view": "work_detail", "action": "add_grant", "can": ["read"] } ] },
    { "id": "staff", "name": "担当者", "signup": "invite",
      "rules": [
        { "target": "table", "table": "members",       "can": ["read"] },
        { "target": "table", "table": "member_groups", "can": ["read"] },
        { "target": "table", "table": "work_grants",   "can": ["read", "write"] },
        { "target": "view",  "view": "work_list",   "can": ["read"] },
        { "target": "view",  "view": "work_form",   "can": ["read"] },
        { "target": "view",  "view": "work_detail", "can": ["read"] },
        { "target": "view",  "view": "work_grant_form", "can": ["read"] },
        { "target": "action", "view": "work_list",   "action": "open_work", "can": ["read"] },
        { "target": "action", "view": "work_detail", "action": "add_grant", "can": ["read"] } ] },
    { "id": "customer", "name": "利用者", "signup": "invite" },
    { "id": "editor", "name": "編集者" },
    { "id": "viewer", "name": "閲覧者" }
  ] }
```

- **業務の表(`work`)を名指しした `target: "table"` の規則を書いていない。**
  **書くと付与を越えて全員分の行が見えるので、書く前に人間に確認すること**(view-shape の参照ファイルの逐語)。
- **`"signup": "invite"` を書かない役割は、登録画面で自称できる**(§7 の (4))。
- **`customer` を規則なしで宣言してある** —— **宣言しなくても登録画面に必ず出る立場だからである**(§7 の (4))。
- **`set_roles` は全置換である。** **1本だけ足す手段も、1本だけ消す手段も無い。**
  書き直すときは**全役割の全規則を丸ごと送り直す** ——
  実在するアプリでは、この全置換だけで4回・合計 26,130 バイトを送り直している。

**この骨格が実物から落としたもの(隠さない)**: 実物は**名簿の表そのものにも `access_control` を宣言**しており、
そのぶんの付与表をもう1本持つ。**骨格では名簿を役割の規則だけで守っている**(表が1本減る)。

---

## 5. 作った直後に必ず起きること —— **規則を書いていない対象は、持ち主にも閉じる**

**表・画面・ボタンを足した時点で自動で入る規則は、既定の3役割(`owner` / `editor` / `viewer`)ぶんだけである。**
実装は `src/kernel/apply-diff.ts:600`-`:659`(`grantDefaultRoleRules`。足す条件が4つ書いてある)。

**帰結は2つある。**

1. **自分で宣言した役割には、規則が1本も入らない。**
   §3 の `customer`、§4 の `staff` のような役割は、**自分で書くまで表も画面もボタンも1つも見えない。**
2. **`set_roles` を送った瞬間、自動で入っていた規則は消える。**
   全置換なので、**送った配列に書かなかった表・画面・ボタンは、`owner` でも閉じる。**

**「運営だから通る」という抜け道は無い。**
検査の逐語(コメント): `src/server/role-rules-enforcement.test.ts:302`
「**`owner` も同じである** —— **「運営だから通る」分岐は1本も無い。**」
(直下の行が、`owner` の一覧 GET に対して `403` を要求している)

**閉じるのは5対象**(表 / 画面 / ボタン / `app` / `role`)。
**項目(`field`)だけは閉じない** —— `src/server/owner-scope.ts:3250`
逐語 `return target.target === "field" ? UNGOVERNED_ROLE_ACCESS : CLOSED_ROLE_ACCESS;`。
**書き忘れた項目は「見えない」ではなく「見える」に落ちる。**

**抜け方**: **画面とボタンを全部作り終えてから、`set_roles` を1回送る。**
その1回に、**全役割ぶんの表・画面・ボタンの規則を全部書く。**
**【禁止】これを「規則を書けば必ず開く」と読まない** —— 共有型では、規則が開いても
付与が1件も無ければ行は返らない(§6)。

**【2026-08-25 追記。上の行は消していない】**
**`app` が閉じると、`dry_run_diff`(差分を当てずに何が起きるかを実測する道具)も断られる。**
着手前は、この道具だけが `app` の規則を持たない相手にも通っていた。
**今日は `apply_diff` とまったく同じ判定が、`intent` の検査より**前**に掛かる。**

- **役割の規則を1本も書いていないアプリでは、持ち主でも `dry_run_diff` が断られる。**
  **直し方は `set_roles` で `owner` に `target: "app"` / `can: ["write"]` を書き戻すことである。**
- **サーバの説明文は今日も「まず `dry_run_diff` → 同意 → `apply_diff` → 検証 → `undo`」の
  5段を全ツールに載せているが、その権限が無い相手は第1段から進めない。**
  **この食い違いは塞いでいない** —— **断り文が直し方を名指ししているので、
  そこから人間への依頼へ回ること。**
- **【誇張しない】これで「定義が読めなくなった」わけではない。**
  **`get_manifest` は今日どおり定義の全量を返す。**

---

## 6. 名簿の最初の1行(共有型だけ)

**`access_control` を宣言した表は、名簿に自分の行がある人しか使えない。**
**名簿が空のあいだは、持ち主(`owner`)でも業務の表に1行も作れず `400` になる。**
**この 400 は「持ち主でも作れない」ではなく「まだ誰も名簿に載っていない」である。**

**踏む手順は3段である。**

1. **自分の利用者IDを調べる。**
   運営者としてログインして `GET /api/apps/:app_id/auth/users` を開く(画面なら利用者管理の一覧)。
   **そこに出る `id` が利用者IDである。** 自分の分だけでよければ `GET /api/apps/:app_id/auth/me` でも読める。
   **【2026-09-05 追記。直前の1文を消していない】画面で見るなら、利用者管理の一覧に出る `利用者ID` の列がそれである(クリックでコピーできる)。AI(MCP)からは今日も利用者一覧を読む道具が無いので、この段は人がブラウザで踏む。**
2. **名簿の表に、その利用者IDで1行足す。**
   「名簿の表」とは `access_control.members.table` が名指しした表である(**名前はアプリごとに違う**)。
   `POST /api/apps/:app_id/tables/<名簿の表>/records` で、`access_control.members.account` が
   名指しした列に**利用者IDを入れる。**
   - **書くのは、ログイン名ではなく利用者IDである。** ログイン名を書いた行は1件も一致せず、**まったく同じ 400 が返る。**
   - **名簿に行を足せるのは運営者(`owner`)だけである。** `editor` は `403` になる。
   - **【2026-09-05 追記】人がブラウザのフォームで書くときは、`account` 欄が利用者の一覧から選ぶプルダウンになる場合がある(利用者の一覧を読める人だけ)。読めない人には今日どおりのテキスト欄が出る。プルダウンは画面の助けであって担保ではない —— `account` 欄は今日も `text` 型のままで、値が実在の利用者IDかはプラットフォームが検査しない。この `POST` のような API・AI(MCP) 経由の書き込みには何の検査も掛からない。**
3. **もう一度、業務の表に行を作る。**
   `201` になり、同時に `creator_permission` に書いた権限名の付与が1行、付与表に自動で入る。

**プラットフォームは名簿に自動では1行も入らない** —— アプリを作ったときも、人が登録したときも、
`access_control` を有効にしたときも入らない。**足すのは人の操作である。**

**もう1つの入れ方が存在する(選ばない理由つき)**: `change_table` で `access_control.enabled` を
`false` に落とし、行を入れてから `true` に戻す形も実在する。**この説明書はそちらを手順として書かない** ——
**`change_table` は破壊的な操作なので、`dry_run_diff` → 人間の同意 → 適用 → 検証 の手続きを2回踏むことになる。**
**選ぶとしたら、運営者としてログインできる人がまだ1人もいない場合だけである**(上の3段は段1でログインを要求する)。

---

## 7. 適用後に必ず見る5点 —— **差分は通ったのに壊れている型**

**5点である。** **どれも「差分は通る」「エラーも警告も返らない」「定義を読んでも分からない」という同じ形を持つ。**
**この5点はリポジトリの中で裏が取れたものだけで、6点目が無いことは保証しない。**

### (1) 規則を書いていない表・画面・ボタンが残っていないか

**確かめ方**: `set_roles` を送ったあと、**その役割の人としてブラウザでログインし、画面を1枚ずつ開く。**
閉じていれば `403` になる。API で見るなら、その人のセッションで
`GET /api/apps/:app_id/tables/<表>/records?view=<画面>` を開く。
**MCP からは再現できない** —— MCP は起動設定で名乗った1人として動くので、**他の役割の見え方を1件も測れない。**
裏づけは §5。

### (2) `st_owner` と `access_control` を同じ表に併せ持っていないか

**確かめ方**: `get_manifest` を開き、**`access_control` を宣言した表の `fields` に `st_owner` が無いこと**を見る。
併せ持ったまま出すなら、**付与だけを持つ人でログインして一覧の件数を見る**(`AND` になるので 0 件になる)。
裏づけは §1(`src/server/owner-scope.ts:548` / `src/server/record-access-visibility.test.ts:689`)。

### (3) 未記入の `boolean` が絞り込みから漏れていないか

**値を1度も書いていない `boolean` は `NULL` になり、`equals` の絞り込みに1件も一致しない。**
実装の逐語: `src/kernel/records.ts:1159`-`:1160`
`const comparator = op === "gte" ? ">=" : op === "lte" ? "<=" : "=";` /
`` return { sql: `${col} ${comparator} ?`, bindings: [bound] }; ``
**SQL の `=` は `NULL` の列に一致しない。**

**確かめ方**: `list_records` を絞り込み無しで呼んだ件数と、`filter` に
`{ "field": "done", "equals": false }` を書いた画面の件数を比べる。**差が出たら、その差が未記入の行である。**
**直し方**: 行を作るすべての経路(入力画面・自動処理・コードの島・受信口)で、その項目に値を書くこと。

### (4) 立場の自己申告を止めたか(`signup`)

**役割に `"signup": "invite"` を書かないと、登録画面でその立場を自称できる。**
値は `open` / `invite` の2つだけ(`schemas/manifest.schema.json:279` / `:282` の `"enum": ["open", "invite"]`)。
判定は `src/server/auth-routes.ts:675` の `return inviteOnlyRoles.includes(requestedKind);`、
検査は `src/server/signup-mode-enforcement.test.ts:266`。

**さらに、登録画面には `customer` が必ず出る** —— **アプリが宣言していなくても出る。**
実装の逐語: `src/server/auth-routes.ts:406` `const today = [DEFAULT_USER_KIND] as readonly string[];` と
`:411` `return [...custom, ...today.filter((id) => !custom.includes(id))];`
(`DEFAULT_USER_KIND` の値は `src/auth/types.ts:73` で `"customer"`)。
**宣言していない `customer` で登録した人には規則が1本も無く、何も見えない。**
**直し方は2つ** —— **非運営の役割の `id` を `customer` にする**か、**`customer` も宣言してしまう**か。

**確かめ方**: **登録画面を開き、選べる立場の一覧を見る。**
運営側の役割がそこに出ていたら、その役割に `"signup": "invite"` が書かれていない。
**宣言した覚えのない立場が出ていたら、それが上の `customer` である。**

### (5) コードの島の書込先に `act_as` が要らないか

**島(`function`)の `write_ops` は、発火させた人の権限で判定される。**
**書込先が `access_control` か `st_owner` を持つなら、発火させた人の付与が無い行は1行も書けない** ——
検査は `src/server/automation-access-control.test.ts:653`
「(iii-a) 権限が無い相手の発火で動いた島の書込は落ち、1行も書かれない」。
**別の人として書きたいときは `act_as` を書く。** 値の形は `$record.<参照フィールドID>` の1つだけで
(`schemas/manifest.schema.json:1828` の `"pattern": "^\\$record\\.[a-z][a-z0-9_-]*$"`)、
**辿れないときは書き込めない**(`fail-closed`)。

**逆に、書込先に `access_control` も `st_owner` も無ければ、判定そのものが起きない。**
実在するアプリは `act_as` を1本も持たずに動いており、**理由は島が書く付与表に宣言が1つも無いことである。**
**【禁止】これを「自動処理には権限が効かない」と読まない** —— 宣言のある表へ書けば落ちる。

**確かめ方**: ワークフローの `history_table` に指した表を一覧で開き、**失敗の行が無いか**を見る。

---

## 8. この説明書が保証しないこと

- **書いてあるのは順序と骨格であって、形の全量ではない。**
  必須キー・書けるキー・値域は diff-shape / view-shape / automation-shape にある。
  **この説明書はそれらを1つも数え直していない。**
- **骨格は語彙の正から生成していない。** 実在するアプリの定義から人が起こし、語を置き換えたものである。
  **正が動いた日に古くなる。** 正は `src/kernel/types.ts` の3配列と
  `schemas/manifest.schema.json` / `schemas/diff.schema.json` である。**食い違いを見つけたら、正のほうを信じること。**
- **§2 の5段が最短であるかを1度も測っていない。** 示したのは「この向きでしか名指しできない」ことだけである。
- **§7 の5点は網羅ではない。** リポジトリの中で裏が取れたものだけを載せてある。
- **`allowed-tools` の4本は、MCP サーバの登録名が `smailtalk` のときの名前である。**
  別の名前で登録している環境では、その名前に読み替える必要がある(この説明書は読み替えを行わない)。
- **この説明書の版がサーバの実装とずれていても、実行は止まらない。**
  版は plugin の `version` 1本だけで、**版が合わないときに実行を止める仕組みは持っていない。**
- **この説明書を開いたことで躓きが減るかどうかは、まだ測られていない。**
