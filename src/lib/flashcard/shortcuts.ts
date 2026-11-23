interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target?: unknown;
}

function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const { tagName, isContentEditable } = target as { tagName?: string; isContentEditable?: boolean };
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || isContentEditable === true;
}

/** Plain "Z" undoes the last rating; Ctrl/Cmd+Z and typing in a field are left alone. */
export function isUndoShortcut(event: KeyLike): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (isTypingTarget(event.target)) return false;
  return event.key === "z" || event.key === "Z";
}
