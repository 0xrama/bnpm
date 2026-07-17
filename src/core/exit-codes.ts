export const ExitCode = {
  success: 0,
  usage: 2,
  policyBlocked: 3,
  integrityFailure: 4,
  networkFailure: 5,
  installIncomplete: 6,
  internalError: 70,
  sigint: 130,
  sigterm: 143,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
