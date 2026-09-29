export interface ContextItem {
  id: string;
  text: string;
  priority: number;
  authority: number;
  mustKeep?: boolean;
}

export interface ContextPacket {
  items: ContextItem[];
  chars: number;
  dropped: number;
}

export function packContext(items: ContextItem[], maxChars: number): ContextPacket {
  const unique = [...new Map(items.map((item) => [item.id, item])).values()];
  const ranked = unique.sort((a, b) => {
    if (Boolean(a.mustKeep) !== Boolean(b.mustKeep)) return a.mustKeep ? -1 : 1;
    const aScore = a.priority + a.authority;
    const bScore = b.priority + b.authority;
    return bScore - aScore;
  });

  const selected: ContextItem[] = [];
  let chars = 0;
  for (const item of ranked) {
    const cost = item.text.length;
    if (chars + cost > maxChars) continue;
    selected.push(item);
    chars += cost;
  }

  return { items: selected, chars, dropped: unique.length - selected.length };
}
