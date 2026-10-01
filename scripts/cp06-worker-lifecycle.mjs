export class Cp06CleanupError extends AggregateError {
  constructor(primary, cleanup) {
    super(
      primary === undefined ? [cleanup] : [primary, cleanup],
      "CP-06 evaluation cleanup failed",
      {
        cause: primary ?? cleanup,
      },
    );
    this.code = "CP06_CLEANUP_FAILED";
    this.exitCode = 74;
  }
}

/** Await cleanup on success and failure; never lose the primary error. */
export async function withCleanup(action, cleanup) {
  let result;
  let primary;
  let failed = false;
  try {
    result = await action();
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      throw new Cp06CleanupError(primary, error);
    }
  }
  if (failed) throw primary;
  return result;
}
