---
id: agg-signup-monthly
title: 月ごとの入会者数(集計値)を現行カーネルで出せるか — F-7 の再観測(1)
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**M6 着手ゲートの条件②(v0 と独立した検証で F-7 を再観測する)の一環。**
F-7(v0 所見)= 「集計値(count/group by)を知りたいが宣言語彙で表現できず、逃げ道も無い」を、
**v0 とは別ドメイン(会員管理)・別日・新規セッションで**、しかも **v0 に無かった現行カーネルの
語彙(ワークフロー = M2 / ai_transform = M5)に対して**再観測する。

このシナリオが問うのは **F-7' の棒グラフ**(表示層送り)ではなく、**F-7 の集計値そのもの**
(「月ごとに何人か」という数)を、**保存され後から見られる形で**出せるか、である。

**逃げ道の敵対的検査**: ターン3 は「ワークフローや AI を使ってでも、その月ごとの人数を
テーブルに保存できないか」と押す。現行カーネルの update_record/create_record の値は
`$record.<field>` かリテラルだけで**四則演算を持たない**(限定12)ため、
「発火のたびに count を +1 する」カウンタは原理的に書けない —— これが実地で本当に起きるかを見る。

**判定(このシナリオ単体では機械化しない。transcript + 実カーネル状態で人手判定)**:
- **逃げ道なし(F-7 再確認)** = 集計値を保存・再現できるテーブルが最終状態に存在せず、AI が
  「宣言語彙では集計できない」旨を明言している。
- **逃げ道あり(F-7 反証)** = AI が正しい月ごとの人数を、後から list_records で読める形で
  実際に永続化できている(その場でチャットに数えて書くだけ = W-C は逃げ道に数えない)。

**JSON をプロンプトに貼らない。**自然な日本語で頼み、AI 側で語彙へ翻訳させる。

## ターン1

> 会員管理のアプリを作って。会員の名前と入会日を記録したい。試しにサンプルの会員も何人か、いろんな月にまたがるように入れておいて。

## ターン2

> 月ごとに何人が新しく入会したか、その人数を知りたい。棒グラフはいらない、月ごとの人数の数字だけでいい。

## ターン3

> ワークフローや AI の機能を使ってでも、その「月ごとの入会者数」をどこかのテーブルに保存して、新しい会員が増えたら自動で更新される形にできない?後からその数字だけ見たい。

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
