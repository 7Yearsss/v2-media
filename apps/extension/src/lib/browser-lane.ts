/** One automation owner across publish, attribution, manual/deep collection and keyword tasks. */
export class BrowserLane {
  private owner: string | null = null;
  get busy() { return this.owner !== null; }
  acquire(owner: string) { if (this.owner !== null) return false; this.owner = owner; return true; }
  release(owner: string) { if (this.owner === owner) this.owner = null; }
  owns(owner: string) { return this.owner === owner; }
}
