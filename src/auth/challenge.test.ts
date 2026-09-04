import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { consumeChallenge, createChallenge } from "./challenge.ts";
import { AuthStore } from "./store.ts";

describe("challenge", () => {
  let store: AuthStore;

  beforeEach(() => {
    store = AuthStore.open(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("生成したチャレンジは同じ purpose で1回だけ消費できる", () => {
    const { pendingId, challenge } = createChallenge(store, "registration", "alice", 300);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(consumeChallenge(store, pendingId, "registration")).toBe(challenge);
  });

  test("使い捨て: 2回目の消費は null", () => {
    const { pendingId } = createChallenge(store, "registration", "alice", 300);
    consumeChallenge(store, pendingId, "registration");
    expect(consumeChallenge(store, pendingId, "registration")).toBeNull();
  });

  test("purpose 不一致は null(そして消費済みなので再取得も null)", () => {
    const { pendingId } = createChallenge(store, "registration", "alice", 300);
    expect(consumeChallenge(store, pendingId, "authentication")).toBeNull();
    expect(consumeChallenge(store, pendingId, "registration")).toBeNull();
  });

  test("期限切れは null", () => {
    const { pendingId } = createChallenge(store, "authentication", null, -1);
    expect(consumeChallenge(store, pendingId, "authentication")).toBeNull();
  });

  test("存在しない pendingId は null", () => {
    expect(consumeChallenge(store, "nope", "registration")).toBeNull();
  });

  test("createChallenge は毎回異なる pendingId / challenge を返す", () => {
    const a = createChallenge(store, "registration", null, 300);
    const b = createChallenge(store, "registration", null, 300);
    expect(a.pendingId).not.toBe(b.pendingId);
    expect(a.challenge).not.toBe(b.challenge);
  });
});
