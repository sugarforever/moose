import { validateAttachments, type Attachment } from "../runtime/attachments";
/** Selection leases prevent a system picker from writing into a different chat. */
export class AttachmentDrafts {
  private drafts = new Map<number, Attachment[]>();
  private active?: number;
  private epoch = 0;
  private selecting = false;
  get items(): Attachment[] {
    return this.active ? (this.drafts.get(this.active) ?? []) : [];
  }
  activate(id?: number) {
    if (id !== this.active) {
      this.active = id;
      this.epoch++;
    }
  }
  remove(id: string) {
    if (this.active)
      this.drafts.set(
        this.active,
        this.items.filter((a) => a.id !== id),
      );
  }
  clear(id: number, submitted: readonly Attachment[]) {
    const ids = new Set(submitted.map((a) => a.id));
    this.drafts.set(
      id,
      (this.drafts.get(id) ?? []).filter((a) => !ids.has(a.id)),
    );
  }
  async select(pick: () => Promise<Attachment[]>): Promise<boolean> {
    if (!this.active || this.selecting) return false;
    const id = this.active,
      epoch = this.epoch;
    this.selecting = true;
    try {
      const items = await pick();
      if (epoch !== this.epoch) return false;
      const next = [...this.items, ...items];
      validateAttachments(next);
      this.drafts.set(id, next);
      return true;
    } finally {
      this.selecting = false;
    }
  }
}
