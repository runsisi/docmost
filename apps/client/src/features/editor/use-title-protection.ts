import { useRef } from "react";
import { Editor } from "@tiptap/core";
import { Transaction } from "@tiptap/pm/state";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { queryClient } from "@/main";
import { IPage } from "@/features/page/types/page.types";
import { usePageQuery } from "@/features/page/queries/page-query";
import {
  clearRecovery,
  recoveryKey,
  saveRecovery,
} from "./protection-recovery";

type PendingTitle = { title: string; version: string; key: string };

export function useTitleProtection(pageId: string, slugId: string) {
  const { t } = useTranslation();
  const { data: page } = usePageQuery({ pageId: slugId });
  const recoveryId = useRef(`title-${Date.now()}-${Math.random()}`);
  const pending = useRef<PendingTitle | null>(null);
  return {
    pending,
    version: page?.protection.version,
    track(editor: Editor, transaction: Transaction) {
      if (!transaction.docChanged) return false;
      const version = queryClient.getQueryData<IPage>(["pages", slugId])
        .protection.version;
      const key = recoveryKey(pageId, version, recoveryId.current);
      pending.current = { title: editor.getText(), version, key };
      saveRecovery(key, editor.getHTML());
      return true;
    },
    acknowledge(saved: PendingTitle) {
      if (pending.current === saved) {
        clearRecovery(saved.key);
        pending.current = null;
      }
    },
    onError() {
      notifications.show({
        color: "red",
        message: t("Unable to save title. A local recovery copy was retained."),
      });
      queryClient.invalidateQueries({ queryKey: ["pages", slugId] });
    },
  };
}
