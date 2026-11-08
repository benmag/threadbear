import CryptoKit
import Foundation
import Security
import UserNotifications

/// Opens notifications that came through the push relay (docs/push-relay.md).
/// The relay forwards them with a stand-in "A thread needs you" and the real
/// title and text sealed in `e`, with a key only this phone and its own
/// Threadbear backend have. Anything that can't be opened shows as it came.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        if let sealed = request.content.userInfo["e"] as? String, let key = PushKeyReader.key(),
           let opened = PushSeal.open(sealed, key: key) {
            content.title = opened.title
            content.body = opened.body
        }
        contentHandler(content)
    }
}

/// The same as ThreadbearKit's PushSeal, copied so the extension doesn't
/// load the Convex client (extensions have a small memory budget).
enum PushSeal {
    static func open(_ sealed: String, key: Data) -> (title: String, body: String)? {
        guard let data = Data(base64Encoded: sealed),
              let box = try? AES.GCM.SealedBox(combined: data),
              let plain = try? AES.GCM.open(box, using: SymmetricKey(data: key)),
              let json = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
              let title = json["title"] as? String, let body = json["body"] as? String else { return nil }
        return (title, body)
    }
}

/// Reads the key the app keeps in the keychain under the shared App Group
/// (ThreadbearKit's PushKeyStore writes it).
enum PushKeyReader {
    static func key() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.mikecann.threadbear.pushKey",
            kSecAttrAccount as String: "pushKey",
            kSecAttrAccessGroup as String: "group.com.lunarlabs.threadbear",
            kSecReturnData as String: true,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }
}
