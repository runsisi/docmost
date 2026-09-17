import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { InfiniteData } from "@tanstack/react-query";
import { IPagination } from "@/lib/types";
import { IPage } from "@/features/page/types/page.types";
import { treeDataAtom } from "@/features/page/tree/atoms/tree-data-atom";
import { SpaceTreeNode } from "@/features/page/tree/types";
import { Socket } from "socket.io-client";
import { queryClient } from "@/main";

export const invalidatePageProtection = () =>
  Promise.all(
    ["pages", "space", "spaces", "sidebar-pages", "root-sidebar-pages"].map(
      (key) =>
        queryClient.invalidateQueries({
          queryKey: [key],
          // Lazy-loaded children have no query observer, but remain in the tree.
          refetchType: key === "sidebar-pages" ? "all" : "active",
        }),
    ),
  );

function updateTreeProtection(
  nodes: SpaceTreeNode[],
  states: Map<string, boolean>,
): SpaceTreeNode[] {
  let changed = false;
  const updated = nodes.map((node) => {
    const children = updateTreeProtection(node.children, states);
    const isLocked = states.has(node.id) ? states.get(node.id)! : node.isLocked;
    if (children === node.children && isLocked === node.isLocked) return node;
    changed = true;
    return { ...node, isLocked, children };
  });
  return changed ? updated : nodes;
}

export function usePageProtectionSubscription(socket: Socket | null) {
  const setTreeData = useSetAtom(treeDataAtom);
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "success") return;
        const key = event.query.queryKey[0];
        if (key !== "sidebar-pages" && key !== "root-sidebar-pages") return;
        const data = event.query.state.data as InfiniteData<IPagination<IPage>>;
        const states = new Map(
          data.pages.flatMap((batch) =>
            batch.items.map((page) => [page.id, page.isLocked] as const),
          ),
        );
        // The tree owns its structure separately from React Query. Patch only protection.
        setTreeData((tree) => updateTreeProtection(tree, states));
      }),
    [setTreeData],
  );
  useEffect(() => {
    const onMessage = (event: { operation: string }) => {
      if (event.operation === "pageProtectionInvalidated")
        invalidatePageProtection();
    };
    socket?.on("message", onMessage);
    socket?.on("connect", invalidatePageProtection);
    return () => {
      socket?.off("message", onMessage);
      socket?.off("connect", invalidatePageProtection);
    };
  }, [socket]);
}
