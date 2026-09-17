import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useParams } from "react-router-dom";
import {
  activeHistoryIdAtom,
  historyAtoms,
} from "@/features/page-history/atoms/history-atoms";
import { fetchPageHistory } from "@/features/page-history/queries/page-history-query";
import { IPageHistory } from "@/features/page-history/types/page.types";
import {
  pageEditorAtom,
  titleEditorAtom,
} from "@/features/editor/atoms/editor-atoms";
import { usePageQuery } from "@/features/page/queries/page-query";
import { queryClient } from "@/main";
import { IPage } from "@/features/page/types/page.types";
import { extractPageSlugId } from "@/lib";

export function useHistoryRestore() {
  const { t } = useTranslation();

  const activeHistoryId = useAtomValue(activeHistoryIdAtom);
  const mainEditor = useAtomValue(pageEditorAtom);
  const mainEditorTitle = useAtomValue(titleEditorAtom);
  const setHistoryModalOpen = useSetAtom(historyAtoms);

  const { pageSlug } = useParams();
  const { data: page } = usePageQuery({ pageId: extractPageSlugId(pageSlug) });
  const canRestore = page?.permissions?.canModifyContent === true;

  const handleRestore = useCallback(
    async (historyId: string) => {
      let historyData: IPageHistory;
      try {
        historyData = await fetchPageHistory(historyId);
      } catch {
        notifications.show({
          message: t("Error fetching page data."),
          color: "red",
        });
        return;
      }

      if (
        !canRestore ||
        queryClient.getQueryData<IPage>(["pages", page.id])?.protection.version !==
          page.protection.version ||
        !mainEditor ||
        mainEditor.isDestroyed ||
        !mainEditorTitle ||
        mainEditorTitle.isDestroyed
      ) {
        return;
      }

      mainEditorTitle
        .chain()
        .clearContent()
        .setContent(historyData.title, { emitUpdate: true })
        .run();

      mainEditor
        .chain()
        .clearContent()
        .setContent(historyData.content)
        .run();

      setHistoryModalOpen(false);
      notifications.show({ message: t("Successfully restored") });
    },
    [mainEditor, mainEditorTitle, setHistoryModalOpen, t, canRestore, page],
  );

  const confirmRestore = useCallback(
    (historyId?: string) => {
      const targetId = historyId ?? activeHistoryId;
      if (!targetId) return;

      modals.openConfirmModal({
        title: t("Please confirm your action"),
        children: (
          <Text size="sm">
            {t(
              "Are you sure you want to restore this version? Any changes not versioned will be lost.",
            )}
          </Text>
        ),
        labels: { confirm: t("Confirm"), cancel: t("Cancel") },
        onConfirm: () => handleRestore(targetId),
      });
    },
    [t, handleRestore, activeHistoryId],
  );

  return { canRestore, confirmRestore };
}
