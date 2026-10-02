/** A failed/partial debugger call may already have pressed the irreversible button. */
export class PublishResultUnknownError extends Error {
  constructor(cause: unknown) {
    super(`发布结果未知，请核对站点，勿直接重发：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PublishResultUnknownError";
  }
}

export async function confirmPublication<T>(click: () => Promise<boolean>, readResult: () => Promise<T>): Promise<T> {
  try {
    if (!(await click())) throw new Error("真实点击未确认成功");
    return await readResult();
  } catch (e) {
    throw new PublishResultUnknownError(e);
  }
}
