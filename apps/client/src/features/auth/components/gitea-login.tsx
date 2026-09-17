import { Alert, Button, Stack, Text } from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api from "@/lib/api-client";

export function GiteaNotice() {
  const [params] = useSearchParams();
  const { t } = useTranslation();
  const error = params.get("giteaError");
  if (error)
    return (
      <Alert color="red" mb="md">
        {t(error)}
      </Alert>
    );
  if (params.get("gitea") === "linked")
    return (
      <Alert color="green" mb="md">
        {t("Gitea account linked successfully.")}
      </Alert>
    );
  return null;
}

export function GiteaLogin() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["gitea-config"],
    queryFn: async () =>
      (await api.get<{ enabled: boolean }>("/auth/gitea/config")).data,
  });
  if (!data?.enabled) return null;
  return (
    <Button
      component="a"
      href="/api/auth/gitea/login"
      variant="default"
      fullWidth
      mb="md"
    >
      {t("Sign in with Gitea")}
    </Button>
  );
}

export function GiteaAccount() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["gitea-status"],
    queryFn: async () =>
      (
        await api.post<{ enabled: boolean; linked: boolean }>(
          "/auth/gitea/status",
        )
      ).data,
  });
  const link = useMutation({
    mutationFn: async () =>
      (await api.post<{ url: string }>("/auth/gitea/link")).data,
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });
  if (!data?.enabled) return null;
  return (
    <Stack mb="lg" align="flex-start">
      <GiteaNotice />
      <Text fw={500}>Gitea</Text>
      {data.linked ? (
        <Text size="sm">
          {t("Your Gitea account is linked. You can use it to sign in.")}
        </Text>
      ) : (
        <Button
          variant="default"
          loading={link.isPending}
          onClick={() => link.mutate()}
        >
          {t("Link Gitea account")}
        </Button>
      )}
      {link.isError && (
        <Alert color="red">
          {t("Could not connect to Gitea. Please try again.")}
        </Alert>
      )}
    </Stack>
  );
}
