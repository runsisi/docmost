import { ActionIcon, Group, Menu, Text, Tooltip } from "@mantine/core";
import { IconChevronDown, IconLock, IconLockOpen } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { IPage } from "@/features/page/types/page.types";
import api from "@/lib/api-client";
import { queryClient } from "@/main";

export function PageProtection({ page }: { page: IPage }) {
  const { t } = useTranslation();
  const mutation = useMutation({
    mutationFn: (mode: "inherit" | "locked" | "unlocked") =>
      api.post("/pages/protection", {
        pageId: page.id,
        mode,
        version: page.protection.version,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["pages"] }),
    onError: (error: any) =>
      notifications.show({
        color: "red",
        message:
          error.response?.status === 409
            ? t("Protection changed. Review the current state and try again.")
            : t("Failed to change page protection"),
      }),
  });
  if (!page.protection) return null;
  const state = page.protection;
  const description =
    state.mode !== "inherit"
      ? t(
          state.isLocked
            ? "This page is explicitly locked"
            : "This page is explicitly unlocked",
        )
      : state.inherited
        ? t(state.isLocked ? "Inherited: locked" : "Inherited: unlocked") +
          (state.sourceTitle ? ` · ${state.sourceTitle}` : "")
        : t("Inherit parent · root pages are unlocked");
  const disabled = !page.permissions?.canManageProtection || mutation.isPending;
  return (
    <Group gap={2} wrap="nowrap">
      <Tooltip label={description}>
        <ActionIcon
          variant="subtle"
          color={state.isLocked ? "orange" : "gray"}
          aria-label={t(state.isLocked ? "Unlock page" : "Lock page")}
          disabled={disabled}
          onClick={() =>
            mutation.mutate(state.isLocked ? "unlocked" : "locked")
          }
        >
          {state.isLocked ? <IconLock size={20} /> : <IconLockOpen size={20} />}
        </ActionIcon>
      </Tooltip>
      <Menu position="bottom-end" width={280}>
        <Menu.Target>
          <ActionIcon variant="subtle" aria-label={t("Page protection")}>
            <IconChevronDown size={14} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Text size="sm" p="xs">
            {description}
          </Text>
          <Menu.Item
            disabled={disabled || state.mode === "inherit"}
            onClick={() => mutation.mutate("inherit")}
          >
            {t("Inherit parent page")}
          </Menu.Item>
          <Text size="xs" c="dimmed" p="xs">
            {t(
              "Protection prevents content changes. Comments and page organization remain available.",
            )}
          </Text>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
