import { describe, expect, it, vi } from "vitest";
import { confirmPublication, PublishResultUnknownError } from "../../extension/src/lib/publish-outcome";

describe("irreversible publication result boundary", () => {
  it("returns only an observed result after the click", async () => {
    const result = { resultUrl: "https://offline.invalid/note" };
    await expect(confirmPublication(async () => true, async () => result)).resolves.toBe(result);
  });
  it("does not label missing post-click evidence as a definite failure", async () => {
    await expect(confirmPublication(async () => true, async () => { throw new Error("result timeout"); }))
      .rejects.toBeInstanceOf(PublishResultUnknownError);
  });
  it("an incomplete physical click is uncertain and never attempts another click", async () => {
    const click = vi.fn(async () => false), read = vi.fn(async () => ({}));
    await expect(confirmPublication(click, read)).rejects.toBeInstanceOf(PublishResultUnknownError);
    expect(click).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
  });
});
