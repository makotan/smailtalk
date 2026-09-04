---
id: t04-design-request
title: ネットショップの見た目を会話だけで指定する(V3-M7-T04。逃げ道に当たる要求を1件混ぜる)
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__list_apps, mcp__smailtalk__preview_undo, mcp__smailtalk__request_custom_css, mcp__smailtalk__undo, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact, ExitPlanMode, ListMcpResourcesTool, ReadMcpResourceTool
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**V3-M7-T04 のシナリオである。** 記録は `docs/plan/v3/records/v3-m7-t04.md`。

`docs/plan/v3/01-design-baseline.md` §1 のユーザ前提「**素早く反映できるか**」を、
**実際の AI が MCP 経由で見た目を指定する往復数**として実測する(ユーザ決定 `D-M7-1` (c))。

対象は参照アプリ `ref-ec`(画面上の名前は「ネットショップ」)である。**このシナリオは
アプリを新しく作らない** —— 既に在るアプリの**見た目だけ**を指定する。
テーブル・ビュー・ワークフロー・関数の追加や変更は頼まない。

**3つのターンは、指定の層が違う。**

- **ターン1 = アプリ全体の見た目**(`docs/plan/v3/records/v3-m7-t01-requirements.json` の
  `M7-R13`(書体)/ `M7-R14`(地の色)/ `M7-R12`(行の高さ)に対応。
  **V3-M7-T02 が3件とも到達と判定した**)。
- **ターン2 = 画面ごとの調整**(同 `M7-R25`(欄ごとの幅)/ `M7-R54`(項目を2つずつ横に)。
  **V3-M7-T02 が2件とも到達と判定した**)。
- **ターン3 = 逃げ道に当たる要求**(同 `M7-R01`(見出しが2行に割れる)。
  **V3-M7-T02 が未到達と判定し、V3-M7-T03 が任意 CSS でのみ到達させた**)。
  **ここが `D-2`(逃げ道は owner 専用 = AI からは1往復増える)の帰結を測る点である** ——
  AI が申請の口を呼ぶのか、諦めるのか、別の手段を採るのかを観測する。

**プロンプトにはスキーマのキー名・カーネル語彙の名前・選択肢の語を1つも書かない。**
要求文は `v3-m7-t01-requirements.json` の `want` をそのまま使っている(同ファイルは
V3-M7-T01 の完了条件2 により、それらの語が0件であることを走査で確認済みである)。
完成形を渡せば AI は転記するだけになり、「会話だけで指定できた」という測定が壊れる。

**データルート**: 既定の `data-t04-design-request` では `ref-ec` が1つも無いので、
**`--data-root` で `ref-ec` の複製を明示すること**(V3-M7-T04 は `data-m7-t04-live` を使った)。
**`--out` も `docs/evidence/cp-v3/transcripts` を明示すること** —— 既定は
`docs/evidence/cp-6/transcripts` であり、明示しないと cp-6 の証跡に混ざる。

## ターン1

> ネットショップの画面を開いてみたけれど、見た目が素っ気なくて店らしさが無い。
> 書体が端末の既定のままなので、店の雰囲気に合った書体にしたい。
> 画面の地が真っ白なので、うっすら色を敷いた地にしたい。
> 表の行をもっと高くして、ゆったり読ませたい。
> この3つを、店のどの画面でも同じようにそろえてほしい。

## ターン2

> ありがとう。次は画面ごとに直したいところがある。
> 商品カタログの画面は、欄の幅が中身の量と関わりなく配られているので、欄ごとに幅を決めたい。
> 商品の詳細の画面は、短い項目が1行ずつ場所を取るので、2つずつ横に並べて縦を短くしたい。

## ターン3

> もうひとつある。どの画面でも一番上に出ている店の名前の見出しが、
> 2行に割れて読みにくい。1行のまま読ませたい。
> できるなら今すぐ直してほしいし、できないなら、なぜできないのかと、
> どうすれば直せるのかを教えて。

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
