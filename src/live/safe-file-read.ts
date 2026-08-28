export interface RegularFileOpenConstants {
  readonly O_RDONLY: number;
  readonly O_NOFOLLOW?: number;
  readonly O_NONBLOCK?: number;
}

export function safeRegularFileOpenFlags(
  constants: RegularFileOpenConstants,
): number {
  let flags = constants.O_RDONLY;
  if (typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  if (typeof constants.O_NONBLOCK === "number") flags |= constants.O_NONBLOCK;
  return flags;
}
