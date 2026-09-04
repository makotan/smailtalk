---
id: blind-session-prep
title: 別セッション用の下ごしらえ(アプリと既知の _id を作る)
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: mcp__smailtalk__undo, mcp__smailtalk__preview_undo, Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**このシナリオ単体では何も観測しない。** `blind-broken-reference` と `stale-record-id` の
**前提を作るためだけ**に存在する下ごしらえである。

**なぜ下ごしらえが要るのか(V1-M1-T07-a の真因分析)**: F-19(参照切れ)が v0 で4回・
CP-V1-0 で1回、**計7回以上誘発を試みて1度も到達しなかった**真因は、ツール権限の操作では
閉じられない構造にある —— **書き込み系ツールの成功レスポンス自身が畳み込み後の完全な
マニフェストを返す**(`create_app` は `manifest` を、`apply_diff` は適用後の状態を返す)。
したがって **AI が同一セッションでアプリを作った時点で、参照系ツールを全部剥がしても
AI はマニフェストを知っている。** `006-broken-reference` が `get_manifest` と
`list_records` を外してもなお AI が「本棚のテーブルは存在していません」と言い切れたのは
これが理由である(`docs/evidence/cp-v1-0.md` §2-2)。

**外すのは「同一セッションであること」の側である。** アプリを**別セッションで**作れば、
本番セッションの AI は書き込み系レスポンスを一度も見ていない状態で始まる。
これは `docs/evidence/cp-v1-0-judgment.md` §6-4 が示した案そのものである。

**このセッションの成果物**(本番セッションが使う):

1. **テーブルが1つだけのアプリ**(本の記録)。**参照先になりうるテーブルは1つも無い**
2. **実在したが削除済みの `_id` が1件**(`stale-record-id` が使う)

**本番セッションのシナリオファイルは、この試行の transcript を読んでから書くこと。**
アプリID・テーブルID・削除済み `_id` を**推測で書いてはならない** —— 推測した値が外れると、
本番セッションのエラーは狙った経路(参照切れ / レコード不在)ではなく
「アプリが無い」「テーブルが無い」になり、**別の経路を観測して到達したと誤記することになる。**

**データルートは本番セッションと共有する**(`--data-root` を明示すること)。
既定はシナリオIDごとに分かれるので、明示しないと本番セッションは空のデータルートで動く。

## ターン1

> 読んだ本を記録するアプリを作って。タイトル・著者・感想メモがあればいい。一覧画面も付けて。

## ターン2

> 日本語のサンプルを5冊入れておいて。宮沢賢治とか夏目漱石とか、有名なやつでいい。

## ターン3

> 入れてもらった本を、それぞれの _id も添えて一覧で見せて。

## ターン4

> 夏目漱石の本を1冊だけ消しておいて。

## ターン5

> それでいい。進めて。消した行の _id は、あとで使うから最後にもう一度書いておいて。
