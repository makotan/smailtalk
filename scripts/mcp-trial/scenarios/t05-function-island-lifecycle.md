---
id: t05-function-island-lifecycle
title: 会話のみでコードの島(関数リソース)の追加→動作確認→undo が完遂するか(V1-M6-T05)
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**V1-M6-T05 の完了条件**「会話のみで関数(コードの島)の追加 → 動作確認 → undo が完遂する」を1本で通す。
ADR-0024 で足した語彙(`function` リソース + `run_function` アクション)が、**ソースを読めない条件下で、
ツール説明文だけを頼りに到達可能か**を実地で確かめる。審査単位は F-7(月ごとの集計値)そのもの。

**確かめること**: (1) AI が会話だけで、月ごとの集計を**島のコード(JS)**として書き、`run_function` を
`on_create` ワークフローで発火させ、出力を出力テーブル+ビューに出す形を組み立てられるか。
(2) 新しい会員を追加すると集計が**自動で計算し直される**か(動作確認)。(3) その追加を **undo** で戻せるか。

**JSON をプロンプトに貼らない。**自然な日本語で頼み、AI 側で語彙へ翻訳させる。「コードで」「関数」という
語だけは使う(ユーザがそう言うのは自然だからである)。

## ターン1

> 会員管理のアプリを作って。会員の名前と入会日を記録したい。試しにサンプルの会員も何人か、いろんな月にまたがるように入れておいて。

## ターン2

> 月ごとに何人が新しく入会したかを、アプリの中でいつでも見られるようにしたい。この「月ごとに数える」計算だけコードで書いて、結果を一覧の画面で見られるようにして。新しい会員が増えたら自動で数え直される形がいい。

## ターン3

> 動くか確認したい。今月の会員をもう1人、サンプルで追加して。そのあと、月ごとの集計がちゃんと更新されているか見せて。

## ターン4

> やっぱりこのコードの島は要らない。undo で、この集計を足す前の状態まで丸ごと戻して。さっき動作確認で追加した会員が1人消えても構わないので、undo を実行して。

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
