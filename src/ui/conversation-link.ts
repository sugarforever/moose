/** Accept only Moose's exact conversation route, never arbitrary URL parameters. */
export function conversationLink(url: string | null): number | undefined {
  const match = /^moose:\/\/conversation\/([1-9]\d*)$/.exec(url ?? "");
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) ? id : undefined;
}
