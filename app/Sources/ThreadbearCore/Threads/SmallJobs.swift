import Foundation

/// Which pools can run titles and the librarian, and which one the menus
/// show. Claude and Cursor logins both can. A stored "claude" with no
/// Claude login shows the Cursor pool, which is where those jobs run.
public enum SmallJobs {
    public static func pools(_ pools: [Pool], accounts: [Account]) -> [Pool] {
        pools.filter { pool in
            pool.accountIds.contains { id in
                accounts.contains { $0.id == id && ($0.provider == "claude" || $0.provider == "cursor") }
            }
        }
    }

    /// Nil stays nil (small jobs off). A pool that can take the work is
    /// shown as stored. "claude" with only a Cursor pool shows "cursor".
    public static func shownPool(stored: String?, pools: [Pool]) -> String? {
        if let stored, pools.contains(where: { $0.id == stored }) { return stored }
        if stored == "claude", pools.contains(where: { $0.id == "cursor" }) { return "cursor" }
        return stored
    }
}
