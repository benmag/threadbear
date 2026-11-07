import XCTest
@testable import ThreadbearCore

final class SmallJobsTests: XCTestCase {
    private let claude = Pool(id: "claude", title: "Claude", accountIds: ["claude-main"], builtIn: true)
    private let cursor = Pool(id: "cursor", title: "Cursor", accountIds: ["cursor-main"], builtIn: true)
    private let codex = Pool(id: "codex", title: "Codex", accountIds: ["codex-main"], builtIn: true)

    func testPoolsAreClaudeOrCursor() {
        let accounts = [
            Account(id: "claude-main", title: "Claude"),
            Account(id: "cursor-main", provider: "cursor", title: "Cursor"),
            Account(id: "codex-main", provider: "codex", title: "Codex"),
        ]
        XCTAssertEqual(SmallJobs.pools([claude, cursor, codex], accounts: accounts).map(\.id), ["claude", "cursor"])
        XCTAssertEqual(SmallJobs.pools([cursor], accounts: accounts).map(\.id), ["cursor"])
    }

    func testStoredClaudeShowsCursorWhenThatIsTheOnlyLogin() {
        XCTAssertEqual(SmallJobs.shownPool(stored: "claude", pools: [cursor]), "cursor")
        XCTAssertEqual(SmallJobs.shownPool(stored: "claude", pools: [claude, cursor]), "claude")
        XCTAssertNil(SmallJobs.shownPool(stored: nil, pools: [cursor]))
        XCTAssertEqual(SmallJobs.shownPool(stored: "codex", pools: [cursor]), "codex")
    }
}
