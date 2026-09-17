import { Divider, Switch } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { ISpace } from "@/features/space/types/space.types";
import { updateSpace } from "@/features/space/services/space-service";
import { invalidatePageProtection } from "@/features/page/hooks/use-page-protection-subscription";

export default function SpacePageProtectionSettings({
  space,
  readOnly,
}: {
  space: ISpace;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const mutation = useMutation({
    mutationFn: (rootDefaultLocked: boolean) =>
      updateSpace({ spaceId: space.id, rootDefaultLocked }),
    onSettled: invalidatePageProtection,
    onError: () =>
      notifications.show({
        color: "red",
        message: t("Failed to change space page protection"),
      }),
  });
  return (
    <>
      <Divider my="lg" />
      <Switch
        role="switch"
        label={t("Lock root pages by default")}
        description={t(
          "Root pages without an explicit protection setting and their inheriting descendants follow this setting. Explicitly locked or unlocked pages are unaffected.",
        )}
        checked={space.settings?.pageProtection?.rootDefaultLocked ?? true}
        disabled={readOnly || mutation.isPending}
        onChange={(event) => mutation.mutate(event.currentTarget.checked)}
      />
    </>
  );
}
