import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
export type Grant = {
  conversationId: number;
  skillId: string;
  permission: string;
};
export type PermissionRequest = Grant & { signal: AbortSignal };
export class PermissionStore {
  private tail: Promise<unknown> = Promise.resolve();
  private versions = new Map<number, number>();
  private pending = new Map<number, Set<AbortController>>();
  private constructor(
    private db: SqliteDatabase,
    private request: (p: PermissionRequest) => Promise<boolean>,
  ) {}
  static async open(
    db: SqliteDatabase,
    request: (p: PermissionRequest) => Promise<boolean>,
  ) {
    await db.exec(
      "CREATE TABLE IF NOT EXISTS moose_grants(conversationId INTEGER NOT NULL,skillId TEXT NOT NULL,permission TEXT NOT NULL,PRIMARY KEY(conversationId,skillId,permission))",
    );
    return new PermissionStore(db, request);
  }
  authorize(
    conversationId: number,
    skillId: string,
    permission: string,
    parent: AbortSignal,
  ): Promise<boolean> {
    const version = this.versions.get(conversationId) ?? 0;
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    if (parent.aborted) abort();
    let pending = this.pending.get(conversationId);
    if (!pending) {
      pending = new Set();
      this.pending.set(conversationId, pending);
    }
    pending.add(controller);
    const work = this.tail.then(async () => {
      const valid = () =>
        !controller.signal.aborted &&
        (this.versions.get(conversationId) ?? 0) === version;
      if (!valid()) return false;
      const stored = await this.db.get(
        "SELECT 1 FROM moose_grants WHERE conversationId=? AND skillId=? AND permission=?",
        conversationId,
        skillId,
        permission,
      );
      if (stored) return valid();
      if (
        !valid() ||
        !(await this.request({
          conversationId,
          skillId,
          permission,
          signal: controller.signal,
        })) ||
        !valid()
      )
        return false;
      await this.db.run(
        "INSERT OR IGNORE INTO moose_grants(conversationId,skillId,permission) VALUES (?,?,?)",
        conversationId,
        skillId,
        permission,
      );
      if (!valid()) {
        await this.db.run(
          "DELETE FROM moose_grants WHERE conversationId=? AND skillId=? AND permission=?",
          conversationId,
          skillId,
          permission,
        );
        return false;
      }
      return true;
    });
    this.tail = work.catch(() => {});
    return work.finally(() => {
      parent.removeEventListener("abort", abort);
      pending!.delete(controller);
      if (!pending!.size) this.pending.delete(conversationId);
    });
  }
  list(conversationId: number) {
    return this.db.all<Grant>(
      "SELECT conversationId,skillId,permission FROM moose_grants WHERE conversationId=? ORDER BY skillId,permission",
      conversationId,
    );
  }
  revoke(conversationId: number) {
    this.versions.set(
      conversationId,
      (this.versions.get(conversationId) ?? 0) + 1,
    );
    for (const controller of this.pending.get(conversationId) ?? [])
      controller.abort();
    const work = this.tail.then(() =>
      this.db.run(
        "DELETE FROM moose_grants WHERE conversationId=?",
        conversationId,
      ),
    );
    this.tail = work.catch(() => {});
    return work;
  }
}
