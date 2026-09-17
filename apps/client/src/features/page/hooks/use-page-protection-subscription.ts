import { useEffect } from "react";
import { Socket } from "socket.io-client";
import { queryClient } from "@/main";

export function usePageProtectionSubscription(socket: Socket | null) {
  useEffect(() => {
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "sidebar-pages" ||
          query.queryKey[0] === "root-sidebar-pages",
      });
    };
    const onMessage = (event: { operation: string }) => {
      if (event.operation === "pageProtectionInvalidated") invalidate();
    };
    socket?.on("message", onMessage);
    socket?.on("connect", invalidate);
    return () => {
      socket?.off("message", onMessage);
      socket?.off("connect", invalidate);
    };
  }, [socket]);
}
