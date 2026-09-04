import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { issueSession, resolveSession, revokeSession } from "./session.ts";
import { AuthStore } from "./store.ts";

describe("session", () => {
  let store: AuthStore;
  let userId: string;

  beforeEach(() => {
    store = AuthStore.open(":memory:");
    userId = store.createUser({ username: "alice" }).id;
  });

  afterEach(() => {
    store.close();
  });

  test("発行したセッションは resolve できる", () => {
    const session = issueSession(store, userId, 3600);
    expect(resolveSession(store, session.id)?.id).toBe(session.id);
    expect(resolveSession(store, session.id)?.userId).toBe(userId);
  });

  test("再発行すると別 ID になる(セッション固定対策)", () => {
    const first = issueSession(store, userId, 3600);
    const second = issueSession(store, userId, 3600);
    expect(second.id).not.toBe(first.id);
    // 両方とも有効(古いものは呼び出し側が明示的に失効させる)
    expect(resolveSession(store, first.id)).not.toBeNull();
    expect(resolveSession(store, second.id)).not.toBeNull();
  });

  test("期限切れセッションは null", () => {
    const session = issueSession(store, userId, -1);
    expect(resolveSession(store, session.id)).toBeNull();
  });

  test("存在しないセッションは null", () => {
    expect(resolveSession(store, "does-not-exist")).toBeNull();
  });

  test("失効後は null", () => {
    const session = issueSession(store, userId, 3600);
    revokeSession(store, session.id);
    expect(resolveSession(store, session.id)).toBeNull();
  });

  test("失効は冪等(存在しない ID でも throw しない)", () => {
    expect(() => revokeSession(store, "nope")).not.toThrow();
  });
});
