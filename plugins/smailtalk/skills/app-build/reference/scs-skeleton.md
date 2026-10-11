# 組織と評価機関の骨格(共有型を2種類の行に広げた形)

この参照ファイルは、app-build の説明書の §7g から開く。 **新しい型ではない** —— 共有型(説明書の §4)の宣言を、
「組織」と「評価機関」の2種類の行に広げ、§7c〜§7f の部品(行への招待・行を相手にした付与・子の表に行を作れる権限・変更履歴)と
名簿の自動登録(§6 の訂正)を1本のアプリにまとめたものである。 §1 の「型は2つ(3つ目は無い)」は今日も変わらない。

差分は、どの段も **`dry_run_diff` で下見してから `apply_diff` で当てる**。 下のコードブロック1つが差分1本(`diff_id` / `intent` / `operations`)で、
そのまま両方の道具に渡せる。 書けるキーの全量は diff-shape・view-shape の説明書にある。 この骨格はそれを数え直していない。

---

## 1. この骨格が向く頼まれ方と、向かないこと

- **向く頼まれ方**: 「組織ごとに記録を持ち、組織の人だけが入力する」「契約した評価機関の人たちにだけ、その組織の記録を見せたい」
  「評価機関の人は組織の記録を直せないが、組織への告知は出せるようにしたい」「記録を誰がいつ何から何に変えたかを残したい」
  「1人は1つの組織にしか入れないようにしたい」。
- **向かないこと**(この骨格は扱わない): 1人の専門家が複数の評価機関に同時に所属する形・メールなどでの通知・外部の道具から読むための鍵。
  名簿のグループ(§4 の `member_groups`)も使わない(人のまとまりは評価機関の行で表す)。

## 2. 型の位置づけ

- 共有型(§4)の「業務の表・付与を記録する表・名簿」の組を、**評価機関・組織・評価・告知の4つの表に1組ずつ**持たせる。 名簿は全部で1つ。
- 評価機関の人を組織に届けるのは、組織の付与の表に足した「評価機関を指す列」(行を相手にした付与)である。 名簿のグループは要らない。
- 評価と告知は組織の子の表(`inherit_from`)で、組織の行を読める人が読める。

## 3. 登場する人と役割

役割は3つ(運営者 `owner` と、組織の人 `org_user`・専門家 `expert`)。 既定の `editor` / `viewer` も残しておく。

- **運営者**(`owner`): 評価機関を作り、最初の管理者(評価機関のオーナー)を招く。 全部の行が見える。
- **組織の人**(`org_user`、登録画面で自分で選べる): 組織を1つ作るとその組織のオーナーになる。 オーナーに招かれて承諾するとメンバーになる。
- **専門家**(`expert`、運営者の招待でだけ登録できる): 評価機関のオーナーか、評価機関に所属する専門家になる。

権限名(行ごと)は表ごとに次のとおり:

- 評価機関: `ag_admin`(管理。読む・書く・消す)・`ag_staff`(所属。読むだけ)
- 組織: `org_admin`(オーナー。読む・書く・消す)・`org_member`(メンバー。読む・書く)・`assessor`(評価機関に渡す。読むだけで、告知の表に行を作れる)
- 評価: `as_author`(入力した人)。 告知: `author`(書いた人。自分の告知を直せる)
- **(2026-10-02 訂正。直前の3行を消していない)** 直前の行のうち、評価機関の `ag_admin` の「消す」と、組織の `org_member` の「書く」は、5-6 の差分で外す。 評価機関の行を消せるのは運営者だけになり、名前などを直せるのは評価機関のオーナー(`ag_admin`)と運営者になる。 組織のメンバーは、組織の行への書込の権限の代わりに、評価と告知を作れる権限(`create_child`)を持つ。 組織の名前などを直せるのは、組織のオーナーと運営者になる。

## 4. 表の一覧

- `members`(名簿): `name`・`account`。 名簿の自動登録で、運営者・組織の人・専門家が登録した直後に1行ずつ入る。
- `agencies`(評価機関)と `ag_grants`(評価機関の付与): 評価機関は運営者だけが作れる(`creatable_by_roles`)。 専門家への招待(`invitations`。受け取れるのは専門家だけ)。
- `orgs`(組織)と `org_grants`(組織の付与): 組織は組織の人が作れる。 付与の表に評価機関を指す列 `agency` を足し、`principal_row` で評価機関の人に届ける。
  メンバーへの招待とコードの招待(`invitations`)。 **1人1組織は、付与の表の相手の列 `member` に `unique` と `unique_message` を書いて表す**(§7)。
- `assessments`(評価)と `assessment_grants`: 組織の子。 `history: true` で変更履歴を残す。
- `notices`(告知)と `notice_grants`: 組織の子。 組織の権限 `assessor` の `create_child` に名を挙げ、組織を直せない評価機関の人にも作らせる。
- 名簿を除く4つの表の `access_control` には、必須の4キー `enabled`・`permissions`・`creator_permission`・`grant` を必ず書く(子の表も、作った人に入る付与のために自分の付与の表を持つ)。

## 5. 組む順序

小分けにして、毎回 `dry_run_diff` で下見してから `apply_diff` で当てる。 順序には理由がある。

1. **役割の名前**(`set_roles`) —— 名簿の自動登録と作成の関門(`creatable_by_roles`)と招待の受け手(`target_roles`)は役割の id を名指しするので、先に役割が要る。
   ここでは規則を運営者の2本だけにする(規則の全部は画面を足した後の5段目で送る)。 **運営者の `app` と `role` の書込の規則を落とさないこと**(落とすと次の差分を当てられない)。
2. **名簿と評価機関** —— 行を相手にした付与は、相手の表(評価機関)の `access_control` が先に在ることを求める。 招待を書いた差分には、同じ差分で `set_workspace` の `invitations`(受け取り画面)も書く。
3. **組織と、組織の子の表**(評価・告知) —— 名簿の自動登録は1つの宣言に書けば足りる(同じ名簿を指す宣言の片方だけが書くのは通る)。
4. **画面** —— 評価の詳細画面の `history: true` は、表が先に `history: true` になっていることを求める。
5. **役割の規則**(`set_roles`。全置換なので全役割の全規則を送る)。
6. **(2026-10-02 訂正。上の5段を消していない)消せる人・名前を変えられる人・告知を直せる人を絞る**(5-6。評価機関と組織の権限の書き直しと、役割の規則の全置換)。 5段目で止めると、5-6 の冒頭の3つが起きる。

### 5-1. 役割の名前

```json
{ "diff_id": "scs-1-roles",
  "intent": "組織の人と専門家の2つの役割を用意する(規則は画面の後で送る)",
  "operations": [
    { "op": "set_roles",
      "roles": [
        { "id": "owner", "name": "運営者",
          "rules": [ { "target": "app", "can": ["write"] }, { "target": "role", "can": ["write"] } ] },
        { "id": "org_user", "name": "組織の人", "signup": "open" },
        { "id": "expert", "name": "専門家", "signup": "invite" },
        { "id": "editor", "name": "編集者" },
        { "id": "viewer", "name": "閲覧者" } ] } ] }
```

### 5-2. 名簿と評価機関

```json
{ "diff_id": "scs-2-roster-agencies",
  "intent": "名簿(登録した人が自動で入る)と、運営者だけが作れる評価機関を用意する",
  "operations": [
    { "op": "add_table",
      "table": { "id": "members", "name": "名簿", "representative_field": "name",
        "fields": [
          { "id": "name", "name": "名前", "type": "text", "required": true },
          { "id": "account", "name": "利用者ID", "type": "text", "required": true } ] } },
    { "op": "add_table",
      "table": { "id": "ag_grants", "name": "評価機関の付与",
        "fields": [
          { "id": "agency", "name": "評価機関", "type": "reference", "reference_table": "agencies", "required": true },
          { "id": "member", "name": "専門家", "type": "reference", "reference_table": "members" },
          { "id": "permission", "name": "権限", "type": "select", "options": ["ag_admin", "ag_staff"] } ] } },
    { "op": "add_table",
      "table": { "id": "agencies", "name": "評価機関", "representative_field": "name",
        "fields": [ { "id": "name", "name": "名前", "type": "text", "required": true } ],
        "access_control": {
          "enabled": true,
          "permissions": [
            { "id": "ag_admin", "name": "管理", "read": true, "write": true, "delete": true },
            { "id": "ag_staff", "name": "所属", "read": true, "write": false, "delete": false } ],
          "creator_permission": "ag_admin",
          "creatable_by_roles": ["owner"],
          "grant": { "table": "ag_grants", "target": "agency", "member": "member", "permission": "permission" },
          "members": { "table": "members", "account": "account",
            "auto_enroll": { "roles": ["owner", "org_user", "expert"], "name": "name" } },
          "invitations": { "grantable": ["ag_admin", "ag_staff"], "target_roles": ["expert"] } } } },
    { "op": "set_workspace", "workspace": { "invitations": { "label": "届いた招待" } } } ] }
```

### 5-3. 組織と、組織の子の表

```json
{ "diff_id": "scs-3-orgs",
  "intent": "組織(1人1組織)と、評価機関に届ける付与、評価(変更履歴つき)と告知を用意する",
  "operations": [
    { "op": "add_table",
      "table": { "id": "org_grants", "name": "組織の付与",
        "fields": [
          { "id": "org", "name": "組織", "type": "reference", "reference_table": "orgs", "required": true },
          { "id": "member", "name": "メンバー", "type": "reference", "reference_table": "members",
            "unique": true, "unique_message": "既に別の組織に所属しています" },
          { "id": "agency", "name": "評価機関", "type": "reference", "reference_table": "agencies" },
          { "id": "permission", "name": "権限", "type": "select", "options": ["org_admin", "org_member", "assessor"] } ] } },
    { "op": "add_table",
      "table": { "id": "orgs", "name": "組織", "representative_field": "name",
        "fields": [ { "id": "name", "name": "名前", "type": "text", "required": true } ],
        "access_control": {
          "enabled": true,
          "permissions": [
            { "id": "org_admin", "name": "オーナー", "read": true, "write": true, "delete": true },
            { "id": "org_member", "name": "メンバー", "read": true, "write": true, "delete": false },
            { "id": "assessor", "name": "評価機関", "read": true, "write": false, "delete": false,
              "create_child": ["notices"] } ],
          "creator_permission": "org_admin",
          "creatable_by_roles": ["org_user"],
          "grant": { "table": "org_grants", "target": "org", "member": "member", "permission": "permission",
            "principal_row": { "column": "agency", "table": "agencies", "via": ["ag_admin", "ag_staff"] } },
          "members": { "table": "members", "account": "account" },
          "invitations": { "grantable": ["org_member", "assessor"], "target_roles": ["org_user"] } } } },
    { "op": "add_table",
      "table": { "id": "assessment_grants", "name": "評価の付与",
        "fields": [
          { "id": "assessment", "name": "評価", "type": "reference", "reference_table": "assessments", "required": true },
          { "id": "member", "name": "入力した人", "type": "reference", "reference_table": "members" },
          { "id": "permission", "name": "権限", "type": "select", "options": ["as_author"] } ] } },
    { "op": "add_table",
      "table": { "id": "assessments", "name": "評価", "representative_field": "criterion", "history": true,
        "fields": [
          { "id": "org", "name": "組織", "type": "reference", "reference_table": "orgs", "required": true },
          { "id": "criterion", "name": "基準", "type": "text", "required": true },
          { "id": "status", "name": "状況", "type": "select", "options": ["未着手", "確認中", "達成"] },
          { "id": "note", "name": "メモ", "type": "long_text" } ],
        "access_control": {
          "enabled": true,
          "permissions": [ { "id": "as_author", "name": "入力した人", "read": true, "write": true, "delete": true } ],
          "creator_permission": "as_author",
          "grant": { "table": "assessment_grants", "target": "assessment", "member": "member", "permission": "permission" },
          "members": { "table": "members", "account": "account" },
          "inherit_from": ["org"] } } },
    { "op": "add_table",
      "table": { "id": "notice_grants", "name": "告知の付与",
        "fields": [
          { "id": "notice", "name": "告知", "type": "reference", "reference_table": "notices", "required": true },
          { "id": "member", "name": "書いた人", "type": "reference", "reference_table": "members" },
          { "id": "permission", "name": "権限", "type": "select", "options": ["author"] } ] } },
    { "op": "add_table",
      "table": { "id": "notices", "name": "告知", "representative_field": "title",
        "fields": [
          { "id": "org", "name": "組織", "type": "reference", "reference_table": "orgs", "required": true },
          { "id": "title", "name": "件名", "type": "text", "required": true },
          { "id": "body", "name": "本文", "type": "long_text" } ],
        "access_control": {
          "enabled": true,
          "permissions": [ { "id": "author", "name": "書いた人", "read": true, "write": true, "delete": true } ],
          "creator_permission": "author",
          "grant": { "table": "notice_grants", "target": "notice", "member": "member", "permission": "permission" },
          "members": { "table": "members", "account": "account" },
          "inherit_from": ["org"] } } } ] }
```

- 子の表(評価・告知)の親の参照(`org`)は `required: true` にする(§6 の「`inherit_from` に書く参照項目は `required: true` にすること」)。
- 子の表の権限名は親と同じ名前でなくてよい。 親の行への付与で読める・書ける人は、子の行も読める・書ける。 子の表の権限名は、作った人に入る付与のためにある。

### 5-4. 画面

```json
{ "diff_id": "scs-4-views",
  "intent": "名簿・評価機関・組織・評価・告知と、2つの付与の表の画面を用意する",
  "operations": [
    { "op": "add_view", "view": { "id": "member_list", "type": "list_view", "table": "members", "name": "名簿",
      "columns": ["name"], "menu_listed": true,
      "actions": [ { "id": "open_member", "name": "開く", "view": "member_detail" } ] } },
    { "op": "add_view", "view": { "id": "member_detail", "type": "detail_view", "table": "members", "name": "名簿の行",
      "fields": ["name"], "menu_listed": false } },
    { "op": "add_view", "view": { "id": "member_form", "type": "form", "table": "members", "name": "名前を直す",
      "fields": ["name"], "after_save": "member_list", "menu_listed": false } },

    { "op": "add_view", "view": { "id": "agency_list", "type": "list_view", "table": "agencies", "name": "評価機関",
      "columns": ["name"], "menu_listed": true,
      "actions": [ { "id": "open_agency", "name": "開く", "view": "agency_detail" } ] } },
    { "op": "add_view", "view": { "id": "agency_form", "type": "form", "table": "agencies", "name": "評価機関を登録",
      "fields": ["name"], "after_save": "agency_list", "menu_listed": true } },
    { "op": "add_view", "view": { "id": "agency_detail", "type": "detail_view", "table": "agencies", "name": "評価機関",
      "fields": ["name"], "menu_listed": false,
      "related": [ { "table": "ag_grants", "via": "agency", "name": "所属する人", "columns": ["member", "permission"] } ] } },
    { "op": "add_view", "view": { "id": "ag_grant_list", "type": "list_view", "table": "ag_grants", "name": "評価機関の付与",
      "columns": ["agency", "member", "permission"], "menu_listed": true,
      "actions": [ { "id": "open_ag_grant", "name": "開く", "view": "ag_grant_detail" } ] } },
    { "op": "add_view", "view": { "id": "ag_grant_detail", "type": "detail_view", "table": "ag_grants", "name": "評価機関の付与",
      "fields": ["agency", "member", "permission"], "menu_listed": false } },
    { "op": "add_view", "view": { "id": "ag_grant_form", "type": "form", "table": "ag_grants", "name": "評価機関の権限を変える",
      "fields": ["agency", "member", "permission"], "after_save": "ag_grant_list", "menu_listed": false } },

    { "op": "add_view", "view": { "id": "org_list", "type": "list_view", "table": "orgs", "name": "組織",
      "columns": ["name"], "menu_listed": true,
      "actions": [ { "id": "open_org", "name": "開く", "view": "org_detail" } ] } },
    { "op": "add_view", "view": { "id": "org_form", "type": "form", "table": "orgs", "name": "組織を作る",
      "fields": ["name"], "after_save": "org_list", "menu_listed": true } },
    { "op": "add_view", "view": { "id": "org_detail", "type": "detail_view", "table": "orgs", "name": "組織",
      "fields": ["name"], "menu_listed": false,
      "related": [
        { "table": "assessments", "via": "org", "name": "評価", "columns": ["criterion", "status"] },
        { "table": "notices", "via": "org", "name": "告知", "columns": ["title"] },
        { "table": "org_grants", "via": "org", "name": "メンバーと評価機関", "columns": ["member", "agency", "permission"] } ],
      "actions": [
        { "id": "add_assessment", "name": "評価を足す", "form": "assessment_form", "prefill": { "field": "org" } },
        { "id": "add_notice", "name": "告知を出す", "form": "notice_form", "prefill": { "field": "org" } } ] } },
    { "op": "add_view", "view": { "id": "org_grant_list", "type": "list_view", "table": "org_grants", "name": "組織の付与",
      "columns": ["org", "member", "agency", "permission"], "menu_listed": true,
      "actions": [ { "id": "open_org_grant", "name": "開く", "view": "org_grant_detail" } ] } },
    { "op": "add_view", "view": { "id": "org_grant_detail", "type": "detail_view", "table": "org_grants", "name": "組織の付与",
      "fields": ["org", "member", "agency", "permission"], "menu_listed": false } },
    { "op": "add_view", "view": { "id": "org_grant_form", "type": "form", "table": "org_grants", "name": "組織の権限を変える",
      "fields": ["org", "member", "agency", "permission"], "after_save": "org_grant_list", "menu_listed": false } },

    { "op": "add_view", "view": { "id": "assessment_list", "type": "list_view", "table": "assessments", "name": "評価",
      "columns": ["org", "criterion", "status"], "menu_listed": true,
      "actions": [ { "id": "open_assessment", "name": "開く", "view": "assessment_detail" } ] } },
    { "op": "add_view", "view": { "id": "assessment_form", "type": "form", "table": "assessments", "name": "評価を入力",
      "fields": ["org", "criterion", "status", "note"], "after_save": "assessment_list", "menu_listed": false } },
    { "op": "add_view", "view": { "id": "assessment_detail", "type": "detail_view", "table": "assessments", "name": "評価",
      "fields": ["org", "criterion", "status", "note"], "menu_listed": false, "history": true } },

    { "op": "add_view", "view": { "id": "notice_list", "type": "list_view", "table": "notices", "name": "告知",
      "columns": ["org", "title"], "menu_listed": true,
      "actions": [ { "id": "open_notice", "name": "開く", "view": "notice_detail" } ] } },
    { "op": "add_view", "view": { "id": "notice_form", "type": "form", "table": "notices", "name": "告知を書く",
      "fields": ["org", "title", "body"], "after_save": "notice_list", "menu_listed": false } },
    { "op": "add_view", "view": { "id": "notice_detail", "type": "detail_view", "table": "notices", "name": "告知",
      "fields": ["org", "title", "body"], "menu_listed": false } } ] }
```

- 招待の欄(行の詳細画面の「招待する」)・評価機関のコードの欄・受け取り画面は、画面の定義に書かなくても出る(宣言から出る。view-shape の説明書の 5e・5f)。

### 5-5. 役割の規則

```json
{ "diff_id": "scs-5-role-rules",
  "intent": "運営者・組織の人・専門家に、表と画面とボタンの規則を配る",
  "operations": [
    { "op": "set_roles",
      "roles": [
        { "id": "owner", "name": "運営者",
          "rules": [
            { "target": "app", "can": ["write"] },
            { "target": "role", "can": ["write"] },
            { "target": "table", "table": "members", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "agencies", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "ag_grants", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "orgs", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "org_grants", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "assessments", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "assessment_grants", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "notices", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "notice_grants", "can": ["read", "write", "delete"] },
            { "target": "view", "view": "member_list", "can": ["read"] },
            { "target": "view", "view": "member_detail", "can": ["read"] },
            { "target": "view", "view": "member_form", "can": ["read"] },
            { "target": "view", "view": "agency_list", "can": ["read"] },
            { "target": "view", "view": "agency_form", "can": ["read"] },
            { "target": "view", "view": "agency_detail", "can": ["read"] },
            { "target": "view", "view": "ag_grant_list", "can": ["read"] },
            { "target": "view", "view": "ag_grant_detail", "can": ["read"] },
            { "target": "view", "view": "ag_grant_form", "can": ["read"] },
            { "target": "view", "view": "org_list", "can": ["read"] },
            { "target": "view", "view": "org_form", "can": ["read"] },
            { "target": "view", "view": "org_detail", "can": ["read"] },
            { "target": "view", "view": "org_grant_list", "can": ["read"] },
            { "target": "view", "view": "org_grant_detail", "can": ["read"] },
            { "target": "view", "view": "org_grant_form", "can": ["read"] },
            { "target": "view", "view": "assessment_list", "can": ["read"] },
            { "target": "view", "view": "assessment_form", "can": ["read"] },
            { "target": "view", "view": "assessment_detail", "can": ["read"] },
            { "target": "view", "view": "notice_list", "can": ["read"] },
            { "target": "view", "view": "notice_form", "can": ["read"] },
            { "target": "view", "view": "notice_detail", "can": ["read"] },
            { "target": "action", "view": "member_list", "action": "open_member", "can": ["read"] },
            { "target": "action", "view": "agency_list", "action": "open_agency", "can": ["read"] },
            { "target": "action", "view": "ag_grant_list", "action": "open_ag_grant", "can": ["read"] },
            { "target": "action", "view": "org_list", "action": "open_org", "can": ["read"] },
            { "target": "action", "view": "org_grant_list", "action": "open_org_grant", "can": ["read"] },
            { "target": "action", "view": "org_detail", "action": "add_assessment", "can": ["read"] },
            { "target": "action", "view": "org_detail", "action": "add_notice", "can": ["read"] },
            { "target": "action", "view": "assessment_list", "action": "open_assessment", "can": ["read"] },
            { "target": "action", "view": "notice_list", "action": "open_notice", "can": ["read"] } ] },
        { "id": "org_user", "name": "組織の人", "signup": "open",
          "rules": [
            { "target": "table", "table": "members", "can": ["read", "write"] },
            { "target": "table", "table": "orgs", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "org_grants", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "assessments", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "assessment_grants", "can": ["read"] },
            { "target": "table", "table": "notices", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "notice_grants", "can": ["read"] },
            { "target": "view", "view": "member_list", "can": ["read"] },
            { "target": "view", "view": "member_detail", "can": ["read"] },
            { "target": "view", "view": "member_form", "can": ["read"] },
            { "target": "view", "view": "org_list", "can": ["read"] },
            { "target": "view", "view": "org_form", "can": ["read"] },
            { "target": "view", "view": "org_detail", "can": ["read"] },
            { "target": "view", "view": "org_grant_list", "can": ["read"] },
            { "target": "view", "view": "org_grant_detail", "can": ["read"] },
            { "target": "view", "view": "org_grant_form", "can": ["read"] },
            { "target": "view", "view": "assessment_list", "can": ["read"] },
            { "target": "view", "view": "assessment_form", "can": ["read"] },
            { "target": "view", "view": "assessment_detail", "can": ["read"] },
            { "target": "view", "view": "notice_list", "can": ["read"] },
            { "target": "view", "view": "notice_form", "can": ["read"] },
            { "target": "view", "view": "notice_detail", "can": ["read"] },
            { "target": "action", "view": "member_list", "action": "open_member", "can": ["read"] },
            { "target": "action", "view": "org_list", "action": "open_org", "can": ["read"] },
            { "target": "action", "view": "org_grant_list", "action": "open_org_grant", "can": ["read"] },
            { "target": "action", "view": "org_detail", "action": "add_assessment", "can": ["read"] },
            { "target": "action", "view": "org_detail", "action": "add_notice", "can": ["read"] },
            { "target": "action", "view": "assessment_list", "action": "open_assessment", "can": ["read"] },
            { "target": "action", "view": "notice_list", "action": "open_notice", "can": ["read"] } ] },
        { "id": "expert", "name": "専門家", "signup": "invite",
          "rules": [
            { "target": "table", "table": "members", "can": ["read", "write"] },
            { "target": "table", "table": "agencies", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "ag_grants", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "orgs", "can": ["read"] },
            { "target": "table", "table": "assessments", "can": ["read"] },
            { "target": "table", "table": "notices", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "notice_grants", "can": ["read"] },
            { "target": "view", "view": "member_list", "can": ["read"] },
            { "target": "view", "view": "member_detail", "can": ["read"] },
            { "target": "view", "view": "member_form", "can": ["read"] },
            { "target": "view", "view": "agency_list", "can": ["read"] },
            { "target": "view", "view": "agency_form", "can": ["read"] },
            { "target": "view", "view": "agency_detail", "can": ["read"] },
            { "target": "view", "view": "ag_grant_list", "can": ["read"] },
            { "target": "view", "view": "ag_grant_detail", "can": ["read"] },
            { "target": "view", "view": "ag_grant_form", "can": ["read"] },
            { "target": "view", "view": "org_list", "can": ["read"] },
            { "target": "view", "view": "org_detail", "can": ["read"] },
            { "target": "view", "view": "assessment_list", "can": ["read"] },
            { "target": "view", "view": "assessment_detail", "can": ["read"] },
            { "target": "view", "view": "notice_list", "can": ["read"] },
            { "target": "view", "view": "notice_form", "can": ["read"] },
            { "target": "view", "view": "notice_detail", "can": ["read"] },
            { "target": "action", "view": "member_list", "action": "open_member", "can": ["read"] },
            { "target": "action", "view": "agency_list", "action": "open_agency", "can": ["read"] },
            { "target": "action", "view": "ag_grant_list", "action": "open_ag_grant", "can": ["read"] },
            { "target": "action", "view": "org_list", "action": "open_org", "can": ["read"] },
            { "target": "action", "view": "org_detail", "action": "add_notice", "can": ["read"] },
            { "target": "action", "view": "assessment_list", "action": "open_assessment", "can": ["read"] },
            { "target": "action", "view": "notice_list", "action": "open_notice", "can": ["read"] } ] },
        { "id": "editor", "name": "編集者" },
        { "id": "viewer", "name": "閲覧者" } ] } ] }
```

- **組織の人と専門家に、名簿の表への書込(`write`)の規則を入れてある** —— 本人が自分の名簿の行の `name`(表示する名前)を直すのに要る。
  規則があっても、直せるのは自分の行の `name` だけで、ほかの列・他人の行・名簿の行の作成と削除は断られる。
- **組織の人に組織の付与の表への書込の規則を入れてある** —— 招待を出す人の役割に付与の表への書込の規則が無いと、招待が承諾できない(§7c の4)。
  専門家には評価機関の付与の表への書込を入れてある(評価機関のオーナーが専門家を招くため)。
- 専門家には組織の表の読取の規則だけを書いた。 組織の行が見えるのは、評価機関を相手にした付与が届いた組織だけである(行ごとに絞られる)。
- 運営者には全部の画面とボタンの規則を入れた。 ただし組織の表の `creatable_by_roles` に `owner` を書いていないので、運営者は組織を作れない(「組織を作る」の画面は開けても、保存で断られる)。
- `set_roles` は全置換である。 書き直すときは全役割の全規則を送り直す。

### 5-6. 消せる人・名前を変えられる人・告知を直せる人を絞る(2026-10-02 訂正。5-1〜5-5 を消していない)

**5-5 までをそのまま当てると、次の3つが起きる**(当てて、人ごとに書き換え・削除を試して確かめた):

- 組織のメンバーが、自分の組織の行を消せる(名前も直せる)。
- 評価機関に所属する専門家(`ag_staff`)が、評価機関の名前を書き換えられ、評価機関の行を消せる。
- 組織のメンバーが、オーナーや専門家の書いた告知を書き換え・消せる。 結んだ評価機関の専門家も、他の人の告知を書き換え・消せる。

**原因は、5-5 の役割の規則に、行ごとに権限を配っている表への条件の無い書込・削除を書いたことである。**
条件の無い書込・削除の規則がある間、その表に配った行ごとの権限は、その役割の人については効かない(読取だけは今日も行ごとに絞られる)。
適用のときのお知らせ(`grants_bypassed`)が、その表と役割を名指ししている。

**直し方は、その規則から書込・削除を外して、行ごとの権限に任せることである。** 5-5 の後に、次の差分を `dry_run_diff` で下見してから `apply_diff` で当てる
(`set_roles` は全置換なので、全役割の全規則を送り直している)。 最初から組むときも、5-5 の後にこの差分を当てる。

```json
{ "diff_id": "scs-6-fix-delete-rename-notices",
  "intent": "組織の行を消せる人・評価機関の名前を変えられる人・告知を直せる人を、行ごとの権限どおりに絞る",
  "operations": [
    { "op": "change_table", "table": "agencies", "changes": {
      "access_control": {
        "enabled": true,
        "permissions": [
          { "id": "ag_admin", "name": "管理", "read": true, "write": true, "delete": false },
          { "id": "ag_staff", "name": "所属", "read": true, "write": false, "delete": false } ],
        "creator_permission": "ag_admin",
        "creatable_by_roles": ["owner"],
        "grant": { "table": "ag_grants", "target": "agency", "member": "member", "permission": "permission" },
        "members": { "table": "members", "account": "account", "auto_enroll": { "roles": ["owner", "org_user", "expert"], "name": "name" } },
        "invitations": { "grantable": ["ag_admin", "ag_staff"], "target_roles": ["expert"] } } } },
    { "op": "change_table", "table": "orgs", "changes": {
      "access_control": {
        "enabled": true,
        "permissions": [
          { "id": "org_admin", "name": "オーナー", "read": true, "write": true, "delete": true },
          { "id": "org_member", "name": "メンバー", "read": true, "write": false, "delete": false, "create_child": ["assessments", "notices"] },
          { "id": "assessor", "name": "評価機関", "read": true, "write": false, "delete": false, "create_child": ["notices"] } ],
        "creator_permission": "org_admin",
        "creatable_by_roles": ["org_user"],
        "grant": { "table": "org_grants", "target": "org", "member": "member", "permission": "permission", "principal_row": { "column": "agency", "table": "agencies", "via": ["ag_admin", "ag_staff"] } },
        "members": { "table": "members", "account": "account" },
        "invitations": { "grantable": ["org_member", "assessor"], "target_roles": ["org_user"] } } } },
    { "op": "set_roles",
      "roles": [
        { "id": "owner", "name": "運営者",
          "rules": [
            { "target": "app", "can": ["write"] },
            { "target": "role", "can": ["write"] },
            { "target": "table", "table": "members", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "agencies", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "ag_grants", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "orgs", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "org_grants", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "assessments", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "assessment_grants", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "notices", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "notice_grants", "can": ["read", "write", "delete"] },
            { "target": "view", "view": "member_list", "can": ["read"] },
            { "target": "view", "view": "member_detail", "can": ["read"] },
            { "target": "view", "view": "member_form", "can": ["read"] },
            { "target": "view", "view": "agency_list", "can": ["read"] },
            { "target": "view", "view": "agency_form", "can": ["read"] },
            { "target": "view", "view": "agency_detail", "can": ["read"] },
            { "target": "view", "view": "ag_grant_list", "can": ["read"] },
            { "target": "view", "view": "ag_grant_detail", "can": ["read"] },
            { "target": "view", "view": "ag_grant_form", "can": ["read"] },
            { "target": "view", "view": "org_list", "can": ["read"] },
            { "target": "view", "view": "org_form", "can": ["read"] },
            { "target": "view", "view": "org_detail", "can": ["read"] },
            { "target": "view", "view": "org_grant_list", "can": ["read"] },
            { "target": "view", "view": "org_grant_detail", "can": ["read"] },
            { "target": "view", "view": "org_grant_form", "can": ["read"] },
            { "target": "view", "view": "assessment_list", "can": ["read"] },
            { "target": "view", "view": "assessment_form", "can": ["read"] },
            { "target": "view", "view": "assessment_detail", "can": ["read"] },
            { "target": "view", "view": "notice_list", "can": ["read"] },
            { "target": "view", "view": "notice_form", "can": ["read"] },
            { "target": "view", "view": "notice_detail", "can": ["read"] },
            { "target": "action", "view": "member_list", "action": "open_member", "can": ["read"] },
            { "target": "action", "view": "agency_list", "action": "open_agency", "can": ["read"] },
            { "target": "action", "view": "ag_grant_list", "action": "open_ag_grant", "can": ["read"] },
            { "target": "action", "view": "org_list", "action": "open_org", "can": ["read"] },
            { "target": "action", "view": "org_grant_list", "action": "open_org_grant", "can": ["read"] },
            { "target": "action", "view": "org_detail", "action": "add_assessment", "can": ["read"] },
            { "target": "action", "view": "org_detail", "action": "add_notice", "can": ["read"] },
            { "target": "action", "view": "assessment_list", "action": "open_assessment", "can": ["read"] },
            { "target": "action", "view": "notice_list", "action": "open_notice", "can": ["read"] } ] },
        { "id": "org_user", "name": "組織の人", "signup": "open",
          "rules": [
            { "target": "table", "table": "members", "can": ["read", "write"] },
            { "target": "table", "table": "orgs", "can": ["read"] },
            { "target": "table", "table": "org_grants", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "assessments", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "assessment_grants", "can": ["read"] },
            { "target": "table", "table": "notices", "can": ["read"] },
            { "target": "table", "table": "notice_grants", "can": ["read"] },
            { "target": "view", "view": "member_list", "can": ["read"] },
            { "target": "view", "view": "member_detail", "can": ["read"] },
            { "target": "view", "view": "member_form", "can": ["read"] },
            { "target": "view", "view": "org_list", "can": ["read"] },
            { "target": "view", "view": "org_form", "can": ["read"] },
            { "target": "view", "view": "org_detail", "can": ["read"] },
            { "target": "view", "view": "org_grant_list", "can": ["read"] },
            { "target": "view", "view": "org_grant_detail", "can": ["read"] },
            { "target": "view", "view": "org_grant_form", "can": ["read"] },
            { "target": "view", "view": "assessment_list", "can": ["read"] },
            { "target": "view", "view": "assessment_form", "can": ["read"] },
            { "target": "view", "view": "assessment_detail", "can": ["read"] },
            { "target": "view", "view": "notice_list", "can": ["read"] },
            { "target": "view", "view": "notice_form", "can": ["read"] },
            { "target": "view", "view": "notice_detail", "can": ["read"] },
            { "target": "action", "view": "member_list", "action": "open_member", "can": ["read"] },
            { "target": "action", "view": "org_list", "action": "open_org", "can": ["read"] },
            { "target": "action", "view": "org_grant_list", "action": "open_org_grant", "can": ["read"] },
            { "target": "action", "view": "org_detail", "action": "add_assessment", "can": ["read"] },
            { "target": "action", "view": "org_detail", "action": "add_notice", "can": ["read"] },
            { "target": "action", "view": "assessment_list", "action": "open_assessment", "can": ["read"] },
            { "target": "action", "view": "notice_list", "action": "open_notice", "can": ["read"] } ] },
        { "id": "expert", "name": "専門家", "signup": "invite",
          "rules": [
            { "target": "table", "table": "members", "can": ["read", "write"] },
            { "target": "table", "table": "agencies", "can": ["read"] },
            { "target": "table", "table": "ag_grants", "can": ["read", "write", "delete"] },
            { "target": "table", "table": "orgs", "can": ["read"] },
            { "target": "table", "table": "assessments", "can": ["read"] },
            { "target": "table", "table": "notices", "can": ["read"] },
            { "target": "table", "table": "notice_grants", "can": ["read"] },
            { "target": "view", "view": "member_list", "can": ["read"] },
            { "target": "view", "view": "member_detail", "can": ["read"] },
            { "target": "view", "view": "member_form", "can": ["read"] },
            { "target": "view", "view": "agency_list", "can": ["read"] },
            { "target": "view", "view": "agency_form", "can": ["read"] },
            { "target": "view", "view": "agency_detail", "can": ["read"] },
            { "target": "view", "view": "ag_grant_list", "can": ["read"] },
            { "target": "view", "view": "ag_grant_detail", "can": ["read"] },
            { "target": "view", "view": "ag_grant_form", "can": ["read"] },
            { "target": "view", "view": "org_list", "can": ["read"] },
            { "target": "view", "view": "org_detail", "can": ["read"] },
            { "target": "view", "view": "assessment_list", "can": ["read"] },
            { "target": "view", "view": "assessment_detail", "can": ["read"] },
            { "target": "view", "view": "notice_list", "can": ["read"] },
            { "target": "view", "view": "notice_form", "can": ["read"] },
            { "target": "view", "view": "notice_detail", "can": ["read"] },
            { "target": "action", "view": "member_list", "action": "open_member", "can": ["read"] },
            { "target": "action", "view": "agency_list", "action": "open_agency", "can": ["read"] },
            { "target": "action", "view": "ag_grant_list", "action": "open_ag_grant", "can": ["read"] },
            { "target": "action", "view": "org_list", "action": "open_org", "can": ["read"] },
            { "target": "action", "view": "org_detail", "action": "add_notice", "can": ["read"] },
            { "target": "action", "view": "assessment_list", "action": "open_assessment", "can": ["read"] },
            { "target": "action", "view": "notice_list", "action": "open_notice", "can": ["read"] } ] },
        { "id": "editor", "name": "編集者" },
        { "id": "viewer", "name": "閲覧者" } ] } ] }
```

5-5 から変えたのは次のところだけである(ほかの規則と画面は 5-5 と同じ):

- 評価機関の権限 `ag_admin`(管理)の「消す」を外した。
- 組織の権限 `org_member`(メンバー)の「書く」を外し、評価と告知を作れる権限(`create_child` に `assessments` と `notices`)を足した。
  **「書く」を残すと、メンバーは組織の行への書込の権限を子の表(告知)へ引き継ぐので、役割の規則を直しても、他の人の告知を書き換えられる**(その形も当てて確かめた)。
  評価と告知を作るには `create_child` が要る(組織の表への役割の書込の規則は、子の行を作れるかの判定に数えない)。
- 組織の人の規則: 組織の表を「読む」だけにした(評価機関と同じく、名前などを直すのは行ごとの権限を持つオーナーに任せる)。 告知の表を「読む」だけにした。
- 専門家の規則: 評価機関の表を「読む」だけにした。 告知の表を「読む」だけにした。

当てた後に起きること(当てて確かめた):

- **組織の名前などを直せるのは、組織のオーナーと運営者だけ。 組織の行を消せるのも、組織のオーナーと運営者だけ。** メンバーと評価機関の専門家は「この行を書き換える権限がありません」「この行を消す権限がありません」で断られる。 組織の人は今日どおり組織を作れる(作った人がオーナーになる)。 評価や告知がぶら下がっている組織を消すときは、今日どおり件数の確かめが入る。
- **評価機関の名前などを直せるのは、評価機関のオーナーと運営者。 評価機関の行を消せるのは運営者だけ。** 所属の専門家の書き換えと削除、オーナーの削除は断られる。
  オーナーは今日どおり、所属の専門家を招待でき、評価機関のコードを発行できる。
- **告知を書き換え・消せるのは、書いた人と、その組織のオーナーと、運営者だけ。** メンバーや専門家が他の人の告知を直す・消すと断られる。 書いた人は、オーナーが直した後も自分の告知を直せる。
- 変わらないこと: メンバーも、結んだ評価機関の専門家も、今日どおり告知を作れる。 メンバーは今日どおり評価を作り、直せる。
  1人1組織・招待の2段(運営者が評価機関のオーナーを招き、オーナーが所属の専門家を招く)・作った人への付与・最後の管理者を外せないこと・コードでの評価機関の結び付けは、当てた後も今日どおり動く。
- メンバーに告知を作らせたくないときは、`org_member` の `create_child` から `notices` を外す(当てて確かめた。メンバーの告知の作成は断られ、評価は今日どおり作れる)。
  外した後も、組織の人の役割には組織の詳細の「告知を出す」ボタンの規則が残るので、メンバーにもボタンは出て、保存で断られる。
- 当てた後も、組織の人の評価の表への規則と、読むだけの規則について、適用のときのお知らせ(`grants_bypassed`)は出る。 読取は行ごとに絞られるので、読むだけの規則のお知らせは、そのままでよい。

## 6. 名簿の自動登録

- 名簿の自動登録(`auto_enroll`)は評価機関の宣言の `members` に書いた。 組織と子の表の `members` には書いていない(同じ名簿を指す宣言の片方だけが書くのは通る。中身が食い違うと断られる)。
- 宣言を足した差分を当てた時点で、既に役割を持つ人(アプリを作った運営者を含む)も名簿に入る。 その後に登録した人・役割を配られた人は、その場で入る。
- 自動で入る名簿に、`account` と `name` の外で必須の列を足さないこと(足すと登録が断られる)。

## 7. 1人1組織と、断りの文言

- **置き場は、組織の付与の表の相手の列(`org_grants` の `member`)である。** ここに `unique: true` と `unique_message` を書くと、次の2つが同じ文言で断られる:
  - 既に組織に入っている人が、別の組織を作ろうとしたとき(作った人への付与が一意に当たり、組織の行も残らない)。
  - 既に組織に入っている人が、別の組織への招待を承諾しようとしたとき(招待は残る)。
- 相手の列が空の付与の行(評価機関を相手にした付与)は、何本あっても一意に当たらない。 1つの組織に評価機関をいくつ結んでもよく、1つの評価機関が複数の組織と結ばれてもよい。
- **代償**: 1人が持てる組織の付与の行は1本だけになる。 オーナーの権限を変えたいときは、行を足さず、付与の行の権限の欄を書き換える。
- 文言はアプリの作者の責任で書く。 文言に他人の行の値を入れない。

## 8. 変更履歴

- 評価の表に `history: true`(5-3)、評価の詳細画面に `history: true`(5-4)を書いた。 作成・更新・削除が行ごとに残り、行を読める、ログインした人に詳細画面で見える。
- 外すときは逆の順にする(先に詳細画面の `history` を外し、次に表の `history` を外す)。 履歴を取っている表では、表と項目の ID を変える差分は断られる。
- (2026-10-02 訂正。直前の行を消していない)同じ `change_table` の `changes` に `history: false` と新しい `id` を一緒に書けば、表の ID は変えられる(それより前の履歴は読めなくなる)。
- 組織の表に `history: true` を足すと、組織の行への招待の発行・承諾・辞退・取消もその行の履歴に残る。

## 9. 人に画面で確かめてもらう手順

**あなた(AI の口)には、招待を出す・承諾する・コードを発行する道具が無い。** 差分を当てた後、次の順で人に画面で踏んでもらう。 各段の「確かめること」まで見てもらってから次へ進む。

**(2026-10-02 訂正。下の1の括弧書きを消していない)** 1の前に、運営者が専門家を登録させておく(運営者の招待で登録する。登録した直後に名簿に入る)。 出したときに居なかったログイン名への行の招待は、後から同じ名前で登録しても届かず、出したときの応答も同じなので気づけない。

1. **運営者**が「評価機関を登録」で評価機関Xを作る。 評価機関Xの詳細画面の「招待する」で、評価機関Xのオーナーになる専門家のログイン名と「管理」を選んで招待する。
   (専門家は運営者の招待で登録しておく。登録した直後に名簿に入る。)
2. **評価機関Xのオーナー**がメニューの「届いた招待」で承諾する。 確かめること: 評価機関の一覧に評価機関Xが出る。
3. **評価機関Xのオーナー**が評価機関Xの詳細画面で、所属する専門家のログイン名と「所属」で招待し、その専門家が承諾する。
4. **組織の人**が登録画面から登録し、「組織を作る」で組織Aを作る(作った人が組織Aのオーナーになる)。 確かめること: もう1つ組織を作ろうとすると「既に別の組織に所属しています」で断られる。
5. **組織Aのオーナー**が組織Aの詳細画面の「招待する」で、メンバーのログイン名と「メンバー」で招待し、メンバーが承諾する。
6. **評価機関Xのオーナー**が評価機関Xの詳細画面の「この行の招待用コード」でコードを発行し、組織Aのオーナーへ渡す。
7. **組織Aのオーナー**が組織Aの詳細画面の「招待する」で「相手の行のコードで招待する」を選び、コードと「評価機関」で招待する。 **評価機関Xのオーナー**が「届いた招待」で承諾する。
8. 確かめること: 評価機関Xの専門家が組織Aと、その評価を読める。 組織Aの詳細画面の「告知を出す」で告知を書ける。 組織Aの行と評価の行は直せない。
   評価機関Xに関係の無い専門家(別の評価機関の人)には、組織Aが見えない。
9. 確かめること: 組織Aのメンバーが評価を入力して状況を変えると、評価の詳細画面の変更履歴に、誰がいつ何から何に変えたかが出る。
10. 確かめること: 組織の人・専門家が名簿の自分の行を開き、名前を直せる(他人の行は直せない)。
11. **(2026-10-02 追記。上の10段を消していない)** 確かめること(5-6 を当てた後): 組織Aのメンバーが組織Aを消そうとすると断られる。 評価機関Xの所属の専門家が評価機関Xの名前を変えようとすると断られる(オーナーは変えられる。 消せるのは運営者だけ)。 組織Aのメンバーがオーナーの書いた告知を直そうとすると断られる(自分の告知は直せる)。

## 10. 契約を終えるとき・コードを使えなくしたいとき

- **契約を終えるときは、付与した側が付与の行を消す** —— 組織のオーナー(か運営者)が、組織の付与の一覧(または組織の詳細画面の「メンバーと評価機関」)で、その評価機関の行を開いて消す。
  評価機関の側からは関係を切れない。
- **コードを無効にしたいときは、評価機関のオーナーがコードを作り直す**(「この行の招待用コード」の「再発行」)。 作り直すと前のコードでは招待できない(前のコードで既にできた関係は消えない。消すのは上の手順)。
  宣言を外して付け直したときと、undo で作り直しの前まで戻したときも前のコードがまた使えるので、作り直す。
- 評価機関から専門家を外すと(評価機関の付与の行を消すと)、その専門家は次の要求から組織を読めない。 組織の側の操作は要らない。

## 11. 告知の作り方の注意

- **告知は、画面か HTTP(子の表に行を作れる権限での作成)で作る。** 自動処理(ワークフロー)や関数(コードの島)で作った告知には、作った人への付与(書いた人)が付かないので、
  書いた本人がその告知を直せない。
- この権限では、告知を別の組織へ付け替えられない(移した先の組織に書ける権限が要る)。
- 組織の行に書き換え禁止の上限(`restrictive`)を掛けると、評価機関の人もその組織に告知を作れなくなる。

## 12. 適用後に必ず見る点

- 説明書の §7 の5点(規則を書いていない表・画面・ボタン、`st_owner` との併用、未記入の `boolean`、立場の自己申告、島の `act_as`)。
- 名簿に自分の行が入っているか(運営者・組織の人・専門家)。 入っていないと、行を作るときに断られる。
- 評価機関の人に届くのは、行の中身の読み書きだけである。 評価機関の人は組織の招待を出せず、組織の付与の一覧も名簿も見えない。
- **(2026-10-02 訂正。直前の行を消していない)** 直前の行の「名簿も見えない」は誤り。 評価機関の人にも名簿の画面と規則を配ってあり(5-5)、名簿の自分の行と、評価機関の付与で関わる人の行は見える(§9 の10)。 見えないのは、組織の付与の一覧と、組織の招待の口である。
- **規模の目安は組織およそ100件まで**(一覧を開くたびに、評価機関の人を1行ずつ確かめる)。
- **(2026-10-02 追記。上の行を消していない)** 適用のときのお知らせに `grants_bypassed` が出たら、名指しされた表のその役割の人には、行ごとの権限が書込・削除で効いていない。 5-5 で止めた骨格では、組織のメンバーが組織を消せる・所属の専門家が評価機関を改名できる・メンバーが他の人の告知を書き換えられる(5-6)。

## 13. 限界の入口

- 行への招待・行を相手にした付与・子の表に行を作れる権限・変更履歴の限界は、diff-shape の説明書の `reference/cannot-do.md` の
  「行への招待でできないこと」「行を相手にした付与でできないこと」「子の表に行を作れる権限でできないこと」「行の変更履歴でできないこと」にある(入口ごとの効き方の表もそこにある)。
- 差分の形は diff-shape の説明書の §3a〜§3d、画面の見え方は view-shape の説明書の 5e〜5h にある。

## 14. 行を消したとき・権限と相手の名前・断りの文(2026-10-04 に足した節。1〜13 を消していない)

- **行を消すと、その行を指す付与の行と招待が一緒に消える。** 組織・評価機関・告知・名簿の行を消すと、その行を守る行・相手の行・名簿の行・グループの行として持つ付与の行と、その行への未承諾の招待・その行を相手にしたコードの招待・その行の招待用コードが、同じ削除の中で消える(消す前の確認の件数には出ない)。 組織を消したオーナーはすぐ新しい組織を作れ、元のメンバーは別の組織の招待を承諾できる(§7 の1人1組織は、消えた組織の行には当たらない)。 評価機関の付与が別の組織のただ1人の管理を担っていても、評価機関の削除は断られない(その組織は運営者の一覧に管理者のいない行として並ぶ)。
- **この版より前に消した行の残り**: 前に消した組織・評価機関を指して残っている付与の行は、自動では消えない。 運営者が組織の付与の一覧(または評価機関の付与の一覧)から開いて消す(運営者でも、作成と書き換えは断られる)。 対象の消えた招待を消す口は無い(承諾しても見つからず、期限で消える)。
- **権限は宣言の名前で出る。** 付与の一覧・付与の詳細・権限を変える画面の選択肢・組織の詳細の「メンバーと評価機関」・変更履歴の「権限:」と項目の変更は「オーナー」「メンバー」「所属」など `permissions` の `name` で出る。 保存の値と、HTTP と AI の口の値は id のまま。 一覧の CSV の書き出し・束ねの見出し・絞り込みと並べ替えの欄・集計表・入力の検証の文・要件ドキュメントは id のまま。
- **結んだ評価機関は名前で出る。** 組織の詳細の「メンバーと評価機関」と、組織の変更履歴の招待・承諾の件は、組織のオーナーとメンバーと運営者に評価機関の名前で出る。 評価機関の専門家には、自分の評価機関の名前だけが出て、ほかの評価機関は今日どおり鍵(`row:<表>:<id>`)で出る。 結んだ評価機関が消えた後は「(表示できません)」。 AI の口の履歴は鍵のまま。
- **(2026-10-04 訂正。直前の行を消していない)** 直前の行のうち、組織の詳細の「メンバーと評価機関」(子の一覧)で評価機関の名前が出るのは、その付与の行を読める人だけである(付与の行を読める人には、評価機関の行を読めなくても名前が出る)。 評価機関の行そのものを読めることが名前に効くのは、組織の変更履歴の招待・承諾の件だけである。
- **断りの文**: 付与の行を付ける・変える・外す断りは「この行に権限を付けられるのは、この行で「オーナー」の権限を持つ人と運営者だけです。」の形(「オーナー」には管理の権限の名前が入る。変える・外すは動詞だけ替わる)。 名簿の断りは、名前の欄を自動登録で書いたこの骨格では「参加者の表で書き換えられるのは、自分の行の名前だけです。ほかの欄と、ほかの人の行は、アプリの運営者だけが書き換えられます。」。 入力画面で保存が断られたとき、作れる立場・1人1組織などの理由はその文で出て、役割と行ごとの権限で断られたとき・内部の綴りの混じる文は「権限がありません(閲覧のみ)。」のまま。 受け取り画面の1人1組織の断りは、項目の綴りを前に付けずに出る。
- **今日のまま残る断り**: 付与の行の人を入れ替えると、入れ替え禁止の文ではなく1人1組織の文が出る。 専門家が自分を評価機関のオーナーにする付与の行を直接作ると、§7 の文言ではなく製品の付与の断りが先に出る。 どちらも断られることは正しい。
- **権限の名前に鉤括弧(「」)を使わない。** 使うと、入力画面の付与の断りが理由の文でなく「権限がありません(閲覧のみ)。」で出る。
- **書き出したアプリ(独立して動かす版)**: 付与の行の後始末・運営者の削除・権限の名前・付与の断りの文は写る。 結んだ評価機関の名前は写らず、子の一覧では id で出る。 名簿の断りは前の文(「参加者の表は、アプリの運営者だけが書き換えられます。」)のまま。 入力画面で理由の文が出るのは、作れる立場を宣言した表の入力画面だけ。 招待・招待用コード・受け取り画面は無い。 訂正します(2026-10-07)。子の行を持つ親の削除の確かめ(件数を見せて、「中身ごとまとめて消す」で子ごと消す)と、どの詳細画面にも出る削除の確かめも、今日から書き出したアプリに写っています(違いは子ごとの削除の説明に書きました)。
- 訂正します(2026-10-08)。書き出したアプリ(独立して動かす版)では、組み込む人が名乗りのファイル(`src/actor.ts`)の名乗りにログイン名(`actorLogin`)を差し込むと、変更履歴の「ログイン名」と自動処理の `$actor.login` に元のアプリと同じ値が入る(差し込まなければ今どおり空。ログイン名の欄を持たない旧い形の名乗りのファイルでも書込は通る)。 今まで空のログイン名を前提にした自動処理の条件があれば、差し込んだ後は動きが変わりうる。 履歴の「誰が変えたか」と「役割」は入口ごとに元のアプリと同じ値になる(画面と HTTP からの書込は名乗りの id と役割の並びの先頭、受信口と決まった時刻の処理は id が空で役割はその種別の名前、自動処理の連鎖は `act_as` を含めて起こした人の値)。 役割の並びの先頭がその人の元のアプリでの役割と違うと(運営者を2つ目に置いたときなど)、履歴の役割は元のアプリと割れる。 読めるが書けない行の更新と削除の断りは元のアプリと同じ操作ごとの文と手がかり(「この行を書き換える権限がありません(読むことはできます)。」「この行を消す権限がありません(読むことはできます)。」。表の ID と行の ID を含まない)になり、自動処理と関数の断りも同じ文になる(その行を読めない人の自動処理でも「(読むことはできます)」と出る。関数の出力先の作り直しの断りの前置きには表の ID が残る)。 画面の詳細の削除と操作のボタンの 403 は「権限がありません(閲覧のみ)。」と出る。 画面の見出しの2行目に表の ID は出ず、詳細に行の ID も出ない。
- 訂正します(2026-10-08)。上の「その行を読めない人の自動処理でも「(読むことはできます)」と出る」は今日は誤りで、書き出したアプリは、その人が読めない行の更新と削除の断りに「(読むことはできます)」を付けない文(「この行を書き換える権限がありません。」「この行を消す権限がありません。」)を返す(HTTP の 403 も自動処理と関数の断りも同じ。状態の番号と残る行は今日どおり)。 親の行から権限を引き継ぐ表では読み直さないので、読めない行にも「(読むことはできます)」が残る。 「403 は「権限がありません(閲覧のみ)。」と出る」のは詳細の削除と操作のボタンと入力画面で、手で起こすボタンの 403 は今日も「Error: 403: …」の生の文で出る。
- 訂正します(2026-10-08)。上の「手で起こすボタンの 403 は今日も「Error: 403: …」の生の文で出る」は今日は誤りで、書き出したアプリの詳細画面の手で起こすボタンが 403 で断られたときも「権限がありません(閲覧のみ)。」と出る(「Error: 403」の前置き、ボタンの id、断った理由の内部の語は出ない)。 403 以外の失敗(未ログイン・見えない行など)の文と、処理が動いたうえで途中のアクションが断られたときの文は今日どおり。
