import { Center, Container, Loader, Space } from "@mantine/core";
import HomeTabs from "@/features/home/components/home-tabs";
import HomeAiPrompt from "@/features/home/components/home-ai-prompt";
import SpaceCarousel from "@/features/space/components/space-carousel.tsx";
import { useTranslation } from "react-i18next";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { Navigate } from "react-router-dom";
import { useGetSpacesQuery } from "@/features/space/queries/space-query.ts";
import { getSpaceUrl } from "@/lib/config.ts";

export default function Home() {
  const { t } = useTranslation();
  const {
    data: spaces,
    isPending,
    isSuccess,
  } = useGetSpacesQuery({ limit: 20 });

  if (isPending) {
    return (
      <Center pt="xl">
        <Loader />
      </Center>
    );
  }

  if (isSuccess && spaces.items.length === 1 && !spaces.meta.hasNextPage) {
    return <Navigate to={getSpaceUrl(spaces.items[0].slug)} replace />;
  }

  return (
    <>
      <DocumentTitle title={t("Home")} />
      <Container size={"900"} pt="xl">
        <HomeAiPrompt />

        <Space h="xl" />

        <SpaceCarousel />

        <Space h="xl" />

        <HomeTabs />
      </Container>
    </>
  );
}
