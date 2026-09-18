import { act, cleanup, renderHook } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom";
import { treeModel } from "@/features/page/tree/model/tree-model";
import type { SpaceTreeNode } from "@/features/page/tree/types";

const mocks = vi.hoisted(() => ({ getAll: vi.fn(), notify: vi.fn() }));
vi.mock("@/main", () => ({
  queryClient: new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
}));
vi.mock("@/features/page/services/page-service", () => ({
  getAllSidebarPages: mocks.getAll,
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notify },
}));
vi.mock("@/i18n", () => ({ default: { t: (text: string) => text } }));
import { queryClient } from "@/main";
import * as protection from "./use-page-protection-subscription";

const list = (...items: object[]) => ({
  pages: [{ items, meta: {} }],
  pageParams: [undefined],
});
const node = (
  id: string,
  isLocked: boolean,
  children: SpaceTreeNode[] = [],
): SpaceTreeNode => ({
  id,
  isLocked,
  children,
  name: id,
  slugId: id,
  spaceId: "space",
  parentPageId: null,
  position: id,
  hasChildren: children.length > 0,
});
let store: ReturnType<typeof createStore>;
beforeEach(() => {
  queryClient.clear();
  vi.clearAllMocks();
  store = createStore();
  store.set(treeDataAtom, [
    node("locked", true, [
      node("child", true, [node("leaf", true), node("override", true)]),
    ]),
    node("unlocked", false),
  ]);
  renderHook(() => protection.usePageProtectionSubscription(null), {
    wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
const locked = (id: string) =>
  treeModel.find(store.get(treeDataAtom), id)!.isLocked;
const move = () =>
  act(() => {
    store.set(
      treeDataAtom,
      treeModel.move(store.get(treeDataAtom), "child", {
        kind: "make-child",
        targetId: "unlocked",
      }).tree,
    );
  });

describe("page tree protection after moves", () => {
  it("does not replace resolved state with partial or stale manual cache updates", async () => {
    const key = ["sidebar-pages", { spaceId: "space", pageId: "unlocked" }];
    await act(async () => {
      await queryClient.fetchQuery({
        queryKey: key,
        queryFn: async () => list({ id: "child", isLocked: false }),
      });
    });
    expect(locked("child")).toBe(false);
    act(() => {
      queryClient.setQueryData(key, list({ id: "child" }));
    });
    expect(locked("child")).toBe(false);
    act(() => {
      queryClient.setQueryData(key, list({ id: "child", isLocked: true }));
    });
    expect(locked("child")).toBe(false);
  });

  it("fetches an uncached destination after moving and refreshes loaded descendants", async () => {
    let inheritedLocked = true;
    const descendants = vi.fn(async () =>
      list(
        { id: "leaf", isLocked: inheritedLocked },
        { id: "override", isLocked: true },
      ),
    );
    await queryClient.fetchQuery({
      queryKey: ["sidebar-pages", { spaceId: "space", pageId: "child" }],
      queryFn: descendants,
      staleTime: Infinity,
    });
    inheritedLocked = false;
    move();
    mocks.getAll.mockResolvedValue(list({ id: "child", isLocked: false }));
    await act(async () => {
      await protection.refreshPageProtectionAfterMove("space", "unlocked");
    });
    expect(mocks.getAll).toHaveBeenCalledWith({
      spaceId: "space",
      pageId: "unlocked",
    });
    expect(locked("child")).toBe(false);
    expect(locked("leaf")).toBe(false);
    expect(descendants).toHaveBeenCalledTimes(2);
    expect(locked("override")).toBe(true);
    expect(
      treeModel.find(store.get(treeDataAtom), "unlocked")!.children![0].id,
    ).toBe("child");
  });

  it("refreshes root destinations using the server default", async () => {
    mocks.getAll.mockResolvedValue(list({ id: "child", isLocked: false }));
    await act(async () => {
      await protection.refreshPageProtectionAfterMove("space", null);
    });
    expect(mocks.getAll).toHaveBeenCalledWith({ spaceId: "space" });
    expect(locked("child")).toBe(false);
  });

  it("discards an in-flight pre-move result instead of overwriting the fresh state", async () => {
    let finishOld!: (value: ReturnType<typeof list>) => void;
    const key = ["sidebar-pages", { spaceId: "space", pageId: "unlocked" }];
    const old = queryClient
      .fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise<ReturnType<typeof list>>((resolve) => {
            finishOld = resolve;
          }),
      })
      .catch(() => {});
    mocks.getAll.mockResolvedValue(list({ id: "child", isLocked: false }));
    move();
    await act(async () => {
      await protection.refreshPageProtectionAfterMove("space", "unlocked");
    });
    await act(async () => {
      finishOld(list({ id: "child", isLocked: true }));
      await old;
    });
    expect(locked("child")).toBe(false);
  });

  it("preserves fresh protection when the other browser applies the move structure later", async () => {
    mocks.getAll.mockResolvedValue({
      pages: [
        { items: [{ id: "other", isLocked: true }], meta: {} },
        { items: [{ id: "child", isLocked: false }], meta: {} },
      ],
      pageParams: [undefined, "next"],
    });
    await act(async () => {
      await protection.refreshPageProtectionAfterMove("space", "unlocked");
    });
    move();
    expect(locked("child")).toBe(false);
    expect(
      treeModel.find(store.get(treeDataAtom), "unlocked")!.children![0].id,
    ).toBe("child");
  });

  it("lets a newer move supersede a pending refresh without showing a failure", async () => {
    let finishOld!: (value: ReturnType<typeof list>) => void;
    mocks.getAll.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const first = protection.refreshPageProtectionAfterMove(
      "space",
      "unlocked",
    );
    await vi.waitFor(() => expect(mocks.getAll).toHaveBeenCalledOnce());
    mocks.getAll.mockResolvedValue(list({ id: "child", isLocked: true }));
    await act(async () => {
      await protection.refreshPageProtectionAfterMove("space", "locked");
    });
    await act(async () => {
      finishOld(list({ id: "child", isLocked: false }));
      await first;
    });
    expect(locked("child")).toBe(true);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("keeps the tree on refresh failure and reports it, then recovers on retry", async () => {
    move();
    const before = store.get(treeDataAtom);
    mocks.getAll.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await protection.refreshPageProtectionAfterMove("space", "unlocked");
    });
    expect(store.get(treeDataAtom)).toBe(before);
    expect(mocks.notify).toHaveBeenCalledOnce();
    mocks.getAll.mockResolvedValue(list({ id: "child", isLocked: false }));
    await act(async () => {
      await protection.invalidatePageProtection();
    });
    expect(locked("child")).toBe(false);
  });
});
