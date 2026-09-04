---
id: broken-reference
title: 参照切れエラー(マニフェスト空間の path)からの自己修正
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__get_changelog, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, ToolSearch
disallowed_tools: mcp__smailtalk__get_manifest, mcp__smailtalk__list_records, Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: mcp__smailtalk__get_manifest, mcp__smailtalk__list_records, Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

CP-5 で**4回試して1度も到達できなかった**経路を、ツール構成の側から強制する。

参照切れのエラーは、`path` が「送った差分」ではなく「畳み込んだ結果のマニフェスト」を根とする
(CP-4 §既知の限界9)。AI が「直せと言われた場所が自分の送った差分に無い」状態で詰まるリスクが
指摘されているが、CP-5 では毎回 AI が `get_manifest` で事前に現状を確認し、
**参照切れの差分がそもそも送られる前に潰されていた**(docs/evidence/cp-5.md 確認方法4 末尾)。

そこでこのシナリオだけ **`get_manifest` を allowedTools から外し、disallowedTools に入れる**。
judge は `system/init` の実効ツール一覧に `get_manifest` が現れないことを検証する
(= 「設定したつもり」ではなく「効いた」ことの確認)。

**CP-6 の実測により、`list_records` も外してある。** 最初の試行(`005-broken-reference`)では
`list_records` を許可したままにしたが、AI は存在しないテーブル名を3回叩き、
エラーの `allowed_values: ["books"]` から不在を知って `apply_diff` を送らずに止まった。
`get_manifest` を外しても、`list_records` のエラーが同等の情報を返してしまう。
試行1の設定は `005-broken-reference/meta.json` と `note.txt` に残してある。

**それでも残る逃げ道**: `list_apps` と `get_changelog` は許可したままである。
`get_changelog` は差分の履歴を返すので、AI がそこからテーブルの不在を推論する経路は塞いでいない。

## ターン1

> 読んだ本を記録するアプリを作って。タイトルと著者があればいい。一覧画面も付けて。

## ターン2

> 本に「本棚」への参照の項目を足して。本棚のテーブルはもう作ってあるので、参照を足すだけでいい。
> 一覧にも本棚の欄を出して。現状の確認はいらないので、そのまま適用して。
