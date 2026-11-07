import BearDock
import AppKit
import ThreadbearCore

/// The CLIs' versions and updates, and what to do when an account runs out
/// of room. The app never polls: `accounts.updated` and `clis.updated`
/// bring the news, and the popover redraws its relative times from `now`.
extension AppModel {
    /// After hello, for a runner that didn't put its CLIs in it: a step 4
    /// runner answers with the list, an older one with -32601.
    func loadClis() {
        guard let client else { return }
        Task {
            do {
                clis = try await client.listClis()
                clisSupported = true
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                clis = []
                clisSupported = false
            } catch {
                AppLog.write("rpc", "clis.list failed: \(error.localizedDescription)")
            }
        }
    }

    /// The Usage panel's charts. The panel asks when it opens and once a
    /// minute while it stays open; nothing else needs them.
    func loadUsageStats() async {
        guard let client else { return }
        do {
            usageStats = try await client.usageStats()
            usageStatsSupported = true
        } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
            usageStatsSupported = false
        } catch {
            AppLog.write("rpc", "usage.stats failed: \(error.localizedDescription)")
        }
    }

    /// The usage popover's buttons. Each returns at once; progress comes
    /// through `clis.updated`.
    func checkClis() { cliCall("clis.check") { try await $0.checkClis() } }

    func updateCli(_ provider: String, version: String? = nil, force: Bool = false) {
        cliCall("clis.update") { try await $0.updateCli(provider: provider, version: version, force: force) }
    }

    func setCliPolicy(_ provider: String, _ policy: String) {
        cliCall("clis.setPolicy") { try await $0.setCliPolicy(provider: provider, policy: policy) }
    }

    private func cliCall(_ method: String, _ call: @escaping (RPCClient) async throws -> [CliStatus]) {
        guard let client else { return }
        Task {
            do {
                clis = try await call(client)
                clisSupported = true
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                clisSupported = false
            } catch {
                show(error)
            }
        }
    }

    /// An update under way, or one that failed and hasn't been dismissed,
    /// for the quiet line under the toolbar.
    var cliBanner: (text: String, failedKey: String?)? {
        for cli in clis {
            guard let update = cli.update, let text = CliText.bannerText(cli) else { continue }
            if update.state == "failed" {
                let key = Self.failureKey(cli)
                if dismissedCliFailures.contains(key) { continue }
                return (text, key)
            }
            return (text, nil)
        }
        return nil
    }

    static func failureKey(_ cli: CliStatus) -> String {
        "\(cli.provider)|\(cli.update?.finishedAt.map(ISO8601.format) ?? cli.update?.targetVersion ?? "")"
    }

    func dismissCliFailure(_ key: String) { dismissedCliFailures.insert(key) }

    // MARK: Limits

    /// When the open thread can't go on where it is: its account is at its
    /// limit, or its last turn failed on the limit. Says so, and where it
    /// could go instead.
    struct LimitAdvice: Equatable {
        var text: String
        var target: Account?
    }

    func limitAdvice(for thread: ThreadSummary) -> LimitAdvice? {
        let account = account(thread.accountId)
        // A pool thread is the runner's to move: say nothing while its pool
        // has a login with room, and say when it carries on once it's
        // waiting. The button still offers a login outside the pool, which
        // pins it there.
        if usesPools, let poolId = thread.poolId, let pool = pool(poolId) {
            if let waiting = thread.waitingForRoom {
                return LimitAdvice(text: Pools.waitingSentence(poolTitle: pool.title, waiting, now: now),
                                   target: AccountUsageText.switchTarget(accounts, from: thread.accountId))
            }
            if Pools.logins(pool, accounts: accounts).contains(where: Pools.hasRoom) { return nil }
        }
        let blocked = account?.usage?.blocked == true
        // Only while the thread is still on the account the turn failed on:
        // after "Switch to ..." the status stays `error` until the next
        // turn, and the line blamed the new account.
        let failedOnLimit = thread.status == .error && failedOnAccount[thread.id] == thread.accountId
            && loadedSession(thread.id)?.lastTurnErrorKind == .usageLimit
        guard blocked || failedOnLimit else { return nil }
        var text = "\(accountShortTitle(thread.accountId)) has reached its limit"
        if let reset = AccountUsageText.mainWindows(account?.usage).filter({ $0.remainingPercent < 1 }).compactMap(\.resetsAt).min() {
            text += ", resets " + AccountUsageText.resetTime(reset, now: now)
        }
        return LimitAdvice(text: text + ".", target: AccountUsageText.switchTarget(accounts, from: thread.accountId))
    }

    // MARK: Signed out

    /// The open thread's last turn failed because its login was refused
    /// (`errorKind` auth: signed out, or the session ran out and couldn't
    /// be refreshed). The login to sign in again, for the sign-in line.
    func signInAccount(for thread: ThreadSummary) -> Account? {
        guard thread.status == .error, loadedSession(thread.id)?.lastTurnErrorKind == .auth else { return nil }
        return account(thread.accountId)
            ?? Account(id: thread.provider == "codex" ? "codex-main" : thread.provider == "cursor" ? "cursor-main" : thread.provider == "opencode" ? "opencode-main" : "claude-main", provider: thread.provider, title: thread.provider)
    }

    /// Opens Terminal on the CLI's own sign-in for that login, the same
    /// way the runner starts it: claude-main with no CLAUDE_CONFIG_DIR (so
    /// it's the login in the Keychain the runner reads), the others with
    /// their folder, and Codex with CODEX_HOME. A .command file rather than
    /// AppleScript, so macOS doesn't ask to let Threadbear control Terminal.
    func signIn(_ account: Account) {
        let path = clis.first { $0.provider == account.provider }?.path ?? ""
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("threadbear-sign-in-\(account.id).command")
        do {
            try SignIn.script(account, cliPath: path).write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
            NSWorkspace.shared.open(url)
        } catch {
            errorMessage = "Couldn't open Terminal to sign in: \(error.localizedDescription)"
        }
    }

    /// Sends the thread's last message of his again, after signing in.
    func sendAgain(_ threadId: String) {
        guard let session = loadedSession(threadId) else { return }
        for index in stride(from: session.displayCount - 1, through: max(0, session.displayCount - 80), by: -1) {
            if case .user(let message) = session.displayRow(index).content, !message.isFromRunner {
                drafts[threadId] = Draft(text: message.text, images: message.images)
                send(threadId: threadId)
                return
            }
        }
    }

    /// Moves a thread to another account (the limit line's button).
    func switchAccount(_ threadId: String, to accountId: String) {
        setAccount(threadId, accountId)
    }
}

extension ThreadSession {
    /// Why the last turn failed, when the runner said (`errorKind`): the
    /// newest footer, a few rows from the end.
    var lastTurnErrorKind: TurnErrorKind? {
        // Read so a view that asks is drawn again once the thread loads
        // (the rows themselves aren't observed).
        guard state == .loaded else { return nil }
        for index in stride(from: displayCount - 1, through: max(0, displayCount - 40), by: -1) {
            if case .footer(let completion) = displayRow(index).content {
                return completion.outcome == .failed ? completion.errorKind : nil
            }
        }
        return nil
    }
}

/// The main window, for popovers that size themselves to fit inside it.
@MainActor
enum AppWindow {
    static var contentHeight: CGFloat? {
        let window = NSApp.windows.first { $0.isVisible && $0.contentView != nil && $0.frame.width > 600
            && !($0 is DockPanelWindow) && !String(describing: type(of: $0)).contains("Popover") }
        return window.map { $0.contentLayoutRect.height }
    }

    /// Screen space above the chip whose popover is opening, set just
    /// before the popover is made. Picker popovers open upwards from the
    /// composer, so this, not the window's height, is what they have to
    /// fit in: a window reaching up near the top of the screen left the
    /// model picker's Effort row below the bottom of the screen.
    static var roomAboveAnchor: CGFloat?
}

/// The Terminal script behind Sign in… (AppModel.signIn).
enum SignIn {
    static func quoted(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    /// `cliPath` is the binary the runner starts for new sessions (Codex is
    /// often Threadbear's own copy, not on the PATH); empty uses the PATH's.
    static func script(_ account: Account, cliPath: String) -> String {
        let cursor = account.provider == "cursor"
        let opencode = account.provider == "opencode"
        let codex = account.provider == "codex"
        var env = ""
        if codex, !account.configDir.isEmpty { env = "CODEX_HOME=\(quoted(account.configDir)) " }
        if !codex, !cursor, !opencode, account.id != "claude-main", !account.configDir.isEmpty { env = "CLAUDE_CONFIG_DIR=\(quoted(account.configDir)) " }
        let binary = cliPath.isEmpty ? (cursor ? "agent" : opencode ? "opencode" : codex ? "codex" : "claude") : quoted(cliPath)
        let name = cursor ? "Cursor" : opencode ? "OpenCode" : codex ? "Codex" : "Claude"
        let login = opencode ? "auth login" : cursor || codex ? "login" : "auth login"
        return """
        #!/bin/zsh -l
        export PATH="$HOME/.local/bin:$PATH"
        echo "Signing in to \(name) for Threadbear (\(account.title))."
        echo
        \(env)\(binary) \(login)
        echo
        echo "Done. Go back to Threadbear and press Send again. You can close this window."

        """
    }
}
