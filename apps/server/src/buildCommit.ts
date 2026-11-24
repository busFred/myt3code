declare const __T3CODE_BUILD_COMMIT__: string | undefined;

/** The commit a packed build was made from; undefined when run from source or in tests. */
export const BUILD_COMMIT: string | undefined =
  typeof __T3CODE_BUILD_COMMIT__ === "string" && __T3CODE_BUILD_COMMIT__ !== ""
    ? __T3CODE_BUILD_COMMIT__
    : undefined;
