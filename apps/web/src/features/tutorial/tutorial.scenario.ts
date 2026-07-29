export interface TutorialStep {
  id: string;
  route: string;
  target: string;
  eyebrow: string;
  title: string;
  description: string;
  note?: string;
}

export const TUTORIAL_PROGRESS_KEY = 'mailmind:tutorial-progress:v1';

export const tutorialSteps: TutorialStep[] = [
  {
    id: 'orientation',
    route: '/dashboard',
    target: '[data-tutorial="primary-navigation"]',
    eyebrow: 'Welcome to MailMind',
    title: 'Your inbox control room',
    description:
      'The main navigation follows the MailMind workflow from inspection to action. This tour is interactive, but it will never run a real email operation.',
    note: 'Use Next and Back, or the left and right arrow keys.',
  },
  {
    id: 'identity',
    route: '/dashboard',
    target: '[data-tutorial="identity-card"]',
    eyebrow: 'Step 1 / Your account',
    title: 'MailMind login is separate',
    description:
      'This card represents your MailMind session. Signing in here does not automatically grant access to Gmail, and you can end one or every session independently.',
  },
  {
    id: 'gmail-summary',
    route: '/dashboard',
    target: '[data-tutorial="gmail-summary"]',
    eyebrow: 'Step 2 / Gmail',
    title: 'Connection at a glance',
    description:
      'The dashboard always reflects whether Gmail is connected. Manage connection and synchronization from the Connections screen.',
  },
  {
    id: 'connection',
    route: '/settings/connections',
    target: '[data-tutorial="connection-stage"]',
    eyebrow: 'Step 3 / Permission',
    title: 'You control Gmail access',
    description:
      'Connect, reconnect, inspect granted permission, or disconnect Gmail here. Disconnecting removes MailMind access without deleting your MailMind account.',
    note: 'The tutorial blocks these controls; no Google consent window will open.',
  },
  {
    id: 'sync',
    route: '/settings/connections',
    target: '[data-tutorial="connection-stage"]',
    eyebrow: 'Step 4 / Synchronization',
    title: 'Bring in safe email metadata',
    description:
      'After connecting, prepare MailMind labels and run the initial sync. Later syncs use Gmail history so only new changes are fetched.',
    note: 'MailMind synchronizes metadata and snippets—not full bodies, raw MIME, or attachments.',
  },
  {
    id: 'automation-status',
    route: '/dashboard/automation',
    target: '[data-tutorial="automation-state"]',
    eyebrow: 'Step 5 / Automation',
    title: 'Know exactly what is running',
    description:
      'This live state shows Gmail readiness, the next daily run, and whether work is active. MailMind classifies unprocessed mail, reuses learned patterns, and records every run.',
  },
  {
    id: 'automation-run',
    route: '/dashboard/automation',
    target: '[data-tutorial="automation-run"]',
    eyebrow: 'Step 6 / Manual control',
    title: 'Run safely on demand',
    description:
      'Run now starts the same resumable workflow as the daily schedule. Token, cost, and message limits stop excessive work; completed labels remain safe if a later item fails.',
    note: 'A real automation run is the only action that can create and apply Gmail labels.',
  },
  {
    id: 'uncertain-review',
    route: '/dashboard/automation',
    target: '[data-tutorial="automation-review"]',
    eyebrow: 'Step 7 / Human judgment',
    title: 'Uncertainty waits for you',
    description:
      'Low-confidence classifications land here without changing Gmail. Approve and apply a corrected category, or skip the message entirely.',
  },
  {
    id: 'complete',
    route: '/dashboard',
    target: '[data-tutorial="primary-navigation"]',
    eyebrow: 'Tour complete',
    title: 'You are in control',
    description:
      'Connect and sync first, then let Automation handle confident messages while you resolve the uncertain ones.',
    note: 'Restart this tutorial anytime with the Tour button in the header.',
  },
];
