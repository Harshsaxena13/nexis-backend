/** Makes model output safe to show and speak: no markdown, no reasoning tags, bounded length. */
export function sanitizeReply(raw: string, maxChars: number): string {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|~~)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= maxChars) return text;

  // Cut at the last sentence end that fits; otherwise at a word boundary.
  const window = text.slice(0, maxChars);
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
    window.lastIndexOf('। '),
  );
  if (sentenceEnd > maxChars * 0.5) return window.slice(0, sentenceEnd + 1).trim();
  const space = window.lastIndexOf(' ');
  return `${window.slice(0, space > 0 ? space : maxChars).trim()}…`;
}
