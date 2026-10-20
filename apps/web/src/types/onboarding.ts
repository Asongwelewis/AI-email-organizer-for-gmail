/** Where a new mailbox is in its first setup. Mirrors `GET /api/onboarding`. */
export type OnboardingStage = 'SYNCING' | 'LEARNING' | 'SORTING' | 'DONE';

export type OnboardingState = 'PENDING' | 'RUNNING' | 'STOPPED' | 'FAILED' | 'DONE';

export interface OnboardingStatus {
  state: OnboardingState;
  stage: OnboardingStage | null;
  processed: number;
  total: number | null;
  sorted: number;
  /** Why it stopped, already written for the person reading it. */
  message: string | null;
  stopReason: string | null;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  completedAt: string | null;
}
