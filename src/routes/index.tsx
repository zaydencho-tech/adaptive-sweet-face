import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BUVI — 어르신의 건강 지킴이" },
      {
        name: "description",
        content:
          "부비(BUVI)는 어르신의 노쇠 예방과 건강한 일상을 함께하는 건강 동반자입니다. 노쇠 예측 설문, 1:1 상담, 건강 배움 등을 제공합니다.",
      },
      { property: "og:title", content: "BUVI — 어르신의 건강 지킴이" },
      {
        property: "og:description",
        content: "어르신의 소중한 건강 동반자, 부비(BUVI).",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  // Full-viewport iframe hosting the self-contained BUVI app.
  useEffect(() => {
    document.documentElement.style.height = "100%";
    document.body.style.margin = "0";
    document.body.style.height = "100%";
    document.body.style.overflow = "hidden";
  }, []);
  return (
    <iframe
      src="/buvi.html"
      title="BUVI 어르신 건강 지킴이"
      style={{
        border: "none",
        width: "100vw",
        height: "100vh",
        display: "block",
      }}
    />
  );
}
