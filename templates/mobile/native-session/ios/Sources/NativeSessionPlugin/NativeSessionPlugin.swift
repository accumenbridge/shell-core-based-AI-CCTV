import Capacitor
import Foundation
import Security

@objc(NativeSessionPlugin)
public final class NativeSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeSessionPlugin"
    public let jsName = "NativeSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    private let service = "com.quadbridge.native-session"
    private let account = "qb-user-session"

    @objc func read(_ call: CAPPluginCall) {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            call.resolve(["token": NSNull()])
            return
        }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8), validToken(token) else {
            call.reject("Secure native session could not be read", "INCOMPATIBLE")
            return
        }
        call.resolve(["token": token])
    }

    @objc func save(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), validToken(token),
              let data = token.data(using: .utf8) else {
            call.reject("Invalid native session value", "INVALID")
            return
        }
        var query = baseQuery
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrSynchronizable as String: false
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            query.merge(attributes) { _, new in new }
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                call.reject("Secure native session could not be saved", "UNAVAILABLE")
                return
            }
        } else if status != errSecSuccess {
            call.reject("Secure native session could not be saved", "UNAVAILABLE")
            return
        }
        call.resolve()
    }

    @objc func clear(_ call: CAPPluginCall) {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Secure native session could not be cleared", "UNAVAILABLE")
            return
        }
        call.resolve()
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
    }

    private func validToken(_ token: String) -> Bool {
        token.range(of: "^[A-Za-z0-9_-]{20,256}$", options: .regularExpression) != nil
    }
}
