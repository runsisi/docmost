import {
  ComponentProps,
  createContext,
  RefObject,
  useContext,
  useState,
} from "react";
import { Editor } from "@tiptap/core";
import { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  HocuspocusRoom,
  useHocuspocusEvent,
  useHocuspocusProvider,
} from "@hocuspocus/provider-react";
import { usePageQuery } from "@/features/page/queries/page-query";
import { queryClient } from "@/main";
import {
  clearRecovery,
  ProtectionRecovery,
  recoveryKey,
  saveRecovery,
} from "./protection-recovery";

const ProtectionContext = createContext<{
  pageId: string;
  version: string;
} | null>(null);

function isProtectionMessage(payload: string) {
  try {
    const message = JSON.parse(payload);
    return (
      message.type === "protection.changed" ||
      message.type === "protection.unavailable"
    );
  } catch {
    return false; // Stateless messages may belong to other extensions.
  }
}

/** Recovery remains accessible even while collaboration authentication is unavailable. */
export function PageRecovery({ pageId }: { pageId: string }) {
  const { data: page } = usePageQuery({ pageId });
  return page ? (
    <ProtectionRecovery pageId={pageId} version={page.protection.version} />
  ) : null;
}

/** A new protection version gets a fresh provider and a separate persisted Y.Doc. */
export function ProtectedRoom({
  name,
  token,
  onStateless,
  children,
  ...props
}: Omit<ComponentProps<typeof HocuspocusRoom>, "token"> & { token: string }) {
  const pageId = name.substring(5);
  const { data: page } = usePageQuery({ pageId });
  if (!page) return null;
  const version = page.protection.version;
  return (
    <ProtectionContext.Provider value={{ pageId, version }}>
      <HocuspocusRoom
        {...props}
        name={name}
        key={version}
        sessionAwareness
        token={JSON.stringify({ token, protectionVersion: version })}
        onStateless={(event) => {
          if (isProtectionMessage(event.payload)) {
            queryClient.invalidateQueries({ queryKey: ["pages"] });
          }
          onStateless?.(event);
        }}
      >
        {children}
      </HocuspocusRoom>
    </ProtectionContext.Provider>
  );
}

export function useCollaborationProtection(
  editorRef: RefObject<Editor | null>,
) {
  const { pageId, version } = useContext(ProtectionContext)!;
  const provider = useHocuspocusProvider();
  const key = recoveryKey(pageId, version, provider.document.clientID);
  const [blocked, setBlocked] = useState(false);
  useHocuspocusEvent("stateless", ({ payload }) => {
    if (isProtectionMessage(payload)) {
      setBlocked(true);
      editorRef.current?.setEditable(false);
    }
  });
  useHocuspocusEvent("authenticated", ({ scope }) => {
    if (scope === "read-write") setBlocked(false);
  });
  useHocuspocusEvent("unsyncedChanges", ({ number }) => {
    if (number === 0) clearRecovery(key);
  });
  return {
    blocked,
    storageName: `${provider.configuration.name}.${version}`,
    onUpdate(editor: Editor, transaction: Transaction) {
      // setEditable also emits update; it must not create or rebind a pending edit.
      if (!transaction.docChanged) return false;
      if (!transaction.getMeta(ySyncPluginKey)?.isChangeOrigin) {
        saveRecovery(key, editor.getHTML());
      }
      return true;
    },
  };
}
