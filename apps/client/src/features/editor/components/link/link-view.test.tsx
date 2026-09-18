import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import LinkView from "./link-view";

const mocks = vi.hoisted(() => ({ notify: vi.fn(), copy: vi.fn() }));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notify },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tiptap/react", () => ({
  MarkViewContent: () => <span>附录 A</span>,
}));
vi.mock("./link-editor-panel", () => ({ LinkEditorPanel: () => null }));
vi.mock("@/features/page/queries/page-query.ts", () => ({
  usePageQuery: () => ({}),
}));
vi.mock("@/features/share/queries/share-query.ts", () => ({
  useSharePageQuery: () => ({}),
}));
vi.mock("@/features/public-space/queries/public-space-query.ts", () => ({
  usePublicSpacePageQuery: () => ({}),
}));
vi.mock("@docmost/editor-ext", async () => {
  const { findAnchorTarget } =
    await import("../../../../../../../packages/editor-ext/src/lib/anchors");
  const { sanitizeUrl } =
    await import("../../../../../../../packages/editor-ext/src/lib/utils");
  return {
    findAnchorTarget,
    sanitizeUrl,
    copyToClipboard: mocks.copy,
    isEditorReady: () => true,
  };
});

function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.hash}
    </output>
  );
}

function mount(
  href: string,
  editable = false,
  path = "/s/xcube/p/title-451UtsGcio",
) {
  const dom = document.createElement("div");
  dom.innerHTML = '<h2 id="fuse-index" data-id="existing-node">Appendix</h2>';
  const scroll = vi.fn();
  dom.firstElementChild!.scrollIntoView = scroll;
  const editor = { isEditable: editable, view: { dom } };
  const mark = { attrs: { href, internal: false } };
  render(
    <MantineProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/s/:spaceSlug/p/:pageSlug"
            element={
              <>
                <LinkView {...({ editor, mark } as any)} />
                <Location />
              </>
            }
          />
          <Route
            path="*"
            element={
              <>
                <LinkView {...({ editor, mark } as any)} />
                <Location />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  );
  return { scroll };
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "open").mockImplementation(() => null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("document link navigation", () => {
  it.each([
    "/s/xcube/p/title-451UtsGcio",
    "/share/example/p/title-451UtsGcio",
    "/docs/xcube/p/title-451UtsGcio",
  ])("scrolls within %s without opening a tab", (path) => {
    const { scroll } = mount("#fuse-index", false, path);
    fireEvent.click(screen.getByText("附录 A"));
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.getByTestId("location").textContent).toBe(
      path + "#fuse-index",
    );
    expect(screen.getByRole("link").getAttribute("target")).toBeNull();
  });

  it.each(["#missing", "#%E0%A4"])(
    "reports unresolved %s without navigating",
    (href) => {
      const { scroll } = mount(href);
      fireEvent.click(screen.getByText("附录 A"));
      expect(scroll).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
      expect(mocks.notify).toHaveBeenCalledWith({
        message: "Link target not found",
        color: "yellow",
      });
      expect(screen.getByTestId("location").textContent).not.toContain("#");
    },
  );

  it("opens a preview in editing mode, then scrolls when its link is opened", async () => {
    const { scroll } = mount("#fuse-index", true);
    fireEvent.click(screen.getByText("附录 A"));
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText("#fuse-index"));
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(window.open).not.toHaveBeenCalled();
  });

  it("copies a complete URL with the original fragment", async () => {
    mount("#fuse-index", true);
    fireEvent.click(screen.getByText("附录 A"));
    await screen.findByText("#fuse-index");
    fireEvent.mouseDown(
      document.querySelector(".tabler-icon-copy")!.closest("button")!,
    );
    expect(mocks.copy).toHaveBeenCalledWith(
      new URL("#fuse-index", window.location.href).href,
    );
  });

  it("keeps existing internal node-ID links working", () => {
    const { scroll } = mount("/s/xcube/p/title-451UtsGcio#existing-node");
    fireEvent.click(screen.getByText("附录 A"));
    expect(scroll).toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.getByTestId("location").textContent).toContain(
      "#existing-node",
    );
  });

  it("opens a fragment in a new tab when explicitly requested while editing", () => {
    const { scroll } = mount("#fuse-index", true);
    fireEvent.click(screen.getByText("附录 A"), { ctrlKey: true });
    expect(window.open).toHaveBeenCalledWith(
      new URL("#fuse-index", window.location.href).href,
      "_blank",
      "noopener,noreferrer",
    );
    expect(scroll).not.toHaveBeenCalled();
  });

  it("continues to open ordinary external URLs", () => {
    mount("https://example.com/reference#chapter");
    fireEvent.click(screen.getByText("附录 A"));
    expect(window.open).toHaveBeenCalledWith(
      "https://example.com/reference#chapter",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
