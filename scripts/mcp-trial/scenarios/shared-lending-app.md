---
id: shared-lending-app
title: 共有型のアプリを1本作り切る(備品の貸し出し)
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, mcp__smailtalk__write_records, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**複数人で共有するアプリを1本、会話だけで作り切らせる**(`O-G30`)。

**このシナリオは `Skill` を `allowed_tools` にも `disallowed_tools` にも書かない。**
既存34本はすべて `disallowed_tools` に `Skill` を持つが、本シナリオは**どちらにも書かない**。
腕の別(説明書を開けるか / 開けないか)は `run.ts` の `--skill allow|deny` が付ける。
**同じ1本のファイルから2腕を組み立てるため**であり、走行の間だけ front matter を書き換えて
あとで戻す形(`V6-M14` が採った手。`docs/plan/v6/records/v6-m14.md:243`-`:246`)を採らない。

**事前状態は `--seed-shared-app` が作る**:空のアプリが1つと、そのアプリに登録済みの利用者が1人。
**AI に `create_app` から始めさせていない。** 理由は製品の側にある —— `V8-M31` 以降、
アプリを名指しする21本の MCP ツールは「**名乗った利用者がそのアプリに登録されていること**」を
要求する(`src/mcp/actor-guard.ts:187`)。`create_app` は利用者を1人も作らないので、
**AI が自分で作ったアプリの中では、続く `apply_diff` が必ず「名乗った利用者は、このアプリに
登録されていません」で落ちる。** これは実測で確かめた(`docs/plan/v8/records/v8-m50-prep.md` §6)。

観測するのは指標4つ(同 §2)であり、**このシナリオ自身は合否を判定しない。**
`judge` が見るのは隔離条件が守られたかだけである。

## ターン1

> 社内で使う備品の貸し出しを管理する仕組みを作ってください。
> いま空のアプリが1つだけあるので、その中に作ってください。
> 借りる人は自分が出した申し込みだけが見えて、備品を管理する担当の人は
> 全部の申し込みを見られるようにしたいです。

## ターン2

> まだ返していないものだけを見られる一覧がほしいです。

## ターン3

> 担当の人が、返ってきたものを一覧から返却済みにできるようにしてください。

## ターン4

> 名簿に、担当の人を1人だけ先に入れておいてください。

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
