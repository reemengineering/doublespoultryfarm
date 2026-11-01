package com.reem.doublespoultryadmin

import android.content.Context
import android.content.SharedPreferences

class PrefsManager(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("doubles_poultry_prefs", Context.MODE_PRIVATE)

    var serverIp: String?
        get() = prefs.getString("server_ip", null)
        set(value) = prefs.edit().putString("server_ip", value).apply()

    var serverPort: String?
        get() = prefs.getString("server_port", null)
        set(value) = prefs.edit().putString("server_port", value).apply()

    fun hasServer(): Boolean = !serverIp.isNullOrEmpty() && !serverPort.isNullOrEmpty()

    fun getServerUrl(): String? {
        if (!hasServer()) return null
        return "http://$serverIp:$serverPort"
    }
}
