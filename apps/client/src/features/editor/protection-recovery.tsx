import { Alert, Button, Group, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useClipboard } from "@/hooks/use-clipboard";
import { htmlToMarkdown } from "@docmost/editor-ext";

const prefix = "docmost-protection-recovery:";
export const recoveryKey = (
  pageId: string,
  version: string,
  clientId: number | string,
) => `${prefix}${pageId}:${version}:${clientId}`;

export function saveRecovery(key: string, html: string) {
  localStorage.setItem(
    key,
    JSON.stringify({ html, savedAt: new Date().toISOString() }),
  );
  window.dispatchEvent(new Event("protection-recovery"));
}
export function clearRecovery(key: string) {
  localStorage.removeItem(key);
  window.dispatchEvent(new Event("protection-recovery"));
}

export function ProtectionRecovery({
  pageId,
  version,
}: {
  pageId: string;
  version: string;
}) {
  const { t } = useTranslation();
  const clipboard = useClipboard();
  const [copies, setCopies] = useState<
    { key: string; html: string; savedAt: string }[]
  >([]);
  useEffect(() => {
    const refresh = () =>
      setCopies(
        Object.keys(localStorage)
          .filter(
            (key) =>
              key.startsWith(`${prefix}${pageId}:`) &&
              !key.startsWith(`${prefix}${pageId}:${version}:`),
          )
          .map((key) => ({ key, ...JSON.parse(localStorage.getItem(key)) })),
      );
    refresh();
    window.addEventListener("protection-recovery", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("protection-recovery", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [pageId, version]);
  if (!copies.length) return null;
  return (
    <Alert color="yellow" title={t("Local recovery copies")} mb="md">
      <Text size="sm">
        {t(
          "Protection changed. Unconfirmed edits were saved locally and will not be replayed. Copy or export them before discarding.",
        )}
      </Text>
      {copies.map((copy) => (
        <Group key={copy.key} mt="xs">
          <Text size="xs">{new Date(copy.savedAt).toLocaleString()}</Text>
          <Button
            size="xs"
            variant="default"
            onClick={() => clipboard.copy(htmlToMarkdown(copy.html))}
          >
            {t("Copy")}
          </Button>
          <Button
            size="xs"
            variant="default"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([htmlToMarkdown(copy.html)], {
                  type: "text/markdown;charset=utf-8",
                }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = `recovery-${pageId}.md`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            {t("Export")}
          </Button>
          <Button
            size="xs"
            color="red"
            variant="subtle"
            onClick={() => clearRecovery(copy.key)}
          >
            {t("Discard")}
          </Button>
        </Group>
      ))}
    </Alert>
  );
}
