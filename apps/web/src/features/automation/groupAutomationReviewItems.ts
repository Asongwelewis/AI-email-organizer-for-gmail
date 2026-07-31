import type { AutomationReviewItem } from '@web/types/automation';

export interface AutomationReviewGroup {
  key: string;
  primary: AutomationReviewItem;
  members: AutomationReviewItem[];
}

const normalize = (value: string | null | undefined) =>
  (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export function groupAutomationReviewItems(items: AutomationReviewItem[]): AutomationReviewGroup[] {
  const groups = new Map<string, AutomationReviewItem[]>();
  for (const item of items) {
    const visualKey = JSON.stringify([
      normalize(item.message.senderEmail),
      normalize(item.message.subject),
      normalize(item.message.snippet),
      item.labelName,
      item.labelPath,
      Math.round(item.confidence * 100),
      normalize(item.explanation),
    ]);
    const group = groups.get(visualKey);
    if (group) group.push(item);
    else groups.set(visualKey, [item]);
  }
  return [...groups.entries()].map(([key, members]) => ({
    key,
    primary: members[0]!,
    members,
  }));
}
