import CryptoKit
import Foundation
import Security

/// This phone's key for notifications that go through the push relay
/// (docs/push-relay.md): 32 random bytes made here, sent only to the phone's
/// own backend, which seals each notification's title and text with it. The
/// relay forwards ciphertext; the app's notification extension opens it.
/// Kept in the keychain under the App Group the extension shares
/// (group.com.lunarlabs.threadbear, registered 28 Oct). Not a team-prefixed
/// keychain group: with automatic signing the extension got the team's
/// wildcard profile, whose App ID prefix differs from the app's, so the two
/// could never share one. An App Group doesn't depend on the prefix.
public enum PushKeyStore {
    public static let accessGroup = "group.com.lunarlabs.threadbear"
    static let service = "com.mikecann.threadbear.pushKey"
    static let account = "pushKey"

    /// The key, made and saved the first time. Nil if the keychain refuses
    /// (then notifications through the relay show the stand-in text).
    public static func loadOrCreate(accessGroup: String? = accessGroup) -> Data? {
        if let key = load(accessGroup: accessGroup) { return key }
        var bytes = Data(count: 32)
        let ok = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) } == errSecSuccess
        guard ok else { return nil }
        var item = base(accessGroup)
        item[kSecValueData as String] = bytes
        // The extension runs while the phone is locked, after the first unlock.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess ? bytes : nil
    }

    static func load(accessGroup: String?) -> Data? {
        var query = base(accessGroup)
        query[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    private static func base(_ accessGroup: String?) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }
}

/// Opens what the backend sealed (convex/push.ts seal): AES-256-GCM, nonce
/// then ciphertext then tag, base64, around {"title","body"}. The extension
/// has its own copy of this (NotificationService.swift).
public enum PushSeal {
    public static func open(_ sealed: String, key: Data) -> (title: String, body: String)? {
        guard let data = Data(base64Encoded: sealed),
              let box = try? AES.GCM.SealedBox(combined: data),
              let plain = try? AES.GCM.open(box, using: SymmetricKey(data: key)),
              let json = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
              let title = json["title"] as? String, let body = json["body"] as? String else { return nil }
        return (title, body)
    }
}
