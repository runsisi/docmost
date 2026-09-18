import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEditorScroll } from "./use-editor-scroll";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  vi.useRealTimers();
});

describe("initial editor anchor scroll", () => {
  it("captures the URL fragment before the editor onCreate callback is registered", async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/s/xcube/p/test#source-index");
    const dom = document.createElement("div");
    dom.innerHTML = '<h2 id="source-index">Appendix B</h2>';
    const scroll = vi.fn();
    dom.firstElementChild!.scrollIntoView = scroll;
    const editor = { isDestroyed: false, view: { dom } } as any;
    const { result } = renderHook(() => {
      const { handleScrollTo } = useEditorScroll({ canScroll: () => true });
      // Tiptap retains the onCreate callback registered on the initial render.
      const [onCreate] = useState(() => handleScrollTo);
      return onCreate;
    });
    let pending: Promise<unknown>;
    act(() => {
      pending = result.current(editor);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(await pending!).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });
});
